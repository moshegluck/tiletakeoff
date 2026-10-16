// ============================================================
// walls.js — turn raw linework into wall BODIES.
//
// Architectural plans draw a wall as two parallel face lines a wall-
// thickness apart. We never trust a single line: every candidate is a
// hypothesis. This stage:
//   1. drops tiny strokes (text, ticks),
//   2. merges collinear duplicates / doubled traces into maximal lines,
//   3. pairs parallel lines whose spacing looks like a wall thickness,
//      preferring the thicknesses that dominate the sheet,
//   4. rejects evenly-spaced series (floor hatch / tile patterns),
//   5. emits centerline bodies { a, b, t, conf } in feet.
// ============================================================

import {
  sub, dot, len, norm, perp, lineAngle, angleDiff, dist, GridIndex,
} from './vec.js';

const IN = 1 / 12;

export const WALL_DEFAULTS = {
  minLineLen: 0.3,          // ft — shorter strokes are text/ticks
  collinearAngTol: 0.6 * Math.PI / 180,
  collinearOffTol: 0.6 * IN,
  collinearGapTol: 0.75 * IN,
  pairAngTol: 1.5 * Math.PI / 180,
  minT: 2.5 * IN,           // thinnest plausible wall
  minTAtypical: 3.5 * IN,   // thinnest wall we accept when it isn't a dominant thickness
  maxT: 16 * IN,            // thickest plausible wall (exterior / foundation)
  minBodyLen: 0.45,         // ft
  peakTol: 0.75 * IN,
  seriesTol: 0.1,           // 10% spacing match → evenly spaced hatch
};

/** Normalize raw lines to { a, b, w, th, u, n, rho, s0, s1, len }. */
function prep(raw, opt) {
  const out = [];
  for (const r of raw) {
    if (!r || !r.a || !r.b) continue;
    const L = dist(r.a, r.b);
    if (!(L >= opt.minLineLen) || !Number.isFinite(L)) continue;
    let th = lineAngle(r.a, r.b);
    if (th > Math.PI - opt.collinearAngTol) th -= Math.PI; // wrap near-horizontal to one side
    const u = { x: Math.cos(th), y: Math.sin(th) };
    const n = perp(u);
    const s0 = dot(r.a, u), s1 = dot(r.b, u);
    out.push({
      th, u, n, rho: (dot(r.a, n) + dot(r.b, n)) / 2,
      s0: Math.min(s0, s1), s1: Math.max(s0, s1), w: r.w || 0, wl: !!r.wl, src: r.src || 'vector',
    });
  }
  return out;
}

/** Merge collinear overlapping / abutting lines (kills doubled traces). */
export function mergeCollinear(raw, options = {}) {
  const opt = { ...WALL_DEFAULTS, ...options };
  const L = prep(raw, opt).sort((p, q) => p.th - q.th);
  // Group by angle against the group's FIRST line (not the previous one), so a
  // sheet full of lines at scattered angles can't chain into one drifting group.
  const groups = [];
  let cur = [];
  for (const l of L) {
    if (cur.length && l.th - cur[0].th > opt.collinearAngTol) { groups.push(cur); cur = []; }
    cur.push(l);
  }
  if (cur.length) groups.push(cur);

  const merged = [];
  for (const g of groups) {
    // reference direction for the group
    const th = g.reduce((s, l) => s + l.th * (l.s1 - l.s0), 0) / g.reduce((s, l) => s + (l.s1 - l.s0), 0);
    const u = { x: Math.cos(th), y: Math.sin(th) }, n = perp(u);
    const items = g.map((l) => {
      // re-project in the group frame
      const pa = { x: l.u.x * l.s0 + l.n.x * l.rho, y: l.u.y * l.s0 + l.n.y * l.rho };
      const pb = { x: l.u.x * l.s1 + l.n.x * l.rho, y: l.u.y * l.s1 + l.n.y * l.rho };
      const a = dot(pa, u), b = dot(pb, u);
      return { rho: (dot(pa, n) + dot(pb, n)) / 2, s0: Math.min(a, b), s1: Math.max(a, b), w: l.w, wl: !!l.wl, src: l.src, orig: { a: pa, b: pb } };
    }).sort((p, q) => p.rho - q.rho);
    // band by rho (again anchored on the band's first line)
    let band = [];
    const flush = () => {
      if (!band.length) return;
      if (band.length === 1) {
        // a line with nothing to merge with is emitted exactly as drawn
        const o = band[0].orig;
        merged.push({ a: { ...o.a }, b: { ...o.b }, w: band[0].w, wl: band[0].wl, dup: 1 });
        band = [];
        return;
      }
      const rho = band.reduce((s, l) => s + l.rho * (l.s1 - l.s0), 0) / band.reduce((s, l) => s + (l.s1 - l.s0), 0);
      band.sort((p, q) => p.s0 - q.s0);
      let a = band[0].s0, b = band[0].s1, w = band[0].w, wl = band[0].wl, cnt = 1;
      const emit = () => merged.push({
        a: { x: u.x * a + n.x * rho, y: u.y * a + n.y * rho },
        b: { x: u.x * b + n.x * rho, y: u.y * b + n.y * rho }, w, wl, dup: cnt,
      });
      let first = band[0];
      const emitRun = () => {
        if (cnt === 1) merged.push({ a: { ...first.orig.a }, b: { ...first.orig.b }, w, wl, dup: 1 });
        else emit();
      };
      for (let i = 1; i < band.length; i++) {
        const l = band[i];
        if (l.s0 <= b + opt.collinearGapTol) { b = Math.max(b, l.s1); w = Math.max(w, l.w); wl = wl || l.wl; cnt++; }
        else { emitRun(); a = l.s0; b = l.s1; w = l.w; wl = l.wl; cnt = 1; first = l; }
      }
      emitRun();
      band = [];
    };
    for (const l of items) {
      if (band.length && l.rho - band[0].rho > opt.collinearOffTol) flush();
      band.push(l);
    }
    flush();
  }
  return merged;
}

