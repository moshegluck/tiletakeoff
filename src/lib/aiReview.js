// ============================================================
// aiReview.js — the AI check of a trace: Claude LOOKS at the drawing with
// the traced model drawn over it (rooms R1…, gaps O1… coloured by type) and
// says where the two disagree. Each finding becomes a located flag in the
// Trace panel. The model never supplies geometry: the numbers stay the
// engine's; the estimator fixes the model with the wall / erase tools.
// ============================================================
import { supabase, cloudEnabled } from './supabase.js';

// the model reads up to 2576 px on the long edge 1:1; keep the JPEG under
// the 4.5 MB request limit
const MAX_EDGE = 2560, MAX_AREA = 3.6e6;

const COL = { door: '#1d6fb0', opening: '#d9771f', window: '#14917d', room: '#7b3fa8' };

export const KIND_TEXT = {
  missing_wall: 'missing wall', false_wall: 'not a wall', missed_door: 'missed doorway', false_opening: 'gap where the drawing has a wall',
  window_as_door: 'window taken as a door', door_as_window: 'door taken as a window', outline_off: 'outline off the walls',
  merged_rooms: 'two rooms in one', not_floor: 'not floor', name_mismatch: 'name differs',
};

const openingKind = (o) => (o.openingType === 'window' ? 'window' : o.openingType === 'opening' ? 'opening' : 'door');

/**
 * What the AI is shown and told: the plan crop around the traced rooms with
 * the model drawn on it, and the tags. Pure apart from the canvas.
 * @param {HTMLImageElement} img  the plan raster on screen
 * @param {object} res            trace result (feet)
 * @param {number} scale          feet per plan px
 */
export function reviewImage(img, res, scale) {
  const f2p = (v) => v / scale;
  const pts = res.rooms.flatMap((r) => r.poly);
  const pad = 4 / scale;   // 4 ft of drawing around the rooms
  const x0 = Math.max(0, Math.min(...pts.map((p) => f2p(p.x))) - pad), y0 = Math.max(0, Math.min(...pts.map((p) => f2p(p.y))) - pad);
  const x1 = Math.min(img.naturalWidth, Math.max(...pts.map((p) => f2p(p.x))) + pad), y1 = Math.min(img.naturalHeight, Math.max(...pts.map((p) => f2p(p.y))) + pad);
  const w = x1 - x0, h = y1 - y0;
  const k = Math.min(MAX_EDGE / Math.max(w, h), Math.sqrt(MAX_AREA / (w * h)), 3);
  const W = Math.round(w * k), H = Math.round(h * k);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, x0, y0, w, h, 0, 0, W, H);
  const P = (p) => ({ x: (f2p(p.x) - x0) * k, y: (f2p(p.y) - y0) * k });
  const lw = Math.max(1.5, 0.12 / scale * k);   // ~1.5" wide on the drawing

  const tags = { rooms: [], openings: [] };
  res.rooms.forEach((r, i) => {
    const tag = `R${i + 1}`;
    ctx.beginPath(); r.poly.forEach((p, j) => { const q = P(p); j ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); }); ctx.closePath();
    ctx.fillStyle = 'rgba(123,63,168,.08)'; ctx.fill();
    ctx.strokeStyle = COL.room; ctx.lineWidth = lw; ctx.stroke();
    const c = P(r.center);
    tags.rooms.push({ tag, id: r.id, name: r.name, x: c.x, y: c.y, areaSf: r.area, wallLf: r.wallLf });
  });
  res.openings.forEach((o, i) => {
    const tag = `O${i + 1}`, kind = openingKind(o);
    const a = P(o.a), b = P(o.b);
    ctx.strokeStyle = COL[kind]; ctx.lineWidth = lw * 2.4; ctx.lineCap = 'butt';
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    tags.openings.push({ tag, id: o.id, type: kind, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, widthFt: o.width });
  });
  // tags last, on top, readable
  const fs = Math.max(11, Math.min(18, lw * 7));
  const label = (txt, x, y, col) => {
    ctx.font = `700 ${fs}px Helvetica, Arial, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const tw = ctx.measureText(txt).width + 6;
    ctx.fillStyle = 'rgba(255,255,255,.92)'; ctx.fillRect(x - tw / 2, y - fs * 0.62, tw, fs * 1.24);
    ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.strokeRect(x - tw / 2, y - fs * 0.62, tw, fs * 1.24);
    ctx.fillStyle = col; ctx.fillText(txt, x, y + 0.5);
  };
  for (const r of tags.rooms) label(r.tag, r.x, r.y, COL.room);
  for (const o of tags.openings) label(o.tag, o.x, o.y - fs, COL[o.type]);
  const b64 = cv.toDataURL('image/jpeg', 0.85).split(',')[1];
  cv.width = cv.height = 0;
  return { b64, W, H, k, x0, y0, tags };
}

/**
 * Findings → flags in feet, on the page the trace is on.
 * @param {{findings:any[], roomsOk:string[]}} out  the route's answer
 */
export function findingsToFlags(out, img, scale) {
  const byTag = new Map([...img.tags.rooms.map((r) => [r.tag, r]), ...img.tags.openings.map((o) => [o.tag, o])]);
  const toFt = (x, y) => ({ x: (x / img.k + img.x0) * scale, y: (y / img.k + img.y0) * scale });
  const flags = (out.findings || []).map((f, i) => {
    const room = byTag.get(f.room), op = byTag.get(f.opening);
    const where = [room && room.name, op && `${op.type} ${op.tag}`].filter(Boolean).join(' · ');
    return {
      id: `ai${i + 1}`, severity: 'warn', kind: `ai_${f.kind}`, ai: true,
      at: toFt(f.x, f.y), roomId: room?.id || null, openingId: op?.id || null, confidence: f.confidence,
      msg: `AI check — ${KIND_TEXT[f.kind] || f.kind}${where ? ` (${where})` : ''}: ${f.note}`,
    };
  });
  const okIds = (out.roomsOk || []).map((t) => byTag.get(t)?.id).filter(Boolean);
  return { flags, okIds };
}

async function loadImage(src) {
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('Could not read the plan image')); im.src = src; });
}

/**
 * Run the AI check on the trace of the page on screen.
 * @returns {Promise<{ at:number, page:number, model?:string, flags:any[], okIds:string[], warning?:string }>}
 */
export async function reviewTraceWithAI(state) {
  const res = state.trace?.result;
  if (!res?.rooms?.length) throw new Error('Trace the plan first');
  if (!state.planImage || !state.scale) throw new Error('No plan or scale');
  const img = reviewImage(await loadImage(state.planImage), res, state.scale);
  const body = {
    mode: 'review', imageBase64: img.b64, mediaType: 'image/jpeg', imageWidth: img.W, imageHeight: img.H,
    pxPerFt: img.k / state.scale, rooms: img.tags.rooms, openings: img.tags.openings,
  };
  const headers = { 'content-type': 'application/json' };
  if (cloudEnabled && supabase) {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    if (token) headers.authorization = `Bearer ${token}`;
  }
  const r = await fetch('/api/detect-plan', { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `AI check failed (${r.status})`);
  }
  const out = await r.json();
  return { at: Date.now(), page: state.pdfPage || 1, model: out.model, warning: out.warning, ...findingsToFlags(out, img, state.scale) };
}
