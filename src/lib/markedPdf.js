// ============================================================
// markedPdf.js — download the takeoff marked up on the plan, as a PDF.
//
// Every plan page that has a takeoff comes out as the ORIGINAL page (still
// vector, still sharp when zoomed or printed) marked the way Moshe marks a
// plan set: floor-tile rooms washed in a highlighter colour by room type
// with a red SF callout (rounded up), blue along fully tiled walls and
// magenta along walls tiled partway, red bathroom dims / shower footprint /
// tub / ceiling note, window cuts, and the markups; a legend says which is
// which. A summary up front reads like the proposal: page → room (bathroom
// header with dims and ceiling) → Floor / Shower floor / Walls / Window cut
// with the arithmetic (engine/takeoffRules.js). Image plans (PNG / JPG) come
// out as the image with the same marks.
// ============================================================

import { centroid, roomArea, polygonArea } from '../engine/geometry.js';
import { floorTakeoff, wallTakeoff, wallTileHeight, roomFixtures, roundUp } from '../engine/takeoffRules.js';
import { roomTypeOf } from '../engine/trace/analyze.js';
import { formatLength, formatArea, ARCH_SCALES } from '../engine/units.js';
import { markupValue, markupUnit, markupCost, isMeasured, MARKUP_TYPES } from '../engine/markups.js';
import { roomRegions, zonesOf } from '../engine/zones.js';
import { fitLabelLines, hexA } from '../components/canvasUtils.js';

/**
 * The pages that have a takeoff, each with what belongs to it.
 * @returns {{ page:number, rooms:any[], markups:any[], trace:any, scale:number|null, archScale:string|null }[]}
 */
export function takeoffPages(st) {
  const cur = st.pdfPage || 1;
  const out = [];
  const add = (page, d) => {
    if (!(d.rooms || []).length && !(d.markups || []).length) return;
    out.push({ page, rooms: d.rooms || [], markups: d.markups || [], trace: d.trace || null, scale: d.scale ?? null, archScale: d.archScale ?? null });
  };
  for (const [k, d] of Object.entries(st.pageData || {})) if (+k !== cur) add(+k, d);
  add(cur, st);
  return out.sort((a, b) => a.page - b.page);
}

const scaleLabel = (id) => ARCH_SCALES.find((a) => a.id === id)?.label || null;

// highlighter colours by room type (Moshe's DOB legend: yellow bath, green
// corridor, purple living / kitchen, cyan mech…)
const HIGHLIGHT = {
  bath: '#ffe14d', hall: '#7ed957', living: '#b48be0', kitchen: '#b48be0', dining: '#b48be0', bedroom: '#8fc6ff',
  closet: '#ffb366', laundry: '#5fd3e6', mech: '#5fd3e6', garage: '#c9c9c9', outdoor: '#ff9ecf', room: '#c7a6e8',
};
const TYPE_NAME = { bath: 'bath', hall: 'hall / corridor', living: 'living / kitchen', kitchen: 'living / kitchen', dining: 'living / kitchen', bedroom: 'bedroom', closet: 'closet', laundry: 'laundry / mech', mech: 'laundry / mech', garage: 'garage', outdoor: 'outdoor', room: 'room' };
const RED = '#d0021b', BLUE = '#1f5fd6', MAGENTA = '#d6249f';
const n2 = (x) => String(+(+x).toFixed(2));
const ft = (h) => (Math.abs(h - Math.round(h)) < 0.01 ? `${Math.round(h)}'` : n2(h) + "'");

/**
 * What a room carries on the marked plan and in the summary, by Artistic's
 * rules: floor tile (red SF callout), walls fully / partly tiled (blue /
 * magenta), bathroom dims and shower footprint, window cuts.
 * @param {object} r     room
 * @param {object} ctx   { floorIds: Set, wallIds: Set, allFloor: boolean }
 */