// interval helpers (closed intervals [a,b], sorted, disjoint)
function subtractIntervals(a, b, cov) {
  let parts = [[a, b]];
  for (const [c0, c1] of cov) {
    const next = [];
    for (const [p0, p1] of parts) {
      if (c1 <= p0 || c0 >= p1) { next.push([p0, p1]); continue; }
      if (c0 > p0) next.push([p0, c0]);
      if (c1 < p1) next.push([c1, p1]);
    }
    parts = next;
  }
  return parts;
}
function addInterval(cov, a, b) {
  cov.push([a, b]);
  cov.sort((p, q) => p[0] - q[0]);
  const out = [];
  for (const iv of cov) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1] + 1e-9) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  cov.length = 0; cov.push(...out);
}

/**
 * Pair parallel lines into wall bodies.
 * @returns {{ bodies: {a,b,t,conf,w}[], faces: {a,b}[], lines: object[], hatch: Set<number>, stats: object }}
 */
export function pairWalls(rawLines, options = {}) {
  const opt = { ...WALL_DEFAULTS, ...options };
  const lines = mergeCollinear(rawLines, opt).map((l, i) => {
    const d = sub(l.b, l.a), L = len(d), u = norm(d);
    return { ...l, id: i, len: L, u, th: lineAngle(l.a, l.b), cov: [] };
  });

  const idx = new GridIndex(Math.max(2, opt.maxT * 4));
  for (const l of lines) {
    idx.insert(l.id, Math.min(l.a.x, l.b.x) - opt.maxT, Math.min(l.a.y, l.b.y) - opt.maxT,
      Math.max(l.a.x, l.b.x) + opt.maxT, Math.max(l.a.y, l.b.y) + opt.maxT);
  }

  // ---- candidate generation ----
  const cands = [];
  const partners = lines.map(() => []); // for series (hatch) detection
  for (const l of lines) {
    const near = idx.query(Math.min(l.a.x, l.b.x), Math.min(l.a.y, l.b.y), Math.max(l.a.x, l.b.x), Math.max(l.a.y, l.b.y));
    for (const j of near) {
      if (j <= l.id) continue;
      const m = lines[j];
      if (angleDiff(l.th, m.th) > opt.pairAngTol) continue;
      const u = l.u, n = perp(u);
      const s0 = dot(l.a, u), s1 = dot(l.b, u);
      const lo = Math.min(s0, s1), hi = Math.max(s0, s1);
      const t0 = dot(m.a, u), t1 = dot(m.b, u);
      const o0 = Math.max(lo, Math.min(t0, t1)), o1 = Math.min(hi, Math.max(t0, t1));
      if (o1 - o0 < opt.minBodyLen) continue;
      const side = dot(sub(m.a, l.a), n) + dot(sub(m.b, l.a), n);
      const d = Math.abs((dot(sub(m.a, l.a), n) + dot(sub(m.b, l.a), n)) / 2);
      if (d < opt.minT || d > opt.maxT) continue;
      const c = { i: l.id, j, d, o0, o1, overlap: o1 - o0 };
      cands.push(c);
      partners[l.id].push({ j, d, side: Math.sign(side), o0, o1 });
      partners[j].push({ j: l.id, d, side: -Math.sign(side), o0, o1 });
    }
  }

  // ---- hatch / evenly spaced series rejection ----
  // A run of evenly spaced parallels is a hatch, tile pattern or stair treads,
  // not walls: six or more in a row always; four or five when they're short
  // strokes (each under ten spacings long — treads, a tile field, diagonal wall
  // hatch). A layered wall (foundation + furring, or an old wall with a new one
  // built against it) also shows faces a near-equal spacing apart, and a deck
  // edge or dimension line can land the same distance off — but those are long
  // runs, many spacings long, and never six deep.
  const hatch = new Set();
  const mids = lines.map((l) => ({ x: (l.a.x + l.b.x) / 2, y: (l.a.y + l.b.y) / 2 }));
  // the next line of the run beyond `x`, coming from `from` (same spacing, further across)
  const nextInRun = (x, d, from) => {
    const nx = perp(lines[x].u);
    const away = Math.sign(dot(sub(mids[x], mids[from]), nx));
    const r = partners[x].find((q) => q.j !== from && Math.abs(q.d - d) / d <= opt.seriesTol &&
      dot(sub(mids[q.j], mids[x]), nx) * away > d * 0.5);
    return r ? r.j : -1;
  };
  const medianLen = (ids) => {
    const ls = ids.map((i) => lines[i].len).sort((a, b) => a - b);
    return ls[Math.floor(ls.length / 2)];
  };
  const isPattern = (ids, d) => ids.length >= 6 || (ids.length >= 4 && medianLen(ids) < 10 * d);
  // a wall face that happens to line up with a pattern's strokes (a long
  // exterior face beside a row of short window-frame or tread lines) is
  // not one of them
  const outlier = (i, ids, d) => lines[i].len >= Math.max(10 * d, 2 * medianLen(ids));
  for (const l of lines) {
    if (hatch.has(l.id)) continue;
    const ps = partners[l.id];
    for (const p of ps) {
      if (p.side >= 0) continue;
      for (const q of ps) {
        if (q.side <= 0) continue;
        if (Math.abs(p.d - q.d) / Math.max(p.d, q.d) > opt.seriesTol) continue;
        // (no overlap test between p and q: diagonal hatch is staggered along the
        // wall, so neighbours overlap l on different stretches)
        const d = (p.d + q.d) / 2;
        const run = [p.j, l.id, q.j];
        for (const [end, from] of [[p.j, l.id], [q.j, l.id]]) {
          let cur = end, prev = from;
          for (let k = 0; k < 64; k++) {
            const nx = nextInRun(cur, d, prev);
            if (nx < 0 || run.includes(nx)) break;
            run.push(nx); prev = cur; cur = nx;
          }
        }
        if (isPattern(run, d)) for (const i of run) if (!outlier(i, run, d)) hatch.add(i);
      }
    }
  }

  // ---- dominant thickness peaks (histogram weighted by overlap length) ----
  const bin = 0.25 * IN;
  const hist = new Map();
  for (const c of cands) {
    if (hatch.has(c.i) || hatch.has(c.j)) continue;
    const k = Math.round(c.d / bin);
    hist.set(k, (hist.get(k) || 0) + c.overlap);
  }
  const smooth = new Map();
  for (const [k] of hist) smooth.set(k, (hist.get(k - 1) || 0) * 0.5 + hist.get(k) + (hist.get(k + 1) || 0) * 0.5);
  const maxMass = Math.max(0, ...smooth.values());
  const peaks = [];
  for (const [k, v] of smooth) {
    if (v < maxMass * 0.15) continue;
    if ((smooth.get(k - 1) || 0) > v || (smooth.get(k + 1) || 0) > v) continue;
    peaks.push({ t: k * bin, mass: v });
  }
  peaks.sort((p, q) => q.mass - p.mass);
  const nearPeak = (d) => peaks.find((p) => Math.abs(p.t - d) <= opt.peakTol);

  for (const c of cands) {
    const pk = nearPeak(c.d);
    c.typical = !!pk;
    c.prio = pk ? 0 : 1;
  }
  // A wall face's true partner is the one it runs alongside the longest: a sink
  // or shelf line may sit a "wall thickness" off the face, but only for a short
  // stretch. Longer overlap first, then the thinner spacing.
  // (overlaps within 1/2" are a tie: the thinner spacing wins, not float noise)
  cands.sort((p, q) => p.prio - q.prio || (Math.abs(q.overlap - p.overlap) > 0.04 ? q.overlap - p.overlap : 0) || p.d - q.d);

  // ---- greedy assignment with per-line interval coverage ----
  const bodies = [];
  for (const c of cands) {
    if (hatch.has(c.i) || hatch.has(c.j)) continue;
    if (!c.typical && c.d < opt.minTAtypical) continue;
    const l = lines[c.i], m = lines[c.j];
    const u = l.u;
    // coverage of l is stored in l's own param (dot with l.u); m's in m's.
    const sOf = (line, p) => dot(p, line.u);
    const covL = l.cov;
    // m's coverage is stored along m.u; rebuild the points and project onto u.
    const mPerp = dot(m.a, perp(m.u));
    const covMProj = m.cov.map(([a, b]) => {
      const pa = { x: m.u.x * a + perp(m.u).x * mPerp, y: m.u.y * a + perp(m.u).y * mPerp };
      const pb = { x: m.u.x * b + perp(m.u).x * mPerp, y: m.u.y * b + perp(m.u).y * mPerp };
      const x0 = dot(pa, u), x1 = dot(pb, u);
      return [Math.min(x0, x1), Math.max(x0, x1)];
    }).sort((p, q) => p[0] - q[0]);
    const lPerp = dot(l.a, perp(u));
    const covLProj = covL.slice();
    let parts = subtractIntervals(c.o0, c.o1, covLProj);
    parts = parts.flatMap(([a, b]) => subtractIntervals(a, b, covMProj));
    for (const [a, b] of parts) {
      // a wall runs most of its thickness at least (two parallel hatch strokes
      // a foot apart are not a 12" wall five inches long)
      if (b - a < Math.max(opt.minBodyLen, c.d * 0.6)) continue;
      const pL0 = { x: u.x * a + perp(u).x * lPerp, y: u.y * a + perp(u).y * lPerp };
      const pL1 = { x: u.x * b + perp(u).x * lPerp, y: u.y * b + perp(u).y * lPerp };
      // foot on m's line
      const foot = (p) => {
        const mu = m.u, ma = m.a;
        const k = dot(sub(p, ma), mu);
        return { x: ma.x + mu.x * k, y: ma.y + mu.y * k };
      };
      const f0 = foot(pL0), f1 = foot(pL1);
      const A = { x: (pL0.x + f0.x) / 2, y: (pL0.y + f0.y) / 2 };
      const B = { x: (pL1.x + f1.x) / 2, y: (pL1.y + f1.y) / 2 };
      const conf = Math.min(1, (c.typical ? 0.85 : 0.55) + Math.min(0.15, (b - a) / 40));
      bodies.push({ a: A, b: B, t: c.d, conf, w: Math.max(l.w, m.w), typical: c.typical, src: 'paired' });
      addInterval(covL, a, b);
      // store m coverage in m's own param
      const ma = sOf(m, f0), mb = sOf(m, f1);
      addInterval(m.cov, Math.min(ma, mb), Math.max(ma, mb));
    }
  }

  // ---- faces left over: lines on the sheet's wall layers that no wall took
  // (a furring layer's inner face beside a foundation wall: the shared middle
  // line went to one wall). analyze.js moves a room's edge in to such a face.
  const faces = [];
  for (const l of lines) {
    if (!l.wl || hatch.has(l.id)) continue;
    const s0 = dot(l.a, l.u), s1 = dot(l.b, l.u), lp = dot(l.a, perp(l.u));
    for (const [a, b] of subtractIntervals(Math.min(s0, s1), Math.max(s0, s1), l.cov)) {
      if (b - a < 1) continue;
      const P = (sv) => ({ x: l.u.x * sv + perp(l.u).x * lp, y: l.u.y * sv + perp(l.u).y * lp });
      faces.push({ a: P(a), b: P(b) });
    }
  }

  return {
    bodies: dropInside(mergeBodies(mergeLayers(mergeBodies(bodies)))),
    faces,
    lines,
    hatch,
    stats: {
      rawLines: rawLines.length, mergedLines: lines.length, candidates: cands.length,
      hatchLines: hatch.size, peaks: peaks.map((p) => +(p.t * 12).toFixed(2)), bodies: bodies.length,
    },
  };
}

