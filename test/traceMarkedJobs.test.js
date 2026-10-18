import { describe, it, expect } from 'vitest';
import { pairWalls } from '../src/engine/trace/walls.js';
import { evidenceToFeet } from '../src/lib/planEvidence.js';
import { cadText, markGlyphs } from '../src/lib/pdfVectors.js';
import { arcsFromDashes, isDoorSwing } from '../src/engine/trace/arcs.js';

// Regressions from Moshe's marked jobs (454 Saddle River Rd, the Herzka
// residence, Promenade at Middletown): AutoCAD sheets whose SHX text is
// plotted as strokes, poché drawn as hatch strokes, layers named in Russian
// and French. Each case below read wrong before.

const IN = 1 / 12;
const HEAVY = 2.88 / 36;   // the sheet's wall pen, in feet
const hline = (y, x0, x1, w = HEAVY) => ({ a: { x: x0, y }, b: { x: x1, y }, w });
const vline = (x, y0, y1, w = HEAVY) => ({ a: { x, y: y0 }, b: { x, y: y1 }, w });

describe('marked jobs — SHX text, poché strokes', () => {
  it('reads AutoCAD text codes as words: %%u underlines drop out', () => {
    expect(cadText('%%uGUEST %%uBATH #3')).toBe('GUEST BATH #3');
    expect(cadText('%%uPOWDER #1')).toBe('POWDER #1');
    expect(cadText('45%%d')).toBe('45°');
    expect(cadText('%%c4" PIPE')).toBe('Ø4" PIPE');
    expect(cadText('50%%% OFF')).toBe('50% OFF');
  });

  it("a room name's letters and underline are text, not walls (Herzka's FAMILY ROOM)", () => {
    // "FAMILY" and "ROOM" as SHX annotations, each underlined by a heavy
    // stroke inside its box: the two underlines 31 px apart read as a 10"
    // wall that cut the family room in two
    const texts = [
      { str: 'FAMILY', x: 3467, y: 1801, w: 94, h: 34, rot: 0, shx: true },
      { str: 'ROOM', x: 3467, y: 1832, w: 78, h: 32, rot: 0, shx: true },
    ];
    const lines = [
      { a: { x: 3424.3, y: 1810.4 }, b: { x: 3506.2, y: 1810.4 }, w: 2.16 },   // FAMILY's underline
      { a: { x: 3432.2, y: 1841.8 }, b: { x: 3498.2, y: 1841.8 }, w: 2.16 },   // ROOM's underline
      { a: { x: 3440, y: 1790 }, b: { x: 3440, y: 1812 }, w: 2.16 },           // the F's stem
      { a: { x: 3169, y: 1826 }, b: { x: 3763, y: 1826 }, w: 2.88 },           // a wall running past the label
    ];
    markGlyphs(lines, texts);
    expect(lines.map((l) => !!l.glyph)).toEqual([true, true, true, false]);
    const k = 1 / 36;
    const input = evidenceToFeet({ lines, curves: [], texts }, k, null);
    expect(input.lines.length).toBe(1);
    expect(input.lines[0].a.y).toBeCloseTo(1826 * k, 6);
  });

  it("a wall's face crossing the poché strokes of the wall it meets still pairs (Herzka's family room)", () => {
    // an exterior wall (5.5") running down x = 0, its poché drawn as short
    // strokes across it every 14.5"; at its top corner an exterior wall
    // runs east, 5.6" thick, its lower face in line with the strokes. The
    // face was taken as one more stroke and the east wall lost — the family
    // room behind it leaked out through the slider beside it
    const t = 5.5 * IN, s = 14.56 * IN, top = 0, bot = 5.6 * IN;
    const lines = [
      vline(0, top, 30), vline(t, bot, 30),
      hline(top, 0, 3.71), hline(bot, 0, 3.71),
    ];
    for (let k = 1; k <= 24; k++) lines.push(hline(bot + k * s, 0, t, 0));
    const res = pairWalls(lines, {});
    const east = res.bodies.find((b) => Math.abs(b.a.y - b.b.y) < 1e-6 && Math.max(b.a.x, b.b.x) > 3);
    expect(east).toBeTruthy();
    expect(east.t * 12).toBeCloseTo(5.6, 1);
    // the strokes are still a pattern, never walls
    expect(res.bodies.every((b) => Math.abs(b.a.y - b.b.y) < 1e-6 ? Math.max(b.a.x, b.b.x) > 3 : true)).toBe(true);
  });

  it('reads a door swing plotted dashed (Saddle River: every door, 45° open)', () => {
    // hinge (0,0), r = 3', closed along +x, open at 45°: the arc as dashes of
    // two short pieces each, gaps between; the leaf drawn as a thin
    // rectangle whose corner meets the arc's open end
    const r = 3, pts = (a0, a1) => [a0, (a0 + a1) / 2, a1].map((a) => ({ x: r * Math.cos(a), y: r * Math.sin(a) }));
    const lines = [];
    const deg = Math.PI / 180;
    for (let a = 0; a < 45 - 1e-9; a += 9) {
      const p = pts(a * deg, (a + 6) * deg);
      lines.push({ a: p[0], b: p[1] }, { a: p[1], b: p[2] });
    }
    const open = { x: r * Math.cos(45 * deg), y: r * Math.sin(45 * deg) };
    lines.push({ a: open, b: { x: open.x - 0.06, y: open.y + 0.06 } });     // the leaf's short side at the open end
    // a straight dashed line nearby is no swing
    for (let x = 0; x < 6; x += 0.5) lines.push({ a: { x, y: -1 }, b: { x: x + 0.3, y: -1 } });
    const arcs = arcsFromDashes(lines);
    expect(arcs.length).toBe(1);
    expect(arcs[0].r).toBeCloseTo(3, 2);
    expect(arcs[0].c.x).toBeCloseTo(0, 2);
    expect(arcs[0].sweepDeg).toBeGreaterThan(35);
    expect(arcs[0].sweepDeg).toBeLessThan(50);   // (the leaf's side, tangent at the open end, carries it on a little)
    // a full swing plotted dashed is a door swing like any other
    const full = [];
    for (let a = 0; a < 90 - 1e-9; a += 9) { const p = pts(a * deg, (a + 6) * deg); full.push({ a: p[0], b: p[1] }, { a: p[1], b: p[2] }); }
    const f = arcsFromDashes(full);
    expect(f.length).toBe(1);
    expect(isDoorSwing(f[0])).toBe(true);
  });
});
