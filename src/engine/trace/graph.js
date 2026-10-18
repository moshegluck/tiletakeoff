// ============================================================
// graph.js — the coherence engine.
//
// Takes wall bodies (centerline + thickness) and builds a planar
// subdivision: corners are nodes, walls/openings are edges, rooms are
// faces. The model is only trusted where it is geometrically coherent:
//
//   • every wall end must connect (corner, tee, or a door/opening),
//   • the trace may not double back over itself (duplicates merge),
//   • every room must close into a loop (face tracing returns home),
//
// and every place that can't satisfy that becomes a located flag.
// ============================================================

import {
  sub, add, mul, dot, cross, len, dist, norm, perp, lineAngle, angleDiff,
  lineIntersect, segIntersect, closestOnSeg, signedArea, GridIndex,
} from './vec.js';

const IN = 1 / 12;
const DEG = Math.PI / 180;

export const GRAPH_DEFAULTS = {
  snapTol: 1.5 * IN,       // endpoints closer than this are the same corner
  draftGap: 0.75,          // ft — gaps smaller than this are drafting gaps → close as wall
  minOpening: 0.75,        // ft
  maxOpening: 16,          // ft — wider gaps are not bridged
  minJoinAngle: 20 * DEG,
  stubFactor: 0.75,        // overshoot stubs shorter than factor*t(other) are pruned
  minComponentLen: 3,      // ft of total wall length for a detached component to be kept
};

let _id = 0;
const uid = (p) => `${p}${(++_id).toString(36)}`;

// ---------------------------------------------------------------------------
// 1. JOIN — connect wall ends (corners, tees, drafting gaps)
// ---------------------------------------------------------------------------

function endsOf(segs) {
  const ends = [];
  segs.forEach((s, bi) => {
    const d = norm(sub(s.b, s.a));
    ends.push({ bi, w: 0, get p() { return segs[bi].a; }, set p(v) { segs[bi].a = v; }, dir: mul(d, -1), t: s.t, joined: false });
    ends.push({ bi, w: 1, get p() { return segs[bi].b; }, set p(v) { segs[bi].b = v; }, dir: d, t: s.t, joined: false });
  });
  return ends;
}

/** Is point p touching segment s (interior or end) within tol? */
function touches(p, s, tol) { return closestOnSeg(p, s.a, s.b).d <= tol; }