export function roomMarks(r, ctx) {
  const type = r.roomType && r.roomType !== 'nofloor' ? r.roomType : roomTypeOf(r.name);
  const floorTiled = ctx.allFloor || (r.assigned || []).some((id) => ctx.floorIds.has(id)) || (r.zones || []).some((z) => z.materialId);
  const wallTiled = (r.assigned || []).some((id) => ctx.wallIds.has(id));
  const fx = roomFixtures(r);
  const floor = floorTiled ? floorTakeoff(r) : null;
  const h = wallTiled ? wallTileHeight(r) : 0;
  const walls = wallTiled ? wallTakeoff(r, h) : null;
  const ceiling = r.wallHeight ?? 8;
  const full = wallTiled && h >= ceiling - 1e-6;
  // room dims as Moshe writes them (9.25x5) when the room is a rectangle
  const xs = r.points.map((q) => q.x), ys = r.points.map((q) => q.y);
  const w = Math.max(...xs) - Math.min(...xs), d = Math.max(...ys) - Math.min(...ys);
  const rect = Math.abs(roomArea(r) + (r.holes || []).reduce((a, hh) => a + Math.abs(polygonArea(hh)), 0) - w * d) < 0.02 * w * d;
  const dims = rect ? `${n2(Math.round(w * 4) / 4)}x${n2(Math.round(d * 4) / 4)}` : '';
  const scope = wallTiled ? (full ? `${ft(ceiling)} ceiling - fully tiled` : `${ft(h)} tile`) : '';
  const paren = [dims, ...fx.showers.map((x) => `sf${n2(x.w)}x${n2(x.d)}`), fx.tubs ? (fx.tubs > 1 ? `${fx.tubs} tubs` : 'tub') : ''].filter(Boolean).join(' ');
  const header = `${r.name}${(type === 'bath' || fx.showers.length || fx.tubs) && paren ? ` (${paren})` : ''}${scope ? ` ${scope}` : ''}`;
  return {
    type, color: HIGHLIGHT[type] || HIGHLIGHT.room, floor, walls, wallTiled, full, height: h, fx, dims, header,
    windows: walls ? walls.windows : 0, tiled: floorTiled || wallTiled,
  };
}

/** Which materials are floor / wall tile, and whether no floor tile is picked yet (then every room is floor). */
export function markContext(st, rooms) {
  const floorIds = new Set(st.materials.filter((m) => m.type !== 'wall').map((m) => m.id));
  const wallIds = new Set(st.materials.filter((m) => m.type === 'wall').map((m) => m.id));
  const anyFloorPick = rooms.some((r) => (r.assigned || []).some((id) => floorIds.has(id)) || (r.zones || []).some((z) => z.materialId));
  return { floorIds, wallIds, allFloor: !anyFloorPick };
}

/**
 * The summary, organized like the proposal: page → room (bathroom header
 * with dims and ceiling) → Floor / Shower floor / Walls / Window cut, each
 * with its arithmetic; then the job totals. Pure (tested).
 */
export function summarize(st) {
  const pages = takeoffPages(st);
  const ctx = markContext(st, pages.flatMap((p) => p.rooms));
  const out = pages.map((p) => {
    const rooms = [], untiled = [];
    for (const r of p.rooms) {
      const mk = roomMarks(r, ctx);
      if (!mk.tiled) { untiled.push(r.name); continue; }
      const lines = [];
      if (mk.floor) lines.push({ label: 'Floor', qty: mk.floor.sf, unit: 'SF', math: mk.floor.text });
      for (const x of mk.floor ? mk.floor.showers : mk.fx.showers.map((s) => ({ ...s, sf: roundUp(s.w * s.d) }))) {
        lines.push({ label: `Shower floor ${n2(x.w)}x${n2(x.d)}`, qty: x.sf, unit: 'SF', math: '1 EA' });
      }
      if (mk.walls) lines.push({ label: mk.full ? 'Walls - fully tiled' : `Walls - ${ft(mk.height)} tile`, qty: mk.walls.sf, unit: 'SF', math: mk.walls.text.replace(/ · .*$/, '') });
      if (mk.windows) lines.push({ label: 'Window cut', qty: mk.windows, unit: 'EA', math: 'never deducted' });
      rooms.push({ name: r.name, header: mk.header, type: mk.type, lines, floorSf: mk.floor?.sf || 0, wallSf: mk.walls?.sf || 0 });
    }
    const markups = p.markups.filter((m) => isMeasured(m.type)).map((m) => ({
      name: m.name || MARKUP_TYPES[m.type]?.label || m.type, type: m.type,
      value: markupValue(m), unit: markupUnit(m), cost: markupCost(m),
    }));
    return {
      page: p.page, scale: scaleLabel(p.archScale), rooms, untiled, markups,
      floorSf: rooms.reduce((a, r) => a + r.floorSf, 0), wallSf: rooms.reduce((a, r) => a + r.wallSf, 0),
    };
  });
  const all = out.flatMap((p) => p.rooms.flatMap((r) => r.lines));
  return {
    pages: out,
    rooms: out.reduce((a, p) => a + p.rooms.length, 0),
    floorSf: out.reduce((a, p) => a + p.floorSf, 0),
    wallSf: out.reduce((a, p) => a + p.wallSf, 0),
    showerFloors: all.filter((l) => l.label.startsWith('Shower floor')).length,
    windowCuts: all.filter((l) => l.label === 'Window cut').reduce((a, l) => a + l.qty, 0),
  };
}