/** Merge collinear bodies of similar thickness that overlap or nearly touch. */
export function mergeBodies(bodies, { angTol = 1 * Math.PI / 180, offTol = 1.0 * IN, gapTol = 1.0 * IN, tTol = 1.25 * IN } = {}) {
  const items = bodies
    .filter((b) => b && b.a && b.b && dist(b.a, b.b) > 1e-3 && Number.isFinite(b.t))
    .map((b) => ({ ...b, th: lineAngle(b.a, b.b), dead: false }));
  const cell = 4;
  let changed = true;
  while (changed) {
    changed = false;
    const idx = new GridIndex(cell);
    items.forEach((b, i) => { if (!b.dead) idx.insert(i, Math.min(b.a.x, b.b.x) - gapTol, Math.min(b.a.y, b.b.y) - gapTol, Math.max(b.a.x, b.b.x) + gapTol, Math.max(b.a.y, b.b.y) + gapTol); });
    for (let i = 0; i < items.length; i++) {
      const p = items[i]; if (p.dead) continue;
      const near = idx.query(Math.min(p.a.x, p.b.x) - gapTol, Math.min(p.a.y, p.b.y) - gapTol, Math.max(p.a.x, p.b.x) + gapTol, Math.max(p.a.y, p.b.y) + gapTol);
      for (const j of near) {
        if (j <= i) continue;
        const q = items[j]; if (q.dead) continue;
        if (angleDiff(p.th, q.th) > angTol || Math.abs(p.t - q.t) > tTol) continue;
        const u = norm(sub(p.b, p.a)), n = perp(u);
        if (Math.abs(dot(sub(q.a, p.a), n)) > offTol || Math.abs(dot(sub(q.b, p.a), n)) > offTol) continue;
        const s = [dot(p.a, u), dot(p.b, u)].sort((a, b) => a - b);
        const r = [dot(q.a, u), dot(q.b, u)].sort((a, b) => a - b);
        if (r[0] > s[1] + gapTol || s[0] > r[1] + gapTol) continue;
        const lo = Math.min(s[0], r[0]), hi = Math.max(s[1], r[1]);
        const rho = dot(p.a, n);
        const wl = len(sub(p.b, p.a)), wq = len(sub(q.b, q.a));
        p.a = { x: u.x * lo + n.x * rho, y: u.y * lo + n.y * rho };
        p.b = { x: u.x * hi + n.x * rho, y: u.y * hi + n.y * rho };
        p.t = (p.t * wl + q.t * wq) / (wl + wq);
        p.conf = Math.max(p.conf, q.conf);
        p.typical = p.typical || q.typical;
        q.dead = true; changed = true;
      }
    }
  }
  return items.filter((b) => !b.dead).map(({ th: _th, dead: _dead, ...b }) => b);
}

