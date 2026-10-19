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
  sub, dot, cross, len, norm, perp, lineAngle, angleDiff, dist, GridIndex,
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
  thickMaxT: 36 * IN,       // an old masonry wall (a mill's brick): up to this thick …
  thickMinLen: 8,           // … when both faces run on together at least this far (ft)
  minBodyLen: 0.45,         // ft
  peakTol: 0.75 * IN,
  seriesTol: 0.1,           // 10% spacing match → evenly spaced hatch
  hairlineRatio: 0.4,       // lighter than this × the sheet's wall pen: not a wall face
  thickPenRatio: 0.25,      // a thick masonry wall's faces: at least this × the wall pen
  windowBays: true,         // a thick wall runs on across its window bays (solid below the sill)
  casework: true,           // a hairline-faced strip against a wall is casework, not wall
  shareThickFaces: true,    // a brick wall may share its face with a wall built against it
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
      s0: Math.min(s0, s1), s1: Math.max(s0, s1), w: r.w || 0, wl: !!r.wl, ann: !!r.ann, glass: !!r.glass, src: r.src || 'vector',
    });
  }
  return out;
}

/**
 * A dashed line — hidden, overhead, demolished, a basement wall's outer face
 * below grade — comes off the sheet as a row of short pieces at an even
 * pitch (a dash-dot's dots are too short to keep). Four or more in a row
 * become one line marked `dashed`: never a wall face of its own, at most the
 * hidden face of a thick wall whose other face is drawn solid.
 */