export function joinWalls(inSegs, options = {}, log = []) {
  const opt = { ...GRAPH_DEFAULTS, ...options };
  const segs = inSegs.map((s) => ({ ...s, a: { ...s.a }, b: { ...s.b } }));
  const ends = endsOf(segs);
  const maxT = Math.max(0.5, ...segs.map((s) => s.t));
  const idx = new GridIndex(Math.max(2, maxT * 4));
  segs.forEach((s, i) => idx.insert(i, Math.min(s.a.x, s.b.x) - maxT, Math.min(s.a.y, s.b.y) - maxT, Math.max(s.a.x, s.b.x) + maxT, Math.max(s.a.y, s.b.y) + maxT));
  const near = (p, r) => idx.query(p.x - r, p.y - r, p.x + r, p.y + r);

  // already-connected ends (touching another segment). A scrap shorter than
  // half the wall is thick (the step a layered wall's poche leaves in a
  // corner) doesn't hold an end: it's pruned as a stub later, and the end
  // would be left open — let it find its corner instead.
  for (const e of ends) {
    for (const j of near(e.p, opt.snapTol)) {
      if (j === e.bi || dist(segs[j].a, segs[j].b) < e.t / 2) continue;
      if (touches(e.p, segs[j], opt.snapTol)) { e.joined = true; e.with = j; break; }
    }
  }

  // ---- corners: pairs of free ends whose lines meet just ahead (or slightly behind) ----
  const cornerC = [];
  const byBody = new Map();
  for (const e of ends) { if (!byBody.has(e.bi)) byBody.set(e.bi, []); byBody.get(e.bi).push(e); }
  const endByBody = (bi) => byBody.get(bi) || [];
  for (let i = 0; i < ends.length; i++) {
    const e1 = ends[i]; if (e1.joined) continue;
    const reach = maxT * 1.2 + opt.snapTol;
    for (const bj of near(e1.p, reach)) {
      if (bj === e1.bi) continue;
      for (const e2 of endByBody(bj)) {
        if (e2.joined) continue;
        const a1 = lineAngle(segs[e1.bi].a, segs[e1.bi].b), a2 = lineAngle(segs[bj].a, segs[bj].b);
        if (angleDiff(a1, a2) < opt.minJoinAngle) continue;
        const hit = lineIntersect(e1.p, e1.dir, e2.p, e2.dir);
        if (!hit) continue;
        const r1 = e2.t * opt.stubFactor + opt.snapTol + e1.t * 0.25;
        const r2 = e1.t * opt.stubFactor + opt.snapTol + e2.t * 0.25;
        if (hit.s > r1 || hit.u > r2 || hit.s < -e2.t - opt.snapTol || hit.u < -e1.t - opt.snapTol) continue;
        cornerC.push({ e1, e2, X: hit.pt, cost: Math.abs(hit.s) + Math.abs(hit.u) });
      }
    }
  }
  cornerC.sort((p, q) => p.cost - q.cost);
  for (const c of cornerC) {
    if (c.e1.joined || c.e2.joined) continue;
    const moved = dist(c.e1.p, c.X) + dist(c.e2.p, c.X);
    c.e1.p = { ...c.X }; c.e2.p = { ...c.X };
    c.e1.joined = c.e2.joined = true;
    c.e1.with = c.e2.bi; c.e2.with = c.e1.bi;
    if (moved > opt.snapTol) log.push({ kind: 'corner', at: { ...c.X }, note: `Corner closed (${(moved * 12).toFixed(1)}" extended)` });
  }

  // ---- tees: ray from a free end hits another wall's body ----
  const extra = [];
  for (const e of ends) {
    if (e.joined) continue;
    let best = null;
    for (const j of near(e.p, maxT * 1.5)) {
      if (j === e.bi) continue;
      const s = segs[j];
      const a1 = lineAngle(segs[e.bi].a, segs[e.bi].b), a2 = lineAngle(s.a, s.b);
      if (angleDiff(a1, a2) < opt.minJoinAngle) continue;
      const hit = lineIntersect(e.p, e.dir, s.a, sub(s.b, s.a));
      if (!hit) continue;
      const L = dist(s.a, s.b);
      const along = hit.u * L;
      if (along < -e.t / 2 - opt.snapTol || along > L + e.t / 2 + opt.snapTol) continue;
      // reaches the wall: within its stub reach of the centerline, or stopping
      // short of its face by less than a drafting gap (a missing scrap of an
      // inner wall layer — anything narrower than a door is not a doorway)
      const shortOfFace = hit.s - s.t / 2;
      if ((hit.s > s.t * opt.stubFactor + opt.snapTol && shortOfFace > Math.min(opt.draftGap, opt.minOpening)) || hit.s < -s.t - opt.snapTol) continue;
      if (!best || Math.abs(hit.s) < Math.abs(best.s)) best = { s: hit.s, pt: hit.pt, j, along, L };
    }
    if (best) {
      const moved = Math.abs(best.s);
      e.p = { ...best.pt }; e.joined = true; e.with = best.j;
      // met just past the other wall's end (its corner fills out beyond its
      // centreline end): that wall runs on to the meeting point
      const o = segs[best.j];
      if (best.along < -opt.snapTol) extra.push({ a: { ...best.pt }, b: { ...o.a }, t: o.t, conf: 0.6, kind: 'wall', src: 'repair' });
      else if (best.along > best.L + opt.snapTol) extra.push({ a: { ...o.b }, b: { ...best.pt }, t: o.t, conf: 0.6, kind: 'wall', src: 'repair' });
      if (moved > opt.snapTol) log.push({ kind: 'tee', at: { ...best.pt }, note: `Wall extended ${(moved * 12).toFixed(1)}" to meet crossing wall` });
    }
  }

  // which side of e's wall line the wall w runs off to (its far end)
  const side = (e, w) => {
    const far = dist(w.a, e.p) > dist(w.b, e.p) ? w.a : w.b;
    return Math.sign(cross(e.dir, sub(far, e.p)));
  };
  // ---- an offset crossing: walls meet a wall from each side a few inches
  // apart, so its pieces each turn a corner or tee into a different one —
  // it still runs straight through between them ----
  for (let i = 0; i < ends.length; i++) {
    const e1 = ends[i];
    if (!e1.joined || e1.through) continue;
    for (const bj of near(e1.p, maxT + opt.snapTol)) {
      if (bj === e1.bi) continue;
      for (const e2 of endByBody(bj)) {
        if (!e2.joined || e2.through || e1.through) continue;
        const g = collinearGap(e1, e2);
        if (!g || g.gap <= opt.snapTol || g.gap > Math.max(e1.t, e2.t) + opt.snapTol) continue;
        // past a drafting gap (a thick brick wall's), only between walls that
        // come in from opposite sides — a doorway's jambs don't
        if (g.gap > opt.draftGap && !(e1.with != null && e2.with != null && side(e1, segs[e1.with]) * side(e1, segs[e2.with]) < 0)) continue;
        extra.push({ a: { ...e1.p }, b: { ...e2.p }, t: Math.min(e1.t, e2.t), conf: 0.6, kind: 'wall', src: 'repair' });
        e1.through = e2.through = true;
      }
    }
  }

  // ---- drafting gaps: collinear free ends facing each other, tiny gap ----
  for (let i = 0; i < ends.length; i++) {
    const e1 = ends[i]; if (e1.joined) continue;
    for (const bj of near(e1.p, opt.draftGap + maxT)) {
      if (bj === e1.bi) continue;
      for (const e2 of endByBody(bj)) {
        if (e2.joined || e1.joined) continue;
        const g = collinearGap(e1, e2);
        if (!g || g.gap > opt.draftGap) continue;
        extra.push({ a: { ...e1.p }, b: { ...e2.p }, t: (e1.t + e2.t) / 2, conf: 0.6, kind: 'wall', src: 'repair' });
        e1.joined = e2.joined = true;
        log.push({ kind: 'gap', at: { x: (e1.p.x + e2.p.x) / 2, y: (e1.p.y + e2.p.y) / 2 }, note: `Drafting gap closed (${(g.gap * 12).toFixed(1)}")` });
      }
    }
  }
  // ---- steps: a wall that changes thickness (a recess, a thickened stretch,
  // a furring layer that stops) — two ends meeting head-on, side by side
  // within their thicknesses: the face steps there, it doesn't open ----
  for (let i = 0; i < ends.length; i++) {
    const e1 = ends[i]; if (e1.joined) continue;
    for (const bj of near(e1.p, maxT + opt.snapTol)) {
      if (bj === e1.bi) continue;
      for (const e2 of endByBody(bj)) {
        if (e2.joined || e1.joined) continue;
        if (dot(e1.dir, e2.dir) > -0.985) continue;
        const v = sub(e2.p, e1.p);
        const gap = dot(v, e1.dir), lateral = Math.abs(cross(e1.dir, v));
        if (gap > opt.draftGap || gap < -Math.max(e1.t, e2.t) || lateral > (e1.t + e2.t) / 2 || lateral < 1e-6) continue;
        extra.push({ a: { ...e1.p }, b: { ...e2.p }, t: Math.min(e1.t, e2.t), conf: 0.6, kind: 'wall', src: 'repair' });
        e1.joined = e2.joined = true;
        log.push({ kind: 'gap', at: { x: (e1.p.x + e2.p.x) / 2, y: (e1.p.y + e2.p.y) / 2 }, note: `Wall thickness changes here (${(lateral * 12).toFixed(1)}" step)` });
      }
    }
  }
  return { segs: segs.concat(extra), ends, extra };
}

/**
 * Before any door is bridged, drop wall pieces that never connected to
 * anything substantial (sink bowls, fixtures, columns, text strokes). A
 * real wall network is one big connected skeleton; furniture isn't.
 */
export function dropDetached(segs, ends, options = {}, log = []) {
  const opt = { ...GRAPH_DEFAULTS, ...options };
  const n = segs.length;
  const parent = segs.map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const tol = opt.snapTol * 1.5;
  const gi = new GridIndex(4);
  segs.forEach((sg, i) => gi.insert(i, Math.min(sg.a.x, sg.b.x) - tol, Math.min(sg.a.y, sg.b.y) - tol, Math.max(sg.a.x, sg.b.x) + tol, Math.max(sg.a.y, sg.b.y) + tol));
  for (let i = 0; i < n; i++) {
    const si = segs[i];
    for (const j of gi.query(Math.min(si.a.x, si.b.x) - tol, Math.min(si.a.y, si.b.y) - tol, Math.max(si.a.x, si.b.x) + tol, Math.max(si.a.y, si.b.y) + tol)) {
      if (j <= i) continue;
      const a = segs[i], b = segs[j];
      if (touches(a.a, b, tol) || touches(a.b, b, tol) || touches(b.a, a, tol) || touches(b.b, a, tol) || segIntersect(a.a, a.b, b.a, b.b)) {
        const x = find(i), y = find(j); if (x !== y) parent[x] = y;
      }
    }
  }
  const total = new Map();
  segs.forEach((s, i) => { const r = find(i); total.set(r, (total.get(r) || 0) + dist(s.a, s.b)); });
  const biggest = Math.max(0, ...total.values());
  const keep = segs.map((_, i) => {
    const t = total.get(find(i));
    return t >= opt.minComponentLen || t === biggest;
  });
  const dropped = keep.filter((k) => !k).length;
  if (dropped) log.push({ kind: 'scrap', at: null, note: `${dropped} detached piece(s) ignored (fixtures, columns, symbols)` });
  const remap = new Map();
  const out = [];
  segs.forEach((s, i) => { if (keep[i]) { remap.set(i, out.length); out.push(s); } });
  const outEnds = ends.filter((e) => keep[e.bi]).map((e) => {
    const bi = remap.get(e.bi);
    return { ...e, bi, w: e.w, get p() { return out[bi][e.w ? 'b' : 'a']; }, joined: e.joined };
  });
  return { segs: out, ends: outEnds, dropped: segs.filter((_, i) => !keep[i]) };
}