/**
 * One wall, not two: parallel bodies that touch face to face (an existing
 * wall with a new layer built against it, a foundation wall with its furring)
 * become a single body of their combined thickness wherever they run side by
 * side. Left as two, the room would leak into the seam between them and their
 * corners would never meet. Repeats until stable (three layers → one wall).
 */
export function mergeLayers(bodies, { angTol = 1.5 * Math.PI / 180, touchTol = 1.0 * IN, cavity = 3 * IN, minOverlap = 0.75 } = {}) {
  let items = bodies.filter((b) => b && b.a && b.b && dist(b.a, b.b) > 1e-3 && Number.isFinite(b.t));
  for (let guard = 0; guard < 8; guard++) {
    const idx = new GridIndex(4);
    items.forEach((b, i) => idx.insert(i, Math.min(b.a.x, b.b.x) - 1, Math.min(b.a.y, b.b.y) - 1, Math.max(b.a.x, b.b.x) + 1, Math.max(b.a.y, b.b.y) + 1));
    const dead = new Set();
    const out = [];
    let merged = 0;
    for (let i = 0; i < items.length; i++) {
      if (dead.has(i)) continue;
      const p = items[i];
      const u = norm(sub(p.b, p.a)), n = perp(u);
      const th = lineAngle(p.a, p.b);
      const near = idx.query(Math.min(p.a.x, p.b.x) - 1, Math.min(p.a.y, p.b.y) - 1, Math.max(p.a.x, p.b.x) + 1, Math.max(p.a.y, p.b.y) + 1);
      for (const j of near) {
        if (j <= i || dead.has(j) || dead.has(i)) continue;
        const q = items[j];
        if (angleDiff(th, lineAngle(q.a, q.b)) > angTol) continue;
        const rp = dot(p.a, n), rq = (dot(q.a, n) + dot(q.b, n)) / 2;
        // face to face, or with an air gap between them (a new stud wall built
        // 1–3" inside a foundation wall): one wall, the gap is no floor
        const gap = Math.abs(rq - rp) - (p.t + q.t) / 2;
        if (gap < -touchTol || gap > cavity) continue;
        const ps = [dot(p.a, u), dot(p.b, u)].sort((a, b) => a - b);
        const qs = [dot(q.a, u), dot(q.b, u)].sort((a, b) => a - b);
        const lo = Math.max(ps[0], qs[0]), hi = Math.min(ps[1], qs[1]);
        if (hi - lo < minOverlap) continue;
        // the combined body spans both outer faces
        const f0 = Math.min(rp - p.t / 2, rq - q.t / 2), f1 = Math.max(rp + p.t / 2, rq + q.t / 2);
        const rc = (f0 + f1) / 2;
        const at = (s, r) => ({ x: u.x * s + n.x * r, y: u.y * s + n.y * r });
        out.push({ ...p, a: at(lo, rc), b: at(hi, rc), t: f1 - f0, conf: Math.max(p.conf ?? 0, q.conf ?? 0), typical: true, layered: true });
        // what runs on past the shared stretch stays as it was, joined to the
        // combined wall by the step its face takes where the other layer stops
        for (const [b, ss, r] of [[p, ps, rp], [q, qs, rq]]) {
          const step = (s) => { if (Math.abs(r - rc) > 0.02) out.push({ ...b, a: at(s, r), b: at(s, rc), t: Math.min(p.t, q.t), typical: false, step: true }); };
          if (lo - ss[0] > 0.05) { out.push({ ...b, a: at(ss[0], r), b: at(lo, r) }); step(lo); }
          if (ss[1] - hi > 0.05) { out.push({ ...b, a: at(hi, r), b: at(ss[1], r) }); step(hi); }
        }
        dead.add(i); dead.add(j);
        merged++;
        break;
      }
      if (!dead.has(i)) out.push(p);
    }
    items = out;
    if (!merged) break;
  }
  return items;
}

