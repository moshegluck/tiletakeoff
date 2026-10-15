// ============================================================
// /api/detect-plan.js — Vercel serverless function.
// Receives one image cut from the user's plan (the PDF page or region
// they are looking at, re-rendered at high resolution) and asks Claude
// (vision) for every room's outline IN THE PIXELS OF THAT IMAGE, plus any
// printed room size. The browser maps those pixels back onto the plan, so
// rooms land exactly over the drawing. The ANTHROPIC_API_KEY lives in an
// env var and never reaches the browser.
//
// Model: Claude Opus 5.5 by default (override with ANTHROPIC_MODEL). On
// current models image coordinates map 1:1 to pixels up to 2576 px on the
// long edge, and higher effort reads technical drawings more accurately.
// Structured outputs guarantee the room list is valid JSON in this shape.
// Refusal fallbacks are on, so a safety-classifier false positive on a
// drawing retries on another model instead of failing.
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
import { projectForToken } from '../src/lib/supabasePublic.js';

// Claude reads a dense plan carefully; give it room (Fluid compute allows 300 s).
export const config = { maxDuration: 300 };

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';
// Models that accept server-side refusal fallbacks ("default" routing).
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

const SYSTEM = `You are a flooring takeoff assistant. You are given one image cut from an architectural drawing; it may be a whole sheet or a zoomed-in part of one.

Find every enclosed room or space on the floor plan in the image: kitchens, baths, closets, halls, corridors, foyers, laundry, lobbies and so on. Do not decide what gets tiled; the estimator decides scope. Ignore title blocks, schedules, notes, details, elevations and sections. Skip rooms that are cut off by the image edge so much that their extent can't be seen.

For each room:
- name: the room label as printed (e.g. "BATH 2"), or a short generic name ("Room A") if it has none.
- x, y, w, h: the room's bounding box in pixels of this image (origin top-left, +x right, +y down), measured to the inside face of the walls.
- outline: the room's floor outline as pixel vertices in order around the room, following the inside face of the walls. A plain rectangle is its 4 corners; an L-shaped room has 6.
- dim_text: the room size printed inside the room (e.g. 12'-6" x 10'-0"), or "" if none is printed.
- dim_w_ft, dim_h_ft: that printed size in decimal feet, oriented to the image: dim_w_ft is the horizontal (x) size and dim_h_ft the vertical (y) size. 0 when no size is printed.
- confidence: 0 to 1, how sure you are of the room and its outline.

The coordinates are used to trace the rooms over this exact image, so be precise.`;

// Structured-output schema. Structured outputs require additionalProperties:false
// and every property in `required`; ranges are enforced in cleanRoom().
const POINT = {
  type: 'object', additionalProperties: false, required: ['x', 'y'],
  properties: { x: { type: 'number' }, y: { type: 'number' } },
};
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
        required: ['name', 'x', 'y', 'w', 'h', 'outline', 'dim_text', 'dim_w_ft', 'dim_h_ft', 'confidence'],
        properties: {
          name: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          w: { type: 'number' },
          h: { type: 'number' },
          outline: { type: 'array', items: POINT },
          dim_text: { type: 'string' },
          dim_w_ft: { type: 'number' },
          dim_h_ft: { type: 'number' },
          confidence: { type: 'number' },
        },
      },
    },
  },
};

const ALLOWED_MEDIA = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
// Vercel caps a function request body at 4.5 MB; ~4.2M base64 chars ≈ 3 MB
// decoded leaves room for the JSON around it. The client sends ~0.5–2 MB.
const MAX_B64 = 4_200_000;
// Larger images are downscaled by the API anyway (2576 px long edge).
const MAX_EDGE = 2576;

// Supabase (optional). When BOTH vars are present the route requires a valid
// user JWT. Vercel exposes all project env vars to functions regardless of the
// VITE_ prefix, so accept either name.
const SB_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const SB_ANON = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
const AUTH_REQUIRED = Boolean(SB_URL && SB_ANON);
// Verify each session with the project that issued it: the token names its
// issuer, and only our projects (the configured one, or the app's live one in
// src/lib/supabasePublic.js) are accepted. A stale env var naming a deleted
// project then can't lock everyone out, and nothing depends on a DNS check.
const sbClients = new Map();
function supabaseFor(project) {
  let c = sbClients.get(project.url);
  if (!c) {
    c = createClient(project.url, project.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    sbClients.set(project.url, c);
  }
  return c;
}

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

// Coerce/validate one room from the model against the image it was given.
// Returns null if unusable so a hallucinated NaN/Infinity/negative value can't
// corrupt the user's project.
function cleanRoom(r, W, H) {
  if (!r || typeof r !== 'object') return null;
  const num = (v) => (Number.isFinite(+v) ? +v : null);
  const clampX = (v) => Math.min(W, Math.max(0, v));
  const clampY = (v) => Math.min(H, Math.max(0, v));
  let x = num(r.x), y = num(r.y), w = num(r.w), h = num(r.h);
  if (x == null || y == null || w == null || h == null) return null;
  const x1 = clampX(x + w), y1 = clampY(y + h);
  x = clampX(x); y = clampY(y);
  w = x1 - x; h = y1 - y;
  if (w < 3 || h < 3) return null;
  const outline = Array.isArray(r.outline)
    ? r.outline.slice(0, 64)
        .map((p) => ({ x: num(p?.x), y: num(p?.y) }))
        .filter((p) => p.x != null && p.y != null)
        .map((p) => ({ x: clampX(p.x), y: clampY(p.y) }))
    : [];
  const ft = (v) => { const n = num(v); return n != null && n > 0 && n < 1000 ? n : 0; };
  let conf = num(r.confidence);
  if (conf == null || conf < 0) conf = 0.5;
  if (conf > 1) conf = 1;
  const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 80) : 'Room';
  const dimText = typeof r.dim_text === 'string' ? r.dim_text.slice(0, 60) : '';
  return { name, x, y, w, h, outline, dimText, dimWFt: ft(r.dim_w_ft), dimHFt: ft(r.dim_h_ft), confidence: conf };
}