// ---------------------------------------------------------------------------
// overlay: the takeoff of one page, marked the way Moshe marks a plan
// ---------------------------------------------------------------------------

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} p      takeoffPages() entry
 * @param {(ft:number)=>number} f2c  feet → canvas px
 * @param {number} pt     canvas px per PDF point (type sizes are in points)
 * @param {string} unit   unit system
 * @param {object} mctx   markContext()
 */
function drawOverlay(ctx, p, f2c, pt, unit, mctx) {
  const P = (q) => ({ x: f2c(q.x), y: f2c(q.y) });
  const ring = (pts) => pts.forEach((q, i) => { const c = P(q); i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y); });
  const path = (r) => { ctx.beginPath(); ring(r.points); ctx.closePath(); for (const h of r.holes || []) { ring(h); ctx.closePath(); } };
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  const marks = p.rooms.map((r) => ({ r, mk: roomMarks(r, mctx) })).filter((x) => x.mk.tiled);

  // floor tile: a highlighter wash in the room-type colour
  for (const { r, mk } of marks) {
    if (!mk.floor) continue;
    path(r);
    ctx.fillStyle = hexA(mk.color, 0.42); ctx.fill('evenodd');
    if (zonesOf(r).length) {
      const reg = roomRegions(r);
      for (const b of reg.bands) { ctx.beginPath(); ring(b.outer); ctx.closePath(); ring(b.holes[0]); ctx.closePath(); ctx.fillStyle = hexA(b.zone.color || '#7a3fa0', 0.3); ctx.fill('evenodd'); }
      for (const z of reg.inlays) { ctx.beginPath(); ring(z.outer); ctx.closePath(); ctx.fillStyle = hexA(z.zone.color || '#b25e00', 0.3); ctx.fill(); }
    }
  }
  // tiled walls: blue = fully tiled, magenta = partway — drawn along the
  // inside of the room's walls (stroke clipped to the room)
  for (const { r, mk } of marks) {
    if (!mk.wallTiled) continue;
    ctx.save();
    path(r); ctx.clip('evenodd');
    path(r);
    ctx.strokeStyle = mk.full ? BLUE : MAGENTA; ctx.lineWidth = 4.2 * pt; ctx.stroke();
    ctx.restore();
  }
  // windows in tiled walls: a cut charge each, never a deduction
  const res = p.trace?.committedAt ? p.trace.result : null;
  if (res) {
    const tiledIds = new Set(marks.filter((x) => x.mk.wallTiled).map((x) => x.r.traceId).filter(Boolean));
    for (const o of res.openings || []) {
      if (o.openingType !== 'window' || !(o.rooms || []).some((id) => tiledIds.has(id))) continue;
      const a = P(o.a), b = P(o.b);
      ctx.strokeStyle = RED; ctx.lineWidth = 1.6 * pt; ctx.setLineDash([3 * pt, 2 * pt]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.setLineDash([]);
      label(ctx, `WIN ${formatLength(o.width, unit)}`, (a.x + b.x) / 2, (a.y + b.y) / 2, 5 * pt, RED, pt);
    }
  }
  // callouts: the room name, the red SF callout, and for bathrooms the red
  // dims, shower footprint, tub and ceiling note
  for (const { r, mk } of marks) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const q of r.points) { const c = P(q); x0 = Math.min(x0, c.x); x1 = Math.max(x1, c.x); y0 = Math.min(y0, c.y); y1 = Math.max(y1, c.y); }
    const F = (w) => `${w} {}px Helvetica, Arial, sans-serif`;
    const lines = [{ text: r.name, size: 7.5 * pt, min: 4.5 * pt, wrap: true, font: F(700), color: '#10171f' }];
    if (mk.floor) lines.push({ text: `${mk.floor.sf} SF`, size: 9 * pt, min: 5 * pt, font: F(700), color: RED });
    const bathy = mk.type === 'bath' || mk.fx.showers.length || mk.fx.tubs;
    if (bathy && mk.dims) lines.push({ text: mk.dims, size: 6.5 * pt, min: 4.5 * pt, font: F(700), color: RED });
    for (const x of mk.fx.showers) lines.push({ text: `SH ${n2(x.w)}x${n2(x.d)}`, size: 6.5 * pt, min: 4.5 * pt, font: F(700), color: RED });
    if (mk.fx.tubs) lines.push({ text: mk.fx.tubs > 1 ? `${mk.fx.tubs} TUBS` : 'TUB', size: 6.5 * pt, min: 4.5 * pt, font: F(700), color: RED });
    if (mk.wallTiled) lines.push({ text: mk.full ? `${ft(r.wallHeight ?? 8)} CEILING FULLY TILED` : `${ft(mk.height)} TILE`, size: 5.5 * pt, min: 4 * pt, wrap: true, font: F(700), color: mk.full ? BLUE : MAGENTA });
    if (mk.walls) lines.push({ text: `WALLS ${mk.walls.sf} SF`, size: 6 * pt, min: 4 * pt, font: F(700), color: mk.full ? BLUE : MAGENTA });
    const measure = (text, size, i) => { ctx.font = lines[i].font.replace('{}', String(size)); return ctx.measureText(text).width; };
    const fit = fitLabelLines(lines, x1 - x0, y1 - y0, measure);
    const c = P(r.labelAt || centroid(r.points));
    let y = c.y - fit.reduce((a, l) => a + l.size * 1.2, 0) / 2;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const l of fit) {
      ctx.font = lines[l.i].font.replace('{}', String(l.size));
      ctx.strokeStyle = 'rgba(255,255,255,.92)'; ctx.lineWidth = 2.4 * pt; ctx.strokeText(l.text, c.x, y);
      ctx.fillStyle = lines[l.i].color; ctx.fillText(l.text, c.x, y);
      y += l.size * 1.2;
    }
  }

  for (const m of p.markups) drawMarkupMark(ctx, m, P, pt, unit);
  drawLegend(ctx, marks.map((x) => x.mk), pt);
}

