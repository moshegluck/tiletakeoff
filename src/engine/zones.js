// ============================================================
// zones.js — floor design zones inside a room.
//
// A room's `points` are its WALL perimeter. Floor designs — a border
// band running around the room, a rug inset, a medallion, a feature
// panel — are not walls, so they live on the room as `zones`:
//
//   border  a band offset in from the walls: { kind:'border', inset, width }
//           (feet). Nothing to trace — it is derived from the wall polygon,
//           so it follows L-shapes and angled walls and re-flows whenever
//           the room is edited.
//   inlay   a polygon traced on the floor over the plan's design lines
//           (or boxed): { kind:'inlay', points, layout }.
//
// Each zone carries its own materialId. The FIELD is whatever is left for
// the room's own floor material: room − border bands − inlays. Everything
// is vector geometry in canonical feet; nothing here reads pixels.
// ============================================================

import { polygonArea, polygonPerimeter, pointInPolygon, centroid, classifyTile, clipPolygon, rectPoly, bounds } from './geometry.js';

const EPS = 1e-9;

/**
 * The room's design zones (older rooms have none).
 * @param {import('./types.js').Room} room
 * @returns {import('./types.js').Zone[]}
 */
export function zonesOf(room) {
  return Array.isArray(room?.zones) ? room.zones : [];
}

function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/**
 * Drop duplicate and collinear vertices so every edge has a direction and
 * consecutive edges actually turn (the offset needs both).
 * @param {import('./types.js').Point[]} pts
 */
export function cleanPolygon(pts) {
  const out = [];
  for (const p of pts) {
    const l = out[out.length - 1];
    if (!l || Math.hypot(p.x - l.x, p.y - l.y) > 1e-7) out.push({ x: p.x, y: p.y });
  }
  if (out.length > 1) {
    const f = out[0], l = out[out.length - 1];
    if (Math.hypot(f.x - l.x, f.y - l.y) <= 1e-7) out.pop();
  }
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i - 1 + out.length) % out.length], b = out[i], c = out[(i + 1) % out.length];
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      const mag = Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(c.x - b.x, c.y - b.y);
      if (Math.abs(cross) <= 1e-9 * Math.max(1, mag)) { out.splice(i, 1); changed = true; break; }
    }
  }
  return out;
}

function segsCross(a, b, c, d) {
  const o = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) &&
         ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS));
}

/** True if any two non-adjacent edges properly cross. */
export function selfIntersects(pts) {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent through the closing edge
      if (segsCross(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return true;
    }
  }
  return false;
}

/**
 * Offset a simple polygon INWARD by `d` feet (mitered corners). This is how
 * a border band is derived from the walls: every wall edge slides in by d and
 * neighbouring edges are re-intersected, so L-shapes and angled walls work.
 * Returns null when the offset collapses (band too wide for the room).
 * @param {import('./types.js').Point[]} pts
 * @param {number} d  feet, > 0 = inward
 * @returns {import('./types.js').Point[] | null}
 */
export function offsetPolygon(pts, d) {
  const P = cleanPolygon(pts);
  const n = P.length;
  if (n < 3) return null;
  const sa = signedArea(P);
  if (Math.abs(sa) < EPS) return null;
  if (Math.abs(d) < 1e-12) return P;
  // with a positive shoelace sum the LEFT normal points inward
  const s = sa > 0 ? 1 : -1;
  const lines = [];
  for (let i = 0; i < n; i++) {
    const a = P[i], b = P[(i + 1) % n];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
    lines.push({ px: a.x - uy * s * d, py: a.y + ux * s * d, ux, uy });
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const L1 = lines[(i - 1 + n) % n], L2 = lines[i];
    const den = L1.ux * L2.uy - L1.uy * L2.ux;
    if (Math.abs(den) < 1e-12) { out.push({ x: L2.px, y: L2.py }); continue; }
    const t = ((L2.px - L1.px) * L2.uy - (L2.py - L1.py) * L2.ux) / den;
    out.push({ x: L1.px + L1.ux * t, y: L1.py + L1.uy * t });
  }
  // every offset edge must keep its wall's direction — a flipped edge means
  // that part of the room is narrower than the offset and has collapsed
  for (let i = 0; i < n; i++) {
    const a = out[i], b = out[(i + 1) % n];
    if ((b.x - a.x) * lines[i].ux + (b.y - a.y) * lines[i].uy <= 1e-9) return null;
  }
  const oa = signedArea(out);
  if (Math.sign(oa) !== Math.sign(sa)) return null;
  if (d > 0 && Math.abs(oa) >= Math.abs(sa)) return null;
  if (selfIntersects(out)) return null;
  return out;
}

/**
 * A polygon with polygon holes (feet).
 * @typedef {{ outer: import('./types.js').Point[], holes: import('./types.js').Point[][], area?: number }} Region
 */

