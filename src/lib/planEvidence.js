// ============================================================
// planEvidence.js — gather everything the trace engine can use from
// the loaded plan, in image-pixel space, and convert it to feet.
//
//   vector PDF  → exact face lines, door-swing curves, sheet text
//   scanned PDF / image → raster stroke detection (+ any text layer)
// ============================================================

import { arcFromBezier, arcsFromPolylines, arcsFromDashes, isDoorSwing, readLeaves } from '../engine/trace/arcs.js';
import { parseScaleNote } from '../engine/trace/analyze.js';
import { planScale } from '../engine/trace/sheetScale.js';
import { dimensionScale, doorTags, doorTagScale } from '../engine/trace/dimScale.js';
import { findStairs } from '../engine/trace/stairs.js';
import { wallCandidates, labelCandidates, hasWallLayers, classifyLayer, isOpeningLayer } from '../engine/trace/layers.js';
import { ARCH_SCALES, archFeetPerPaperInch } from '../engine/units.js';
import { chromatic } from './pdfVectors.js';

const VECTOR_MIN_LINES = 150;

// cached per page so re-solving after a manual edit doesn't re-read the PDF
let cache = { key: null, ev: null };

/**
 * @returns {Promise<{mode:'vector'|'raster', lines, bodies, curves, texts, width, height, stats}>} px space
 */