function collinearGap(e1, e2) {
  if (dot(e1.dir, e2.dir) > -0.985) return null; // must face each other
  const v = sub(e2.p, e1.p);
  const gap = dot(v, e1.dir);
  if (gap <= 0) return null;
  const lateral = Math.abs(cross(e1.dir, v));
  if (lateral > Math.max(e1.t, e2.t) * 0.6) return null;
  return { gap, lateral };
}

// ---------------------------------------------------------------------------
// 2. OPENINGS — bridge door / cased openings so rooms can close
// ---------------------------------------------------------------------------

/**
 * How much of the gap a→b has door / window drawing across it (0..1): the
 * share of its length that linework from the sheet's door and window layers
 * (bifold leaves, slider panels, window sashes, swing arcs) covers, within
 * `reach` of the gap line.
 */
function hintCoverage(a, b, hints, hintIdx, reach) {
  const W = dist(a, b);
  if (!hints.length || W < 1e-6) return 0;
  const u = norm(sub(b, a)), n = perp(u);
  const ivs = [];
  const q = hintIdx.query(Math.min(a.x, b.x) - reach, Math.min(a.y, b.y) - reach, Math.max(a.x, b.x) + reach, Math.max(a.y, b.y) + reach);
  for (const i of q) {
    const h = hints[i];
    const s0 = dot(sub(h.a, a), u), s1 = dot(sub(h.b, a), u);
    const d0 = dot(sub(h.a, a), n), d1 = dot(sub(h.b, a), n);
    // the part of the hint inside the band |d| <= reach
    let t0 = 0, t1 = 1;
    if (Math.abs(d1 - d0) < 1e-9) { if (Math.abs(d0) > reach) continue; }
    else {
      const ta = (-reach - d0) / (d1 - d0), tb = (reach - d0) / (d1 - d0);
      t0 = Math.max(0, Math.min(ta, tb)); t1 = Math.min(1, Math.max(ta, tb));
      if (t1 <= t0) continue;
    }
    const lo = Math.max(0, Math.min(s0 + (s1 - s0) * t0, s0 + (s1 - s0) * t1));
    const hi = Math.min(W, Math.max(s0 + (s1 - s0) * t0, s0 + (s1 - s0) * t1));
    if (hi > lo) ivs.push([lo, hi]);
  }
  ivs.sort((p, q2) => p[0] - q2[0]);
  let cov = 0, end = -Infinity;
  for (const [lo, hi] of ivs) {
    if (hi <= end) continue;
    cov += hi - Math.max(lo, end);
    end = hi;
  }
  return cov / W;
}

/**
 * @param {object[]} segs  wall segments
 * @param {object[]} ends  wall ends
 * @param {object[]} [arcs]  door swings
 * @param {object} [options]
 * @param {object[]} [log]
 * @param {{a,b,kind?:string}[]} [hints]  linework from the sheet's door / window layers (ft):
 *   evidence that a gap is a doorway / window. With it, a gap can close across
 *   two wall ends that aren't in line (a closet front between two partitions)
 *   or from a wall end sideways to another wall, and one wall end can carry a
 *   door on each side.
 */
