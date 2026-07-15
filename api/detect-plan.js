// ============================================================
// /api/detect-plan.js — Vercel serverless function.
// Receives a base64 floor-plan image + a known scale, asks Claude
// (vision) to return rooms as rectangles in feet. The ANTHROPIC_API_KEY
// lives in an env var and never reaches the browser.
//
// AI upgrades:
//   - Official Anthropic SDK (typed, retries, timeouts) instead of raw fetch.
//   - Structured outputs (output_config.format + JSON schema) so the room
//     list is GUARANTEED valid JSON in the expected shape — no markdown
//     fence stripping, no "model returned non-JSON" failure path.
//   - Adaptive thinking for better reasoning on dense/complex plans.
//   - Default model claude-sonnet-5 (current, high-resolution vision — reads
//     dimension strings and scale bars far better than prior tiers).
//
// Hardening (the key spends real money, so the route is guarded):
//   - requires a valid Supabase session WHEN Supabase is configured;
//     otherwise runs open but IP-rate-limited so a standalone deploy works.
//   - best-effort per-identity rate limit.
//   - bounded image size + media-type allow-list (DoS / cost guard).
//   - validates & sanitizes the model's JSON before returning it.
//   - never leaks upstream error bodies or stack traces to the client.
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
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
- confidence is 0.0–1.0 (how sure you are of the room and its dimensions).

The response format is enforced by a JSON schema — return the rooms array only.`;

// Structured-output schema. Structured outputs require additionalProperties:false
// and all properties in `required`; numeric ranges (0–1 confidence) are enforced
// downstream in cleanRoom() since the schema layer doesn't support min/max.
const ROOM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rooms'],
  properties: {
    rooms: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'x', 'y', 'w', 'h', 'confidence'],
        properties: {
          name: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          w: { type: 'number' },
          h: { type: 'number' },
          confidence: { type: 'number' },
        },
      },
    },
  },
};

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

// Rate limiter. Uses Upstash Redis (durable across serverless instances) when
// configured, else falls back to a best-effort in-memory window (per warm
// instance). Enable the durable path by setting UPSTASH_REDIS_REST_URL +
// UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL + KV_REST_API_TOKEN). Keyed by
// user id when authenticated, otherwise by client IP.
const RATE = { windowMs: 5 * 60_000, max: 20, hits: new Map() };
const KV_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '';
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
let _redis; // undefined = not yet initialized, null = unavailable
async function getRedis() {
  if (!KV_URL || !KV_TOKEN) return null;
  if (_redis === undefined) {
    try {
      const { Redis } = await import('@upstash/redis');
      _redis = new Redis({ url: KV_URL, token: KV_TOKEN });
    } catch (e) {
      console.error('[detect-plan] Redis init failed, using in-memory limiter:', e?.message);
      _redis = null;
    }
  }
  return _redis;
}

function rateLimitedInMemory(key) {
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

async function rateLimited(key) {
  const redis = await getRedis();
  if (redis) {
    try {
      // fixed-window counter with a TTL matching the window
      const bucket = `detect:${key}:${Math.floor(Date.now() / RATE.windowMs)}`;
      const n = await redis.incr(bucket);
      if (n === 1) await redis.expire(bucket, Math.ceil(RATE.windowMs / 1000));
      return n > RATE.max;
    } catch (e) {
      // Redis hiccup — fall back rather than blocking the request path.
      console.error('[detect-plan] Redis rate-limit error, falling back:', e?.message);
      return rateLimitedInMemory(key);
    }
  }
  return rateLimitedInMemory(key);
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
    if (await rateLimited(identity)) {
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

    // ---- Anthropic call: structured outputs + adaptive thinking ----
    const anthropic = new Anthropic({ apiKey: key, timeout: 50_000, maxRetries: 1 });
    let msg;
    try {
      msg = await anthropic.messages.create({
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
        max_tokens: 8192,
        thinking: { type: 'adaptive' },
        system: SYSTEM,
        output_config: { format: { type: 'json_schema', schema: ROOM_SCHEMA } },
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
            { type: 'text', text: userText },
          ],
        }],
      });
    } catch (err) {
      const status = err?.status;
      console.error(`[detect-plan] Anthropic SDK error ${status || ''}:`, err?.message);
      const msgOut = status === 429 ? 'AI service is busy. Please try again shortly.'
        : (status === 401 || status === 403) ? 'AI detection is misconfigured on this server.'
        : status === 413 ? 'Image too large for the AI service.'
        : 'AI detection failed. Please try again.';
      return res.status(502).json({ error: msgOut });
    }

    if (msg.stop_reason === 'refusal') {
      return res.status(200).json({ rooms: [], warning: 'The AI declined to analyze this image.' });
    }

    // Structured outputs guarantee valid schema-shaped JSON in the text block(s),
    // but parse defensively anyway (thinking blocks are filtered out).
    const text = (msg.content || []).filter((c) => c?.type === 'text').map((c) => c.text).join('');
    let parsed;
    try { parsed = JSON.parse(text); }
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