export async function gatherEvidence({ doc, pageNum, renderScale, planImage, pxPerFtHint }) {
  const key = `${doc ? doc.fingerprints?.[0] || 'doc' : 'img'}:${pageNum}:${renderScale}:${fingerprint(planImage)}`;
  if (cache.key === key && cache.ev) return cache.ev;

  let vec = null;
  if (doc) {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const { extractPageVectors, readLayers } = await import('./pdfVectors.js');
    const page = await doc.getPage(pageNum);
    vec = await extractPageVectors(page, renderScale, pdfjs.OPS, { layers: await readLayers(doc) });
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

// A cheap fingerprint of the WHOLE image string (data URLs of same-size scans
// share their first hundred characters; blob URLs are unique anyway).
function fingerprint(str) {
  if (!str) return '';
  let h = 2166136261;
  const step = Math.max(1, Math.floor(str.length / 4096));
  for (let i = 0; i < str.length; i += step) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `${str.length}:${(h >>> 0).toString(36)}`;
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

/** ft: a window-layer run this long is a glass wall, not a window in one */
const GLASS_WALL = 8;

const inRegion = (p, r) => !r || (p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1);

/**
 * The sheet's door swings (ft, at `k` ft per px), each with the way it closes
 * when its leaf is drawn: Bézier arcs, swings a CAD export flattened into
 * short straight pieces, and swings plotted dashed.
 */
function readSwings(ev, k, region = null) {
  const P = (p) => ({ x: p.x * k, y: p.y * k });
  const swings = [], short = [];
  const sheetLines = ev.lines.filter((l) => !l.glyph && inRegion(l.a, region)).map((l) => ({ a: P(l.a), b: P(l.b) }));
  for (const c of ev.curves || []) {
    if (!inRegion(c.pieces[0].p0, region)) continue;
    const arc = arcFromBezier(c.pieces.map((pc) => ({ p0: P(pc.p0), p1: P(pc.p1), p2: P(pc.p2), p3: P(pc.p3) })));
    if (isDoorSwing(arc)) swings.push(arc); else if (arc) short.push(arc);
  }
  const found = [...arcsFromPolylines(sheetLines), ...arcsFromDashes(sheetLines)];
  // an SHX text's box is square to the sheet: a door tag written along the
  // leaf takes in the dashes of the swing beside it. Read the dashes again
  // with its strokes; a swing found only then is added (no letter is a
  // door-sized arc), and one found only in part (under 60°) gives way to it;
  // a whole one stands as it was read
  const glyphs = ev.lines.filter((l) => l.glyph && inRegion(l.a, region));
  if (glyphs.length) {
    const same = (p, q) => Math.hypot(p.c.x - q.c.x, p.c.y - q.c.y) < 0.5 && Math.abs(p.r - q.r) < 0.15 * q.r;
    for (const arc of arcsFromDashes(sheetLines.concat(glyphs.map((l) => ({ a: P(l.a), b: P(l.b) }))))) {
      if (swings.some((q) => same(arc, q))) continue;
      const k = found.findIndex((q) => same(arc, q));
      if (k < 0) found.push(arc);
      else if (found[k].sweepDeg < 60 && arc.sweepDeg > found[k].sweepDeg + 15) found[k] = arc;
    }
  }
  for (const arc of found) {
    if (isDoorSwing(arc)) swings.push(arc); else short.push(arc);
  }
  // which way each door closes (from its drawn leaf); doors drawn part open
  return readLeaves(swings, short, sheetLines);
}

/**
 * px evidence → feet input for runTrace. region is a px rect {x0,y0,x1,y1} or null.
 * A CAD sheet that names its wall layers gives only those lines (and lines on
 * layers we can't name) to the wall finder, and only room-label text to room
 * naming — dimensions, beams overhead, demolished walls, furniture and the
 * title block never become walls or room names.
 */
export function evidenceToFeet(ev, scale, region = null) {
  const k = scale;
  const P = (p) => ({ x: p.x * k, y: p.y * k });
  const layered = hasWallLayers(ev.lines);
  // wl: drawn on a wall layer (a sheet that names them) — the architect's own walls
  // (a white fill's edge with no stroke is a wipeout / text mask, not drawing)
  // (an SHX letter or underline is text, not drawing)
  const drawn = ev.lines.filter((l) => !l.glyph && inRegion(l.a, region) && inRegion(l.b, region) && !(l.filled && l.col === '#ffffff'));
  const lines = wallCandidates(drawn)
    .map((l) => ({ a: P(l.a), b: P(l.b), w: (l.w || 0) * k, wl: layered && classifyLayer(l.layer) === 'wall', ann: chromatic(l.col) }));
  // a glass wall: a run on the window layer as long as a wall (an interior
  // glazed partition, a storefront) closes rooms as a wall does
  if (layered) {
    for (const l of drawn) {
      if (classifyLayer(l.layer) !== 'window' || Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y) * k < GLASS_WALL) continue;
      lines.push({ a: P(l.a), b: P(l.b), w: (l.w || 0) * k, wl: false, ann: false, glass: true });
    }
  }
  const bodies = (ev.bodies || []).filter((b) => inRegion(b.a, region) && inRegion(b.b, region)).map((b) => ({ a: P(b.a), b: P(b.b), t: b.t * k, conf: 0.7, src: 'raster' }));
  const arcs = readSwings(ev, k, region);
  // door / window linework: where the sheet says a doorway or a window is
  // (kind: door | window | opening = a layer holding both)
  const hints = [];
  for (const l of ev.lines) {
    const kind = l.layer != null ? classifyLayer(l.layer) : null;
    if (isOpeningLayer(kind) && inRegion(l.a, region)) hints.push({ a: P(l.a), b: P(l.b), kind });
  }
  for (const c of ev.curves || []) {
    const kind = c.layer != null ? classifyLayer(c.layer) : null;
    if (!isOpeningLayer(kind) || !inRegion(c.pieces[0].p0, region)) continue;
    for (const pc of c.pieces) hints.push({ a: P(pc.p0), b: P(pc.p3), kind });
  }
  const inR = ev.texts.filter((t) => inRegion(t, region));
  const texts = inR.map((t) => ({ str: t.str, ...P(t), ...(t.h ? { h: t.h * k } : {}) }));
  const labels = labelCandidates(inR).map((t) => ({ str: t.str, ...P(t) }));
  // stair runs, from every line on the sheet (a stair layer gives no walls)
  const stairs = findStairs(drawn.map((l) => ({ a: P(l.a), b: P(l.b) })), texts);
  return { lines, bodies, arcs, texts, labels, hints, layered, stairs };
}

/**
 * Read the floor plan's drawing scale off the sheet: the note printed with
 * the plan's title (a sheet's details and sections carry their own), else
 * the note most of the sheet agrees on — then measured against the sheet's
 * own dimension strings. When enough of them agree on a different scale
 * (a note copied from another sheet, a plot fitted to the paper), they win.
 * With no dimension strings to read, the door tags do it (each names the
 * leaf of the swing it stands in). Returns { id, label, scale, how:
 * 'title'|'common'|'dimensions'|'doors', title?, note?, dims?, doors? } or
 * null. A measured scale that's no standard one has id null.
 */
export function detectSheetScale(ev, planDpi) {
  if (!planDpi) return null;
  const pick = planScale(ev.texts);
  const id = pick?.id || parseScaleNote(ev.texts);
  const a = id ? ARCH_SCALES.find((x) => x.id === id) : null;
  const fpi = a ? archFeetPerPaperInch(a) : null;
  const noted = a && fpi ? { id, label: a.label, scale: fpi / planDpi, how: pick?.how || 'common', ...(pick?.title ? { title: pick.title } : {}) } : null;
  const dims = dimensionScale(ev.texts, ev.lines || [], planDpi);
  if (dims && dims.votes >= 5 && dims.agree >= 0.4) return measuredScale(noted, fpi, dims, planDpi, 'dimensions', 0.02, 0.01);
  // no note to read, and the dimensions too noisy to agree as a whole (a
  // dimension string paired with the wrong extension line votes at random):
  // a sheet is drawn at a standard scale, and random votes don't pile up on
  // one. The standard most of them land on (within 1.5%), several times over
  // any other, is the scale.
  if (!noted && dims) {
    const tally = ARCH_SCALES.map((x) => ({ x, f: archFeetPerPaperInch(x) })).filter((s) => s.f)
      .map((s) => ({ ...s, n: dims.all.filter((v) => Math.abs(v / s.f - 1) <= 0.015).length }))
      .sort((p, q) => q.n - p.n);
    if (tally[0].n >= 5 && tally[0].n >= 3 * (tally[1]?.n || 0)) {
      const s = tally[0];
      return { id: s.x.id, label: s.x.label, scale: s.f / planDpi, how: 'dimensions', dims: { votes: s.n, of: dims.of, fpi: +s.f.toFixed(3) } };
    }
  }
  // no dimension strings to read (drawn as strokes): the door tags, each in
  // the swing of the door it names, against the swing's radius
  const tags = doorTags(ev.texts);
  if (tags.length >= 5) {
    const k0 = noted ? noted.scale : 4 / planDpi;
    const arcs = readSwings(ev, k0).map((a) => ({ c: { x: a.c.x / k0, y: a.c.y / k0 }, r: a.r / k0, p0: { x: a.p0.x / k0, y: a.p0.y / k0 }, p3: { x: a.p3.x / k0, y: a.p3.y / k0 } }));
    const doors = doorTagScale(tags, arcs, planDpi);
    // a swing's radius reads to about 1%, but a CAD door block draws its
    // swing at the clear opening, a leaf's thickness (1 3/8"–1 3/4") short of
    // the tagged size: up to 7% on a 2'-0" door. The doors overrule a note
    // only past that (a sheet plotted to fit the paper is off by far more).
    if (doors && doors.votes >= 5 && doors.votes >= 0.6 * doors.of) return measuredScale(noted, fpi, doors, planDpi, 'doors', 0.08, 0.015);
  }
  return noted;
}

/** A scale measured off the sheet (fpi = feet per paper inch) against its note. */
function measuredScale(noted, fpi, m, planDpi, how, confirmTol, stdTol) {
  const measured = { votes: m.votes, of: m.of, fpi: +m.fpi.toFixed(3) };
  if (noted && Math.abs(m.fpi / fpi - 1) <= confirmTol) return { ...noted, [how === 'dimensions' ? 'dims' : how]: measured };
  const std = ARCH_SCALES.find((x) => { const f = archFeetPerPaperInch(x); return f && Math.abs(f / m.fpi - 1) <= stdTol; });
  return {
    id: std ? std.id : null,
    label: std ? std.label : `1" = ${m.fpi.toFixed(2)}' (measured)`,
    scale: (std ? archFeetPerPaperInch(std) : m.fpi) / planDpi,
    how, [how === 'dimensions' ? 'dims' : how]: measured, ...(noted ? { note: noted.label } : {}),
  };
}