const DASH = { maxLen: 3, minGap: 0.05, maxGap: 1.5, minCount: 4, spread: 2.5 };
function dashRuns(runs, at) {
  const out = [];
  const len = (r) => r.s1 - r.s0;
  let i = 0;
  while (i < runs.length) {
    let j = i;
    while (j + 1 < runs.length && len(runs[j]) <= DASH.maxLen && len(runs[j + 1]) <= DASH.maxLen) {
      const gap = runs[j + 1].s0 - runs[j].s1;
      if (gap < DASH.minGap || gap > DASH.maxGap) break;
      j++;
    }
    const seq = runs.slice(i, j + 1);
    const gaps = seq.slice(1).map((r, k) => r.s0 - seq[k].s1);
    const even = (xs) => xs.length && Math.max(...xs) <= DASH.spread * Math.min(...xs);
    if (seq.length >= DASH.minCount && even(gaps) && even(seq.map(len))) {
      const pens = seq.map((r) => r.w).sort((p, q) => p - q);
      out.push({
        a: at(seq[0].s0), b: at(seq[seq.length - 1].s1), w: pens[Math.floor(pens.length / 2)],
        wl: seq.some((r) => r.wl), ann: seq.filter((r) => r.ann).length > seq.length / 2,
        dup: seq.reduce((acc, r) => acc + r.dup, 0), dashed: true,
      });
    } else {
      for (const r of seq) out.push({ a: r.a, b: r.b, w: r.w, wl: r.wl, ann: r.ann, dup: r.dup, ...(r.glass ? { glass: true } : {}), ...(r.pens ? { pens: r.pens } : {}) });
    }
    i = j + 1;
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
      return { rho: (dot(pa, n) + dot(pb, n)) / 2, s0: Math.min(a, b), s1: Math.max(a, b), w: l.w, wl: !!l.wl, ann: l.ann, glass: l.glass, src: l.src, orig: { a: pa, b: pb } };
    }).sort((p, q) => p.rho - q.rho);
    // band by rho (again anchored on the band's first line)
    let band = [];
    const flush = () => {
      if (!band.length) return;
      if (band.length === 1) {
        // a line with nothing to merge with is emitted exactly as drawn
        const o = band[0].orig;
        merged.push({ a: { ...o.a }, b: { ...o.b }, w: band[0].w, wl: band[0].wl, ann: band[0].ann, dup: 1, ...(band[0].glass ? { glass: true } : {}) });
        band = [];
        return;
      }
      const rho = band.reduce((s, l) => s + l.rho * (l.s1 - l.s0), 0) / band.reduce((s, l) => s + (l.s1 - l.s0), 0);
      band.sort((p, q) => p.s0 - q.s0);
      // the run's pen: the heaviest weight drawing at least half as much of it
      // as the most-used one — a wall face doubled by a lighter gypsum line is
      // heavy; a long hairline dimension string that brushes a few heavy
      // wall end-caps stays a hairline
      const pen = new Map();
      let annL = 0, allL = 0, glassL = 0;   // a run drawn mostly in an annotation colour is annotation (mostly glazing: glass)
      const addPen = (l) => { pen.set(l.w, (pen.get(l.w) || 0) + (l.s1 - l.s0)); allL += l.s1 - l.s0; if (l.ann) annL += l.s1 - l.s0; if (l.glass) glassL += l.s1 - l.s0; };
      const runW = () => {
        const most = Math.max(...pen.values());
        return Math.max(...[...pen].filter(([, L]) => L >= most * 0.5).map(([pw]) => pw));
      };
      let a = band[0].s0, b = band[0].s1, wl = band[0].wl, cnt = 1;
      addPen(band[0]);
      // which pen draws which stretch: a run that changes pen along its
      // length (a wall face running on as a vanity's hairline) is judged by
      // the stretch a pair uses (see penOn)
      let pieces = [band[0]];
      const runs = [];
      const at = (sv) => ({ x: u.x * sv + n.x * rho, y: u.y * sv + n.y * rho });
      const emit = () => runs.push({ a: at(a), b: at(b), s0: a, s1: b, w: runW(), wl, ann: annL > allL / 2, dup: cnt, ...(glassL > allL / 2 ? { glass: true } : {}),
        ...(pen.size > 1 ? { pens: pieces.map((pc) => ({ a: at(pc.s0), b: at(pc.s1), w: pc.w })) } : {}) });
      let first = band[0];
      const emitRun = () => {
        if (cnt === 1) runs.push({ a: { ...first.orig.a }, b: { ...first.orig.b }, s0: a, s1: b, w: first.w, wl, ann: first.ann, dup: 1, ...(first.glass ? { glass: true } : {}) });
        else emit();
      };
      for (let i = 1; i < band.length; i++) {
        const l = band[i];
        if (l.s0 <= b + opt.collinearGapTol) { b = Math.max(b, l.s1); wl = wl || l.wl; cnt++; addPen(l); pieces.push(l); }
        else { emitRun(); a = l.s0; b = l.s1; wl = l.wl; cnt = 1; first = l; pen.clear(); annL = allL = glassL = 0; addPen(l); pieces = [l]; }
      }
      emitRun();
      merged.push(...dashRuns(runs, at));
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
 * The pen a line is drawn with along [o0, o1] (projected on u). A merged run
 * that changes pen along its length carries its pieces (`pens`). Within the
 * span its own pen covers, it is that line (a stretch of wall drawn on a
 * lighter layer between heavier ones is still the wall); a stretch that runs
 * on past the end of it — a wall face running on as a vanity's edge — is
 * judged by the pen that draws that stretch (the heaviest drawing at least
 * half as much as the most-used one, as for a whole run in mergeCollinear).
 */
function penOn(l, o0, o1, u) {
  if (!l.pens) return l.w;
  const span = (pc) => [Math.min(dot(pc.a, u), dot(pc.b, u)), Math.max(dot(pc.a, u), dot(pc.b, u))];
  let h0 = Infinity, h1 = -Infinity;
  for (const pc of l.pens) if (pc.w >= l.w) { const [s0, s1] = span(pc); h0 = Math.min(h0, s0); h1 = Math.max(h1, s1); }
  const past = [[o0, Math.min(o1, h0)], [Math.max(o0, h1), o1]].filter(([a, b]) => b - a > 0);
  if (past.reduce((acc, [a, b]) => acc + b - a, 0) < 0.5 * (o1 - o0)) return l.w;
  const mass = new Map();
  for (const pc of l.pens) {
    const [s0, s1] = span(pc);
    for (const [a, b] of past) {
      const ov = Math.min(b, s1) - Math.max(a, s0);
      if (ov > 0) mass.set(pc.w, (mass.get(pc.w) || 0) + ov);
    }
  }
  if (!mass.size) return l.w;
  const most = Math.max(...mass.values());
  return Math.max(...[...mass].filter(([, L]) => L >= most * 0.5).map(([pw]) => pw));
}

/**
 * Pair parallel lines into wall bodies.
 * @returns {{ bodies: {a,b,t,conf,w}[], faces: {a,b}[], lines: object[], hatch: Set<number>, stats: object }}
 */
export function pairWalls(rawLines, options = {}) {
  const opt = { ...WALL_DEFAULTS, ...options };
  const lines = mergeCollinear(rawLines, opt).map((l, i) => {
    const d = sub(l.b, l.a), L = len(d), u = norm(d);
    return { ...l, id: i, len: L, u, th: lineAngle(l.a, l.b), cov: [], tcov: [] };
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
      if (d < opt.minT || d > opt.thickMaxT) continue;
      // past the usual thickness only a long pair can be a wall — one long
      // run, or the piers of a brick wall between its window bays (short
      // pairs sharing one face at one thickness: summed below)
      const thick = d > opt.maxT;
      if (thick && o1 - o0 < Math.max(opt.minBodyLen, 1.5)) continue;
      // a dashed line is only ever the hidden face of a thick wall
      if ((l.dashed || m.dashed) && (!thick || (l.dashed && m.dashed))) continue;
      const c = { i: l.id, j, d, o0, o1, overlap: o1 - o0, thick, wi: penOn(l, o0, o1, u), wj: penOn(m, o0, o1, u) };
      cands.push(c);
      if (thick) continue;
      partners[l.id].push({ j, d, side: Math.sign(side), o0, o1 });
      partners[j].push({ j: l.id, d, side: -Math.sign(side), o0, o1 });
    }
  }

  // ---- piers: short thick pairs along one face at one thickness add up ----
  {
    const run = new Map();
    const keys = (c) => {
      const l = lines[c.i], m = lines[c.j];
      const sl = Math.sign(dot(sub(m.a, l.a), perp(l.u)) + dot(sub(m.b, l.a), perp(l.u)));
      const sm = Math.sign(dot(sub(l.a, m.a), perp(m.u)) + dot(sub(l.b, m.a), perp(m.u)));
      const dk = Math.round(c.d / (1.5 * IN));
      return [`${c.i}|${sl}|${dk}`, `${c.j}|${sm}|${dk}`];
    };
    for (const c of cands) if (c.thick) for (const k of keys(c)) run.set(k, (run.get(k) || 0) + c.overlap);
    for (const c of cands) if (c.thick && c.overlap < opt.thickMinLen && !keys(c).some((k) => run.get(k) >= opt.thickMinLen)) c.dead = true;
    for (let k = cands.length - 1; k >= 0; k--) if (cands[k].dead) cands.splice(k, 1);
  }

  // ---- a thick masonry wall is solid between its faces: a pair with other
  // faces running inside it for most of its length (a layered wall and the
  // deck edge beside it, two walls side by side) is not one thick wall. The
  // window frames in a mill wall's bays are short beside its run.
  for (const c of cands) {
    if (!c.thick) continue;
    const l = lines[c.i], u = l.u, n = perp(u);
    const r0 = dot(l.a, n), r1 = dot(lines[c.j].a, n);
    const lo = Math.min(r0, r1) + opt.minT / 2, hi = Math.max(r0, r1) - opt.minT / 2;
    const ivs = [];
    const mid = { x: (l.a.x + l.b.x) / 2, y: (l.a.y + l.b.y) / 2 };
    const R = dist(l.a, l.b) / 2 + opt.thickMaxT;
    for (const k of idx.query(mid.x - R, mid.y - R, mid.x + R, mid.y + R)) {
      if (k === c.i || k === c.j) continue;
      const q = lines[k];
      if (angleDiff(l.th, q.th) > opt.pairAngTol) continue;
      const rq = (dot(q.a, n) + dot(q.b, n)) / 2;
      if (rq <= lo || rq >= hi) continue;
      const a0 = Math.max(c.o0, Math.min(dot(q.a, u), dot(q.b, u))), a1 = Math.min(c.o1, Math.max(dot(q.a, u), dot(q.b, u)));
      if (a1 > a0) ivs.push([a0, a1]);
    }
    ivs.sort((p, q) => p[0] - q[0]);
    let cov = 0, end = -Infinity;
    for (const [a0, a1] of ivs) { if (a1 <= end) continue; cov += a1 - Math.max(a0, end); end = a1; }
    if (cov > 0.5 * c.overlap) c.dead = true;
  }
  for (let k = cands.length - 1; k >= 0; k--) if (cands[k].dead) cands.splice(k, 1);

  // ---- line weight: on a sheet plotted with line weights, a wall cut in
  // plan is drawn with the heavy pen and furniture, fixtures, casework and
  // dimension lines with hairlines. When the candidates show a clear heavy
  // class, a pair whose heavier line is still a hairline (under 40% of that
  // weight) is not a wall — two parallel hairlines are a wardrobe, a tub, a
  // dimension line beside a cabinet. A heavy face paired with a light one
  // stays (an exterior wall drawn heavy outside, light inside). Each pair's
  // say is capped, so one long border or dimension can't set the weight.
  const heavyW = (() => {
    const mass = new Map();
    let total = 0;
    for (const c of cands) {
      if (c.thick) continue;
      const w = Math.max(c.wi || 0, c.wj || 0);
      if (!(w > 0)) continue;
      const key = Math.round(Math.log(w) / Math.log(1.08));
      const m = Math.min(c.overlap, 10);
      mass.set(key, (mass.get(key) || 0) + m); total += m;
    }
    const keys = [...mass.keys()].sort((p, q) => q - p);
    const k = keys.find((x) => mass.get(x) >= total * 0.15);
    return k == null ? 0 : Math.pow(1.08, k);
  })();
  // A light line in an annotation colour (a dimension string, a grid line)
  // is never a wall face. A thick masonry pair needs both faces in a wall
  // pen — an existing wall is often plotted lighter than new work, but a
  // hairline dimension string three feet off a wall is not its other face.
  const light = (w, ratio) => heavyW > 0 && (w || 0) < heavyW * ratio;
  const hairline = (c) => {
    const l = lines[c.i], m = lines[c.j];
    // a glass wall (both faces on the window layer, a storefront's full run) is drawn light by convention
    if (l.glass && m.glass && !c.thick) return false;
    if ((l.ann && light(c.wi, opt.hairlineRatio)) || (m.ann && light(c.wj, opt.hairlineRatio))) return true;
    if (c.thick) return l.ann || m.ann || light(c.wi, opt.thickPenRatio) || light(c.wj, opt.thickPenRatio);
    return heavyW > 0 && Math.max(c.wi || 0, c.wj || 0) < heavyW * opt.hairlineRatio;
  };

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
  // a hatch or tile pattern is drawn with one pen: four short lines a few
  // inches apart in four different pens (a door leaf, a wall's two faces, the
  // washer box beside it) are drawing that happens to line up
  const onePen = (ids) => {
    const n = new Map();
    for (const i of ids) { const key = lines[i].w > 0 ? Math.round(Math.log(lines[i].w) / Math.log(1.1)) : 'none'; n.set(key, (n.get(key) || 0) + 1); }
    return Math.max(...n.values()) >= Math.ceil(0.75 * ids.length);
  };
  // (four or five short lines in the sheet's wall pen are a layered wall's faces
  // where it stops at a door — block with a stud wall either side — not hatch)
  const wallPen = (ids) => heavyW > 0 && ids.filter((i) => lines[i].w >= 0.8 * heavyW).length >= Math.ceil(0.75 * ids.length);
  const isPattern = (ids, d) => ids.length >= 6 || (ids.length >= 4 && medianLen(ids) < 10 * d && onePen(ids) && !wallPen(ids));
  // a wall face that happens to line up with a pattern's strokes (a long
  // exterior face beside a row of short window-frame or tread lines) is
  // not one of them
  // (or a wall face several times its strokes' length: a thick old wall's
  // inner face lines up with the window-frame strokes in its bays)
  const strokeLen = (ids) => {
    const ls = ids.map((i) => lines[i].len).sort((a, b) => a - b);
    return ls[Math.floor((ls.length - 1) / 4)];
  };
  // (or a face that crosses the pattern only where it turns a corner: a
  // wall's face running on through the poché strokes of the wall it meets —
  // the strokes cover under half of it)
  const strokeCover = (i, ids) => {
    const l = lines[i], u = l.u, a0 = dot(l.a, u), a1 = dot(l.b, u), lo = Math.min(a0, a1), hi = Math.max(a0, a1);
    const ivs = [], short = 2 * medianLen(ids);
    for (const k of ids) {
      if (k === i || lines[k].len >= short) continue;
      const q = lines[k], b0 = dot(q.a, u), b1 = dot(q.b, u);
      const s0 = Math.max(lo, Math.min(b0, b1)), s1 = Math.min(hi, Math.max(b0, b1));
      if (s1 > s0) ivs.push([s0, s1]);
    }
    ivs.sort((p, q) => p[0] - q[0]);
    let cov = 0, end = -Infinity;
    for (const [s0, s1] of ivs) { if (s1 <= end) continue; cov += s1 - Math.max(s0, end); end = s1; }
    return cov / Math.max(hi - lo, 1e-9);
  };
  const outlier = (i, ids, d) => lines[i].len >= Math.max(10 * d, 2 * medianLen(ids))
    || lines[i].len >= Math.max(3 * strokeLen(ids), 4 * d)
    || (lines[i].len >= 2 * medianLen(ids) && strokeCover(i, ids) < 0.5);
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
    if (hatch.has(c.i) || hatch.has(c.j) || hairline(c) || c.thick) continue;
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
    c.typical = !!pk && !c.thick;
    c.prio = c.thick ? 2 : pk ? 0 : 1;
  }
  // A wall face's true partner is the one it runs alongside the longest: a sink
  // or shelf line may sit a "wall thickness" off the face, but only for a short
  // stretch. Longer overlap first, then the thinner spacing.
  // (overlaps within 1/2" are a tie: the thinner spacing wins, not float noise)
  // On a sheet drawn with pen weights, both faces in a wall pen first: a heavy
  // face's hairline partner (the tub's apron, a vanity's front a few inches
  // off the wall) is only its partner where no heavy face runs beside it.
  const mixed = (c) => (heavyW > 0 && light(Math.min(c.wi || 0, c.wj || 0), opt.hairlineRatio) ? 1 : 0);
  cands.sort((p, q) => p.prio - q.prio || mixed(p) - mixed(q) || (Math.abs(q.overlap - p.overlap) > 0.04 ? q.overlap - p.overlap : 0) || p.d - q.d);
  const debugPairs = /** @type {any} */ (opt)._debugPairs;
  if (Array.isArray(debugPairs)) debugPairs.push({ peaks, heavyW, cands, lines, hatch });

  // ---- greedy assignment with per-line interval coverage ----
  let bodies = [];
  for (const c of cands) {
    if (hatch.has(c.i) || hatch.has(c.j)) continue;
    if (!c.typical && c.d < opt.minTAtypical) continue;
    if (hairline(c)) continue;
    const l = lines[c.i], m = lines[c.j];
    const u = l.u;
    // coverage of l is stored in l's own param (dot with l.u); m's in m's.
    const sOf = (line, p) => dot(p, line.u);
    // a thick masonry wall may share its face with a wall built against it
    // (the new partition along an old brick wall: one line, both walls'
    // face); mergeLayers makes them one wall. Thick walls don't overlap each
    // other. Only on a sheet drawn with pen weights, where a counter's or a
    // bench's line (a hairline) can't be a masonry face.
    const share = c.thick && heavyW > 0 && opt.shareThickFaces !== false && !light(c.wi, opt.hairlineRatio) && !light(c.wj, opt.hairlineRatio);
    const covL = share ? l.tcov : l.cov;
    // m's coverage is stored along m.u; rebuild the points and project onto u.
    const mPerp = dot(m.a, perp(m.u));
    const covMProj = (share ? m.tcov : m.cov).map(([a, b]) => {
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
      // faced on one side by a hairline that isn't on a wall layer: maybe casework against a wall
      const lightFace = heavyW > 0 && [[l, c.wi], [m, c.wj]].some(([x, w]) => !x.wl && (w || 0) < heavyW * opt.hairlineRatio);
      bodies.push({ a: A, b: B, t: c.d, conf, w: Math.max(c.wi, c.wj), wmin: Math.min(c.wi, c.wj), typical: c.typical, src: 'paired', ...(c.thick ? { faces: [c.i, c.j] } : {}), ...(lightFace ? { lightFace: true } : {}) });
      addInterval(l.cov, a, b);
      if (c.thick) addInterval(l.tcov, a, b);
      // store m coverage in m's own param
      const ma = sOf(m, f0), mb = sOf(m, f1);
      addInterval(m.cov, Math.min(ma, mb), Math.max(ma, mb));
      if (c.thick) addInterval(m.tcov, Math.min(ma, mb), Math.max(ma, mb));
    }
  }

  // ---- window bays: a thick masonry wall is drawn cut at window height, so
  // between its piers the plan shows the window recess, not the wall. Below
  // the sill the wall is solid: the floor stops at its inner face. Piers
  // that pair with one unbroken face line, a bay's width apart, are one
  // wall running on across the bay.
  if (opt.windowBays !== false) {
    const thick = bodies.filter((b) => b.faces);
    for (let x = 0; x < thick.length; x++) {
      for (let y = 0; y < thick.length; y++) {
        const p = thick[x], q = thick[y];
        if (p === q) continue;
        const shared = p.faces.find((f) => q.faces.includes(f));
        if (shared == null || Math.abs(p.t - q.t) > 2 * IN) continue;
        const line = lines[shared], u = line.u;
        const along = (pt) => dot(pt, u);
        const p1 = Math.max(along(p.a), along(p.b));
        const q0 = Math.min(along(q.a), along(q.b));
        if (q0 < p1) continue;                       // q must lie past p along the face
        const gap = q0 - p1;
        if (gap < 0.05 || gap > 12) continue;        // a window bay, not a run of wall missing
        // nothing nearer between them (only the next pier closes a bay)
        if (thick.some((o) => o !== p && o !== q && o.faces.includes(shared) && Math.max(along(o.a), along(o.b)) > p1 + 0.05 && Math.min(along(o.a), along(o.b)) < q0 - 0.05)) continue;
        const [l0, l1] = [along(line.a), along(line.b)].sort((a, b) => a - b);
        if (l0 > p1 + 0.05 || l1 < q0 - 0.05) continue; // the face runs unbroken across the bay
        const n = perp(u), r = (dot(p.a, n) + dot(p.b, n) + dot(q.a, n) + dot(q.b, n)) / 4;
        const at = (sv) => ({ x: u.x * sv + n.x * r, y: u.y * sv + n.y * r });
        bodies.push({ a: at(p1), b: at(q0), t: (p.t + q.t) / 2, conf: Math.min(p.conf, q.conf), w: p.w, wmin: p.wmin, typical: false, src: 'paired', bay: true });
      }
    }
  }

  if (opt.casework !== false) bodies = dropCasework(bodies, opt);

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
      hatchLines: hatch.size, peaks: peaks.map((p) => +(p.t * 12).toFixed(2)), bodies: bodies.length, heavyW,
      thickBodies: bodies.filter((b) => b.t > opt.maxT).length,
      dashedLines: lines.filter((l) => l.dashed).length, annotationLines: lines.filter((l) => l.ann).length,
    },
  };
}

