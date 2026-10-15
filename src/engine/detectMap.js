// ============================================================
// detectMap.js — turn AI room detections into rooms in feet, placed
// exactly over the plan underlay.
//
// The detection image is a region of the plan re-rendered at high
// resolution. An ImageMap converts its pixels back to underlay (model)
// pixels:  model = origin + pixel × r.  Model pixels × project scale
// (feet per model px) = feet. When no scale is set, the printed room
// sizes the AI read (e.g. 12'-6" × 10'-0") give one. Pure; no DOM.
// ============================================================

import { polygonArea, bounds, rectPoly } from './geometry.js';
import { cleanPolygon, selfIntersects } from './zones.js';
import { ARCH_SCALES, archFeetPerPaperInch } from './units.js';

/**
 * Detection image px → underlay (model) px.
 * @typedef {{ ox: number, oy: number, rx: number, ry: number }} ImageMap
 */

/**
 * One room as returned by /api/detect-plan (coordinates in image px).
 * @typedef {Object} Detection
 * @property {string} name
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 * @property {import('./types.js').Point[]} outline
 * @property {string} dimText
 * @property {number} dimWFt   printed horizontal size, 0 if none
 * @property {number} dimHFt   printed vertical size, 0 if none
 * @property {number} confidence
 */

/** @param {import('./types.js').Point} p @param {ImageMap} map */
export function imageToModel(p, map) {
  return { x: map.ox + p.x * map.rx, y: map.oy + p.y * map.ry };
}

