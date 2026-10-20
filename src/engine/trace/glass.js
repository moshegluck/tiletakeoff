// ============================================================
// glass.js — storefronts: glazing too wide to bridge as an opening.
//
// A lobby's or vestibule's front is a run of glass between mullions, often
// with door pairs in it — 20–30 ft between the wall stubs at its ends, far
// past any doorway the trace bridges. Drawn on the window layer as short
// pieces of thin glazing (2" deep: too thin to pair as a wall), it left the
// rooms either side open. Read as a chain — glazing runs joined across
// mullions and across doorways drawn on the door layer — a chain wider than
// an opening is a glass wall: each glazing run becomes a wall body, and the
// doors between them are bridged as doors. Ordinary windows (a chain an
// opening's width or less) stay windows.
// Pure; no DOM. Units: feet.
// ============================================================

import { dot, dist, perp } from './vec.js';

const segDist = (p, a, b) => {
  const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
  return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y);
};

const IN = 1 / 12;

/**
 * @param {{a,b}[]} win   window-layer linework
 * @param {{a,b}[]} doors door-layer linework (leaves, swings, frames)
 * @param {{a,b}[]} [walls] wall-layer linework: a gap with wall faces along the line is a pier, not a doorway
 * @param {{ minSpan?: number, mullion?: number, maxDoor?: number, band?: number, minT?: number }} [opt]
 *   minSpan: a chain at least this wide is a storefront (ft; the widest opening bridged)
 * @returns {{a,b,t,conf,src:string}[]} glass wall bodies
 */
export function storefronts(win, doors, walls = [], { minSpan = 16, mullion = 1.0, maxDoor = 10, band = 6 * IN, minT = 2.5 * IN } = {}) {
  const segs = win
    .map((l) => {
      const L = dist(l.a, l.b);
      if (L < 0.05) return null;
      let th = Math.atan2(l.b.y - l.a.y, l.b.x - l.a.x);
      if (th < 0) th += Math.PI;
      if (th >= Math.PI - 0.5 * Math.PI / 180) th -= Math.PI;
      return { l, th };
    })
    .filter(Boolean)
    .sort((p, q) => p.th - q.th);
  const out = [];
  // directions: lines within 1° of the group's first
  const groups = [];
  for (const s of segs) {
    const g = groups[groups.length - 1];
    if (g && s.th - g[0].th <= Math.PI / 180) g.push(s); else groups.push([s]);
  }
  for (const g of groups) {
    const th = g[0].th, u = { x: Math.cos(th), y: Math.sin(th) }, n = perp(u);
    const items = g.map(({ l }) => {
      const s0 = dot(l.a, u), s1 = dot(l.b, u);
      return { o: (dot(l.a, n) + dot(l.b, n)) / 2, s0: Math.min(s0, s1), s1: Math.max(s0, s1) };
    }).sort((p, q) => p.o - q.o);
    // bands: the glazing's lines lie within a few inches of each other
    const bands = [];
    for (const it of items) {
      const b = bands[bands.length - 1];
      if (b && it.o - b[0].o <= band) b.push(it); else bands.push([it]);
    }
    for (const b of bands) {
      // runs: pieces meeting across mullions
      b.sort((p, q) => p.s0 - q.s0);
      const runs = [];
      for (const it of b) {
        const r = runs[runs.length - 1];
        if (r && it.s0 <= r.s1 + mullion) { r.s1 = Math.max(r.s1, it.s1); r.o0 = Math.min(r.o0, it.o); r.o1 = Math.max(r.o1, it.o); }
        else runs.push({ s0: it.s0, s1: it.s1, o0: it.o, o1: it.o });
      }
      const om = (b[0].o + b[b.length - 1].o) / 2;
      // door-layer drawing near the line (leaves, swings, frames): where it lies along it
      const doorS = [];
      for (const d of doors) {
        for (const p of [d.a, d.b, { x: (d.a.x + d.b.x) / 2, y: (d.a.y + d.b.y) / 2 }]) {
          if (Math.abs(dot(p, n) - om) <= 2) doorS.push(dot(p, u));
        }
      }
      // wall faces along the line (within a foot of it): how much of [s0, s1] they cover
      const along = [];
      for (const w of walls) {
        const L = dist(w.a, w.b);
        if (L < 0.2 || Math.abs(dot({ x: (w.b.x - w.a.x) / L, y: (w.b.y - w.a.y) / L }, u)) < Math.cos(3 * Math.PI / 180)) continue;
        if (Math.abs((dot(w.a, n) + dot(w.b, n)) / 2 - om) > 1) continue;
        const a = dot(w.a, u), b = dot(w.b, u);
        along.push([Math.min(a, b), Math.max(a, b)]);
      }
      const walled = (s0, s1) => along.reduce((acc, [a, b]) => acc + Math.max(0, Math.min(b, s1) - Math.max(a, s0)), 0) > 0.5;
      // a doorway between two runs: door drawing in the gap, no wall along it (a pier)
      const doorIn = (s0, s1) => doorS.some((s) => s > s0 && s < s1) && !walled(s0, s1);
      // chains: runs joined across doorways; the doors at either end of one
      // (a pair of entrance doors each side of a sidelight) are part of its span
      let chain = [runs[0]];
      const flush = () => {
        const s0 = chain[0].s0, s1 = chain[chain.length - 1].s1;
        let lead = Math.min(s0, ...doorS.filter((s) => s < s0 && s >= s0 - maxDoor));
        let trail = Math.max(s1, ...doorS.filter((s) => s > s1 && s <= s1 + maxDoor));
        if (walled(lead, s0)) lead = s0;
        if (walled(s1, trail)) trail = s1;
        const span = trail - lead;
        // it stands in a wall line: wall drawing at both its ends (skylight
        // glazing drawn overhead floats in the room)
        const at = (sv) => ({ x: u.x * sv + n.x * om, y: u.y * sv + n.y * om });
        const held = (p) => walls.some((w) => segDist(p, w.a, w.b) <= 1);
        if (span >= minSpan && held(at(lead)) && held(at(trail))) {
          for (const r of chain) {
            if (r.s1 - r.s0 < 0.5) continue;
            const o = (r.o0 + r.o1) / 2;
            const pt = (sv) => ({ x: u.x * sv + n.x * o, y: u.y * sv + n.y * o });
            out.push({ a: pt(r.s0), b: pt(r.s1), t: Math.max(r.o1 - r.o0, minT), conf: 0.8, src: 'glass', glass: true });
          }
        }
      };
      for (let i = 1; i < runs.length; i++) {
        const p = chain[chain.length - 1], r = runs[i];
        const gap = r.s0 - p.s1;
        if (gap <= maxDoor && doorIn(p.s1, r.s0)) chain.push(r);
        else { flush(); chain = [r]; }
      }
      flush();
    }
  }
  return out;
}

