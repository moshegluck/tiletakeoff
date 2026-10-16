// ============================================================
// /api/detect-plan.js — Vercel serverless function.
// Receives one image cut from the user's plan (the PDF page or region
// they are looking at, re-rendered at high resolution) and asks Claude
// (vision) for every room's outline IN THE PIXELS OF THAT IMAGE, plus any
// printed room size. The browser maps those pixels back onto the plan, so
// rooms land exactly over the drawing. With `mode: 'label'` (Trace) the
// rooms are already measured by the trace engine and the model only reads
// the name printed at each one. The ANTHROPIC_API_KEY lives in an env var
// and never reaches the browser.
//
// Model: Claude Opus 5.5 by default. ANTHROPIC_MODEL may name another model
// that reads plans at full resolution (see src/lib/planModels.js); an older
// one is ignored, and a configured model the API rejects falls back to the
// default. Image coordinates map 1:1 to pixels up to 2576 px on the long
// edge, and higher effort reads technical drawings more accurately.
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
import { FALLBACK_MODELS, planModels, isModelProblem } from '../src/lib/planModels.js';

// Claude reads a dense plan carefully; give it room (Fluid compute allows 300 s).
export const config = { maxDuration: 300 };

const MODELS = planModels(process.env.ANTHROPIC_MODEL);
if (MODELS.ignored) {
  console.warn(`[detect-plan] ANTHROPIC_MODEL=${MODELS.ignored} can't read plans at full resolution; using ${MODELS.chain[0]}. Remove or update ANTHROPIC_MODEL.`);
}

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

// ---- room naming (trace mode) ----
// The geometry comes from the trace engine; the model only READS the plan:
// for each traced room centre it returns the label printed there.
const LABEL_SYSTEM = `You read architectural floor plans. You are given a plan image and a list of
rooms that were already measured by a geometry engine; each has an id and the pixel position of
its centre on this image. For each room, read the room name printed inside that space on the plan
(e.g. "MASTER BATH", "W.I.C.", "KITCHEN"). If no name is printed, give the most likely name from
the fixtures you can see (toilet/tub → bath, rod/shelf → closet, range/sink run → kitchen).
Also classify each as one of: bath, closet, kitchen, laundry, bedroom, living, dining, hall,
garage, outdoor, mech, room. Never invent rooms; return exactly the ids you were given.`;

const LABEL_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['rooms'],
  properties: {
    rooms: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'name', 'type', 'printed'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          type: { type: 'string', enum: ['bath', 'closet', 'kitchen', 'laundry', 'bedroom', 'living', 'dining', 'hall', 'garage', 'outdoor', 'mech', 'room'] },
          printed: { type: 'boolean' },
        },
      },
    },
  },
};

// ---- trace review (mode: 'review') ----
// The trace engine built the walls, rooms and openings; this asks Claude to
// LOOK at the drawing with that model drawn over it and say where they
// disagree. Findings come back as located notes for the estimator — the
// model never supplies geometry, and the takeoff numbers stay the engine's.
export const REVIEW_KINDS = ['missing_wall', 'false_wall', 'missed_door', 'false_opening', 'window_as_door', 'door_as_window', 'outline_off', 'merged_rooms', 'not_floor', 'name_mismatch'];
const REVIEW_SYSTEM = `You check a flooring takeoff against the architectural drawing it was traced from.

The image is part of a floor plan with the traced model drawn over it:
- each traced room is outlined in purple with a tag R1, R2, … at its centre;
- each place the trace treats as a gap in a wall is a thick bar with a tag O1, O2, …:
  blue = door, orange = opening with no door (cased opening, closet front), teal = window
  (a window stays in the wall's linear footage; a door or opening is taken off it);
- every other wall the trace found is where the purple outlines run.

Compare the model with the drawing underneath and report only real disagreements you can see:
- missing_wall: the drawing has a wall where the model has none (two spaces share one outline, an outline crosses a wall).
- false_wall: the model closes or cuts a room along something that is not a wall (stair lines, a handrail, cabinets, counters, a dimension or break line, a furniture edge).
- missed_door: the drawing has a doorway or opening where the model runs a solid wall.
- false_opening: the model has a gap (an O tag) where the drawing has a solid wall.
- window_as_door: an O tag marked door/opening is actually a window in the drawing.
- door_as_window: an O tag marked window is actually a door or opening.
- outline_off: a room's outline doesn't follow the inside face of its walls (runs into a wall, misses a recess or a furring layer, cuts a corner).
- merged_rooms: one outline holds two rooms the drawing separates.
- not_floor: a traced room isn't finished floor (unexcavated, open to below, shaft, mechanical chase).
- name_mismatch: the room's printed name differs from the name given for its tag.

For each finding give the room tag and/or opening tag it concerns ("" if none), the pixel position on this image where the problem is, a short note an estimator understands (what is wrong and what the drawing shows), and your confidence 0–1. Do not report things that are right. If everything matches, return no findings. Never invent rooms, walls or doors that are not drawn.`;

