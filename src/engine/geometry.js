// ============================================================
// geometry.js — polygon math in canonical feet.
// Rooms are stored as a list of vertices [{x,y}] (feet).
// Rectangles are just 4-vertex polygons; the engine treats all
// rooms as polygons so trace/polygon rooms work the same way.
// ============================================================

export function polygonArea(pts) {
  // shoelace, absolute
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

export function polygonPerimeter(pts) {
  let per = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    per += Math.hypot(q.x - p.x, q.y - p.y);
  }
  return per;
}

export function bounds(pts) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const p of pts) {
    minx = Math.min(minx, p.x); miny = Math.min(miny, p.y);
    maxx = Math.max(maxx, p.x); maxy = Math.max(maxy, p.y);
  }
  return { minx, miny, maxx, maxy, w: maxx - minx, h: maxy - miny };
}

export function centroid(pts) {
  let x = 0, y = 0;
  for (const p of pts) { x += p.x; y += p.y; }
  return { x: x / pts.length, y: y / pts.length };
}

export function pointInPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    const hit = (yi > y) !== (yj > y) &&
      x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

// Clip-test a tile rect (in feet) against a polygon room.
// Returns: 'full' | 'cut' | 'out'. Uses a small inset so tiles whose
// edges sit flush with the room boundary count as inside (full), which
// is what happens with an exact-fit grid.
export function classifyTile(tx, ty, tw, th, poly) {
  const eps = Math.min(tw, th) * 0.02;
  const corners = [
    { x: tx + eps, y: ty + eps }, { x: tx + tw - eps, y: ty + eps },
    { x: tx + tw - eps, y: ty + th - eps }, { x: tx + eps, y: ty + th - eps },
  ];
  const inside = corners.map((c) => pointInPolygon(c.x, c.y, poly));
  const nIn = inside.filter(Boolean).length;
  const centerIn = pointInPolygon(tx + tw / 2, ty + th / 2, poly);
  if (nIn === 4) return 'full';
  if (nIn === 0 && !centerIn) return 'out';
  return 'cut';
}

export const rectPoly = (x, y, w, h) => ([
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
]);

// ---- Sutherland–Hodgman: clip subject polygon by convex-ish room ----
// Returns the clipped polygon (possibly empty). Used to find the EXACT
// portion of a tile that lands inside the room, so we can size the cut.
// Note: SH assumes a convex clip window; for non-convex rooms we clip
// against the room's edges sequentially, which is exact for convex rooms
// and a close approximation for mildly concave ones (good enough for the
// offcut sizing the cut engine needs; the visual fill still clips precisely).
export function clipPolygon(subject, clip) {
  let output = subject.slice();
  const n = clip.length;
  // ensure clip is CCW for consistent inside test
  const area = signedArea(clip);
  const cw = area < 0;
  for (let i = 0; i < n; i++) {
    if (output.length === 0) break;
    const A = clip[i], B = clip[(i + 1) % n];
    const input = output;
    output = [];
    for (let j = 0; j < input.length; j++) {
      const P = input[j], Q = input[(j + 1) % input.length];
      const Pin = inside(P, A, B, cw), Qin = inside(Q, A, B, cw);
      if (Pin && Qin) output.push(Q);
      else if (Pin && !Qin) output.push(intersect(P, Q, A, B));
      else if (!Pin && Qin) { output.push(intersect(P, Q, A, B)); output.push(Q); }
    }
  }
  return output;
}

function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}
function inside(p, a, b, cw) {
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  return cw ? cross <= 1e-9 : cross >= -1e-9;
}
function intersect(p, q, a, b) {
  const a1 = b.y - a.y, b1 = a.x - b.x, c1 = a1 * a.x + b1 * a.y;
  const a2 = q.y - p.y, b2 = p.x - q.x, c2 = a2 * p.x + b2 * p.y;
  const d = a1 * b2 - a2 * b1;
  if (Math.abs(d) < 1e-12) return { ...q };
  return { x: (b2 * c1 - b1 * c2) / d, y: (a1 * c2 - a2 * c1) / d };
}

// Exact area of a tile rect that falls inside the room polygon.
export function clippedTileArea(tx, ty, tw, th, poly) {
  const clipped = clipPolygon(rectPoly(tx, ty, tw, th), poly);
  return clipped.length >= 3 ? polygonArea(clipped) : 0;
}