export function bridgeOpenings(segs, ends, arcs = [], options = {}, log = [], hints = [], drawn = []) {
  const opt = { ...GRAPH_DEFAULTS, ...options };
  // ends left open on purpose (an alcove's mouth: runTrace's second pass)
  const keepOpen = opt.keepOpen || [];
  const held = (e) => keepOpen.some((p) => dist(p, e.p) < 0.1);
  const free = ends.filter((e) => !e.joined && !held(e));
  const hintIdx = new GridIndex(4);
  hints.forEach((h, i) => hintIdx.insert(i, Math.min(h.a.x, h.b.x), Math.min(h.a.y, h.b.y), Math.max(h.a.x, h.b.x), Math.max(h.a.y, h.b.y)));
  const reachOf = (t) => Math.max(1.25, (t || 0) / 2 + 0.75);
  const hinted = (a, b, t) => hints.length > 0 && hintCoverage(a, b, hints, hintIdx, reachOf(t)) >= 0.6;
  // a window, not a doorway: drawn on a window layer, and nothing on a door
  // (or door-and-window) layer across it. It closes the room; it is no
  // break in the wall at the floor (wall LF runs under it).
  const windowIdx = new GridIndex(4), doorIdx = new GridIndex(4);
  const winHints = hints.filter((h) => h.kind === 'window'), doorHints = hints.filter((h) => h.kind && h.kind !== 'window');
  winHints.forEach((h, i) => windowIdx.insert(i, Math.min(h.a.x, h.b.x), Math.min(h.a.y, h.b.y), Math.max(h.a.x, h.b.x), Math.max(h.a.y, h.b.y)));
  doorHints.forEach((h, i) => doorIdx.insert(i, Math.min(h.a.x, h.b.x), Math.min(h.a.y, h.b.y), Math.max(h.a.x, h.b.x), Math.max(h.a.y, h.b.y)));
  // …or, on a sheet without layers, the window symbol itself: two or more
  // lines running across the gap inside the wall's thickness (frame, glass,
  // sill). A doorway has nothing drawn along it there.
  const drawnIdx = new GridIndex(4);
  drawn.forEach((l, i) => drawnIdx.insert(i, Math.min(l.a.x, l.b.x), Math.min(l.a.y, l.b.y), Math.max(l.a.x, l.b.x), Math.max(l.a.y, l.b.y)));
  const glazed = (c) => {
    const [p, q] = c.jambs;
    const W = dist(p, q);
    if (!drawn.length || W < 1e-6) return false;
    const u = norm(sub(q, p)), n = perp(u), band = (c.t || 0.4) / 2 + 1 / 12;
    const offs = [];
    for (const i of drawnIdx.query(Math.min(p.x, q.x) - band, Math.min(p.y, q.y) - band, Math.max(p.x, q.x) + band, Math.max(p.y, q.y) + band)) {
      const l = drawn[i];
      const L = dist(l.a, l.b);
      if (L < 1e-6 || Math.abs(dot(norm(sub(l.b, l.a)), u)) < Math.cos(3 * DEG)) continue;
      const o = (dot(sub(l.a, p), n) + dot(sub(l.b, p), n)) / 2;
      if (Math.abs(o) > band) continue;
      const s0 = Math.min(dot(sub(l.a, p), u), dot(sub(l.b, p), u)), s1 = Math.max(dot(sub(l.a, p), u), dot(sub(l.b, p), u));
      // it spans most of the gap and doesn't run on far past it (that's a wall face beside it)
      if (Math.min(W, s1) - Math.max(0, s0) < 0.6 * W || s1 - s0 > W + 1.5) continue;
      if (!offs.some((x) => Math.abs(x - o) < 0.5 / 12)) offs.push(o);
    }
    return offs.length >= 2;
  };
  const isWindow = (c) => !c.arcs.length && ((winHints.length > 0
    && hintCoverage(c.jambs[0], c.jambs[1], winHints, windowIdx, reachOf(c.t)) >= 0.6
    && hintCoverage(c.jambs[0], c.jambs[1], doorHints, doorIdx, reachOf(c.t)) < 0.3)
    || (!winHints.length && !doorHints.length && glazed(c)));
  /** @type {any[]} */
  const cands = [];
  const segIdx = new GridIndex(4);
  segs.forEach((sg, i) => segIdx.insert(i, Math.min(sg.a.x, sg.b.x), Math.min(sg.a.y, sg.b.y), Math.max(sg.a.x, sg.b.x), Math.max(sg.a.y, sg.b.y)));
  const segsNear = (a, b) => segIdx.query(Math.min(a.x, b.x) - 0.1, Math.min(a.y, b.y) - 0.1, Math.max(a.x, b.x) + 0.1, Math.max(a.y, b.y) + 0.1);
  const blocked = (a, b, ignore) => {
    for (const i of segsNear(a, b)) {
      if (ignore.includes(i)) continue;
      const sg = segs[i];
      const h = segIntersect(a, b, sg.a, sg.b);
      // touching at the very ends is fine
      if (h && h.t > 0.02 && h.t < 0.98) return true;
    }
    return false;
  };
  const endIdx = new GridIndex(Math.max(4, opt.maxOpening / 2));
  free.forEach((e, i) => endIdx.insert(i, e.p.x, e.p.y, e.p.x, e.p.y));
  // wall ends that already turn a corner (a closet's side wall meeting its front)
  // (only a plain L: the end of a tee's stem looks across the wall it meets)
  const plainL = (e) => {
    let n = 0;
    for (const j of segsNear(e.p, e.p)) {
      if (j === e.bi) continue;
      const sg = segs[j];
      const c = closestOnSeg(e.p, sg.a, sg.b);
      if (c.d > Math.max(e.t, sg.t, 0.3)) continue;
      const L = dist(sg.a, sg.b);
      if (c.t * L > sg.t && (1 - c.t) * L > sg.t) return false;   // runs on past it: a tee
      const v = norm(sub(sg.b, sg.a));
      if (Math.abs(dot(v, e.dir)) > Math.cos(45 * DEG)) {
        // the same wall carrying on behind the end (a scrap of it before the
        // corner) is no reason it isn't a plain L
        const mid = { x: (sg.a.x + sg.b.x) / 2, y: (sg.a.y + sg.b.y) / 2 };
        if (dot(sub(mid, e.p), e.dir) < 0 && Math.abs(cross(e.dir, sub(mid, e.p))) < Math.max(e.t, sg.t)) continue;
        return false;
      }
      n++;
    }
    return n === 1;
  };
  const corners = ends.filter((e) => e.joined && plainL(e) && !held(e));
  const isCorner = new Set(corners);
  const joinedEnd = new Set(ends.filter((e) => e.joined).map((e) => `${e.bi}:${e.w}`));

  // door / window drawing across the gap, or a matching swing
  const evidenced = (c) => { c.arcs = matchArcs(c, arcs); c.hint = hinted(c.jambs[0], c.jambs[1], c.t); return c.hint || c.arcs.length > 0; };
  // a doorway spans one gap: it never runs past another wall end (two closet
  // fronts side by side are two openings, each between its own jambs)
  const passesJamb = (a, b, skip) => {
    const L = dist(a, b);
    for (const k of endIdx.query(Math.min(a.x, b.x) - 0.6, Math.min(a.y, b.y) - 0.6, Math.max(a.x, b.x) + 0.6, Math.max(a.y, b.y) + 0.6)) {
      const f = free[k];
      if (skip.includes(f)) continue;
      const c = closestOnSeg(f.p, a, b);
      if (c.d <= Math.max(0.5, f.t) && c.t * L > 0.5 && (1 - c.t) * L > 0.5) return true;
    }
    return false;
  };
  // ...and its span is clear: no wall runs alongside it inside the gap (the
  // side wall of the closet next door is not part of this closet's front)
  const alongside = (a, b, skip) => {
    const L = dist(a, b), band = 1.0;
    if (L < 1e-6) return false;
    const u = norm(sub(b, a)), n = perp(u);
    let run = 0;
    for (const i of segIdx.query(Math.min(a.x, b.x) - band, Math.min(a.y, b.y) - band, Math.max(a.x, b.x) + band, Math.max(a.y, b.y) + band)) {
      if (skip.includes(i)) continue;
      const sg = segs[i];
      const sl = dist(sg.a, sg.b);
      if (sl < 1e-6 || Math.abs(dot(u, sub(sg.b, sg.a))) / sl < Math.cos(30 * DEG)) continue;
      const d0 = dot(sub(sg.a, a), n), d1 = dot(sub(sg.b, a), n);
      if (Math.abs(d0) > band || Math.abs(d1) > band) continue;
      const s0 = dot(sub(sg.a, a), u), s1 = dot(sub(sg.b, a), u);
      run += Math.max(0, Math.min(L, Math.max(s0, s1)) - Math.max(0, Math.min(s0, s1)));
    }
    return run > Math.min(0.75, 0.25 * L);
  };

  // (a) collinear: two free ends facing each other across a gap
  for (let i = 0; i < free.length; i++) {
    const p = free[i].p, R = opt.maxOpening;
    for (const k of endIdx.query(p.x - R, p.y - R, p.x + R, p.y + R)) {
      if (k <= i) continue;
      const e1 = free[i], e2 = free[k];
      if (e1.bi === e2.bi) continue;
      const g = collinearGap(e1, e2);
      if (!g || g.gap < opt.minOpening || g.gap > opt.maxOpening) continue;
      if (blocked(e1.p, e2.p, [e1.bi, e2.bi])) continue;
      cands.push({ type: 'collinear', e1, e2, a: e1.p, b: e2.p, width: g.gap, t: (e1.t + e2.t) / 2, jambs: [e1.p, e2.p] });
    }
  }
  // ...or where the wall turns a corner at one or both jambs (a closet whose
  // side walls meet its front): only with a door drawn there, since two
  // corners face each other across every hallway too
  if (hints.length || arcs.length) {
    const cornerIdx = new GridIndex(Math.max(4, opt.maxOpening / 2));
    corners.forEach((e, i) => cornerIdx.insert(i, e.p.x, e.p.y, e.p.x, e.p.y));
    const R = opt.maxOpening;
    const tryPair = (e1, e2) => {
      if (e1.bi === e2.bi) return;
      const g = collinearGap(e1, e2);
      if (!g) return;
      const jamb = (e) => (isCorner.has(e) ? add(e.p, mul(e.dir, e.t / 2)) : e.p);
      const width = g.gap - (isCorner.has(e1) ? e1.t / 2 : 0) - (isCorner.has(e2) ? e2.t / 2 : 0);
      if (width < opt.minOpening || width > opt.maxOpening) return;
      const c = { type: 'collinear', e1, e2, a: e1.p, b: e2.p, width, t: (e1.t + e2.t) / 2, jambs: [jamb(e1), jamb(e2)] };
      if (blocked(e1.p, e2.p, [e1.bi, e2.bi]) || !evidenced(c) || passesJamb(e1.p, e2.p, [e1, e2])) return;
      cands.push(c);
    };
    corners.forEach((e1, i) => {
      const p = e1.p;
      for (const k of cornerIdx.query(p.x - R, p.y - R, p.x + R, p.y + R)) if (k > i) tryPair(e1, corners[k]);
      for (const k of endIdx.query(p.x - R, p.y - R, p.x + R, p.y + R)) tryPair(free[k], e1);
    });
  }
  // (b) end → perpendicular wall (door beside a corner, opening onto a hall);
  //     from a corner only with a door drawn there (a closet front running on
  //     from the wall that turns)
  for (const e of hints.length || arcs.length ? free.concat(corners) : free) {
    const fromCorner = isCorner.has(e);
    let best = null, grazedBest = null;
    const far = { x: e.p.x + e.dir.x * (opt.maxOpening + 2), y: e.p.y + e.dir.y * (opt.maxOpening + 2) };
    for (const j of segsNear(e.p, far)) {
      const s = segs[j];
      if (j === e.bi) continue;
      if (angleDiff(lineAngle(segs[e.bi].a, segs[e.bi].b), lineAngle(s.a, s.b)) < 30 * DEG) continue;
      const hit = lineIntersect(e.p, e.dir, s.a, sub(s.b, s.a));
      if (!hit) continue;
      // just past the wall's end (its corner fills out beyond its centreline
      // end: a door's far jamb whose return is too short to read as a wall) —
      // taken only with a door swing to say so
      const sl = Math.max(0.3, s.t) / Math.max(dist(s.a, s.b), 1e-6);
      if (hit.u < -sl || hit.u > 1 + sl) continue;
      const grazed = hit.u < -0.001 || hit.u > 1.001;
      if (grazed && !arcs.length) continue;
      if (grazed) hit.pt = hit.u < 0 ? { ...s.a } : { ...s.b };
      if (fromCorner && hit.s < e.t) continue;                    // the wall it turns into
      const width = hit.s - s.t / 2 - (fromCorner ? e.t / 2 : 0);
      if (width < opt.minOpening || width > (fromCorner ? Math.min(opt.maxOpening, 10) : opt.maxOpening)) continue;
      if (grazed) { if (!grazedBest || hit.s < grazedBest.s) grazedBest = { s: hit.s, pt: hit.pt, j, width, t: s.t, grazed }; continue; }
      if (!best || hit.s < best.s) best = { s: hit.s, pt: hit.pt, j, width, t: s.t, grazed };
    }
    // a wall end the ray just grazes counts only when it's clearly nearer
    // than any wall it meets — and only with a swing; else the wall it meets
    const tries = grazedBest && (!best || grazedBest.s < best.s - 0.5) ? [grazedBest, best] : [best];
    for (const hit of tries) {
      if (!hit) continue;
      if (blocked(e.p, hit.pt, [e.bi, hit.j]) || passesJamb(e.p, hit.pt, [e])) continue;
      const jamb2 = sub(hit.pt, mul(e.dir, hit.t / 2));
      const c = { type: 'ray', e1: e, a: e.p, b: hit.pt, width: hit.width, t: e.t, jambs: [fromCorner ? add(e.p, mul(e.dir, e.t / 2)) : e.p, jamb2], hitBody: hit.j };
      if ((fromCorner || hit.grazed) && (!evidenced(c) || alongside(e.p, hit.pt, [e.bi, hit.j]))) continue;
      // landing on the other wall's free end: that end is this door's jamb too
      if (hit.grazed) { const e2 = free.find((f) => f.bi === hit.j && dist(f.p, hit.pt) < 0.05); if (e2) c.e2 = e2; }
      cands.push(c);
      break;
    }
  }

  // (c) across, with door / window drawing or a door swing as evidence: two
  //     wall ends not in line (a closet front between two partitions, a door
  //     between two wall stubs), or a wall end sideways to another wall
  const maxAcross = Math.min(opt.maxOpening, 10);   // bifolds, sliders, cased openings
  if (hints.length || arcs.length) {
    for (let i = 0; i < free.length; i++) {
      const e1 = free[i], p = e1.p, R = opt.maxOpening;
      for (const k of endIdx.query(p.x - R, p.y - R, p.x + R, p.y + R)) {
        if (k === i) continue;
        const e2 = free[k];
        if (k < i || e1.bi === e2.bi) continue;
        const w = dist(e1.p, e2.p);
        if (w < opt.minOpening || w > maxAcross) continue;
        if (collinearGap(e1, e2)) continue;                    // (a) has it
        // a doorway runs square to its walls: across, not on a slant
        const across = norm(sub(e2.p, e1.p));
        const square = (e) => Math.abs(dot(across, e.dir)) < Math.sin(15 * DEG) || Math.abs(dot(across, e.dir)) > Math.cos(15 * DEG);
        if (!square(e1) || !square(e2)) continue;
        const t = (e1.t + e2.t) / 2;
        // between two parallel wall ends the doorway is the clear gap between their faces
        const perpTo = (e) => Math.abs(dot(across, e.dir)) < Math.sin(15 * DEG);
        const clear = perpTo(e1) && perpTo(e2) ? w - t : w;
        if (clear < opt.minOpening) continue;
        const jambs = perpTo(e1) && perpTo(e2)
          ? [add(e1.p, mul(across, e1.t / 2)), sub(e2.p, mul(across, e2.t / 2))]
          : [e1.p, e2.p];
        // off square (one end set back from the other) costs its offset
        const skew = (e) => { const d = Math.abs(dot(across, e.dir)); return Math.min(d, Math.sqrt(Math.max(0, 1 - d * d))); };
        const c = { type: 'across', e1, e2, a: e1.p, b: e2.p, width: clear, t, jambs, skew: w * Math.max(skew(e1), skew(e2)) };
        if (!evidenced(c) || blocked(e1.p, e2.p, [e1.bi, e2.bi]) || passesJamb(e1.p, e2.p, [e1, e2]) || alongside(e1.p, e2.p, [e1.bi, e2.bi])) continue;
        cands.push(c);
      }
      for (const side of [1, -1]) {
        const dir = mul(perp(e1.dir), side);
        const far = { x: p.x + dir.x * (R + 2), y: p.y + dir.y * (R + 2) };
        let best = null;
        for (const j of segsNear(p, far)) {
          const s = segs[j];
          if (j === e1.bi) continue;
          const hit = lineIntersect(p, dir, s.a, sub(s.b, s.a));
          if (!hit || hit.s <= 0) continue;
          // a wall's corner fills out past its centreline end: a door can
          // run up to the face of a corner the ray just grazes
          const len = dist(s.a, s.b), slack = Math.max(0.5, s.t) / Math.max(len, 1e-6);
          if (hit.u < -0.001 && !(hit.u >= -slack && joinedEnd.has(`${j}:0`))) continue;
          if (hit.u > 1.001 && !(hit.u <= 1 + slack && joinedEnd.has(`${j}:1`))) continue;
          const pt = hit.u < 0 ? { ...s.a } : hit.u > 1 ? { ...s.b } : hit.pt;
          // clear width: from this wall's side face to the other wall's face
          const width = hit.s - s.t / 2 - e1.t / 2;
          if (width < opt.minOpening || width > maxAcross) continue;
          if (!best || hit.s < best.s) best = { s: hit.s, pt, j, width, t: s.t };
        }
        if (!best) continue;
        const stop = add(p, mul(dir, best.s - best.t / 2));
        const c = { type: 'side', e1, a: p, b: best.pt, width: best.width, t: e1.t, jambs: [add(p, mul(dir, e1.t / 2)), stop], hitBody: best.j };
        // landing on the other wall's own free end: that end is this door's jamb too
        const e2 = free.find((f) => f.bi === best.j && dist(f.p, best.pt) <= Math.max(segs[best.j].t, 0.5));
        if (!evidenced(c) || blocked(p, best.pt, [e1.bi, best.j]) || passesJamb(p, best.pt, [e1, e2].filter(Boolean)) || alongside(p, best.pt, [e1.bi, best.j])) continue;
        if (e2) c.e2 = e2;
        cands.push(c);
      }
    }
  }

  // door-swing evidence makes a candidate much more trustworthy; door / window
  // drawing across the gap nearly as much
  for (const c of cands) {
    if (c.hint === undefined) { c.arcs = matchArcs(c, arcs); c.hint = hinted(c.jambs[0], c.jambs[1], c.t); }
    c.cost = c.width - (c.arcs.length ? 100 : 0) - (c.hint ? 60 : 0) + (c.type === 'ray' || c.type === 'side' ? 0.5 : 0) + (c.skew || 0);
  }
  cands.sort((p, q) => p.cost - q.cost);
  if (Array.isArray(opt._debugCands)) opt._debugCands.push(...cands);

  // An end takes one opening — or, with door drawing / a swing as evidence,
  // one per direction (the end of a partition between two closets is a jamb
  // of both).
  const dirFrom = (e, c) => norm(sub(e === c.e1 ? c.b : c.a, e.p));
  const clash = (e, c) => {
    if (!e.joined) return false;
    if (!(c.hint || c.arcs.length)) return true;
    if (!e.used) return !isCorner.has(e);       // a corner end can still be a door's jamb
    return e.used.some((d) => dot(d, dirFrom(e, c)) > Math.cos(45 * DEG));
  };
  const openings = [];
  const usedArcs = new Set();   // each swing is one door
  // an inferred opening never crosses one already placed: a gap bridged across
  // another doorway's line (a ray from a counter's end through the closet
  // door beside it) is no gap. A door with its own swing or drawing stands.
  const crossesTaken = (c) => openings.some((o) => {
    const h = segIntersect(c.a, c.b, o.a, o.b);
    return h && h.t > 0.02 && h.t < 0.98 && h.u > 0.02 && h.u < 0.98;
  });
  for (const c of cands) {
    if (!c.hint && !c.arcs.length && crossesTaken(c)) continue;
    if (c.arcs.some((a) => usedArcs.has(a))) {
      c.arcs = c.arcs.filter((a) => !usedArcs.has(a));
      if (c.arcs.length === 1 && Math.abs(c.arcs[0].r - c.width) / c.width >= 0.25) c.arcs = [];
    }
    if (clash(c.e1, c) || (c.e2 && clash(c.e2, c))) continue;
    for (const a of c.arcs) usedArcs.add(a);
    for (const e of [c.e1, c.e2]) {
      if (!e) continue;
      e.joined = true;
      (e.used ||= []).push(dirFrom(e, c));
    }
    const nArc = c.arcs.length;
    const kind = nArc >= 2 ? 'double_door' : nArc === 1 ? 'door' : isWindow(c) ? 'window' : 'opening';
    let width = c.width;
    if (nArc === 1) width = refineWidth(c.width, c.arcs[0].r);
    openings.push({
      id: uid('o'), a: { ...c.a }, b: { ...c.b }, t: c.t, kind: 'opening', openingType: kind,
      width, arcs: c.arcs, conf: nArc ? 0.95 : (c.width <= 4 ? 0.7 : 0.5), via: c.type, hint: !!c.hint,
      jambs: c.jambs.map((p) => ({ ...p })),
    });
  }
  for (const o of openings) {
    const what = o.openingType === 'opening' ? 'Opening' : o.openingType === 'window' ? 'Window' : 'Door';
    log.push({ kind: 'opening', at: { x: (o.a.x + o.b.x) / 2, y: (o.a.y + o.b.y) / 2 }, note: `${what} bridged (${fmtIn(o.width)})` });
  }
  return openings;
}

