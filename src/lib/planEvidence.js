// ============================================================
// planEvidence.js — gather everything the trace engine can use from
// the loaded plan, in image-pixel space, and convert it to feet.
//
//   vector PDF  → exact face lines, door-swing curves, sheet text
//   scanned PDF / image → raster stroke detection (+ any text layer)
// ============================================================

import { arcFromBezier, isDoorSwing } from '../engine/trace/arcs.js';
import { parseScaleNote } from '../engine/trace/analyze.js';
import { ARCH_SCALES, archFeetPerPaperInch } from '../engine/units.js';

const VECTOR_MIN_LINES = 150;

// cached per page so re-solving after a manual edit doesn't re-read the PDF
let cache = { key: null, ev: null };

/**
 * @returns {Promise<{mode:'vector'|'raster', lines, bodies, curves, texts, width, height, stats}>} px space
 */
export async function gatherEvidence({ doc, pageNum, renderScale, planImage, pxPerFtHint }) {
  const key = `${doc ? doc.fingerprints?.[0] || 'doc' : 'img'}:${pageNum}:${renderScale}:${planImage?.slice?.(0, 64)}`;
  if (cache.key === key && cache.ev) return cache.ev;

  let vec = null;
  if (doc) {
    const pdfjs = await import('pdfjs-dist');
    const { extractPageVectors } = await import('./pdfVectors.js');
    const page = await doc.getPage(pageNum);
    vec = await extractPageVectors(page, renderScale, pdfjs.OPS);
  }

  let ev;
  if (vec && vec.lines.length >= VECTOR_MIN_LINES) {
    ev = { mode: 'vector', lines: vec.lines, bodies: [], curves: vec.curves, texts: vec.texts, width: vec.width, height: vec.height, stats: vec.stats };
  } else {
    if (!planImage) throw new Error('No plan image to read.');
    const img = await loadImage(planImage);
    const cv = document.createElement('canvas');
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, cv.width, cv.height);
    cv.width = cv.height = 0;
    const { extractRasterWalls } = await import('./rasterWalls.js');
    const ppf = pxPerFtHint || 48;
    const r = extractRasterWalls(data, ppf);
    ev = { mode: 'raster', lines: r.lines, bodies: r.bodies, curves: [], texts: vec?.texts || [], width: data.width, height: data.height, stats: { ...r.stats, vectorLines: vec?.lines.length || 0 } };
  }
  cache = { key, ev };
  return ev;
}

export function clearEvidenceCache() { cache = { key: null, ev: null }; }

function loadImage(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('Could not read the plan image'));
    im.src = src;
  });
}

const inRegion = (p, r) => !r || (p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1);

/** px evidence → feet input for runTrace. region is a px rect {x0,y0,x1,y1} or null. */
export function evidenceToFeet(ev, scale, region = null) {
  const k = scale;
  const P = (p) => ({ x: p.x * k, y: p.y * k });
  const lines = ev.lines.filter((l) => inRegion(l.a, region) && inRegion(l.b, region)).map((l) => ({ a: P(l.a), b: P(l.b), w: (l.w || 0) * k }));
  const bodies = (ev.bodies || []).filter((b) => inRegion(b.a, region) && inRegion(b.b, region)).map((b) => ({ a: P(b.a), b: P(b.b), t: b.t * k, conf: 0.7, src: 'raster' }));
  const arcs = [];
  for (const c of ev.curves || []) {
    if (!inRegion(c.pieces[0].p0, region)) continue;
    const arc = arcFromBezier(c.pieces.map((pc) => ({ p0: P(pc.p0), p1: P(pc.p1), p2: P(pc.p2), p3: P(pc.p3) })));
    if (isDoorSwing(arc)) arcs.push(arc);
  }
  const texts = ev.texts.filter((t) => inRegion(t, region)).map((t) => ({ str: t.str, ...P(t) }));
  return { lines, bodies, arcs, texts };
}

/** Try to read the drawing scale off the sheet. Returns { id, label, scale } or null. */
export function detectSheetScale(ev, planDpi) {
  if (!planDpi) return null;
  const id = parseScaleNote(ev.texts);
  if (!id) return null;
  const a = ARCH_SCALES.find((x) => x.id === id);
  const fpi = archFeetPerPaperInch(a);
  if (!a || !fpi) return null;
  return { id, label: a.label, scale: fpi / planDpi };
}