/**
 * Drop a short body lying wholly inside a longer wall's footprint: hatch
 * strokes drawn across a new wall pair up into little slanted "walls" near
 * its ends, where the run is too short to read as hatch. Inside another wall
 * they're its drawing, not a wall of their own.
 */
export function dropInside(bodies, { tol = 1.0 * IN, maxLen = 3 } = {}) {
  const idx = new GridIndex(4);
  bodies.forEach((b, i) => idx.insert(i, Math.min(b.a.x, b.b.x), Math.min(b.a.y, b.b.y), Math.max(b.a.x, b.b.x), Math.max(b.a.y, b.b.y)));
  const inside = (p, w, tl = tol) => {
    const L = dist(w.a, w.b);
    if (L < 1e-6) return false;
    const u = { x: (w.b.x - w.a.x) / L, y: (w.b.y - w.a.y) / L };
    const s = dot(sub(p, w.a), u), d = Math.abs(dot(sub(p, w.a), perp(u)));
    return s >= -tl && s <= L + tl && d <= w.t / 2 + tl;
  };
  return bodies.filter((b, i) => {
    const L = dist(b.a, b.b);
    if (L > maxLen || b.step) return true;
    const reach = 3 * IN;   // a corner tick often stops in the junction, just past one wall's end
    const hosts = [...idx.query(Math.min(b.a.x, b.b.x) - reach, Math.min(b.a.y, b.b.y) - reach, Math.max(b.a.x, b.b.x) + reach, Math.max(b.a.y, b.b.y) + reach)]
      .filter((j) => j !== i && dist(bodies[j].a, bodies[j].b) >= 2 * L);
    // inside one wall
    if (hosts.some((j) => inside(b.a, bodies[j]) && inside(b.b, bodies[j]))) return false;
    // a short slanted stroke across a corner or ticked off a wall (the wall
    // hatch's 45° strokes at an inside corner): no wall runs on a slant to
    // every wall it touches for under 1'-6"
    if (L <= 1.5 && hosts.some((j) => inside(b.a, bodies[j], reach) || inside(b.b, bodies[j], reach))) {
      const slant = hosts.every((j) => {
        const c = Math.abs(dot(norm(sub(b.b, b.a)), norm(sub(bodies[j].b, bodies[j].a))));
        return c > Math.sin(10 * Math.PI / 180) && c < Math.cos(10 * Math.PI / 180);
      });
      if (slant) return false;
    }
    return true;
  });
}

