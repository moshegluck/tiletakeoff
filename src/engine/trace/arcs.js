// ============================================================
// arcs.js — recognise door swings in vector curves.
// A door swing is a quarter (≈60–100°) circular arc centred on the hinge;
// its radius is the door leaf width — a free ruler on every sheet.
// ============================================================

import { sub, dot, cross, dist, norm, perp, lineIntersect, GridIndex } from './vec.js';

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

/**
 * Read each swing's leaf: a straight edge (or the long side of a leaf drawn
 * as a thin rectangle) from the hinge — the arc's centre — out to one end of
 * the arc. That end is where the door stands open; the other is where it
 * closes, across the doorway (`closed`). A swing with no leaf drawn keeps no
 * `closed` end.
 *
 * Doors drawn part open (a closet door at 45°) have a shorter swing; they are
 * kept only with their leaf — a short arc with no leaf is anything (a curved
 * counter, a tub's corner).
 * @param {{c,r,sweepDeg,p0,p3}[]} arcs  door swings (ft)
 * @param {{c,r,sweepDeg,p0,p3}[]} short  shorter arcs that may be part-open doors (ft)
 * @param {{a:{x,y},b:{x,y}}[]} lines   the sheet's linework (ft)
 */
export function readLeaves(arcs, short, lines) {
  const part = short.filter((a) => a && a.sweepDeg >= 25 && a.sweepDeg < 55 && a.r >= 1.2 && a.r <= 4.2);
  const idx = new GridIndex(2);
  lines.forEach((l, i) => { idx.insert(i, l.a.x, l.a.y, l.a.x, l.a.y); idx.insert(i, l.b.x, l.b.y, l.b.x, l.b.y); });
  // the leaf is the edge as long as the swing's radius (a washer box's side
  // that happens to start at the hinge is shorter or longer)
  const leaf = (arc) => {
    const tol = Math.max(0.25, arc.r * 0.12);
    let best = null, bestD = Infinity;
    for (const i of idx.query(arc.c.x - tol, arc.c.y - tol, arc.c.x + tol, arc.c.y + tol)) {
      const l = lines[i];
      const d = Math.abs(dist(l.a, l.b) - arc.r);
      if (d > 2 * tol || d >= bestD) continue;
      for (const [h, f] of [[l.a, l.b], [l.b, l.a]]) {
        if (dist(h, arc.c) > tol) continue;
        const end = dist(f, arc.p0) <= tol ? 'p0' : dist(f, arc.p3) <= tol ? 'p3' : null;
        if (end) { best = end; bestD = d; break; }
      }
    }
    return best;
  };
  const out = [];
  for (const arc of arcs) {
    const open = leaf(arc);
    out.push(open ? { ...arc, closed: open === 'p0' ? arc.p3 : arc.p0 } : arc);
  }
  for (const arc of part) {
    const open = leaf(arc);
    if (open) out.push({ ...arc, closed: open === 'p0' ? arc.p3 : arc.p0 });
  }
  return out;
}

/**
 * The lines that draw a door's leaf standing open: from the hinge (the
 * swing's centre) out to the end of the swing where the door stands open, as
 * long as the swing's radius — both long sides of a leaf drawn as a thin
 * rectangle. A leaf is never a wall's face: opened flat along a wall, it
 * pairs with the wall into one thick wall that eats a strip of the room.
 * Only swings whose leaf `readLeaves` found (`closed` set) have one, and only
 * a leaf drawn lighter than the sheet's wall pen is told apart from a short
 * return wall it opens against (a sheet in one pen keeps its lines).
 * @param {{c,r,p0,p3,closed?}[]} arcs  door swings (ft)
 * @param {{a:{x,y},b:{x,y},w?:number}[]} lines   linework (ft)
 * @returns {Set<number>} indexes into lines
 */
export function leafLines(arcs, lines) {
  const out = new Set();
  const doors = arcs.filter((a) => a?.closed && a.c && a.p0 && a.p3 && a.r > 0);
  if (!doors.length || !lines.length) return out;
  // the sheet's wall pen: the heaviest drawing a fair share of its linework
  const mass = new Map();
  let total = 0;
  for (const l of lines) { const L = dist(l.a, l.b); total += L; if (l.w > 0) mass.set(l.w, (mass.get(l.w) || 0) + L); }
  const wallPen = Math.max(0, ...[...mass].filter(([, L]) => L >= 0.05 * total).map(([w]) => w));
  if (!(wallPen > 0)) return out;
  const idx = new GridIndex(2);
  lines.forEach((l, i) => { idx.insert(i, l.a.x, l.a.y, l.a.x, l.a.y); idx.insert(i, l.b.x, l.b.y, l.b.x, l.b.y); });
  for (const arc of doors) {
    const tol = Math.max(0.25, arc.r * 0.12);
    const open = dist(arc.closed, arc.p0) < dist(arc.closed, arc.p3) ? arc.p3 : arc.p0;
    for (const i of idx.query(arc.c.x - tol, arc.c.y - tol, arc.c.x + tol, arc.c.y + tol)) {
      const l = lines[i];
      if (out.has(i) || !((l.w || 0) < 0.8 * wallPen) || Math.abs(dist(l.a, l.b) - arc.r) > 2 * tol) continue;
      if ((dist(l.a, arc.c) <= tol && dist(l.b, open) <= tol) || (dist(l.b, arc.c) <= tol && dist(l.a, open) <= tol)) out.add(i);
    }
  }
  return out;
}

