// ============================================================
// arcs.js — recognise door swings in vector curves.
// A door swing is a quarter (≈60–100°) circular arc centred on the hinge;
// its radius is the door leaf width — a free ruler on every sheet.
// ============================================================

import { sub, dot, cross, dist, norm, perp, lineIntersect } from './vec.js';

/**
 * Fit a circle to a chain of cubic Bézier pieces (one subpath).
 * pieces: [{ p0, p1, p2, p3 }] in feet, consecutive.
 * Returns { c, r, sweepDeg, p0, p3 } or null if it's not a circular arc.
 */
export function arcFromBezier(pieces) {
  if (!pieces.length) return null;
  const first = pieces[0], last = pieces[pieces.length - 1];
  const P0 = first.p0, P3 = last.p3;
  const t0 = norm(sub(first.p1, first.p0));
  const t1 = norm(sub(last.p3, last.p2));
  if (!t0.x && !t0.y) return null;
  if (!t1.x && !t1.y) return null;
  // centre = intersection of the normals at both ends
  const hit = lineIntersect(P0, perp(t0), P3, perp(t1));
  if (!hit) return null;
  const c = hit.pt;
  const r0 = dist(c, P0), r1 = dist(c, P3);
  if (r0 < 1e-6 || Math.abs(r0 - r1) / Math.max(r0, r1) > 0.06) return null;
  const r = (r0 + r1) / 2;
  // every on-curve point must sit on the circle
  for (const pc of pieces) {
    for (const t of [0.25, 0.5, 0.75]) {
      const p = bez(pc, t);
      if (Math.abs(dist(c, p) - r) / r > 0.04) return null;
    }
  }
  const a0 = sub(P0, c), a1 = sub(P3, c);
  let sweep = Math.atan2(cross(a0, a1), dot(a0, a1)) * 180 / Math.PI;
  sweep = Math.abs(sweep);
  return { c, r, sweepDeg: sweep, p0: P0, p3: P3 };
}

function bez(pc, t) {
  const m = 1 - t;
  return {
    x: m * m * m * pc.p0.x + 3 * m * m * t * pc.p1.x + 3 * m * t * t * pc.p2.x + t * t * t * pc.p3.x,
    y: m * m * m * pc.p0.y + 3 * m * m * t * pc.p1.y + 3 * m * t * t * pc.p2.y + t * t * t * pc.p3.y,
  };
}

/** Keep arcs that look like door swings (sweep ~ 60–100°, radius 1'–4'). */
export function isDoorSwing(arc) {
  return arc && arc.sweepDeg >= 55 && arc.sweepDeg <= 100 && arc.r >= 1.2 && arc.r <= 4.2;
}