/** @param {Region} r */
export function regionArea(r) {
  return Math.max(0, polygonArea(r.outer) - (r.holes || []).reduce((s, h) => s + polygonArea(h), 0));
}

/** @param {number} x @param {number} y @param {Region} r */
export function pointInRegion(x, y, r) {
  return pointInPolygon(x, y, r.outer) && !(r.holes || []).some((h) => pointInPolygon(x, y, h));
}

/**
 * Split a room into its field regions, border bands and inlays.
 *  field   Region[] — the room's own floor material (a ring between bands
 *          when a band is inset from the wall, plus the center)
 *  bands   one per valid border: outer/inner ring + centerline + linear feet
 *  inlays  one per traced zone
 * @param {import('./types.js').Room} room
 */
export function roomRegions(room) {
  const P = room.points;
  const zones = zonesOf(room);
  /** @type {string[]} */
  const warnings = [];
  /** @type {Region[]} */
  const field = [];
  const bands = [];

  const borders = zones.filter((z) => z.kind === 'border').slice().sort((a, b) => (a.inset || 0) - (b.inset || 0));
  let cur = 0, curPoly = P;
  for (const z of borders) {
    const inset = Math.max(0, +z.inset || 0), width = +z.width || 0;
    if (!(width > 0)) { warnings.push(`${z.name}: band width must be more than zero`); continue; }
    if (inset < cur - 1e-6) { warnings.push(`${z.name} overlaps the band next to it — skipped`); continue; }
    const outer = inset > 1e-9 ? offsetPolygon(P, inset) : P;
    const inner = offsetPolygon(P, inset + width);
    if (!outer || !inner) { warnings.push(`${z.name} is too wide for this room — skipped`); continue; }
    if (inset > cur + 1e-6) field.push({ outer: curPoly, holes: [outer] });
    const centerline = offsetPolygon(P, inset + width / 2) || outer;
    bands.push({
      zone: z, outer, holes: [inner],
      area: Math.max(0, polygonArea(outer) - polygonArea(inner)),
      centerline, lf: polygonPerimeter(centerline),
    });
    cur = inset + width; curPoly = inner;
  }
  field.push({ outer: curPoly, holes: [] });

  const inlays = [];
  for (const z of zones) {
    if (z.kind !== 'inlay' || !Array.isArray(z.points) || z.points.length < 3) continue;
    const c = centroid(z.points);
    const host = field.find((f) => pointInRegion(c.x, c.y, f));
    if (host) host.holes.push(z.points);
    else warnings.push(`${z.name} isn't inside the field, so it isn't deducted from the field area`);
    inlays.push({ zone: z, outer: z.points, holes: [], area: polygonArea(z.points), layout: inlayLayout(z) });
  }

  for (const f of field) f.area = regionArea(f);
  const fieldArea = field.reduce((s, f) => s + f.area, 0);
  return { field, bands, inlays, fieldArea, warnings };
}