/**
 * Door swings drawn as polylines. Many CAD exports flatten a swing into a
 * chain of short straight pieces (8 or 16 to a quarter circle) — no curve on
 * the sheet at all. Chain the short segments that meet end to end and turn
 * the same way a little at each joint, fit the circle through them, and hand
 * back the same arc a Bézier swing gives: { c, r, sweepDeg, p0, p3 }.
 * @param {{a:{x,y},b:{x,y}}[]} lines  in feet
 * @param {{ maxSeg?:number, tol?:number }} [opt]
 */
export function arcsFromPolylines(lines, { maxSeg = 1.2, tol = 0.02 } = {}) {
  /** @type {{ a:{x:number,y:number}, b:{x:number,y:number}, u:number, v:number }[]} */
  const segs = [];
  for (const l of lines) {
    const L = dist(l.a, l.b);
    if (L > 0.03 && L <= maxSeg) segs.push({ a: l.a, b: l.b, u: -1, v: -1 });
  }
  // endpoints → nodes (snapped within tol)
  const nodes = [], cells = new Map();
  const ck = (i, j) => `${i},${j}`;
  const nodeAt = (p) => {
    const i = Math.round(p.x / tol), j = Math.round(p.y / tol);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      for (const id of cells.get(ck(i + di, j + dj)) || []) if (dist(nodes[id].p, p) <= tol) return id;
    }
    const id = nodes.length;
    nodes.push({ p, segs: [] });
    const k = ck(i, j);
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(id);
    return id;
  };
  segs.forEach((s, i) => { s.u = nodeAt(s.a); s.v = nodeAt(s.b); if (s.u !== s.v) { nodes[s.u].segs.push(i); nodes[s.v].segs.push(i); } });

  const used = new Uint8Array(segs.length);
  const other = (s, n) => (s.u === n ? s.v : s.u);
  const dirOf = (from, to) => norm(sub(nodes[to].p, nodes[from].p));
  const out = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i] || segs[i].u === segs[i].v) continue;
    used[i] = 1;
    // grow both ways through nodes joining exactly two short pieces
    let chain = [segs[i].u, segs[i].v];
    let turn = 0;
    const grow = (atEnd) => {
      for (;;) {
        const n = atEnd ? chain[chain.length - 1] : chain[0];
        const prev = atEnd ? chain[chain.length - 2] : chain[1];
        if (nodes[n].segs.length !== 2) return;
        const j = nodes[n].segs.find((x) => !used[x]);
        if (j == null) return;
        const nx = other(segs[j], n);
        const d0 = dirOf(prev, n), d1 = dirOf(n, nx);
        const ang = Math.atan2(cross(d0, d1), dot(d0, d1)) * 180 / Math.PI;
        const sgn = Math.sign(atEnd ? ang : -ang);
        if (Math.abs(ang) < 2 || Math.abs(ang) > 35 || (turn && sgn !== turn)) return;
        turn = sgn;
        used[j] = 1;
        if (atEnd) chain.push(nx); else chain = [nx, ...chain];
      }
    };
    grow(true); grow(false);
    if (chain.length < 4) continue;   // three pieces at least
    const pts = chain.map((n) => nodes[n].p);
    const c = circumcentre(pts[0], pts[Math.floor(pts.length / 2)], pts[pts.length - 1]);
    if (!c) continue;
    const r = dist(c, pts[0]);
    if (pts.some((p) => Math.abs(dist(c, p) - r) / r > 0.04)) continue;
    let sweep = 0;
    for (let k = 1; k < pts.length; k++) {
      const a0 = sub(pts[k - 1], c), a1 = sub(pts[k], c);
      sweep += Math.atan2(cross(a0, a1), dot(a0, a1));
    }
    out.push({ c, r, sweepDeg: Math.abs(sweep) * 180 / Math.PI, p0: pts[0], p3: pts[pts.length - 1], src: 'polyline' });
  }
  return out;
}

function circumcentre(a, b, c) {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
  return { x: (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d, y: (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d };
}