const median = (a) => {
  const s = a.slice().sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const agree = (u, v, tol) => Math.abs(u - v) / Math.max(u, v) <= tol;

/**
 * Drawing scale implied by the printed room sizes, in feet per model px.
 * Each room whose label agrees with its drawn proportions (either way
 * round) votes; votes far from the median are dropped as misreads.
 * @param {Detection[]} dets
 * @param {ImageMap} map
 * @returns {{ feetPerModelPx: number, samples: number } | null}
 */
export function inferScale(dets, map) {
  const votes = [];
  for (const d of dets) {
    if (!(d.dimWFt > 0) || !(d.dimHFt > 0) || !(d.w > 0) || !(d.h > 0)) continue;
    const wm = d.w * map.rx, hm = d.h * map.ry;
    const a = d.dimWFt / wm, b = d.dimHFt / hm;   // as labeled
    const c = d.dimHFt / wm, e = d.dimWFt / hm;   // label written the other way round
    if (agree(a, b, 0.12)) votes.push((a + b) / 2);
    else if (agree(c, e, 0.12)) votes.push((c + e) / 2);
  }
  if (!votes.length) return null;
  const m = median(votes);
  const keep = votes.filter((v) => agree(v, m, 0.1));
  return { feetPerModelPx: keep.reduce((s, v) => s + v, 0) / keep.length, samples: keep.length };
}

// Snap nearly-equal x (and y) coordinates together so walls the AI traced a
// few pixels off true come out square. tol is in the same units as pts.
export function squareUp(pts, tol) {
  const snap = (key) => {
    const idx = pts.map((p, i) => i).sort((i, j) => pts[i][key] - pts[j][key]);
    const out = pts.map((p) => p[key]);
    let start = 0;
    for (let k = 1; k <= idx.length; k++) {
      if (k === idx.length || pts[idx[k]][key] - pts[idx[k - 1]][key] > tol) {
        const group = idx.slice(start, k);
        const mean = group.reduce((s, i) => s + pts[i][key], 0) / group.length;
        for (const i of group) out[i] = mean;
        start = k;
      }
    }
    return out;
  };
  const xs = snap('x'), ys = snap('y');
  return pts.map((p, i) => ({ x: xs[i], y: ys[i] }));
}

/**
 * Use the traced outline only when it is a sane polygon that matches the
 * room's box; otherwise fall back to the box itself.
 * @param {import('./types.js').Point[]} outline
 * @param {{x:number,y:number,w:number,h:number}} box
 */
export function outlineOk(outline, box) {
  if (!Array.isArray(outline) || outline.length < 4 || outline.length > 64) return false;
  const pts = cleanPolygon(outline);
  if (pts.length < 4 || selfIntersects(pts)) return false;
  const boxArea = box.w * box.h;
  if (!(boxArea > 0)) return false;
  const frac = polygonArea(pts) / boxArea;
  if (frac < 0.45 || frac > 1.05) return false;
  const b = bounds(pts), slackX = box.w * 0.08, slackY = box.h * 0.08;
  return b.minx >= box.x - slackX && b.maxx <= box.x + box.w + slackX &&
         b.miny >= box.y - slackY && b.maxy <= box.y + box.h + slackY;
}

const HALF_INCH = 1 / 24;
const roundFt = (v) => Math.round(v / HALF_INCH) * HALF_INCH;

/**
 * The room's outline in detection-image px: the traced outline squared up
 * when it is usable, else its box.
 * @param {Detection} d
 */
export function detectionOutlinePx(d) {
  if (!outlineOk(d.outline, d)) return { pts: rectPoly(d.x, d.y, d.w, d.h), traced: false };
  const tol = Math.max(2, Math.max(d.w, d.h) * 0.006); // ~0.6% of the room, at least 2 px
  return { pts: squareUp(cleanPolygon(d.outline), tol), traced: true };
}

/**
 * The part of the plan on screen, in underlay (model) px, clamped to the
 * plan. null when the plan is (nearly) off screen.
 * @param {{x:number,y:number,zoom:number}} view
 * @param {{w:number,h:number}} stage    canvas size in CSS px
 * @param {{w:number,h:number}} plan     underlay size in px
 */
export function visiblePlanRegion(view, stage, plan) {
  const x0 = Math.max(0, -view.x / view.zoom), y0 = Math.max(0, -view.y / view.zoom);
  const x1 = Math.min(plan.w, (stage.w - view.x) / view.zoom);
  const y1 = Math.min(plan.h, (stage.h - view.y) / view.zoom);
  if (x1 - x0 < 16 || y1 - y0 < 16) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * A detection as a room in feet, ready for the store.
 * @param {Detection} d
 * @param {ImageMap} map
 * @param {number} feetPerModelPx
 */
export function detectionToRoom(d, map, feetPerModelPx) {
  const { pts: imgPts, traced } = detectionOutlinePx(d);
  let points = cleanPolygon(imgPts.map((p) => {
    const m = imageToModel(p, map);
    return { x: roundFt(m.x * feetPerModelPx), y: roundFt(m.y * feetPerModelPx) };
  }));
  if (points.length < 3) points = rectPoly(0, 0, 0, 0);
  const b = bounds(points);
  const wFt = b.w, hFt = b.h;
  let labelMismatch = false;
  if (d.dimWFt > 0 && d.dimHFt > 0 && wFt > 0 && hFt > 0) {
    const same = agree(wFt, d.dimWFt, 0.1) && agree(hFt, d.dimHFt, 0.1);
    const swapped = agree(wFt, d.dimHFt, 0.1) && agree(hFt, d.dimWFt, 0.1);
    labelMismatch = !same && !swapped;
  }
  return {
    name: d.name, points, wFt, hFt, areaSf: polygonArea(points),
    shape: traced && points.length > 4 ? 'polygon' : 'rect',
    confidence: d.confidence, dimText: d.dimText || '', labelMismatch,
  };
}

/**
 * True when a new room mostly covers an existing room (already drawn).
 * @param {import('./types.js').Point[]} points
 * @param {import('./types.js').Room[]} rooms
 */
export function overlapsExisting(points, rooms) {
  const a = bounds(points), aA = a.w * a.h;
  if (!(aA > 0)) return false;
  return rooms.some((r) => {
    const b = bounds(r.points), bA = b.w * b.h;
    const iw = Math.min(a.maxx, b.maxx) - Math.max(a.minx, b.minx);
    const ih = Math.min(a.maxy, b.maxy) - Math.max(a.miny, b.miny);
    if (iw <= 0 || ih <= 0 || !(bA > 0)) return false;
    return (iw * ih) / Math.min(aA, bA) > 0.6;
  });
}

/**
 * Drawings are drawn at standard scales, so a scale read from room labels
 * is snapped to the preset it is within 4% of (when the plan's paper dpi is
 * known), e.g. 1/4" = 1'-0".
 * Imperial presets are tried first unless the project is metric (1:50 and
 * 1/4" = 1'-0" are only ~4% apart).
 * @param {number} feetPerModelPx
 * @param {number} planDpi   underlay px per paper inch (0 = unknown)
 * @param {boolean} [metric]
 * @returns {{ feetPerModelPx: number, id: ?string, label: ?string }}
 */
export function snapToPreset(feetPerModelPx, planDpi, metric = false) {
  const none = { feetPerModelPx, id: null, label: null };
  if (!(planDpi > 0) || !(feetPerModelPx > 0)) return none;
  const closest = (list) => {
    let best = null;
    for (const a of list) {
      const f = archFeetPerPaperInch(a) / planDpi;
      const off = Math.abs(f - feetPerModelPx) / feetPerModelPx;
      if (off <= 0.04 && (!best || off < best.off)) best = { off, f, a };
    }
    return best;
  };
  const isMetric = (a) => a.group === 'metric';
  const best = closest(ARCH_SCALES.filter((a) => isMetric(a) === metric)) || closest(ARCH_SCALES);
  return best ? { feetPerModelPx: best.f, id: best.a.id, label: best.a.label } : none;
}
