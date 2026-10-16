import { describe, it, expect } from 'vitest';
import { runTrace } from '../src/engine/trace/index.js';
import { pairWalls, mergeCollinear } from '../src/engine/trace/walls.js';
import { arcsFromPolylines, isDoorSwing, readLeaves } from '../src/engine/trace/arcs.js';
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

describe('trace — the sheet checks the trace', () => {
  const W = 12, H = 10, t = 5 * IN;
  const room = () => heavy(wallsToLines(box(W, H, t), [], W, H));
  const area = (W - t) * (H - t);

  it("a room tag's printed area is the answer key: agreeing rooms are confirmed, others flagged with both numbers", () => {
    const ok = runTrace({ lines: room(), texts: [{ str: 'OFFICE', x: 6, y: 4 }, { str: `${Math.round(area)} SF`, x: 6, y: 5 }] });
    expect(ok.verify).toMatchObject({ tags: 1, matched: 1, off: 0 });
    expect(ok.rooms[0].areaCheck).toBe('match');
    const off = runTrace({ lines: room(), texts: [{ str: 'OFFICE', x: 6, y: 4 }, { str: '1,457 SF', x: 6, y: 5 }] });
    expect(off.verify).toMatchObject({ tags: 1, matched: 0, off: 1 });
    const f = off.flags.find((x) => x.kind === 'area_check');
    expect(f.msg).toMatch(/plan prints 1,457 SF; the trace has 1\d\d SF/);
    expect(f.at).toEqual({ x: 6, y: 5 });
  });

  it('two room tags in one traced room say the rooms merged', () => {
    const res = runTrace({ lines: room(), texts: [{ str: '60 SF', x: 3, y: 5 }, { str: '50 SF', x: 9, y: 5 }] });
    expect(res.verify.off).toBe(1);
    expect(res.flags.find((x) => x.kind === 'area_check').msg).toMatch(/2 room tags \(60 \+ 50 = 110 SF\).*rooms merged/);
  });

  it('a window drawn as frame lines across the gap is a window (closes the room, stays in wall LF) on a sheet without layers', () => {
    const T = 8 * IN;
    const lines = heavy(wallsToLines(box(W, H, T), [{ axis: 'h', c: 0, s: 4, w: 3, t: T }], W, H));
    // the window symbol: frame + glass lines running across the gap inside the wall
    lines.push(hline(-1.5 * IN, 4, 7, { w: LIGHT }), hline(1.5 * IN, 4, 7, { w: LIGHT }));
    const res = runTrace({ lines });
    expect(res.rooms.length).toBe(1);
    expect(res.totals.windows).toBe(1);
    const door = runTrace({ lines: heavy(wallsToLines(box(W, H, T), [{ axis: 'h', c: 0, s: 4, w: 3, t: T }], W, H)) });
    expect(door.totals.windows).toBe(0);
  });

  it("a brick wall's piers between window bays add up to one thick wall", () => {
    const T = 28 * IN;
    // outer face runs on; the inner face stops at each 3' bay; piers 4' long
    const lines = [hline(0, 0, 21, { w: 1 })];
    for (let x = 0; x < 21; x += 7) lines.push(hline(T, x, x + 4, { w: 1 }));
    const p = pairWalls(lines);
    expect(p.bodies.filter((b) => Math.abs(b.t - T) < 0.05).length).toBeGreaterThanOrEqual(3);
  });

  it('tries another reading when a rule could be wrong for the sheet, and keeps the one that agrees with it', () => {
    // a sheet whose partitions are drawn with a light pen and its exterior heavy:
    // "hairlines are furniture" would lose the partition
    const lines = heavy(wallsToLines(box(20, 10, 8 * IN), [], 20, 10));
    lines.push(...wallsToLines([{ x1: 10, y1: 0, x2: 10, y2: 10, t: 4 * IN, capA: 0, capB: 0 }], [], 20, 10).map((l) => ({ ...l, w: LIGHT })));
    const res = runTrace({ lines, texts: [{ str: 'KITCHEN', x: 5, y: 5 }, { str: 'DINING', x: 15, y: 5 }] });
    expect(res.readings.map((r) => r.id)).toContain('all-pens');
    expect(res.rooms.map((r) => r.name).sort()).toEqual(['DINING', 'KITCHEN']);
    expect(res.survey.notes.join(' ')).toMatch(/Read as: every pen can draw a wall/);
  });
});

describe('trace — what is drawing', () => {
  it('a white fill with no stroke (a wipeout behind text) is not drawing', async () => {
    const { evidenceToFeet } = await import('../src/lib/planEvidence.js');
    const rect = (x, y, w, h, extra) => [
      { a: { x, y }, b: { x: x + w, y }, ...extra }, { a: { x: x + w, y }, b: { x: x + w, y: y + h }, ...extra },
      { a: { x: x + w, y: y + h }, b: { x, y: y + h }, ...extra }, { a: { x, y: y + h }, b: { x, y }, ...extra },
    ];
    const ev = { lines: [...rect(0, 0, 100, 12, { w: 2, filled: true, col: '#ffffff' }), ...rect(0, 50, 100, 12, { w: 2, col: '#000000' })], curves: [], texts: [] };
    const out = evidenceToFeet(ev, 1 / 36, null);
    expect(out.lines.length).toBe(4);
    expect(out.lines.every((l) => l.a.y >= 50 / 36 - 1e-9)).toBe(true);
  });
});