// One Messages call. With a fallback-capable model, opt into server-side
// refusal fallbacks; if the API rejects that request shape, retry plainly so
// an optional extra can never take detection down.
async function askClaude(anthropic, params) {
  if (FALLBACK_MODELS.has(params.model)) {
    try {
      return await anthropic.beta.messages.create({
        ...params,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
    } catch (err) {
      if (!(err instanceof Anthropic.BadRequestError)) throw err;
      console.error('[detect-plan] fallback request rejected, retrying without it:', err?.message);
    }
  }
  return anthropic.messages.create(params);
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
      const project = projectForToken(token, { url: SB_URL, anonKey: SB_ANON });
      if (!project) return res.status(401).json({ error: 'Your session has expired — sign in again.' });
      const { data, error } = await supabaseFor(project).auth.getUser(token);
      if (error || !data?.user) {
        if (error) console.error('[detect-plan] session check failed:', error.message);
        return res.status(401).json({ error: 'Your session has expired — sign in again.' });
      }
      identity = `u:${data.user.id}`;
    }

    // ---- rate limit ----
    if (await rateLimited(identity)) {
      return res.status(429).json({ error: 'Too many detection requests. Please wait a minute and try again.' });
    }

    // ---- input validation ----
    const { imageBase64, mediaType = 'image/jpeg', imageWidth, imageHeight, feetPerPixel } = req.body || {};
    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return res.status(400).json({ error: 'imageBase64 required' });
    }
    if (imageBase64.length > MAX_B64) {
      return res.status(413).json({ error: 'Plan image too large. Zoom in on the floor plan and try again.' });
    }
    if (!ALLOWED_MEDIA.has(mediaType)) {
      return res.status(400).json({ error: 'Unsupported image type. Use PNG, JPEG, WebP or GIF.' });
    }
    const W = Math.round(+imageWidth), H = Math.round(+imageHeight);
    if (!(W >= 16 && H >= 16 && W <= MAX_EDGE && H <= MAX_EDGE)) {
      return res.status(400).json({ error: `imageWidth/imageHeight required (16–${MAX_EDGE} px).` });
    }
    const fpp = Number.isFinite(+feetPerPixel) && +feetPerPixel > 0 ? +feetPerPixel : null;

    const userText = `This image is ${W} × ${H} pixels. Return coordinates in these pixels.` + (fpp
      ? ` Drawing scale: 1 pixel ≈ ${fpp.toPrecision(4)} ft (about ${(1 / fpp).toFixed(1)} px per foot).`
      : ' The drawing scale is not known; read printed room sizes where they are shown.');

    // ---- Anthropic call: structured outputs + adaptive thinking ----
    // Two attempts of ≤140 s each stay inside the 300 s function limit.
    const anthropic = new Anthropic({ apiKey: key, timeout: 140_000, maxRetries: 1 });
    let msg;
    try {
      msg = await askClaude(anthropic, {
        model: MODEL,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high', format: { type: 'json_schema', schema: ROOM_SCHEMA } },
        system: SYSTEM,
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
      const msgOut = status === 429 || status === 529 ? 'The AI service is busy. Please try again in a minute.'
        : (status === 401 || status === 403) ? 'AI detection is misconfigured on this server (API key).'
        : status === 404 ? 'AI detection is misconfigured on this server (model).'
        : status === 413 ? 'Plan image too large for the AI service. Zoom in and try again.'
        : err instanceof Anthropic.APIConnectionTimeoutError ? 'The AI took too long on this plan. Zoom in on part of it and try again.'
        : 'AI detection failed. Please try again.';
      return res.status(502).json({ error: msgOut });
    }

    if (msg.stop_reason === 'refusal') {
      return res.status(200).json({ rooms: [], imageWidth: W, imageHeight: H, warning: 'The AI declined to analyze this image.' });
    }
    if (msg.stop_reason === 'max_tokens') {
      console.error('[detect-plan] hit max_tokens');
    }

    // Structured outputs guarantee schema-shaped JSON in the text block(s);
    // parse defensively anyway (thinking / fallback blocks are filtered out).
    const text = (msg.content || []).filter((c) => c?.type === 'text').map((c) => c.text).join('');
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { return res.status(200).json({ rooms: [], imageWidth: W, imageHeight: H, warning: 'The AI returned an unreadable answer. Try again.' }); }

    const rooms = Array.isArray(parsed?.rooms)
      ? parsed.rooms.map((r) => cleanRoom(r, W, H)).filter(Boolean).slice(0, 200)
      : [];
    return res.status(200).json({ rooms, imageWidth: W, imageHeight: H, model: msg.model });
  } catch (err) {
    console.error('[detect-plan] error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
}