// Liang–Barsky: does segment ab touch the axis-aligned rect?
function segHitsRect(a, b, x0, y0, x1, y1) {
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy], q = [a.x - x0, x1 - a.x, a.y - y0, y1 - a.y];
  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < 1e-15) { if (q[i] < 0) return false; continue; }
    const t = q[i] / p[i];
    if (p[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return true;
}

function polyHitsRect(poly, x0, y0, x1, y1) {
  for (let i = 0; i < poly.length; i++) {
    if (segHitsRect(poly[i], poly[(i + 1) % poly.length], x0, y0, x1, y1)) return true;
  }
  return false;
}

/**
 * classifyTile generalized to a region with holes. With no holes it is
 * exactly classifyTile, so rooms without design zones estimate as before.
 * @returns {'full'|'cut'|'out'}
 */
export function classifyTileRegion(tx, ty, tw, th, region) {
  let cls = /** @type {'full'|'cut'|'out'} */ (classifyTile(tx, ty, tw, th, region.outer));
  if (cls === 'out' || !region.holes?.length) return cls;
  const eps = Math.min(tw, th) * 0.02;
  const x0 = tx + eps, y0 = ty + eps, x1 = tx + tw - eps, y1 = ty + th - eps;
  for (const hole of region.holes) {
    if (polyHitsRect(hole, x0, y0, x1, y1)) { cls = 'cut'; continue; }
    if (pointInPolygon((x0 + x1) / 2, (y0 + y1) / 2, hole)) return 'out';
  }
  return cls;
}

/**
 * Installed piece of a tile inside a region: its area and the bounding size
 * the cutter needs. A hole whose edge runs straight across the tile trims the
 * piece to a strip; a notched (L-shaped) piece keeps its full bounding box,
 * which is conservative for ordering.
 * @param {import('./types.js').TileQuad} tile
 * @param {Region} region
 * @returns {{ w: number, h: number, area: number } | null}
 */
export function fragmentInRegion(tile, region) {
  const tx = tile.cx - tile.w / 2, ty = tile.cy - tile.h / 2;
  const rect = rectPoly(tx, ty, tile.w, tile.h);
  const clipped = clipPolygon(rect, region.outer);
  if (clipped.length < 3) return null;
  let area = polygonArea(clipped);
  const b = bounds(clipped);
  let x0 = b.minx, x1 = b.maxx, y0 = b.miny, y1 = b.maxy;
  const e = 1e-6;
  for (const hole of region.holes || []) {
    const hc = clipPolygon(hole, rect);
    if (hc.length < 3) continue;
    const ha = polygonArea(hc);
    if (ha <= 1e-12) continue;
    area -= ha;
    const hb = bounds(hc);
    if (hb.miny <= y0 + e && hb.maxy >= y1 - e) {
      if (hb.minx <= x0 + e) x0 = Math.max(x0, hb.maxx);
      else if (hb.maxx >= x1 - e) x1 = Math.min(x1, hb.minx);
    } else if (hb.minx <= x0 + e && hb.maxx >= x1 - e) {
      if (hb.miny <= y0 + e) y0 = Math.max(y0, hb.maxy);
      else if (hb.maxy >= y1 - e) y1 = Math.min(y1, hb.miny);
    }
  }
  if (area <= 1e-9 || x1 - x0 <= 1e-9 || y1 - y0 <= 1e-9) return null;
  return { w: Math.min(tile.w, x1 - x0), h: Math.min(tile.h, y1 - y0), area };
}

/**
 * Pieces for a border band, laid the way an installer runs a border: along
 * each wall run, long side with the band. The band takes as many full-width
 * courses as fit, plus one rip course for the remainder; each tile yields as
 * many rip strips as fit across its width. Runs are measured on the band's
 * centerline and each run is rounded up to whole pieces (corners cut per run).
 * @param {{ zone: import('./types.js').Zone, centerline: import('./types.js').Point[], lf: number }} band
 * @param {import('./types.js').Material} material
 */
export function bandPieces(band, material) {
  const g = (material.grout || 0) / 12;
  const tileShort = Math.min(material.tw, material.th) / 12;
  const long = Math.max(material.tw, material.th) / 12 + g;
  const short = tileShort + g;
  const width = +band.zone.width || 0;
  const runs = [];
  if (!(long > 0) || !(tileShort > 0) || !(width > 0)) {
    return { courses: 0, fullCourses: 0, ripWidth: 0, strips: 0, stripsPerTile: 1, tiles: 0, lf: band.lf, runs, pieceLen: long || 0 };
  }
  const fullCourses = Math.floor(width / short + 1e-6);
  const rip = width - fullCourses * short;
  const hasRip = rip > 1e-4; // under ~1/64" the grout joint absorbs it
  const stripsPerTile = hasRip ? Math.max(1, Math.floor(tileShort / rip + 1e-6)) : 1;
  const courses = fullCourses + (hasRip ? 1 : 0);
  const C = band.centerline;
  let pieces = 0;
  for (let i = 0; i < C.length; i++) {
    const a = C[i], b = C[(i + 1) % C.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.ceil(len / long - 1e-6);
    runs.push({ len, pieces: n });
    pieces += n;
  }
  const tiles = pieces * fullCourses + (hasRip ? Math.ceil(pieces / stripsPerTile) : 0);
  return { courses, fullCourses, ripWidth: hasRip ? rip : 0, strips: pieces * courses, stripsPerTile, tiles, lf: band.lf, runs, pieceLen: long };
}

/**
 * An inlay's effective tile layout. `anchor` pins the pattern to the shape
 * itself — 'corner' starts full tiles at its top-left, 'center' puts a joint
 * on its center lines so the cuts are even on both sides — so moving or
 * reshaping the inlay carries its tiles with it. Without an anchor the
 * stored absolute `origin` is used.
 * @param {import('./types.js').Zone} zone
 * @returns {import('./types.js').LayoutSpec}
 */
export function inlayLayout(zone) {
  const L = zone.layout || { pattern: 'grid' };
  if (!L.anchor || !zone.points?.length) return L;
  const b = bounds(zone.points);
  const origin = L.anchor === 'center' ? { x: b.minx + b.w / 2, y: b.miny + b.h / 2 } : { x: b.minx, y: b.miny };
  return { ...L, origin };
}

/** True for a 4-vertex axis-aligned rectangle (editable by W × H). */
export function isAxisRect(pts) {
  if (!Array.isArray(pts) || pts.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const a = pts[i], b = pts[(i + 1) % 4];
    if (Math.abs(a.x - b.x) > 1e-6 && Math.abs(a.y - b.y) > 1e-6) return false;
  }
  const bb = bounds(pts);
  return bb.w > 0 && bb.h > 0;
}
