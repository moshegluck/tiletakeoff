// ============================================================
// vec.js — tiny 2D vector + segment helpers for the trace engine.
// All coordinates are canonical FEET in plan space (+x right, +y down).
// ============================================================

export const EPS = 1e-9;

export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
export const mul = (a, k) => ({ x: a.x * k, y: a.y * k });
export const dot = (a, b) => a.x * b.x + a.y * b.y;
export const cross = (a, b) => a.x * b.y - a.y * b.x;
export const len = (a) => Math.hypot(a.x, a.y);
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
export function norm(a) { const l = len(a); return l < EPS ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l }; }
export const perp = (a) => ({ x: -a.y, y: a.x });

/** Undirected line angle in [0, PI). */
export function lineAngle(a, b) {
  let t = Math.atan2(b.y - a.y, b.x - a.x);
  if (t < 0) t += Math.PI;
  if (t >= Math.PI) t -= Math.PI;
  return t;
}

/** Smallest difference between two undirected angles (0..PI/2). */
export function angleDiff(t1, t2) {
  let d = Math.abs(t1 - t2) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d;
  return d;
}

/** Closest point on segment ab to p, with parameter t in [0,1]. */
export function closestOnSeg(p, a, b) {
  const ab = sub(b, a);
  const L2 = dot(ab, ab);
  if (L2 < EPS) return { t: 0, pt: { ...a }, d: dist(p, a) };
  let t = dot(sub(p, a), ab) / L2;
  t = Math.max(0, Math.min(1, t));
  const pt = lerp(a, b, t);
  return { t, pt, d: dist(p, pt) };
}

/** Perpendicular distance from p to the infinite line through a,b. */
export function distToLine(p, a, b) {
  const ab = sub(b, a);
  const L = len(ab);
  if (L < EPS) return dist(p, a);
  return Math.abs(cross(ab, sub(p, a))) / L;
}

/**
 * Intersection of infinite lines (p + r*s) and (q + u*w).
 * Returns { pt, s, u } (params along each, in units of the direction vectors) or null if parallel.
 */
export function lineIntersect(p, r, q, w) {
  const den = cross(r, w);
  if (Math.abs(den) < 1e-12) return null;
  const qp = sub(q, p);
  const s = cross(qp, w) / den;
  const u = cross(qp, r) / den;
  return { pt: add(p, mul(r, s)), s, u };
}

/** Proper/improper intersection of segments ab and cd. Returns {pt, t, u} or null. */
export function segIntersect(a, b, c, d, tol = 1e-9) {
  const r = sub(b, a), w = sub(d, c);
  const hit = lineIntersect(a, r, c, w);
  if (!hit) return null;
  if (hit.s < -tol || hit.s > 1 + tol || hit.u < -tol || hit.u > 1 + tol) return null;
  return { pt: hit.pt, t: hit.s, u: hit.u };
}

export function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function polyPerimeter(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) s += dist(pts[i], pts[(i + 1) % pts.length]);
  return s;
}

export function pointInPoly(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    if ((yi > p.y) !== (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** A point guaranteed (for simple polygons) to be strictly inside: centroid if inside, else scanline midpoint. */
export function interiorPoint(pts) {
  let cx = 0, cy = 0, A = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    const c = p.x * q.y - q.x * p.y;
    A += c; cx += (p.x + q.x) * c; cy += (p.y + q.y) * c;
  }
  if (Math.abs(A) > EPS) {
    const c = { x: cx / (3 * A), y: cy / (3 * A) };
    if (pointInPoly(c, pts)) return c;
  }
  // scanline through the vertical middle of the bbox: take the widest inside span
  let miny = Infinity, maxy = -Infinity;
  for (const p of pts) { miny = Math.min(miny, p.y); maxy = Math.max(maxy, p.y); }
  for (const f of [0.5, 0.37, 0.63, 0.25, 0.75]) {
    const y = miny + (maxy - miny) * f;
    const xs = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if ((a.y > y) !== (b.y > y)) xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
    }
    xs.sort((m, n) => m - n);
    let best = null, bw = 0;
    for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > bw) { bw = xs[i + 1] - xs[i]; best = (xs[i] + xs[i + 1]) / 2; }
    if (best != null) return { x: best, y };
  }
  return { ...pts[0] };
}

/** Simple uniform-grid spatial hash over bounding boxes. */
export class GridIndex {
  constructor(cell) { this.cell = cell; this.map = new Map(); }
  _key(i, j) { return i * 73856093 ^ j * 19349663; }
  insert(id, minx, miny, maxx, maxy) {
    const c = this.cell;
    for (let i = Math.floor(minx / c); i <= Math.floor(maxx / c); i++)
      for (let j = Math.floor(miny / c); j <= Math.floor(maxy / c); j++) {
        const k = this._key(i, j);
        let arr = this.map.get(k);
        if (!arr) this.map.set(k, (arr = []));
        arr.push(id);
      }
  }
  query(minx, miny, maxx, maxy) {
    const c = this.cell, out = new Set();
    for (let i = Math.floor(minx / c); i <= Math.floor(maxx / c); i++)
      for (let j = Math.floor(miny / c); j <= Math.floor(maxy / c); j++) {
        const arr = this.map.get(this._key(i, j));
        if (arr) for (const id of arr) out.add(id);
      }
    return out;
  }
}
