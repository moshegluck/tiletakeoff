import { describe, it, expect } from 'vitest';
import { runTrace } from '../src/engine/trace/index.js';
import { pairWalls, mergeCollinear } from '../src/engine/trace/walls.js';
import { arcsFromPolylines, isDoorSwing } from '../src/engine/trace/arcs.js';
import { chromatic } from '../src/lib/pdfVectors.js';
import { wallsToLines } from './fixtures/planFactory.js';

// Regressions from an old mill converted to apartments + amenity space
// (1/8" basement plan, 34k lines): line weights, a blue dimension string,
// door swings flattened into straight pieces, walls drawn as face + gypsum +
// fill lines, 28" brick walls with window bays, a basement wall's outer face
// drawn hidden. Each case below failed before.

const IN = 1 / 12;
const HEAVY = 2.6 / 36, LIGHT = 0.5 / 36;   // pen widths in feet (as evidenceToFeet hands them over)
const hline = (y, x0, x1, extra = {}) => ({ a: { x: x0, y }, b: { x: x1, y }, ...extra });
const vline = (x, y0, y1, extra = {}) => ({ a: { x, y: y0 }, b: { x, y: y1 }, ...extra });
const heavy = (lines) => lines.map((l) => ({ ...l, w: HEAVY }));
const box = (W, H, t) => [
  { x1: 0, y1: 0, x2: W, y2: 0, t }, { x1: 0, y1: H, x2: W, y2: H, t },
  { x1: 0, y1: 0, x2: 0, y2: H, t }, { x1: W, y1: 0, x2: W, y2: H, t },
];
const errors = (res) => res.flags.filter((f) => f.severity === 'error');
/** a quarter circle as n straight pieces, hinge at c, from angle a0 */
const flatArc = (c, r, a0, n = 8) => Array.from({ length: n }, (_, i) => {
  const t0 = a0 + (Math.PI / 2) * (i / n), t1 = a0 + (Math.PI / 2) * ((i + 1) / n);
  return { a: { x: c.x + r * Math.cos(t0), y: c.y + r * Math.sin(t0) }, b: { x: c.x + r * Math.cos(t1), y: c.y + r * Math.sin(t1) }, w: LIGHT };
});

