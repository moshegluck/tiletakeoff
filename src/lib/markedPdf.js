// ============================================================
// markedPdf.js — download the takeoff marked up on the plan, as a PDF.
//
// Every plan page that has a takeoff comes out as the ORIGINAL page (still
// vector, still sharp when zoomed or printed) with the takeoff laid over it:
// rooms tinted and outlined with name / SF / wall LF, the doors and
// openings the wall LF was taken net of, and the markups. A summary page
// up front lists every room, opening and markup with page and job totals.
// Image plans (PNG / JPG) come out as the image with the same overlay.
// ============================================================

import { centroid, roomArea, roomWallLf } from '../engine/geometry.js';
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

/** Openings a room's wall LF was taken net of, in words ("2 doors, 1 opening · 9'-4\""). */
export function openingsText(r, unit) {
  const ops = r.openings || [];
  if (!ops.length) return '';
  const doors = ops.filter((o) => /door/.test(o.type || '')).length;
  const open = ops.length - doors;
  const w = ops.reduce((a, o) => a + (o.width || 0), 0);
  const parts = [doors && `${doors} door${doors > 1 ? 's' : ''}`, open && `${open} opening${open > 1 ? 's' : ''}`].filter(Boolean);
  return `${parts.join(', ')} · ${formatLength(w, unit)}`;
}

/**
 * The summary: per page, the rooms and markups with totals; then the job.
 * Pure (tested): the PDF only lays these rows out.
 */
export function summarize(st) {
  const unit = st.unitSystem;
  const matName = (id) => st.materials.find((m) => m.id === id)?.name;
  const pages = takeoffPages(st).map((p) => {
    const rooms = p.rooms.map((r) => ({
      name: r.name, sf: roomArea(r), lf: roomWallLf(r), traced: Number.isFinite(r.wallLf),
      openings: openingsText(r, unit), height: r.wallHeight ?? 8,
      materials: (r.assigned || []).map(matName).filter(Boolean).join(', '),
    }));
    const markups = p.markups.filter((m) => isMeasured(m.type)).map((m) => ({
      name: m.name || MARKUP_TYPES[m.type]?.label || m.type, type: m.type,
      value: markupValue(m), unit: markupUnit(m), cost: markupCost(m),
    }));
    return {
      page: p.page, scale: scaleLabel(p.archScale), rooms, markups,
      sf: rooms.reduce((a, r) => a + r.sf, 0), lf: rooms.reduce((a, r) => a + r.lf, 0),
    };
  });
  return {
    pages,
    sf: pages.reduce((a, p) => a + p.sf, 0),
    lf: pages.reduce((a, p) => a + p.lf, 0),
    rooms: pages.reduce((a, p) => a + p.rooms.length, 0),
  };
}

// ---------------------------------------------------------------------------
// overlay: the takeoff of one page drawn on a transparent canvas
// ---------------------------------------------------------------------------

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} p      takeoffPages() entry
 * @param {(ft:number)=>number} f2c  feet → canvas px
 * @param {number} pt     canvas px per PDF point (type sizes are in points)
 * @param {string} unit   unit system
 */
