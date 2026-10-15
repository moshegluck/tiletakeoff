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

  // already-connected ends (touching another segment)
  for (const e of ends) {
    for (const j of near(e.p, opt.snapTol)) {
      if (j === e.bi) continue;
      if (touches(e.p, segs[j], opt.snapTol)) { e.joined = true; break; }
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
    if (moved > opt.snapTol) log.push({ kind: 'corner', at: { ...c.X }, note: `Corner closed (${(moved * 12).toFixed(1)}" extended)` });
  }

  // ---- tees: ray from a free end hits another wall's body ----
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
      if (hit.s > s.t * opt.stubFactor + opt.snapTol || hit.s < -s.t - opt.snapTol) continue;
      if (!best || Math.abs(hit.s) < Math.abs(best.s)) best = { s: hit.s, pt: hit.pt, j };
    }
    if (best) {
      const moved = Math.abs(best.s);
      e.p = { ...best.pt }; e.joined = true;
      if (moved > opt.snapTol) log.push({ kind: 'tee', at: { ...best.pt }, note: `Wall extended ${(moved * 12).toFixed(1)}" to meet crossing wall` });
    }
  }

  // ---- drafting gaps: collinear free ends facing each other, tiny gap ----
  const extra = [];
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

export function bridgeOpenings(segs, ends, arcs = [], options = {}, log = []) {
  const opt = { ...GRAPH_DEFAULTS, ...options };
  const free = ends.filter((e) => !e.joined);
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
  // (b) end → perpendicular wall (door beside a corner, opening onto a hall)
  for (const e of free) {
    let best = null;
    const far = { x: e.p.x + e.dir.x * (opt.maxOpening + 2), y: e.p.y + e.dir.y * (opt.maxOpening + 2) };
    for (const j of segsNear(e.p, far)) {
      const s = segs[j];
      if (j === e.bi) continue;
      if (angleDiff(lineAngle(segs[e.bi].a, segs[e.bi].b), lineAngle(s.a, s.b)) < 30 * DEG) continue;
      const hit = lineIntersect(e.p, e.dir, s.a, sub(s.b, s.a));
      if (!hit || hit.u < -0.001 || hit.u > 1.001) continue;
      const width = hit.s - s.t / 2;
      if (width < opt.minOpening || width > opt.maxOpening) continue;
      if (!best || hit.s < best.s) best = { s: hit.s, pt: hit.pt, j, width, t: s.t };
    }
    if (!best) continue;
    if (blocked(e.p, best.pt, [e.bi, best.j])) continue;
    const jamb2 = sub(best.pt, mul(e.dir, best.t / 2));
    cands.push({ type: 'ray', e1: e, a: e.p, b: best.pt, width: best.width, t: e.t, jambs: [e.p, jamb2], hitBody: best.j });
  }

  // door-swing evidence makes a candidate much more trustworthy
  for (const c of cands) {
    c.arcs = matchArcs(c, arcs);
    c.cost = c.width - (c.arcs.length ? 100 : 0) + (c.type === 'ray' ? 0.5 : 0);
  }
  cands.sort((p, q) => p.cost - q.cost);

  const openings = [];
  for (const c of cands) {
    if (c.e1.joined || (c.e2 && c.e2.joined)) continue;
    c.e1.joined = true; if (c.e2) c.e2.joined = true;
    const nArc = c.arcs.length;
    const kind = nArc >= 2 ? 'double_door' : nArc === 1 ? 'door' : 'opening';
    let width = c.width;
    if (nArc === 1) width = refineWidth(c.width, c.arcs[0].r);
    openings.push({
      id: uid('o'), a: { ...c.a }, b: { ...c.b }, t: c.t, kind: 'opening', openingType: kind,
      width, arcs: c.arcs, conf: nArc ? 0.95 : (c.width <= 4 ? 0.7 : 0.5), via: c.type,
      jambs: c.jambs.map((p) => ({ ...p })),
    });
  }
  for (const o of openings) {
    log.push({ kind: 'opening', at: { x: (o.a.x + o.b.x) / 2, y: (o.a.y + o.b.y) / 2 }, note: `${o.openingType === 'opening' ? 'Opening' : 'Door'} bridged (${fmtIn(o.width)})` });
  }
  return openings;
}

function refineWidth(gap, r) {
  // the swing radius IS the leaf width; trust it when it agrees with the gap
  return Math.abs(r - gap) / gap < 0.2 ? r : gap;
}

function matchArcs(c, arcs) {
  if (!arcs.length) return [];
  const out = [];
  for (const arc of arcs) {
    const tol = Math.max(0.6, c.t + 0.35);
    const nearJamb = c.jambs.some((j) => dist(j, arc.c) <= tol);
    if (!nearJamb) continue;
    const single = Math.abs(arc.r - c.width) / c.width < 0.2;
    const dbl = Math.abs(arc.r * 2 - c.width) / c.width < 0.2;
    if (single || dbl) out.push(arc);
  }
  // a single leaf whose radius = full width beats two half-width matches
  const full = out.filter((a) => Math.abs(a.r - c.width) / c.width < 0.2);
  return full.length ? full.slice(0, 1) : out.slice(0, 2);
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
  for (let i = 0; i < S.length; i++) {
    const s = S[i];
    const cand = idx.query(Math.min(s.a.x, s.b.x) - opt.snapTol, Math.min(s.a.y, s.b.y) - opt.snapTol, Math.max(s.a.x, s.b.x) + opt.snapTol, Math.max(s.a.y, s.b.y) + opt.snapTol);
    const L = dist(s.a, s.b);
    for (const j of cand) {
      if (j === i) continue;
      const o = S[j];
      // other's endpoints lying on this segment (tees)
      for (const p of [o.a, o.b]) {
        const c = closestOnSeg(p, s.a, s.b);
        if (c.d <= opt.snapTol && c.t * L > opt.snapTol && (1 - c.t) * L > opt.snapTol) cuts[i].push(c.t);
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
    for (let k = 0; k + 1 < ts.length; k++) {
      const a = { x: s.a.x + (s.b.x - s.a.x) * ts[k], y: s.a.y + (s.b.y - s.a.y) * ts[k] };
      const b = { x: s.a.x + (s.b.x - s.a.x) * ts[k + 1], y: s.a.y + (s.b.y - s.a.y) * ts[k + 1] };
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