const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['findings', 'rooms_ok'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['kind', 'room', 'opening', 'x', 'y', 'note', 'confidence'],
        properties: {
          kind: { type: 'string', enum: REVIEW_KINDS },
          room: { type: 'string' },
          opening: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          note: { type: 'string' },
          confidence: { type: 'number' },
        },
      },
    },
    rooms_ok: { type: 'array', items: { type: 'string' } },
  },
};

/** Coerce the model's review against the tags and image it was given. */
export function cleanReview(parsed, { W, H, rooms, openings }) {
  const rTags = new Set(rooms.map((r) => r.tag)), oTags = new Set(openings.map((o) => o.tag));
  const findings = (Array.isArray(parsed?.findings) ? parsed.findings : []).filter((f) => f && REVIEW_KINDS.includes(f.kind))
    .map((f) => ({
      kind: f.kind,
      room: rTags.has(String(f.room)) ? String(f.room) : '',
      opening: oTags.has(String(f.opening)) ? String(f.opening) : '',
      x: Math.min(W, Math.max(0, +f.x || 0)), y: Math.min(H, Math.max(0, +f.y || 0)),
      note: String(f.note || '').replace(/\s+/g, ' ').trim().slice(0, 240),
      confidence: Math.min(1, Math.max(0, +f.confidence || 0)),
    }))
    .filter((f) => f.note && f.confidence >= 0.35)
    .slice(0, 80);
  const roomsOk = (Array.isArray(parsed?.rooms_ok) ? parsed.rooms_ok : []).map(String).filter((t) => rTags.has(t));
  return { findings, roomsOk };
}

async function reviewTrace(body, key, res) {
  const W = Math.round(+body.imageWidth), H = Math.round(+body.imageHeight);
  if (!(W >= 16 && H >= 16 && W <= MAX_EDGE && H <= MAX_EDGE)) return res.status(400).json({ error: `imageWidth/imageHeight required (16–${MAX_EDGE} px).` });
  const tag = (s) => String(s || '').slice(0, 8);
  const rooms = (Array.isArray(body.rooms) ? body.rooms : []).slice(0, 150).map((r) => ({
    tag: tag(r.tag), name: String(r.name || '').slice(0, 40), x: Math.round(+r.x || 0), y: Math.round(+r.y || 0),
    sf: Math.round((+r.areaSf || 0) * 10) / 10, wallLf: Math.round((+r.wallLf || 0) * 10) / 10,
  }));
  const openings = (Array.isArray(body.openings) ? body.openings : []).slice(0, 300).map((o) => ({
    tag: tag(o.tag), type: ['door', 'opening', 'window'].includes(o.type) ? o.type : 'opening', x: Math.round(+o.x || 0), y: Math.round(+o.y || 0), widthFt: Math.round((+o.widthFt || 0) * 100) / 100,
  }));
  if (!rooms.length) return res.status(400).json({ error: 'rooms required' });
  const ppf = +body.pxPerFt > 0 ? ` About ${(+body.pxPerFt).toFixed(1)} pixels per foot.` : '';
  const anthropic = new Anthropic({ apiKey: key, timeout: 140_000, maxRetries: 1 });
  let msg;
  try {
    msg = await askClaude(anthropic, {
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: { type: 'json_schema', schema: REVIEW_SCHEMA } },
      system: REVIEW_SYSTEM,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: body.mediaType || 'image/jpeg', data: body.imageBase64 } },
          { type: 'text', text: `This image is ${W} × ${H} pixels.${ppf}\nTraced rooms (tag, name, centre px, floor SF, wall LF): ${JSON.stringify(rooms)}\nGaps in walls (tag, type, centre px, width ft): ${JSON.stringify(openings)}` },
        ],
      }],
    });
  } catch (err) {
    console.error(`[detect-plan:review] Anthropic SDK error ${err?.status || ''}:`, err?.message);
    return res.status(502).json({ error: sdkErrorText(err, 'The AI check failed. Please try again.') });
  }
  if (msg.stop_reason === 'refusal') return res.status(200).json({ findings: [], roomsOk: [], warning: 'The AI declined to read this plan.' });
  const text = (msg.content || []).filter((c) => c?.type === 'text').map((c) => c.text).join('');
  let parsed; try { parsed = JSON.parse(text); } catch { return res.status(200).json({ findings: [], roomsOk: [], warning: 'The AI returned an unreadable answer. Try again.' }); }
  return res.status(200).json({ ...cleanReview(parsed, { W, H, rooms, openings }), model: msg.model });
}

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