function refineWidth(gap, r) {
  // the swing radius IS the leaf width; trust it when it agrees with the gap
  return Math.abs(r - gap) / gap < 0.2 ? r : gap;
}

/**
 * A door drawn part open whose jambs are short returns, too small to read as
 * walls: the gap the trace sees runs on to the wall faces beyond, wider than
 * the leaf. The swing still marks it when it hinges at one jamb and closes
 * (`arc.closed`: the end away from its drawn leaf) on the doorway line,
 * across most of it.
 */
function closesAcross(c, arc) {
  if (!arc.closed) return false;
  const [A, B] = dist(c.jambs[0], arc.c) <= dist(c.jambs[1], arc.c) ? c.jambs : [c.jambs[1], c.jambs[0]];
  const W = dist(A, B);
  if (W < 1e-6) return false;
  const u = norm(sub(B, A)), v = sub(arc.closed, A), s = dot(v, u);
  return Math.abs(cross(u, v)) <= (c.t || 0) / 2 + 0.3 && s >= 0.55 * W && s <= W + 0.3;
}

/** A swing whose drawn leaf says where it closes closes on this doorway's line. */
function closesOnLine(c, arc) {
  if (!arc.closed) return true;
  const [A, B] = c.jambs;
  const W = dist(A, B);
  if (W < 1e-6) return true;
  const u = norm(sub(B, A)), v = sub(arc.closed, A), s = dot(v, u);
  return Math.abs(cross(u, v)) <= (c.t || 0) / 2 + 0.3 && s >= -0.3 && s <= W + 0.3;
}

