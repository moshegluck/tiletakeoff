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
      s0: Math.min(s0, s1), s1: Math.max(s0, s1), w: r.w || 0, src: r.src || 'vector',
    });
  }
  return out;
}

/** Merge collinear overlapping / abutting lines (kills doubled traces). */
export function mergeCollinear(raw, options = {}) {
  const opt = { ...WALL_DEFAULTS, ...options };
  const L = prep(raw, opt).sort((p, q) => p.th - q.th);
  const groups = [];
  let cur = [];
  for (const l of L) {
    if (cur.length && l.th - cur[cur.length - 1].th > opt.collinearAngTol) { groups.push(cur); cur = []; }
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
      return { rho: (dot(pa, n) + dot(pb, n)) / 2, s0: Math.min(a, b), s1: Math.max(a, b), w: l.w, src: l.src };
    }).sort((p, q) => p.rho - q.rho);
    // chain by rho
    let band = [];
    const flush = () => {
      if (!band.length) return;
      const rho = band.reduce((s, l) => s + l.rho * (l.s1 - l.s0), 0) / band.reduce((s, l) => s + (l.s1 - l.s0), 0);
      band.sort((p, q) => p.s0 - q.s0);
      let a = band[0].s0, b = band[0].s1, w = band[0].w, cnt = 1;
      const emit = () => merged.push({
        a: { x: u.x * a + n.x * rho, y: u.y * a + n.y * rho },
        b: { x: u.x * b + n.x * rho, y: u.y * b + n.y * rho }, w, dup: cnt,
      });
      for (let i = 1; i < band.length; i++) {
        const l = band[i];
        if (l.s0 <= b + opt.collinearGapTol) { b = Math.max(b, l.s1); w = Math.max(w, l.w); cnt++; }
        else { emit(); a = l.s0; b = l.s1; w = l.w; cnt = 1; }
      }
      emit();
      band = [];
    };
    for (const l of items) {
      if (band.length && l.rho - band[band.length - 1].rho > opt.collinearOffTol) flush();
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
 * @returns {{ bodies: {a,b,t,conf,w}[], lines: object[], stats: object }}
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
  // Four or more evenly spaced parallels = a hatch or tile pattern, not walls.
  // (Three can happen by coincidence: wall faces + one pattern line.)
  const hatch = new Set();
  const mids = lines.map((l) => ({ x: (l.a.x + l.b.x) / 2, y: (l.a.y + l.b.y) / 2 }));
  const extends4 = (x, d, from) => {
    // "further" is measured across the lines (along x's normal), never along them
    const nx = perp(lines[x].u);
    const away = dot(sub(mids[x], mids[from]), nx);
    return partners[x].some((r) => r.j !== from && Math.abs(r.d - d) / d <= opt.seriesTol &&
      dot(sub(mids[r.j], mids[x]), nx) * Math.sign(away) > d * 0.5);
  };
  for (const l of lines) {
    const ps = partners[l.id];
    for (const p of ps) {
      if (p.side >= 0) continue;
      for (const q of ps) {
        if (q.side <= 0) continue;
        if (Math.abs(p.d - q.d) / Math.max(p.d, q.d) > opt.seriesTol) continue;
        const ov = Math.min(p.o1, q.o1) - Math.max(p.o0, q.o0);
        if (ov < 0.6 * Math.min(p.o1 - p.o0, q.o1 - q.o0)) continue;
        const d = (p.d + q.d) / 2;
        if (!extends4(p.j, d, l.id) && !extends4(q.j, d, l.id)) continue;
        hatch.add(l.id); hatch.add(p.j); hatch.add(q.j);
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
  cands.sort((p, q) => p.prio - q.prio || (q.overlap - p.overlap) || p.d - q.d);

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
      if (b - a < opt.minBodyLen) continue;
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

  return {
    bodies: mergeBodies(bodies),
    lines,
    stats: {
      rawLines: rawLines.length, mergedLines: lines.length, candidates: cands.length,
      hatchLines: hatch.size, peaks: peaks.map((p) => +(p.t * 12).toFixed(2)), bodies: bodies.length,
    },
  };
}

/** Merge collinear bodies of similar thickness that overlap or nearly touch. */
export function mergeBodies(bodies, { angTol = 1 * Math.PI / 180, offTol = 1.0 * IN, gapTol = 1.0 * IN, tTol = 1.25 * IN } = {}) {
  const items = bodies.map((b) => ({ ...b, th: lineAngle(b.a, b.b), dead: false }));
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < items.length; i++) {
      const p = items[i]; if (p.dead) continue;
      for (let j = i + 1; j < items.length; j++) {
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
  return items.filter((b) => !b.dead).map(({ th, dead, ...b }) => b);
}