describe('trace — an old mill (line weights, flattened swings, thick brick, hidden faces)', () => {
  it('reads a door swing drawn as eight straight pieces', () => {
    const arcs = arcsFromPolylines(flatArc({ x: 10, y: 10 }, 2.5, 0));
    expect(arcs.length).toBe(1);
    expect(arcs[0].r).toBeCloseTo(2.5, 2);
    expect(arcs[0].sweepDeg).toBeCloseTo(90, 0);
    expect(arcs[0].c.x).toBeCloseTo(10, 2);
    expect(isDoorSwing(arcs[0])).toBe(true);
    // a column circle (all the way round) and a zig-zag are not swings
    const circle = Array.from({ length: 24 }, (_, i) => {
      const t0 = (i / 24) * 2 * Math.PI, t1 = ((i + 1) / 24) * 2 * Math.PI;
      return { a: { x: 2 * Math.cos(t0), y: 2 * Math.sin(t0) }, b: { x: 2 * Math.cos(t1), y: 2 * Math.sin(t1) } };
    });
    expect(arcsFromPolylines(circle).filter(isDoorSwing)).toEqual([]);
    const zig = Array.from({ length: 8 }, (_, i) => ({ a: { x: i * 0.4, y: (i % 2) * 0.3 }, b: { x: (i + 1) * 0.4, y: ((i + 1) % 2) * 0.3 } }));
    expect(arcsFromPolylines(zig)).toEqual([]);
  });

  it('a door whose swing is flattened into pieces closes the room on it', () => {
    // a 12x10 room; a 2'-6" door in the south wall between two wall stubs
    const W = 12, H = 10, t = 5 * IN;
    const lines = heavy(wallsToLines(box(W, H, t), [{ axis: 'h', c: H, s: 4, w: 2.5, t }], W, H));
    lines.push(...flatArc({ x: 4, y: H - t / 2 }, 2.5, -Math.PI / 2));
    const res = runTrace({ lines, arcs: arcsFromPolylines(lines).filter(isDoorSwing) });
    expect(res.rooms.length).toBe(1);
    expect(res.totals.doors).toBe(1);
    expect(errors(res)).toEqual([]);
  });

  it('two hairlines never make a wall on a sheet drawn with a heavy wall pen (a wardrobe, a bed)', () => {
    const W = 14, H = 12, t = 5 * IN;
    const lines = heavy(wallsToLines(box(W, H, t), [], W, H));
    // a wardrobe 2' deep: two hairlines 6" apart, 6' long, in the room
    lines.push(hline(3, 3, 9, { w: LIGHT }), hline(3.5, 3, 9, { w: LIGHT }));
    const res = runTrace({ lines });
    expect(res.rooms.length).toBe(1);
    expect(res.walls.some((w) => w.a.y > 2.5 && w.a.y < 4 && w.b.y > 2.5 && w.b.y < 4)).toBe(false);
    // with no pen weights on the sheet the old reading stands (nothing to tell them apart)
    const flat = runTrace({ lines: lines.map((l) => ({ ...l, w: 0 })) });
    expect(flat.stats.wallBodies).toBeGreaterThan(res.stats.wallBodies);
  });

  it('a hairline dimension string that brushes heavy wall end-caps stays a hairline', () => {
    const lines = [
      hline(10, 0, 60, { w: LIGHT }),                    // the dimension string
      hline(10.01, 20, 21.5, { w: HEAVY }), hline(10.01, 40, 41.5, { w: HEAVY }),   // end-caps of walls on its line
    ];
    const m = mergeCollinear(lines);
    const long = m.find((l) => Math.abs(l.a.x - l.b.x) > 50);
    expect(long.w).toBeCloseTo(LIGHT, 6);
  });

  it('a wall drawn as faces + gypsum lines + its fill edge is one wall, so a door between its stubs still closes', () => {
    // west partition of a 12x10 room drawn with four lines: faces 4.9" apart, inner lines 0.7" in
    const W = 12, H = 10, t = 4.9 * IN;
    const walls = box(W, H, t);
    const lines = heavy(wallsToLines(walls, [{ axis: 'v', c: 0, s: 4, w: 2.5, t }], W, H));
    for (const [y0, y1] of [[-t / 2, 4], [6.5, H + t / 2]]) {
      lines.push(vline(-t / 2 + 0.7 * IN, y0, y1, { w: HEAVY }), vline(t / 2 - 0.7 * IN, y0, y1, { w: HEAVY }));
    }
    const p = pairWalls(lines);
    const west = p.bodies.filter((b) => Math.abs(b.a.x) < 0.2 && Math.abs(b.b.x) < 0.2);
    // never two bodies stacked one inside the other
    for (const b of west) for (const c of west) if (b !== c) expect(Math.min(b.a.y, b.b.y) >= Math.max(c.a.y, c.b.y) - 0.05 || Math.min(c.a.y, c.b.y) >= Math.max(b.a.y, b.b.y) - 0.05).toBe(true);
    lines.push(...flatArc({ x: 0, y: 4 }, 2.5, 0));
    const res = runTrace({ lines, arcs: arcsFromPolylines(lines).filter(isDoorSwing) });
    expect(res.rooms.length).toBe(1);
    expect(res.totals.doors).toBe(1);
    expect(errors(res)).toEqual([]);
  });

  it("a 28\" brick wall (a long pair past the usual thickness) is a wall; the room stops at its inner face", () => {
    const W = 30, H = 20, T = 28 * IN, t = 5 * IN;
    const lines = heavy(wallsToLines([
      { x1: 0, y1: 0, x2: W, y2: 0, t: T }, { x1: 0, y1: H, x2: W, y2: H, t },
      { x1: 0, y1: 0, x2: 0, y2: H, t }, { x1: W, y1: 0, x2: W, y2: H, t },
    ], [], W, H));
    const res = runTrace({ lines });
    expect(res.rooms.length).toBe(1);
    expect(res.walls.some((w) => Math.abs(w.t - T) < 0.05)).toBe(true);
    expect(res.rooms[0].area).toBeCloseTo((W - t) * (H - t / 2 - T / 2), 0);
  });

  it("a long inner face beside a bay's window-frame strokes stays a wall face, not hatch", () => {
    // inner face 10' long; window frame strokes 14" apart in the bay beside it
    const lines = [hline(0, 0, 10, { w: 1 }), hline(-14 * IN, 3, 6, { w: 1 }), hline(-28 * IN, 3, 6, { w: 1 }), hline(-42 * IN, 3, 6, { w: 1 })];
    const p = pairWalls(lines);
    const face = p.lines.find((l) => Math.abs(l.a.y) < 1e-6 && l.len > 9);
    expect(p.hatch.has(face.id)).toBe(false);
  });

  it('a dashed line is never a wall face of its own, but is the hidden outer face of a thick basement wall', () => {
    const dashes = (y, x0, x1, w) => {
      const out = [];
      for (let x = x0; x + 1.5 <= x1; x += 2.7) out.push(hline(y, x, x + 1.5, { w }));
      return out;
    };
    // a dashed line 6" off a solid one: a beam overhead, not a 6" wall
    const p1 = pairWalls([hline(0, 0, 20, { w: 1 }), ...dashes(0.5, 0, 20, 1)]);
    expect(p1.bodies.length).toBe(0);
    expect(mergeCollinear(dashes(0.5, 0, 20, 1)).every((l) => l.dashed)).toBe(true);
    // a basement wall: outer face hidden (dashed), inner face solid, 28" apart
    const p2 = pairWalls([hline(0, 0, 20, { w: 1 }), ...dashes(-28 * IN, 0, 20, 1)]);
    expect(p2.bodies.some((b) => Math.abs(b.t - 28 * IN) < 0.05)).toBe(true);
  });

  it('a thin line in an annotation colour (a blue dimension string) is never a wall face', () => {
    expect(chromatic('#3d428b')).toBe(true);
    expect(chromatic('#aaaaaa')).toBe(false);
    expect(chromatic('#000000')).toBe(false);
    const lines = [hline(0, 0, 20, { w: HEAVY }), hline(0.5, 0, 20, { w: LIGHT, ann: true }),
      hline(5, 0, 20, { w: HEAVY }), hline(5.4, 0, 20, { w: HEAVY })];
    const p = pairWalls(lines);
    expect(p.bodies.length).toBe(1);
    expect(p.bodies[0].a.y).toBeCloseTo(5.2, 3);
  });
});