/**
 * Casework against a wall: a strip faced by a hairline (`lightFace`) lying
 * face to face along a wall body (a toilet tank, a vanity, a counter run
 * drawn against the wall's heavy face) is not more wall — merged in, it
 * would carve a notch out of the room.
 */
export function dropCasework(bodies, { maxT = WALL_DEFAULTS.maxT } = {}) {
  const solid = bodies.filter((b) => !b.lightFace);
  const sIdx = new GridIndex(4);
  solid.forEach((b, i) => sIdx.insert(i, Math.min(b.a.x, b.b.x), Math.min(b.a.y, b.b.y), Math.max(b.a.x, b.b.x), Math.max(b.a.y, b.b.y)));
  const against = (p) => {
    const L = dist(p.a, p.b);
    if (L < 1e-6) return false;
    const u = norm(sub(p.b, p.a)), n = perp(u), rp = dot(p.a, n);
    const r = p.t / 2 + maxT;
    for (const j of sIdx.query(Math.min(p.a.x, p.b.x) - r, Math.min(p.a.y, p.b.y) - r, Math.max(p.a.x, p.b.x) + r, Math.max(p.a.y, p.b.y) + r)) {
      const q = solid[j];
      if (dist(q.a, q.b) < 1e-6 || Math.abs(cross(u, norm(sub(q.b, q.a)))) > 0.03) continue;
      const rq = (dot(q.a, n) + dot(q.b, n)) / 2;
      if (Math.abs(Math.abs(rq - rp) - (p.t + q.t) / 2) > 1.5 * IN) continue;   // face to face
      const s0 = Math.max(Math.min(dot(p.a, u), dot(p.b, u)), Math.min(dot(q.a, u), dot(q.b, u)));
      const s1 = Math.min(Math.max(dot(p.a, u), dot(p.b, u)), Math.max(dot(q.a, u), dot(q.b, u)));
      if (s1 - s0 >= 0.8 * L) return true;
    }
    return false;
  };
  return bodies.filter((b) => !(b.lightFace && against(b)));
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
        // 1–3" inside a foundation wall): one wall, the gap is no floor. Or
        // one inside the other: a wall drawn in layers (face lines, gypsum
        // lines, the fill's edge) pairs up twice, a thinner body stacked in
        // the thicker — still one wall, as thick as its outer faces
        const gap = Math.abs(rq - rp) - (p.t + q.t) / 2;
        if (gap > cavity) continue;
        const ps = [dot(p.a, u), dot(p.b, u)].sort((a, b) => a - b);
        const qs = [dot(q.a, u), dot(q.b, u)].sort((a, b) => a - b);
        const lo = Math.max(ps[0], qs[0]), hi = Math.min(ps[1], qs[1]);
        // (one inside the other, it's the same wall at any length: a door's
        // 6" jamb drawn on two layers)
        if (hi - lo < (gap < -touchTol ? Math.min(minOverlap, 0.1) : minOverlap)) continue;
        if (gap < -touchTol) {
          // overlapping: only the same wall twice — one band inside the
          // other, or the two sharing most of the thinner one's thickness (a
          // face paired with the far gypsum line, the near gypsum line with
          // the other face) — running together for most of both lengths
          const nested = Math.abs(rq - rp) + Math.min(p.t, q.t) / 2 <= Math.max(p.t, q.t) / 2 + touchTol;
          const shared = Math.min(rp + p.t / 2, rq + q.t / 2) - Math.max(rp - p.t / 2, rq - q.t / 2) >= 0.5 * Math.min(p.t, q.t);
          if (!(nested || shared)) continue;
          if (hi - lo < 0.5 * (ps[1] - ps[0]) || hi - lo < 0.5 * (qs[1] - qs[0])) {
            // a copy of part of a longer wall, lying in it, is that wall —
            // as it's drawn, not widened to the copy (two walls can't overlap)
            const pShort = ps[1] - ps[0] < qs[1] - qs[0];
            const [sb, lb, rs, rl] = pShort ? [p, q, rp, rq] : [q, p, rq, rp];
            if (hi - lo < 0.8 * Math.min(ps[1] - ps[0], qs[1] - qs[0])) continue;
            // (a short thicker body standing out of the wall is a pilaster, not a copy)
            if (Math.abs(rs - rl) + sb.t / 2 > lb.t / 2 + touchTol) continue;
            dead.add(pShort ? i : j); merged++;
            if (pShort) break;
            continue;
          }
        }
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