function matchArcs(c, arcs) {
  if (!arcs.length) return [];
  const out = [];
  for (const arc of arcs) {
    const tol = Math.max(0.6, c.t + 0.35);
    const nearJamb = c.jambs.some((j) => dist(j, arc.c) <= tol);
    if (!nearJamb || !closesOnLine(c, arc)) continue;
    // a swing drawn a size off its frame (2'-6" leaf in a 3'-2" rough gap) still marks the door
    const single = Math.abs(arc.r - c.width) / c.width < 0.25 || closesAcross(c, arc);
    const dbl = Math.abs(arc.r * 2 - c.width) / c.width < 0.25;
    if (single || dbl) out.push(arc);
  }
  // a single leaf whose radius = full width beats two half-width matches; a
  // double door needs both its leaves — one half-width swing alone is no door
  const full = out.filter((a) => Math.abs(a.r - c.width) / c.width < 0.25 || closesAcross(c, a));
  if (full.length) return full.slice(0, 1);
  return out.length >= 2 ? out.slice(0, 2) : [];
}

export const fmtIn = (ft) => {
  const tot = Math.round(ft * 12);
  const f = Math.floor(tot / 12), i = tot % 12;
  return `${f}'-${i}"`;
};

// ---------------------------------------------------------------------------
// 3. PLANAR GRAPH — split at intersections, merge corners, dedupe
// ---------------------------------------------------------------------------