describe('trace — bathrooms and closets of the mill units', () => {
  it('four short lines a few inches apart in four different pens are drawing, not a hatch (a door leaf, a wall, a washer box)', () => {
    // a 3' wall between a bath and a laundry closet: faces 6.4" apart; the bath
    // door's leaf 6" above it, the washer box 6" below — evenly spaced by chance
    const sp = 6.4 * IN;
    const lines = [hline(0, 0, 2.5, { w: 1.15 / 36 }), hline(sp, 0, 3, { w: HEAVY }), hline(2 * sp, 0, 3, { w: 2.0 / 36 }), hline(3 * sp, 0.2, 2.4, { w: LIGHT })];
    // other walls on the sheet set the heavy pen and the usual thickness
    for (let k = 0; k < 4; k++) lines.push(hline(20 + 5 * k, 0, 12, { w: HEAVY }), hline(20 + 5 * k + sp, 0, 12, { w: HEAVY }));
    const p = pairWalls(lines);
    expect(p.bodies.some((b) => Math.abs(b.a.y - 1.5 * sp) < 0.05 && Math.abs(b.t - sp) < 0.05)).toBe(true);
    // the same four strokes in one pen are a pattern
    const hatch = pairWalls([0, 1, 2, 3].map((k) => hline(k * sp, 0, 3, { w: HEAVY })).concat(lines.slice(4)));
    expect(hatch.bodies.some((b) => b.a.y < 2 && b.a.y > -1)).toBe(false);
  });

  it('a corner closes past the scrap of a layered wall\'s step that touches one end', () => {
    // 10x8 room; the NE corner: the north wall stops 3" short of the east wall's
    // centreline, the east wall starts 2" below the north's, and a 1" step piece
    // (left by the wall's poche) touches the north wall's end
    const t = 6 * IN;
    const bodies = [
      { a: { x: 0, y: 0 }, b: { x: 10 - 0.27, y: 0 }, t },
      { a: { x: 10, y: 0.17 }, b: { x: 10, y: 8 }, t: 4.9 * IN },
      { a: { x: 10, y: 8 }, b: { x: 0, y: 8 }, t },
      { a: { x: 0, y: 8 }, b: { x: 0, y: 0 }, t },
      { a: { x: 10 - 0.27, y: 0 }, b: { x: 10 - 0.27, y: -0.06 }, t: 3.5 * IN },
    ];
    const res = runTrace({ bodies });
    expect(res.rooms.length).toBe(1);
    expect(errors(res)).toEqual([]);
    expect(res.flags.filter((f) => f.kind === 'spur' || f.kind === 'open_end')).toEqual([]);
  });

  it("reads each swing's leaf: the end it stands open at, and the end it closes on", () => {
    const c = { x: 0, y: 0 }, r = 2.5;
    const swing = { c, r, sweepDeg: 90, p0: { x: r, y: 0 }, p3: { x: 0, y: -r } };
    // the leaf drawn open along -y: it closes along +x
    const [read] = readLeaves([swing], [], [{ a: c, b: { x: 0, y: -r } }]);
    expect(read.closed).toEqual({ x: r, y: 0 });
    // no leaf drawn: no closed end
    expect(readLeaves([swing], [], [])[0].closed).toBeUndefined();
    // a 45° arc is a door only with its leaf
    const part = { c, r: 1.7, sweepDeg: 45, p0: { x: 0, y: 1.7 }, p3: { x: -1.2, y: 1.2 } };
    expect(readLeaves([], [part], [])).toEqual([]);
    const kept = readLeaves([], [part], [{ a: { x: 0.05, y: 0.05 }, b: { x: -1.15, y: 1.25 } }]);
    expect(kept.length).toBe(1);
    expect(kept[0].closed).toEqual({ x: 0, y: 1.7 });
  });

  it('a closet door drawn part open, between jamb returns too short to read as walls, closes the closet', () => {
    // a 5x3 closet off a 12' room: its front wall stops 2'-7" short of the
    // north wall's face (the 4" jamb returns are too short to pair); a 1'-8"
    // leaf hinges at the north jamb, drawn open at 45°, closing to the south one
    const t = 4 * IN, T = 6 * IN;
    const bodies = [
      { a: { x: 0, y: 0 }, b: { x: 12, y: 0 }, t: T },                 // north wall
      { a: { x: 12, y: 0 }, b: { x: 12, y: 10 }, t: T },
      { a: { x: 12, y: 10 }, b: { x: 0, y: 10 }, t: T },
      { a: { x: 0, y: 10 }, b: { x: 0, y: 0 }, t: T },
      { a: { x: 9, y: 0 }, b: { x: 9, y: 3 }, t },                       // closet's east side
      { a: { x: 9, y: 3 }, b: { x: 6.5, y: 3 }, t },                     // closet front, stops at x 6.5
      { a: { x: 4, y: 0 }, b: { x: 4, y: 6 }, t },                       // a partition west of it
    ];
    const hinge = { x: 6.45, y: 0.6 };
    const arc = { c: hinge, r: 1.67, sweepDeg: 45, p0: { x: 6.45, y: 0.6 + 1.67 }, p3: { x: 6.45 - 1.18, y: 0.6 + 1.18 }, closed: { x: 6.45, y: 0.6 + 1.67 } };
    const res = runTrace({ bodies, arcs: [arc], texts: [{ str: 'CL', x: 7.7, y: 1.5 }] });
    const cl = res.rooms.find((rm) => rm.name === 'CL');
    expect(cl).toBeTruthy();
    expect(cl.area).toBeLessThan(10);
    // the door is the closet's, not a 2'-6" "opening" across the room to the partition
    expect(res.openings.some((o) => o.openingType === 'door' && o.rooms.includes(cl.id))).toBe(true);
  });
});

