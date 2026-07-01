// ============================================================
// /api/detect-plan.js — Vercel serverless function.
// Receives a base64 floor-plan image + a known scale, asks Claude
// (vision) to return rooms as rectangles in feet. The ANTHROPIC_API_KEY
// lives in an env var and never reaches the browser.
//
// Hardening (the key spends real money, so the route is guarded):
//   - requires a valid Supabase session WHEN Supabase is configured
//     (server has SUPABASE_URL + anon key); otherwise runs open but
//     IP-rate-limited so a standalone deploy still works.
//   - best-effort per-identity rate limit.
//   - bounded image size + media-type allow-list (DoS / cost guard).
//   - validates & sanitizes the model's JSON before returning it
//     (rejects NaN/Infinity/negative dims that would corrupt rooms).
//   - never leaks upstream error bodies or stack traces to the client.
// ============================================================

import { createClient } from '@supabase/supabase-js';

export const config = { maxDuration: 60 };

const SYSTEM = `You are a flooring takeoff assistant analyzing an architectural floor plan image.
Extract EVERY enclosed room/space you can identify. Do not filter by room type and do not
decide what gets tiled — the contractor makes scope decisions. For each room return its
rectangular footprint (or bounding box if irregular) with real-world dimensions in FEET.

Rules:
- Read dimension strings and scale bars when present; otherwise estimate from the given pixelsPerFoot.
- Return decimal feet (e.g. 12.5), not feet-inches strings.
- Coordinates: top-left origin, +x right, +y down, in FEET from the plan's top-left.
- If unsure of a label, use a generic name (e.g. "Room A").

Respond with ONLY valid JSON, no markdown, in this exact shape:
{"rooms":[{"name":"Kitchen","x":0,"y":0,"w":12.5,"h":10,"confidence":0.0-1.0}]}`;

const ALLOWED_MEDIA = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
// ~8M base64 chars ≈ 6 MB decoded — generous for a plan page, bounds cost/DoS.
const MAX_B64 = 8_000_000;

// Supabase (optional). When BOTH vars are present the route requires a valid
// user JWT. Vercel exposes all project env vars to functions regardless of the
// VITE_ prefix, so accept either name.
const SB_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const SB_ANON = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
const AUTH_REQUIRED = Boolean(SB_URL && SB_ANON);
const sb = AUTH_REQUIRED
  ? createClient(SB_URL, SB_ANON, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

// Best-effort in-memory rate limiter (per warm instance). For multi-instance
// production hardening, back this with Vercel KV / Upstash. Keyed by user id
// when authenticated, otherwise by client IP.
const RATE = { windowMs: 5 * 60_000, max: 20, hits: new Map() };
function rateLimited(key) {
  const now = Date.now();
  const arr = (RATE.hits.get(key) || []).filter((t) => now - t < RATE.windowMs);
  arr.push(now);
  RATE.hits.set(key, arr);
  if (RATE.hits.size > 5000) {
    for (const [k, v] of RATE.hits) {
      if (!v.length || now - v[v.length - 1] > RATE.windowMs) RATE.hits.delete(k);
    }
  }
  return arr.length > RATE.max;
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  const first = (Array.isArray(xff) ? xff[0] : xff || '').split(',')[0].trim();
  return first || req.socket?.remoteAddress || 'unknown';
}

// Coerce/validate one room from the model. Returns null if unusable so a
// hallucinated NaN/Infinity/negative dimension can't corrupt the user's project.
function cleanRoom(r) {
  if (!r || typeof r !== 'object') return null;
  const num = (v) => (Number.isFinite(+v) ? +v : null);
  const x = num(r.x) ?? 0;
  const y = num(r.y) ?? 0;
  const w = num(r.w);
  const h = num(r.h);
  if (w == null || h == null || w <= 0 || h <= 0) return null;
  // reject absurd values (feet) that would blow up the canvas / estimate
  if (w > 1000 || h > 1000 || Math.abs(x) > 100000 || Math.abs(y) > 100000) return null;
  let conf = num(r.confidence);
  if (conf == null || conf < 0) conf = 0.5;
  if (conf > 1) conf = 1;
  const name = typeof r.name === 'string' && r.name.trim() ? r.name.slice(0, 80) : 'Room';
  return { name, x, y, w, h, confidence: conf };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'AI detection is not configured on this server.' });

  try {
    // ---- auth (only when Supabase is configured server-side) ----
    let identity = `ip:${clientIp(req)}`;
    if (AUTH_REQUIRED) {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!token) return res.status(401).json({ error: 'Sign in to use AI detection.' });
      const { data, error } = await sb.auth.getUser(token);
      if (error || !data?.user) {
        return res.status(401).json({ error: 'Your session has expired — sign in again.' });
      }
      identity = `u:${data.user.id}`;
    }

    // ---- rate limit ----
    if (rateLimited(identity)) {
      return res.status(429).json({ error: 'Too many detection requests. Please wait a minute and try again.' });
    }

    // ---- input validation ----
    const { imageBase64, mediaType = 'image/png', pixelsPerFoot } = req.body || {};
    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return res.status(400).json({ error: 'imageBase64 required' });
    }
    if (imageBase64.length > MAX_B64) {
      return res.status(413).json({ error: 'Image too large (max ~6 MB). Use a smaller or lower-resolution plan.' });
    }
    if (!ALLOWED_MEDIA.has(mediaType)) {
      return res.status(400).json({ error: 'Unsupported image type. Use PNG, JPEG, WebP or GIF.' });
    }
    const ppf = Number.isFinite(+pixelsPerFoot) && +pixelsPerFoot > 0 ? +pixelsPerFoot : null;

    const userText = ppf
      ? `The plan is rendered at approximately ${ppf} pixels per foot. Extract all rooms.`
      : `No scale provided. Use visible dimension strings or a scale bar to infer real feet. Extract all rooms.`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
        max_tokens: 4096,
        system: SYSTEM,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
            { type: 'text', text: userText },
          ],
        }],
      }),
    });

    if (!r.ok) {
      // Log the upstream detail server-side only; return a generic, status-shaped message.
      let detail = '';
      try { detail = await r.text(); } catch { /* ignore */ }
      console.error(`[detect-plan] Anthropic API ${r.status}:`, detail.slice(0, 500));
      const msg = r.status === 429 ? 'AI service is busy. Please try again shortly.'
        : (r.status === 401 || r.status === 403) ? 'AI detection is misconfigured on this server.'
        : 'AI detection failed. Please try again.';
      return res.status(502).json({ error: msg });
    }

    const data = await r.json();
    const text = (data.content || []).filter((c) => c?.type === 'text').map((c) => c.text).join('');
    const clean = text.replace(/```json|```/g, '').trim();

    let parsed;
    try { parsed = JSON.parse(clean); }
    catch { return res.status(200).json({ rooms: [], warning: 'Model returned non-JSON' }); }

    const rooms = Array.isArray(parsed?.rooms)
      ? parsed.rooms.map(cleanRoom).filter(Boolean).slice(0, 200)
      : [];
    return res.status(200).json({ rooms });
  } catch (err) {
    console.error('[detect-plan] error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
}