// what the colours mean, top-left of the sheet
function drawLegend(ctx, mks, pt) {
  const types = [...new Set(mks.filter((m) => m.floor).map((m) => m.type))];
  const rows = types.map((t) => ({ sw: HIGHLIGHT[t] || HIGHLIGHT.room, text: `floor tile — ${TYPE_NAME[t] || t}` }));
  rows.push({ red: true, text: '123 SF  floor tile SF (rounded up)' });
  if (mks.some((m) => m.wallTiled && m.full)) rows.push({ line: BLUE, text: 'walls fully tiled to the ceiling' });
  if (mks.some((m) => m.wallTiled && !m.full)) rows.push({ line: MAGENTA, text: 'walls tiled partway (height noted)' });
  if (!rows.length) return;
  const fs = 6.5 * pt, lh = fs * 1.55, pad = 6 * pt, sw = 14 * pt;
  ctx.font = `600 ${fs}px Helvetica, Arial, sans-serif`;
  const w = pad * 3 + sw + Math.max(...rows.map((r) => ctx.measureText(r.text).width));
  const h = pad * 2 + lh * rows.length;
  const x = 18 * pt, y = 18 * pt;
  ctx.fillStyle = 'rgba(255,255,255,.94)'; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#33414f'; ctx.lineWidth = 0.6 * pt; ctx.strokeRect(x, y, w, h);
  rows.forEach((r, i) => {
    const cy = y + pad + lh * i + lh / 2;
    if (r.sw) { ctx.fillStyle = hexA(r.sw, 0.6); ctx.fillRect(x + pad, cy - fs * 0.45, sw, fs * 0.9); }
    if (r.line) { ctx.strokeStyle = r.line; ctx.lineWidth = 3 * pt; ctx.beginPath(); ctx.moveTo(x + pad, cy); ctx.lineTo(x + pad + sw, cy); ctx.stroke(); }
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillStyle = r.red ? RED : '#10171f';
    ctx.font = `${r.red ? 700 : 600} ${fs}px Helvetica, Arial, sans-serif`;
    ctx.fillText(r.text, x + pad * 2 + (r.red ? 0 : sw), cy);
  });
}

