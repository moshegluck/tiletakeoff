// ============================================================
// aiLabels.js — Claude labels the trace, it never draws it. The engine
// numbers what it doubts (labels.js: rooms R, walls W, gaps G, bridged gaps
// O); each tile of the plan is sent with the numbers drawn on; Claude answers
// per number; the engine applies each answer and keeps it only when the plan
// itself agrees better (rooms close, printed areas match). The rest become
// notes. Same prompt as scripts/ai-labels.mjs, so the benchmark asks exactly
// what the app asks.
// ============================================================
import { supabase, cloudEnabled } from './supabase.js';
import { labelCandidates, labelTiles, labelEdits } from '../engine/trace/labels.js';

const MAX_EDGE = 2560, MAX_AREA = 3.6e6, MAX_TILES = 8;
const COL = { R: '#7b3fa8', W: '#d0021b', G: '#0a8f3c', door: '#1d6fb0', opening: '#d9771f', window: '#14917d' };

/**
 * One tile of the plan with its numbers drawn on, and the tags in image px.
 * @param {HTMLImageElement} img  the plan raster on screen
 * @param {object} tile           labelTiles() entry (feet)
 * @param {number} scale          feet per plan px
 */
export function tileImage(img, tile, scale) {
  const f2p = (v) => v / scale;
  const x0 = Math.max(0, f2p(tile.frame.x0)), y0 = Math.max(0, f2p(tile.frame.y0));
  const x1 = Math.min(img.naturalWidth, f2p(tile.frame.x1)), y1 = Math.min(img.naturalHeight, f2p(tile.frame.y1));
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
  const k = Math.min(MAX_EDGE / Math.max(w, h), Math.sqrt(MAX_AREA / (w * h)), 4);
  const W = Math.round(w * k), H = Math.round(h * k);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, x0, y0, w, h, 0, 0, W, H);
  const P = (p) => ({ x: (f2p(p.x) - x0) * k, y: (f2p(p.y) - y0) * k });
  const lw = Math.max(2, (2 / 12) / scale * k);   // ~2" on the drawing
  const fs = Math.round(Math.max(14, Math.min(22, lw * 5)));
  const tags = { rooms: [], walls: [], gaps: [], openings: [] };
  const labels = [];
  ctx.lineCap = 'butt';
  for (const m of tile.marks) {
    const a = P(m.x.a), b = P(m.x.b), c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const col = m.kind === 'O' ? COL[m.x.type] : COL[m.kind];
    ctx.strokeStyle = col; ctx.lineWidth = m.kind === 'O' ? lw * 2.4 : lw;
    ctx.setLineDash(m.kind === 'G' ? [lw * 3, lw * 2] : []);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    const list = m.kind === 'W' ? tags.walls : m.kind === 'G' ? tags.gaps : tags.openings;
    list.push({ tag: m.x.tag, x: c.x, y: c.y, width: m.x.width, type: m.x.type });
    labels.push({ tag: m.x.tag, x: c.x, y: m.kind === 'O' ? c.y - fs : c.y, col });
  }
  ctx.setLineDash([]);
  for (const r of tile.rooms) {
    const c = P(r.center);
    if (c.x < 0 || c.y < 0 || c.x > W || c.y > H) continue;
    tags.rooms.push({ tag: r.tag, name: r.name, x: c.x, y: c.y, area: r.area });
    labels.push({ tag: r.tag, x: c.x, y: c.y, col: COL.R });
  }
  ctx.font = `700 ${fs}px Helvetica, Arial, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const l of labels) {
    const tw = ctx.measureText(l.tag).width + 8, th = fs * 1.25;
    ctx.fillStyle = 'rgba(255,255,255,.92)'; ctx.fillRect(l.x - tw / 2, l.y - th / 2, tw, th);
    ctx.strokeStyle = l.col; ctx.lineWidth = 1; ctx.strokeRect(l.x - tw / 2, l.y - th / 2, tw, th);
    ctx.fillStyle = l.col; ctx.fillText(l.tag, l.x, l.y + 0.5);
  }
  const b64 = cv.toDataURL('image/jpeg', 0.88).split(',')[1];
  cv.width = cv.height = 0;
  return { b64, W, H, tags };
}

async function loadImage(src) {
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('Could not read the plan image')); im.src = src; });
}

async function askTile(t, headers) {
  const body = { mode: 'labels', imageBase64: t.b64, mediaType: 'image/jpeg', imageWidth: t.W, imageHeight: t.H, tags: t.tags };
  const r = await fetch('/api/detect-plan', { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `AI labels failed (${r.status})`);
  }
  return r.json();
}

/**
 * Ask Claude to label what the trace doubts on the page on screen.
 * @returns {Promise<{ plan:{edits:any[], seeds:any[]}, asked:number, answered:number, warning?:string }>}
 */
export async function labelTraceWithAI(state) {
  const res = state.trace?.result;
  if (!res?.rooms?.length) throw new Error('Trace the plan first');
  if (!state.planImage || !state.scale) throw new Error('No plan or scale');
  const cands = labelCandidates(res);
  const tiles = labelTiles(cands).slice(0, MAX_TILES);
  if (!tiles.length) return { plan: { edits: [], seeds: [] }, asked: 0, answered: 0 };
  const img = await loadImage(state.planImage);
  const headers = { 'content-type': 'application/json' };
  if (cloudEnabled && supabase) {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    if (token) headers.authorization = `Bearer ${token}`;
  }
  const answers = await Promise.all(tiles.map((t) => askTile(tileImage(img, t, state.scale), headers).catch((e) => ({ error: e.message }))));
  const ok = answers.filter((a) => !a.error);
  if (!ok.length) throw new Error(answers[0]?.error || 'AI labels failed');
  const labels = { rooms: [], walls: [], gaps: [], openings: [] };
  for (const a of ok) for (const k of Object.keys(labels)) labels[k].push(...(a[k] || []));
  const warning = answers.find((a) => a.warning)?.warning || (ok.length < answers.length ? `${answers.length - ok.length} of ${answers.length} parts of the plan could not be checked` : undefined);
  return { plan: labelEdits(cands, labels), asked: tiles.length, answered: ok.length, warning };
}