// One Messages call on one model. With a fallback-capable model, opt into
// server-side refusal fallbacks; if the API rejects that request shape, retry
// plainly so an optional extra can never take detection down.
async function askModel(anthropic, params) {
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

// Try each model in the chain; move on only when the API says the model
// itself can't serve the request (unknown to this key, or missing a feature).
async function askClaude(anthropic, params) {
  const { chain } = MODELS;
  for (let i = 0; ; i++) {
    try {
      return await askModel(anthropic, { ...params, model: chain[i] });
    } catch (err) {
      if (i === chain.length - 1 || !isModelProblem(err)) throw err;
      console.error(`[detect-plan] ${chain[i]} rejected the request (${err?.status}: ${err?.message}); trying ${chain[i + 1]}`);
    }
  }
}

// What to tell the user when the Anthropic call fails (never the upstream body).
function sdkErrorText(err, fallback) {
  const status = err?.status;
  return status === 429 || status === 529 ? 'The AI service is busy. Please try again in a minute.'
    : (status === 401 || status === 403) ? 'AI detection is misconfigured on this server (API key).'
    : status === 404 ? 'AI detection is misconfigured on this server (model).'
    : status === 413 ? 'Plan image too large for the AI service. Zoom in and try again.'
    : err instanceof Anthropic.APIConnectionTimeoutError ? 'The AI took too long on this plan. Zoom in on part of it and try again.'
    : fallback;
}

// Trace mode: the geometry comes from the trace engine; the model only reads
// the name printed at each traced room's centre (pixels of this image).
async function labelRooms(body, key, res) {
  const traced = body?.rooms;
  const list = Array.isArray(traced) ? traced.slice(0, 150).map((r) => ({
    id: String(r.id).slice(0, 20), x: Math.round(+r.x || 0), y: Math.round(+r.y || 0), areaSf: Math.round(+r.areaSf || 0),
  })) : [];
  if (!list.length) return res.status(400).json({ error: 'rooms required' });
  const W = Math.round(+body.imageWidth), H = Math.round(+body.imageHeight);
  const size = W > 0 && H > 0 ? `This image is ${W} × ${H} pixels. ` : '';
  const anthropic = new Anthropic({ apiKey: key, timeout: 90_000, maxRetries: 1 });
  let msg;
  try {
    msg = await askClaude(anthropic, {
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: LABEL_SCHEMA } },
      system: LABEL_SYSTEM,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: body.mediaType || 'image/jpeg', data: body.imageBase64 } },
          { type: 'text', text: `${size}Rooms (pixel centres on this image):\n${JSON.stringify(list)}` },
        ],
      }],
    });
  } catch (err) {
    console.error(`[detect-plan:label] Anthropic SDK error ${err?.status || ''}:`, err?.message);
    return res.status(502).json({ error: sdkErrorText(err, 'AI naming failed. Please try again.') });
  }
  if (msg.stop_reason === 'refusal') return res.status(200).json({ rooms: [], warning: 'The AI declined to read this plan.' });
  const text = (msg.content || []).filter((c) => c?.type === 'text').map((c) => c.text).join('');
  let parsed; try { parsed = JSON.parse(text); } catch { return res.status(200).json({ rooms: [] }); }
  const ids = new Set(list.map((r) => r.id));
  const out = (parsed?.rooms || []).filter((r) => ids.has(r.id) && typeof r.name === 'string' && r.name.trim())
    .map((r) => ({ id: r.id, name: r.name.trim().slice(0, 40), type: r.type, printed: !!r.printed }));
  return res.status(200).json({ rooms: out, model: msg.model });
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
    const { imageBase64, mediaType = 'image/jpeg', imageWidth, imageHeight, feetPerPixel, mode } = req.body || {};
    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return res.status(400).json({ error: 'imageBase64 required' });
    }
    if (imageBase64.length > MAX_B64) {
      return res.status(413).json({ error: 'Plan image too large. Zoom in on the floor plan and try again.' });
    }
    if (!ALLOWED_MEDIA.has(mediaType)) {
      return res.status(400).json({ error: 'Unsupported image type. Use PNG, JPEG, WebP or GIF.' });
    }
    if (mode === 'label') return await labelRooms(req.body, key, res);
    if (mode === 'review') return await reviewTrace(req.body, key, res);

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
      console.error(`[detect-plan] Anthropic SDK error ${err?.status || ''}:`, err?.message);
      return res.status(502).json({ error: sdkErrorText(err, 'AI detection failed. Please try again.') });
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