function label(ctx, text, x, y, size, color, pt) {
  ctx.font = `700 ${size}px Helvetica, Arial, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width + 3 * pt;
  ctx.fillStyle = 'rgba(255,255,255,.92)'; ctx.fillRect(x - w / 2, y - size * 0.65, w, size * 1.3);
  ctx.fillStyle = color; ctx.fillText(text, x, y);
}

function drawMarkupMark(ctx, m, P, pt, unit) {
  const pts = (m.points || []).map(P);
  if (!pts.length) return;
  const col = m.color || '#c8521f';
  ctx.strokeStyle = col; ctx.fillStyle = hexA(col, 0.14); ctx.lineWidth = 1.6 * pt;
  if (m.type === 'count') {
    pts.forEach((c, i) => {
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(c.x, c.y, 4.5 * pt, 0, 7); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = `700 ${5.5 * pt}px Helvetica, Arial, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), c.x, c.y);
    });
  } else if (m.type === 'length' || m.type === 'arrow') {
    ctx.beginPath(); pts.forEach((c, i) => (i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y))); ctx.stroke();
  } else if (m.type === 'text') {
    label(ctx, m.name || 'Text', pts[0].x, pts[0].y, 7 * pt, col, pt);
    return;
  } else if ((m.type === 'rect' || m.type === 'ellipse') && pts.length >= 2) {
    const [a, b] = pts;
    ctx.beginPath();
    if (m.type === 'rect') ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    else ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, 7);
    ctx.fill(); ctx.stroke();
  } else if (pts.length >= 3) {
    ctx.beginPath(); pts.forEach((c, i) => (i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y))); ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  if (isMeasured(m.type) && m.type !== 'count') {
    const v = markupValue(m);
    const txt = m.type === 'length' ? formatLength(v, unit) : formatArea(v, unit);
    const at = m.type === 'length' ? pts[Math.floor(pts.length / 2)] : { x: pts.reduce((a, c) => a + c.x, 0) / pts.length, y: pts.reduce((a, c) => a + c.y, 0) / pts.length };
    label(ctx, (m.name ? m.name + ' · ' : '') + txt, at.x, at.y, 6 * pt, col, pt);
  }
}

// ---------------------------------------------------------------------------
// the PDF
// ---------------------------------------------------------------------------

/** WinAnsi-safe text for the PDF's standard fonts. */
const pdfText = (s) => String(s ?? '').replace(/[′’‘]/g, "'").replace(/[″“”]/g, '"').replace(/[–—−]/g, '-').replace(/→/g, '=').replace(/[^\x20-\x7e\xa0-\xff]/g, '?');

async function canvasPng(canvas) {
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  if (!blob) throw new Error('The overlay could not be drawn (canvas too large for this device).');
  return new Uint8Array(await blob.arrayBuffer());
}

// largest overlay canvas we draw (iOS caps a canvas near 16.7 MP)
const MAX_OVERLAY_PX = 12e6;

/**
 * Build the marked-up PDF.
 * @param {object} st  store state
 * @param {{ plan?: { kind:'pdf'|'image', blob: Blob, name?: string } | null, pdfDoc?: any, onProgress?: (msg:string)=>void }} src
 * @returns {Promise<Uint8Array>}
 */