export function buildGraph(segs, options = {}, log = []) {
  const opt = { ...GRAPH_DEFAULTS, ...options };
  const S = segs.filter((s) => dist(s.a, s.b) > opt.snapTol * 0.5);
  const maxT = Math.max(0.5, ...S.map((s) => s.t || 0));
  const idx = new GridIndex(Math.max(2, maxT * 4));
  S.forEach((s, i) => idx.insert(i, Math.min(s.a.x, s.b.x) - opt.snapTol, Math.min(s.a.y, s.b.y) - opt.snapTol, Math.max(s.a.x, s.b.x) + opt.snapTol, Math.max(s.a.y, s.b.y) + opt.snapTol));

  // split parameters per segment
  const cuts = S.map(() => [0, 1]);
  // an end that stops on another wall right by that wall's own end — too near
  // it to split the wall there, a little past the snap distance from it — is
  // that corner (a short scrap of a wall leaves it hanging otherwise)
  const snapTo = new Map();
  for (let i = 0; i < S.length; i++) {
    const s = S[i];
    const cand = idx.query(Math.min(s.a.x, s.b.x) - opt.snapTol, Math.min(s.a.y, s.b.y) - opt.snapTol, Math.max(s.a.x, s.b.x) + opt.snapTol, Math.max(s.a.y, s.b.y) + opt.snapTol);
    const L = dist(s.a, s.b);
    for (const j of cand) {
      if (j === i) continue;
      const o = S[j];
      // other's endpoints lying on this segment (tees)
      for (const [w, p] of [['a', o.a], ['b', o.b]]) {
        const c = closestOnSeg(p, s.a, s.b);
        if (c.d > opt.snapTol) continue;
        if (c.t * L > opt.snapTol && (1 - c.t) * L > opt.snapTol) { cuts[i].push(c.t); continue; }
        const E = c.t < 0.5 ? s.a : s.b, d = dist(p, E);
        if (d > opt.snapTol && d <= 2 * opt.snapTol) snapTo.set(`${j}:${w}`, E);
      }
      // proper crossings
      if (j > i) {
        const h = segIntersect(s.a, s.b, o.a, o.b);
        if (h && h.t * L > opt.snapTol && (1 - h.t) * L > opt.snapTol) {
          const Lo = dist(o.a, o.b);
          cuts[i].push(h.t);
          if (h.u * Lo > opt.snapTol && (1 - h.u) * Lo > opt.snapTol) cuts[j].push(h.u);
        }
      }
    }
  }

  // nodes via clustering
  const pts = [];
  const pieces = [];
  S.forEach((s, i) => {
    const ts = [...new Set(cuts[i].map((t) => +t.toFixed(9)))].sort((a, b) => a - b);
    const at = (t) => (t === 0 && snapTo.get(`${i}:a`)) || (t === 1 && snapTo.get(`${i}:b`)) || { x: s.a.x + (s.b.x - s.a.x) * t, y: s.a.y + (s.b.y - s.a.y) * t };
    for (let k = 0; k + 1 < ts.length; k++) {
      const a = { ...at(ts[k]) };
      const b = { ...at(ts[k + 1]) };
      const ia = pts.push(a) - 1, ib = pts.push(b) - 1;
      pieces.push({ ia, ib, src: s });
    }
  });
  const parent = pts.map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const pIdx = new GridIndex(opt.snapTol * 2);
  pts.forEach((p, i) => pIdx.insert(i, p.x, p.y, p.x, p.y));
  pts.forEach((p, i) => {
    for (const j of pIdx.query(p.x - opt.snapTol, p.y - opt.snapTol, p.x + opt.snapTol, p.y + opt.snapTol)) {
      if (j !== i && dist(p, pts[j]) <= opt.snapTol) { const a = find(i), b = find(j); if (a !== b) parent[a] = b; }
    }
  });
  const nodeOf = new Map();
  const nodes = [];
  pts.forEach((p, i) => {
    const r = find(i);
    if (!nodeOf.has(r)) { nodeOf.set(r, nodes.length); nodes.push({ id: nodes.length, x: 0, y: 0, n: 0 }); }
    const nd = nodes[nodeOf.get(r)];
    nd.x += p.x; nd.y += p.y; nd.n++;
  });
  for (const nd of nodes) { nd.x /= nd.n; nd.y /= nd.n; delete nd.n; }

  // edges + dedupe
  const edgeMap = new Map();
  let dupes = 0;
  for (const pc of pieces) {
    const u = nodeOf.get(find(pc.ia)), v = nodeOf.get(find(pc.ib));
    if (u === v) continue;
    const key = u < v ? `${u}_${v}` : `${v}_${u}`;
    const prev = edgeMap.get(key);
    const e = {
      u, v, t: pc.src.t || 0, kind: pc.src.kind || 'wall', conf: pc.src.conf ?? 0.8,
      src: pc.src.src || 'paired', opening: pc.src.kind === 'opening' ? pc.src : null,
    };
    if (!prev) { edgeMap.set(key, e); continue; }
    dupes++;
    // a wall beats an opening; a hand-drawn wall beats evidence; otherwise keep
    // the thicker, more confident one
    if (prev.kind === 'opening' && e.kind === 'wall') edgeMap.set(key, e);
    else if (e.src === 'manual' && prev.kind === 'wall') edgeMap.set(key, { ...e, t: Math.max(prev.t, e.t) });
    else if (prev.kind === e.kind && prev.src !== 'manual' && (e.t > prev.t || e.conf > prev.conf)) edgeMap.set(key, { ...prev, t: Math.max(prev.t, e.t), conf: Math.max(prev.conf, e.conf) });
  }
  if (dupes) log.push({ kind: 'dedupe', at: null, note: `${dupes} doubled/overlapping trace segments merged` });

  const edges = [...edgeMap.values()].map((e, i) => ({ ...e, id: i }));
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// 4. CLEAN — prune overshoot stubs and detached scraps
// ---------------------------------------------------------------------------

export function pruneGraph(g, options = {}, log = []) {
  const opt = { ...GRAPH_DEFAULTS, ...options };
  let edges = g.edges.slice();
  let changed = true;
  while (changed) {
    changed = false;
    const deg = new Map();
    for (const e of edges) { deg.set(e.u, (deg.get(e.u) || 0) + 1); deg.set(e.v, (deg.get(e.v) || 0) + 1); }
    const keep = [];
    for (const e of edges) {
      const du = deg.get(e.u), dv = deg.get(e.v);
      if (du !== 1 && dv !== 1) { keep.push(e); continue; }
      if (du === 1 && dv === 1) { keep.push(e); continue; } // isolated piece handled below
      const free = du === 1 ? e.u : e.v, host = du === 1 ? e.v : e.u;
      const L = dist(g.nodes[free], g.nodes[host]);
      const hostT = Math.max(0, ...edges.filter((o) => o !== e && (o.u === host || o.v === host)).map((o) => o.t));
      if (e.kind === 'opening' || L <= hostT * opt.stubFactor + opt.snapTol) {
        changed = true;
        if (e.kind === 'wall') log.push({ kind: 'stub', at: { ...g.nodes[free] }, note: `Overshoot stub trimmed (${(L * 12).toFixed(1)}")` });
        continue;
      }
      keep.push(e);
    }
    edges = keep;
  }

  // components
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for (const e of edges) { if (!parent.has(e.u)) parent.set(e.u, e.u); if (!parent.has(e.v)) parent.set(e.v, e.v); }
  for (const e of edges) { const a = find(e.u), b = find(e.v); if (a !== b) parent.set(a, b); }
  const comp = new Map();
  for (const e of edges) {
    const r = find(e.u);
    if (!comp.has(r)) comp.set(r, { len: 0, edges: [] });
    const c = comp.get(r);
    c.len += dist(g.nodes[e.u], g.nodes[e.v]); c.edges.push(e);
  }
  const detached = [];
  const kept = [];
  const biggest = Math.max(0, ...[...comp.values()].map((c) => c.len));
  for (const c of comp.values()) {
    if (c.len < opt.minComponentLen && c.len < biggest) {
      detached.push(c);
      continue;
    }
    kept.push(...c.edges);
  }
  if (detached.length) log.push({ kind: 'scrap', at: null, note: `${detached.length} small detached linework piece(s) ignored` });
  return { nodes: g.nodes, edges: kept.map((e, i) => ({ ...e, id: i })), detached };
}

// ---------------------------------------------------------------------------
// 5. FACES — trace every loop with a consistent turning rule
// ---------------------------------------------------------------------------

/**
 * Half-edge face tracing. Every half-edge has exactly one face on its left;
 * walking "next" from any half-edge must come back to where it started.
 * Interior faces have positive signed area; each component's outer boundary
 * is negative. Spurs (walls that dead-end inside a room) appear as an edge
 * walked in both directions inside the same face — the "in and out".
 */
export function traceFaces(g) {
  const { nodes, edges } = g;
  const out = new Map(); // node -> sorted outgoing half-edges
  const H = [];
  for (const e of edges) {
    const h1 = { id: H.length, e, from: e.u, to: e.v }; H.push(h1);
    const h2 = { id: H.length, e, from: e.v, to: e.u }; H.push(h2);
    h1.twin = h2; h2.twin = h1;
  }
  for (const h of H) {
    const a = nodes[h.from], b = nodes[h.to];
    h.ang = Math.atan2(b.y - a.y, b.x - a.x);
    if (!out.has(h.from)) out.set(h.from, []);
    out.get(h.from).push(h);
  }
  for (const list of out.values()) list.sort((p, q) => p.ang - q.ang);
  for (const list of out.values()) list.forEach((h, i) => { h.rank = i; });
  const next = (h) => {
    const list = out.get(h.to);
    const k = h.twin.rank;
    return list[(k - 1 + list.length) % list.length];
  };

  const seen = new Set();
  /** @type {any[]} */
  const faces = [];
  for (const h0 of H) {
    if (seen.has(h0.id)) continue;
    const cyc = [];
    let h = h0, guard = 0;
    while (!seen.has(h.id) && guard++ < 100000) { seen.add(h.id); cyc.push(h); h = next(h); }
    const closed = h === h0;
    const poly = cyc.map((x) => nodes[x.from]);
    faces.push({ id: faces.length, half: cyc, closed, area: signedArea(poly) });
  }
  return { faces, half: H };
}

/** Remove back-and-forth pairs (spurs) from a face cycle. */
export function stripSpurs(cyc) {
  const st = [];
  const spurs = [];
  for (const h of cyc) {
    if (st.length && st[st.length - 1] === h.twin) { spurs.push(st.pop().e); continue; }
    st.push(h);
  }
  // wrap-around pairs
  let changed = true;
  while (changed && st.length >= 2) {
    changed = false;
    if (st[st.length - 1].twin === st[0]) { spurs.push(st.pop().e); st.shift(); changed = true; }
    // re-scan for new adjacent pairs created by the wrap removal
    for (let i = 0; i + 1 < st.length; i++) {
      if (st[i + 1] === st[i].twin) { spurs.push(st[i].e); st.splice(i, 2); changed = true; break; }
    }
  }
  return { loop: st, spurs };
}

/** Split a loop that visits a node twice (a pinch) into simple sub-loops. */
export function splitPinches(loop) {
  const loops = [];
  const stack = [];
  const pos = new Map();
  for (const h of loop) {
    if (pos.has(h.from)) {
      const k = pos.get(h.from);
      const sub = stack.splice(k);
      for (const x of sub) pos.delete(x.from);
      loops.push(sub);
    }
    pos.set(h.from, stack.length);
    stack.push(h);
  }
  if (stack.length) loops.push(stack);
  return loops;
}

export { dist, perp, norm, add, sub, mul, len };
