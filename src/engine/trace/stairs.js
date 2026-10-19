// ============================================================
// stairs.js — stair runs on the sheet. A run is drawn as its treads: five
// or more parallel lines 9"–13" apart, the stair's width long, ends in
// line, with the stair's note beside it (UP / DN / 22R). The floor stops at
// the run: an estimator takes the landings, not the treads.
// ============================================================
import { dot, perp, sub, GridIndex } from './vec.js';

const STAIR_TEXT = /\b(UP|DN|DOWN)\b|\b\d{1,2}\s*R\b|\bRISERS?\b|\bTREADS?\b|\bSTAIRS?\b/i;

/**
 * @param {{a,b}[]} lines   every line on the sheet (ft)
 * @param {{str,x,y}[]} texts  (ft)
 * @returns {{ poly: {x,y}[], treads: number, going: number, width: number, at: {x,y} }[]}
 */
export function findStairs(lines, texts, { minTreads = 5, minGoing = 0.7, maxGoing = 1.15, minW = 2, maxW = 9 } = {}) {
  const cands = [];
  for (const l of lines) {
    const d = sub(l.b, l.a), L = Math.hypot(d.x, d.y);
    if (L < minW || L > maxW) continue;
    let th = Math.atan2(d.y, d.x);
    if (th < 0) th += Math.PI;
    if (th >= Math.PI - 1e-3) th -= Math.PI;
    cands.push({ l, L, th, mid: { x: (l.a.x + l.b.x) / 2, y: (l.a.y + l.b.y) / 2 } });
  }
  const idx = new GridIndex(4);
  cands.forEach((c, i) => idx.insert(i, c.mid.x, c.mid.y, c.mid.x, c.mid.y));
  const notes = texts.filter((t) => STAIR_TEXT.test(String(t.str || '')));
  const used = new Uint8Array(cands.length);
  const out = [];
  for (let i = 0; i < cands.length; i++) {
    if (used[i]) continue;
    const c = cands[i];
    const u = { x: Math.cos(c.th), y: Math.sin(c.th) }, n = perp(u);
    // its neighbours: parallel, the same length, ends in line, stacked across
    const R = maxGoing * 30;
    const near = [];
    for (const j of idx.query(c.mid.x - R, c.mid.y - R, c.mid.x + R, c.mid.y + R)) {
      const q = cands[j];
      if (Math.abs(q.th - c.th) > 0.02 && Math.abs(Math.abs(q.th - c.th) - Math.PI) > 0.02) continue;
      if (Math.abs(q.L - c.L) > 0.15 * c.L) continue;
      if (Math.abs(dot(sub(q.mid, c.mid), u)) > 0.2 * c.L) continue;
      near.push({ j, off: dot(sub(q.mid, c.mid), n) });
    }
    near.sort((p, q) => p.off - q.off);
    // dedupe doubled lines, then the longest run at an even going through c
    const offs = [];
    for (const p of near) if (!offs.length || p.off - offs[offs.length - 1].off > 0.1) offs.push(p);
    const at = offs.findIndex((p) => Math.abs(p.off) < 0.05);
    if (at < 0) continue;
    let best = null;
    for (const dir of [1, -1]) {
      const k = at + dir;
      if (k < 0 || k >= offs.length) continue;
      const g = Math.abs(offs[k].off - offs[at].off);
      if (g < minGoing || g > maxGoing) continue;
      // walk both ways at this going
      const run = [offs[at]];
      for (const s of [1, -1]) {
        let cur = offs[at];
        for (let m = at + s; m >= 0 && m < offs.length; m += s) {
          const step = Math.abs(offs[m].off - cur.off);
          if (step < g * 0.85) continue;
          if (step > g * 1.15) break;
          run.push(offs[m]); cur = offs[m];
        }
      }
      if (!best || run.length > best.run.length) best = { run, g };
    }
    if (!best || best.run.length < minTreads) continue;
    const ids = best.run.map((p) => p.j);
    for (const j of ids) used[j] = 1;
    const o0 = Math.min(...best.run.map((p) => p.off)), o1 = Math.max(...best.run.map((p) => p.off));
    const s0 = Math.min(...ids.map((j) => Math.min(dot(cands[j].l.a, u), dot(cands[j].l.b, u))));
    const s1 = Math.max(...ids.map((j) => Math.max(dot(cands[j].l.a, u), dot(cands[j].l.b, u))));
    const base = dot(c.mid, n);
    const P = (s, o) => ({ x: u.x * s + n.x * (base + o), y: u.y * s + n.y * (base + o) });
    const poly = [P(s0, o0), P(s1, o0), P(s1, o1), P(s0, o1)];
    const ctr = P((s0 + s1) / 2, (o0 + o1) / 2);
    // the stair's note: in the run or within a few feet of it
    const reach = 4;
    const noted = notes.some((t) => {
      const ts = dot(t, u), to = dot(t, n) - base;
      return ts > s0 - reach && ts < s1 + reach && to > o0 - reach && to < o1 + reach;
    });
    if (!noted) continue;
    // a run found again from a doubled tread is the same run
    if (out.some((o) => inside(ctr, o.poly))) continue;
    out.push({ poly, treads: ids.length, going: best.g, width: s1 - s0, at: ctr });
  }
  return out;
}

const inside = (p, poly) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
};

/** The part of polygon `poly` inside the convex polygon `clip` (Sutherland–Hodgman). */
export function clipToConvex(poly, clip) {
  let out = poly;
  const sgn = Math.sign(area(clip)) || 1;
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length];
    const side = (p) => sgn * ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x));
    const next = [];
    for (let k = 0; k < out.length; k++) {
      const p = out[k], q = out[(k + 1) % out.length];
      const sp = side(p), sq = side(q);
      if (sp >= 0) next.push(p);
      if ((sp >= 0) !== (sq >= 0)) { const t = sp / (sp - sq); next.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t }); }
    }
    out = next;
  }
  return out;
}

/** Signed area of a polygon. */
export function area(poly) {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += poly[j].x * poly[i].y - poly[i].x * poly[j].y;
  return s / 2;
}

/**
 * Take each stair run off the floor of the room it stands in: the run is a
 * hole in the room's floor (`area`; `areaFaces` keeps it — a room tag counts
 * the stair in the room), noted at the stair.
 * @returns {{ id: string, severity: string, kind: string, at: {x,y}, msg: string, roomId: string }[]} flags
 */
export function takeStairsOffFloors(rooms, stairs, fmt = (v) => `${v.toFixed(0)} SF`) {
  const flags = [];
  for (const st of stairs) {
    for (const r of rooms) {
      if (r.type === 'nofloor') continue;
      const part = clipToConvex(r.poly, st.poly);
      const a = part.length >= 3 ? Math.abs(area(part)) : 0;
      if (a < 1) continue;
      (r.holes ||= []).push(part);
      (r.stairHoles ||= []).push(part);
      r.area -= a;
      r.stairSf = (r.stairSf || 0) + a;
      flags.push({ id: `fs${flags.length + 1}`, severity: 'info', kind: 'stair', at: st.at, roomId: r.id,
        msg: `Stair run (${st.treads} treads) — ${fmt(a)} off ${r.name}'s floor (the landings stay)` });
    }
  }
  return flags;
}