export async function buildMarkedPdf(st, { plan = null, pdfDoc = null, onProgress = () => {} } = {}) {
  const lib = await import('pdf-lib');
  const { PDFDocument, StandardFonts, rgb, degrees, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject, PDFContentStream } = lib;
  const pages = takeoffPages(st);
  if (!pages.length) throw new Error('Nothing to download yet: trace or draw rooms, or place markups, first.');
  const unit = st.unitSystem;
  const out = await PDFDocument.create();
  out.setTitle(pdfText(`${st.name} — marked-up takeoff`));
  out.setCreator('TileTakeoff');
  const font = await out.embedFont(StandardFonts.Helvetica);
  const bold = await out.embedFont(StandardFonts.HelveticaBold);

  drawSummary(out, summarize(st), { st, font, bold, rgb, unit, planName: plan?.name });
  const mctx = markContext(st, pages.flatMap((p) => p.rooms));

  let srcPdf = null, jsDoc = pdfDoc;
  if (plan?.kind === 'pdf') {
    const bytes = new Uint8Array(await plan.blob.arrayBuffer());
    srcPdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    if (!jsDoc) { const { loadPdf } = await import('./pdf.js'); jsDoc = (await loadPdf(plan.blob)).doc; }
  }
  const { pageRenderScale, PLAN_RENDER_WIDTH } = await import('./pdf.js');

  for (const p of pages) {
    onProgress(`Page ${p.page}…`);
    if (!p.scale) continue;   // nothing measured on it can be placed
    let pg, W, H, toPdf, perFt;
    if (srcPdf && jsDoc && p.page <= srcPdf.getPageCount()) {
      const [copy] = await out.copyPages(srcPdf, [p.page - 1]);
      pg = out.addPage(copy);
      // keep the original page's drawing state to itself
      pg.node.normalize();
      const start = out.context.register(PDFContentStream.of(out.context.obj({}), [pushGraphicsState()]));
      const end = out.context.register(PDFContentStream.of(out.context.obj({}), [popGraphicsState()]));
      pg.node.wrapContentStreams(start, end);
      const vp = (await jsDoc.getPage(p.page)).getViewport({ scale: 1 });
      W = vp.width; H = vp.height;
      toPdf = (x, y) => vp.convertToPdfPoint(x, y);
      // feet → plan px (the page's scale) → points (the render scale it was measured at)
      perFt = 1 / p.scale / pageRenderScale(W, H, PLAN_RENDER_WIDTH);
    } else if (plan?.kind === 'image' && p.page === 1) {
      const img = await imageForPdf(out, plan.blob);
      const k = Math.min(1, 2592 / Math.max(img.width, img.height));   // ≤ 36" on its long side
      W = img.width * k; H = img.height * k;
      pg = out.addPage([W, H]);
      pg.drawImage(img, { x: 0, y: 0, width: W, height: H });
      toPdf = (x, y) => [x, H - y];
      perFt = k / p.scale;
    } else {
      // the plan isn't available: the takeoff on a blank sheet, to scale
      const xs = p.rooms.flatMap((r) => r.points.map((q) => q.x)).concat(p.markups.flatMap((m) => (m.points || []).map((q) => q.x)));
      const ys = p.rooms.flatMap((r) => r.points.map((q) => q.y)).concat(p.markups.flatMap((m) => (m.points || []).map((q) => q.y)));
      const x0 = Math.min(...xs), y0 = Math.min(...ys), x1 = Math.max(...xs), y1 = Math.max(...ys);
      const k = Math.min(720 / Math.max(1e-6, x1 - x0), 540 / Math.max(1e-6, y1 - y0));
      W = 792; H = 612;
      pg = out.addPage([W, H]);
      const ox = (W - (x1 - x0) * k) / 2 - x0 * k, oy = (H - (y1 - y0) * k) / 2 - y0 * k;
      p.rooms = p.rooms.map((r) => shiftRoom(r, ox / k, oy / k));
      p.markups = p.markups.map((m) => ({ ...m, points: (m.points || []).map((q) => ({ x: q.x + ox / k, y: q.y + oy / k })) }));
      toPdf = (x, y) => [x, H - y];
      perFt = k;
      pg.drawText(pdfText(`Page ${p.page} — plan file not available, takeoff only`), { x: 24, y: H - 24, size: 9, font, color: rgb(0.4, 0.45, 0.5) });
    }
    // the overlay, at up to 2 px per point
    const pt = Math.min(2, Math.sqrt(MAX_OVERLAY_PX / (W * H)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(W * pt); canvas.height = Math.ceil(H * pt);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas unavailable on this device.');
    drawOverlay(ctx, p, (ftv) => ftv * perFt * pt, pt, unit, mctx);
    const png = await out.embedPng(await canvasPng(canvas));
    canvas.width = canvas.height = 0;
    // image unit square → the page as displayed (rotation and crop box included)
    const [ax, ay] = toPdf(0, H), [bx, by] = toPdf(W, H), [cx, cy] = toPdf(0, 0);
    const name = pg.node.newXObject('Image', png.ref);
    pg.pushOperators(pushGraphicsState(), concatTransformationMatrix(bx - ax, by - ay, cx - ax, cy - ay, ax, ay), drawObject(name), popGraphicsState());
    stampFooter(pg, { font, rgb, degrees, text: pdfText(`TileTakeoff · ${st.name} · page ${p.page}`), toPdf, H });
  }
  onProgress('Saving…');
  return out.save();
}

function shiftRoom(r, dx, dy) {
  const sh = (q) => ({ x: q.x + dx, y: q.y + dy });
  return { ...r, points: r.points.map(sh), holes: (r.holes || []).map((h) => h.map(sh)), labelAt: r.labelAt ? sh(r.labelAt) : undefined, zones: undefined };
}

async function imageForPdf(out, blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (/png/i.test(blob.type)) return out.embedPng(bytes);
  if (/jpe?g/i.test(blob.type)) return out.embedJpg(bytes);
  // webp / gif: through a canvas
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  return out.embedPng(await canvasPng(c));
}

// a small line along the bottom edge of the page as displayed
function stampFooter(pg, { font, rgb, degrees, text, toPdf, H }) {
  const [x, y] = toPdf(12, H - 8), [x2, y2] = toPdf(13, H - 8);
  const ang = Math.atan2(y2 - y, x2 - x) * 180 / Math.PI;
  pg.drawText(text, { x, y, size: 7, font, color: rgb(0.35, 0.4, 0.45), rotate: degrees(ang) });
}

// ---------------------------------------------------------------------------
// summary pages (US Letter, landscape)
// ---------------------------------------------------------------------------

function drawSummary(out, sum, { st, font, bold, rgb, unit, planName }) {
  const W = 792, H = 612, M = 40;
  let pg = null, y = 0;
  const ink = rgb(0.06, 0.09, 0.12), mute = rgb(0.4, 0.45, 0.5), line = rgb(0.83, 0.86, 0.89), red = rgb(0.82, 0.01, 0.11), band = rgb(0.95, 0.96, 0.97);
  const newPage = () => {
    pg = out.addPage([W, H]); y = H - M;
    pg.drawText(pdfText(st.name || 'Takeoff'), { x: M, y: y - 14, size: 16, font: bold, color: ink });
    pg.drawText(pdfText(['Marked-up takeoff', planName, new Date().toLocaleDateString()].filter(Boolean).join(' · ')), { x: M, y: y - 30, size: 9, font, color: mute });
    y -= 50;
  };
  const fit = (s, w, f, size) => {
    let t = pdfText(s);
    if (f.widthOfTextAtSize(t, size) <= w) return t;
    while (t.length > 1 && f.widthOfTextAtSize(t + '...', size) > w) t = t.slice(0, -1);
    return t + '...';
  };
  const text = (s, x, w, f = font, size = 8.5, color = ink, right = false) => {
    const t = fit(s, w, f, size);
    pg.drawText(t, { x: right ? x + w - f.widthOfTextAtSize(t, size) : x, y, size, font: f, color });
  };
  const need = (h) => { if (!pg || y - h < M) newPage(); };
  const C = { label: M + 14, qty: M + 200, unit: M + 262, math: M + 300 };

  newPage();
  const tot = [`${sum.rooms} tiled room${sum.rooms === 1 ? '' : 's'}`, `floor ${sum.floorSf} SF`, `walls ${sum.wallSf} SF`,
    sum.showerFloors && `${sum.showerFloors} shower floor${sum.showerFloors > 1 ? 's' : ''}`, sum.windowCuts && `${sum.windowCuts} window cut${sum.windowCuts > 1 ? 's' : ''}`].filter(Boolean).join(' · ');
  text(tot, M, W - 2 * M, bold, 11, red);
  y -= 14;
  text("Floor = room - shower - 10 SF a tub.  Walls = perimeter x tiled height - 14 SF a door (8 at 4'), wide openings at their width, - 10 SF a tub; windows never deducted.  All rounded up.", M, W - 2 * M, font, 7.5, mute);
  y -= 22;
  for (const p of sum.pages) {
    need(50);
    pg.drawRectangle({ x: M, y: y - 4, width: W - 2 * M, height: 16, color: band });
    text(`PAGE ${p.page}${p.scale ? `  -  ${p.scale}` : ''}`, M + 4, 300, bold, 10);
    text(`floor ${p.floorSf} SF · walls ${p.wallSf} SF`, M + 300, W - 2 * M - 304, font, 8.5, mute, true);
    y -= 20;
    for (const r of p.rooms) {
      need(14 + 12.5 * r.lines.length);
      text(r.header, M, W - 2 * M, bold, 9);
      y -= 12.5;
      for (const l of r.lines) {
        text(l.label, C.label, C.qty - C.label - 6);
        text(String(l.qty), C.qty, 52, bold, 8.5, l.label === 'Floor' ? red : ink, true);
        text(l.unit, C.unit, 30, font, 8, mute);
        text(l.math, C.math, W - M - C.math, font, 7.5, mute);
        y -= 12.5;
      }
      pg.drawLine({ start: { x: M, y: y + 6 }, end: { x: W - M, y: y + 6 }, thickness: 0.4, color: line });
      y -= 4;
    }
    if (p.untiled.length) {
      need(14);
      text(`Not tiled (no tile picked): ${p.untiled.join(', ')}`, M, W - 2 * M, font, 7.5, mute);
      y -= 12;
    }
    if (p.markups.length) {
      need(30); y -= 4;
      text('Markups', M, 200, bold, 8.5, mute); y -= 12;
      for (const m of p.markups) {
        need(14);
        const qty = m.type === 'length' ? formatLength(m.value, unit) : m.type === 'count' ? `${m.value} ea` : formatArea(m.value, unit);
        text(m.name, C.label, C.qty - C.label - 6); text(qty, C.qty, 90, bold); if (m.cost) text(`$${m.cost.toFixed(2)}`, C.math, 120);
        y -= 12.5;
      }
    }
    y -= 12;
  }
}

/**
 * Build the marked-up PDF for the open project and download it. The plan
 * comes from this device's copy, or the project's copy in the cloud.
 * @param {object} st  store state
 * @param {(msg:string)=>void} [onProgress]
 */
export async function downloadMarkedPdf(st, onProgress) {
  const { getPlan } = await import('./planStore.js');
  const { planKey } = await import('./planLoad.js');
  let plan = null;
  const rec = await getPlan(planKey(st)).catch(() => null);
  if (rec?.blob) plan = { kind: rec.kind, blob: rec.blob, name: rec.name };
  else if (st.cloudId && st.planFile?.path) {
    const { downloadPlanFile } = await import('./cloud.js');
    const blob = await downloadPlanFile(st.planFile.path).catch(() => null);
    if (blob) plan = { kind: st.planFile.kind, blob, name: st.planFile.name };
  }
  const bytes = await buildMarkedPdf(st, { plan, pdfDoc: plan?.kind === 'pdf' ? st.pdfDoc : null, onProgress });
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${String(st.name || 'takeoff').replace(/[^\w.-]+/g, '_')}_marked.pdf`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return { pages: takeoffPages(st).length, plan: !!plan };
}