function drawOverlay(ctx, p, f2c, pt, unit) {
  const P = (q) => ({ x: f2c(q.x), y: f2c(q.y) });
  const ring = (pts) => pts.forEach((q, i) => { const c = P(q); i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y); });
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';

  for (const r of p.rooms) {
    ctx.beginPath(); ring(r.points); ctx.closePath();
    for (const h of r.holes || []) { ring(h); ctx.closePath(); }
    ctx.fillStyle = hexA(r.color || '#1d4e6b', 0.16); ctx.fill('evenodd');
    ctx.strokeStyle = r.color || '#1d4e6b'; ctx.lineWidth = 1.4 * pt; ctx.stroke();
    if (zonesOf(r).length) {
      const reg = roomRegions(r);
      for (const b of reg.bands) {
        ctx.beginPath(); ring(b.outer); ctx.closePath(); ring(b.holes[0]); ctx.closePath();
        ctx.fillStyle = hexA(b.zone.color || '#7a3fa0', 0.3); ctx.fill('evenodd');
      }
      for (const z of reg.inlays) {
        ctx.beginPath(); ring(z.outer); ctx.closePath();
        ctx.fillStyle = hexA(z.zone.color || '#b25e00', 0.3); ctx.fill();
      }
    }
  }

  // the doors / openings the traced wall LF is net of
  const res = p.trace?.committedAt ? p.trace.result : null;
  if (res && p.rooms.some((r) => r.traceId)) {
    for (const o of res.openings || []) {
      const a = P(o.a), b = P(o.b);
      ctx.strokeStyle = o.openingType === 'opening' ? '#b25e00' : '#1d6fb0';
      ctx.lineWidth = 3 * pt; ctx.globalAlpha = 0.85;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.globalAlpha = 1;
      label(ctx, formatLength(o.width, unit), (a.x + b.x) / 2, (a.y + b.y) / 2, 5.5 * pt, ctx.strokeStyle, pt);
    }
  }

  for (const r of p.rooms) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const q of r.points) { const c = P(q); x0 = Math.min(x0, c.x); x1 = Math.max(x1, c.x); y0 = Math.min(y0, c.y); y1 = Math.max(y1, c.y); }
    const lines = [
      { text: r.name, size: 8 * pt, min: 4.5 * pt, wrap: true, font: '700 {}px Helvetica, Arial, sans-serif', color: r.color || '#1d4e6b' },
      { text: formatArea(roomArea(r), unit), size: 7 * pt, min: 4.5 * pt, font: '600 {}px Helvetica, Arial, sans-serif', color: '#10171f' },
      { text: `${formatLength(roomWallLf(r), unit)} LF`, size: 6.5 * pt, min: 4.5 * pt, font: '500 {}px Helvetica, Arial, sans-serif', color: '#33414f' },
    ];
    const measure = (text, size, i) => { ctx.font = lines[i].font.replace('{}', String(size)); return ctx.measureText(text).width; };
    const fit = fitLabelLines(lines, x1 - x0, y1 - y0, measure);
    const c = P(r.labelAt || centroid(r.points));
    let y = c.y - fit.reduce((a, l) => a + l.size * 1.2, 0) / 2;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const l of fit) {
      ctx.font = lines[l.i].font.replace('{}', String(l.size));
      ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 2.2 * pt; ctx.strokeText(l.text, c.x, y);
      ctx.fillStyle = lines[l.i].color; ctx.fillText(l.text, c.x, y);
      y += l.size * 1.2;
    }
  }

  for (const m of p.markups) drawMarkupMark(ctx, m, P, pt, unit);
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
const pdfText = (s) => String(s ?? '').replace(/[′’‘]/g, "'").replace(/[″“”]/g, '"').replace(/[–—]/g, '-').replace(/[^\x20-\x7e\xa0-\xff]/g, '?');

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
    drawOverlay(ctx, p, (ft) => ft * perFt * pt, pt, unit);
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
  const ink = rgb(0.06, 0.09, 0.12), mute = rgb(0.4, 0.45, 0.5), line = rgb(0.83, 0.86, 0.89), accent = rgb(0.78, 0.32, 0.12);
  const newPage = () => {
    pg = out.addPage([W, H]); y = H - M;
    pg.drawText(pdfText(st.name || 'Takeoff'), { x: M, y: y - 14, size: 16, font: bold, color: ink });
    pg.drawText(pdfText(['Marked-up takeoff', planName, new Date().toLocaleDateString()].filter(Boolean).join(' · ')), { x: M, y: y - 30, size: 9, font, color: mute });
    y -= 50;
  };
  const cols = [
    { k: 'name', x: M, w: 210, h: 'Room' },
    { k: 'sf', x: M + 215, w: 70, h: 'Floor SF', right: true },
    { k: 'lf', x: M + 290, w: 80, h: 'Wall LF', right: true },
    { k: 'openings', x: M + 380, w: 150, h: 'Doors / openings (net of)' },
    { k: 'materials', x: M + 535, w: W - M - (M + 535), h: 'Materials' },
  ];
  const fit = (s, w, f, size) => {
    let t = pdfText(s);
    if (f.widthOfTextAtSize(t, size) <= w) return t;
    while (t.length > 1 && f.widthOfTextAtSize(t + '...', size) > w) t = t.slice(0, -1);
    return t + '...';
  };
  const cell = (c, text, f = font, size = 8.5, color = ink) => {
    const t = fit(text, c.w, f, size);
    const x = c.right ? c.x + c.w - f.widthOfTextAtSize(t, size) : c.x;
    pg.drawText(t, { x, y, size, font: f, color });
  };
  const need = (h) => { if (!pg || y - h < M) newPage(); };
  const rule = () => pg.drawLine({ start: { x: M, y: y - 4 }, end: { x: W - M, y: y - 4 }, thickness: 0.6, color: line });

  newPage();
  pg.drawText(pdfText(`${sum.rooms} rooms · ${formatArea(sum.sf, unit)} floor · ${formatLength(sum.lf, unit)} wall LF${sum.pages.length > 1 ? ` · ${sum.pages.length} pages` : ''}`), { x: M, y, size: 11, font: bold, color: accent });
  y -= 24;
  for (const p of sum.pages) {
    need(60);
    pg.drawText(pdfText(`Page ${p.page}${p.scale ? ` — ${p.scale}` : ''}`), { x: M, y, size: 11, font: bold, color: ink });
    pg.drawText(pdfText(`${p.rooms.length} rooms · ${formatArea(p.sf, unit)} · ${formatLength(p.lf, unit)} wall LF`), { x: M + 200, y, size: 9, font, color: mute });
    y -= 16;
    if (p.rooms.length) {
      for (const c of cols) cell(c, c.h, bold, 7.5, mute);
      rule(); y -= 13;
      for (const r of p.rooms) {
        need(14);
        cell(cols[0], r.name); cell(cols[1], formatArea(r.sf, unit).replace(/\s*sf$/i, '')); cell(cols[2], formatLength(r.lf, unit) + (r.traced ? '' : ' *'));
        cell(cols[3], r.openings || '—'); cell(cols[4], r.materials || '—', font, 8, mute);
        y -= 12.5;
      }
    }
    if (p.markups.length) {
      need(30); y -= 4;
      pg.drawText('Markups', { x: M, y, size: 8.5, font: bold, color: mute }); y -= 12;
      for (const m of p.markups) {
        need(14);
        const qty = m.type === 'length' ? formatLength(m.value, unit) : m.type === 'count' ? `${m.value} ea` : formatArea(m.value, unit);
        cell(cols[0], m.name); cell(cols[1], qty); cell(cols[2], m.cost ? `$${m.cost.toFixed(2)}` : '');
        y -= 12.5;
      }
    }
    y -= 14;
  }
  need(30);
  pg.drawText('* wall LF is the room outline (no traced walls to net openings from).', { x: M, y, size: 7.5, font, color: mute });
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
