import { describe, it, expect } from 'vitest';
import { runTrace } from '../src/engine/trace/index.js';
import { pairWalls, mergeCollinear, dropCasework, mergeLayers } from '../src/engine/trace/walls.js';
import { buildGraph, joinWalls, bridgeOpenings } from '../src/engine/trace/graph.js';
import { arcsFromPolylines, isDoorSwing, readLeaves, leafLines } from '../src/engine/trace/arcs.js';
import { notchSpur } from '../src/engine/trace/analyze.js';
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

  it("a room tag is compared at the wall faces; beyond 3% it's flagged", () => {
    // 12x10 room with a 3' doorway in its south wall; the floor stops at the wall line across it
    const lines = heavy(wallsToLines(box(W, H, t), [{ axis: 'h', c: H, s: 4, w: 3, t }], W, H));
    lines.push(...flatArc({ x: 4, y: H - t / 2 }, 3, -Math.PI / 2));
    const res = runTrace({ lines, arcs: arcsFromPolylines(lines).filter(isDoorSwing), texts: [{ str: `${Math.round(area)} SF`, x: 6, y: 5 }] });
    const r = res.rooms[0];
    expect(r.area).toBeCloseTo(area, 1);               // the takeoff: to the faces, as the estimators measure
    expect(r.areaFaces).toBeCloseTo(area, 1);          // the tag: to the faces
    expect(r.areaCheck).toBe('match');
    // to the door's centre when asked (the Trace panel's "Floor at doors")
    const centre = runTrace({ lines, arcs: arcsFromPolylines(lines).filter(isDoorSwing), texts: [{ str: `${Math.round(area)} SF`, x: 6, y: 5 }], options: { floorAtDoor: 'center' } });
    expect(centre.rooms[0].area).toBeCloseTo(area + 3 * t / 2, 1);
    expect(centre.rooms[0].areaCheck).toBe('match');
    // 4% off is no longer let through
    const off = runTrace({ lines, arcs: arcsFromPolylines(lines).filter(isDoorSwing), texts: [{ str: `${Math.round(area * 1.04)} SF`, x: 6, y: 5 }] });
    expect(off.rooms[0].areaCheck).toBe('off');
  });

  it('two room tags in one traced room say the rooms merged', () => {
    const res = runTrace({ lines: room(), texts: [{ str: '60 SF', x: 3, y: 5 }, { str: '30 SF', x: 9, y: 5 }] });
    expect(res.verify.off).toBe(1);
    expect(res.flags.find((x) => x.kind === 'area_check').msg).toMatch(/2 room tags \(60 \+ 30 = 90 SF\).*rooms merged/);
  });

  it('an open space the plan prints as two areas, with nothing drawn between them, agrees when they add up', () => {
    // a meter alcove and the electric room it opens off: 47 + 64 = 111 SF
    const res = runTrace({ lines: room(), texts: [{ str: 'METER', x: 3, y: 4 }, { str: '47 SF', x: 3, y: 5 }, { str: 'ELECTRIC', x: 9, y: 4 }, { str: '64 SF', x: 9, y: 5 }] });
    expect(res.verify).toMatchObject({ matched: 1, off: 0 });
    expect(res.rooms[0].areaCheck).toBe('match');
    expect(res.rooms[0].printedParts).toEqual([47, 64]);
    expect(res.flags.find((x) => x.kind === 'area_zones').msg).toMatch(/2 areas here \(47 \+ 64 = 111 SF\) with nothing drawn between them/);
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
    // …one wall, running on across the bays: below the sill the brick is solid
    const thick = p.bodies.filter((b) => Math.abs(b.t - T) < 0.05);
    const span = thick.reduce((a, b) => a + Math.abs(b.b.x - b.a.x), 0);
    expect(span).toBeGreaterThanOrEqual(18 - 0.05);
  });

  it('the floor stops at a brick wall\'s inner face across its window bays (the bay is above the sill)', () => {
    // a 21x14 room under a 28" brick wall; the bays recess 8" into it between 4' piers
    const T = 28 * IN, t = 5 * IN;
    const lines = [hline(-T, 0, 21, { w: HEAVY })];                       // outer face, unbroken
    for (const [x0, x1] of [[0, 4], [7, 11], [14, 21]]) lines.push(hline(0, x0, x1, { w: HEAVY }));   // pier inner faces
    for (const x of [4, 11]) lines.push(hline(-8 * IN, x, x + 3, { w: HEAVY }), vline(x, -8 * IN, 0, { w: HEAVY }), vline(x + 3, -8 * IN, 0, { w: HEAVY }));
    lines.push(...heavy(wallsToLines([
      { x1: 0, y1: 14, x2: 21, y2: 14, t }, { x1: 0, y1: -T / 2, x2: 0, y2: 14, t, capA: 0 }, { x1: 21, y1: -T / 2, x2: 21, y2: 14, t, capA: 0 },
    ], [], 21, 14)));
    const res = runTrace({ lines });
    expect(res.rooms.length).toBe(1);
    // to the inner face (y 0) — none of the bays' 3' x 8" recesses
    expect(res.rooms[0].area).toBeCloseTo((21 - t) * (14 - t / 2), 0);
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
    // the same four strokes in one light pen are a pattern (in the wall pen they're
    // a layered wall's faces: see traceMarkedJobs, Saddle River's dining room)
    const hatch = pairWalls([0, 1, 2, 3].map((k) => hline(k * sp, 0, 3, { w: 1.15 / 36 })).concat(lines.slice(4)));
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

  it("a wall stopping on another wall right by that wall's own end (a 3\" scrap of it) joins that corner", () => {
    // the west wall comes in three pieces, one a 3" scrap; the south wall of the
    // room ends 1.6" off the scrap's top — on the wall, too near the scrap's end
    // to split it, a hair past the snap distance from the corner
    const t = 6 * IN;
    const segs = [
      { a: { x: 0, y: 0 }, b: { x: 0, y: 5 }, t, kind: 'wall' },
      { a: { x: 0, y: 5 }, b: { x: 0.02, y: 5.25 }, t, kind: 'wall' },
      { a: { x: 0.02, y: 5.25 }, b: { x: 0.05, y: 9 }, t, kind: 'wall' },
      { a: { x: 0.095, y: 5.09 }, b: { x: 8, y: 5.09 }, t: 4 * IN, kind: 'wall' },
    ];
    const g = buildGraph(segs);
    const deg = new Map();
    for (const e of g.edges) for (const n of [e.u, e.v]) deg.set(n, (deg.get(n) || 0) + 1);
    const corner = g.nodes.find((n) => Math.abs(n.x) < 0.1 && Math.abs(n.y - 5) < 0.1);
    expect(deg.get(corner.id)).toBe(3);
  });

  it("a wall meeting another just past that wall's end (its corner fills out beyond the centreline) closes the corner", () => {
    // 10x8 room: the north wall ends 1.8" above where the east wall's centreline stops
    const t = 4 * IN;
    const bodies = [
      { a: { x: 0, y: 0 }, b: { x: 9.95, y: 0 }, t },
      { a: { x: 10, y: 0.15 }, b: { x: 10, y: 8 }, t },
      { a: { x: 10, y: 0.15 }, b: { x: 12, y: 0.15 }, t: 7.8 * IN },
      { a: { x: 10, y: 8 }, b: { x: 0, y: 8 }, t },
      { a: { x: 0, y: 8 }, b: { x: 0, y: 0 }, t },
    ];
    const res = runTrace({ bodies });
    expect(res.rooms.length).toBe(1);
    const atCorner = (f) => f.at && Math.hypot(f.at.x - 10, f.at.y) < 0.5;
    expect(res.flags.filter((f) => (f.kind === 'spur' || f.kind === 'open_end') && atCorner(f))).toEqual([]);
    expect(res.rooms[0].area).toBeGreaterThan(70);
  });

  it('a wall runs straight through an offset crossing (walls meeting it from each side 5" apart)', () => {
    // a 20x16 block cut by a N-S wall at x 10; an E-W wall meets it from the west
    // at y 8 and one from the east at y 8.4 — each ends at the N-S wall, whose
    // pieces stop at the walls they turn into
    const t = 4 * IN;
    const bodies = [
      ...box(20, 16, 6 * IN).map((w) => ({ a: { x: w.x1, y: w.y1 }, b: { x: w.x2, y: w.y2 }, t: w.t })),
      { a: { x: 10, y: 0 }, b: { x: 10, y: 8 }, t },
      { a: { x: 10, y: 8.4 }, b: { x: 10, y: 16 }, t },
      { a: { x: 0, y: 8.4 }, b: { x: 10, y: 8.4 }, t },
      { a: { x: 10, y: 8 }, b: { x: 20, y: 8 }, t },
    ];
    const res = runTrace({ bodies });
    expect(res.rooms.length).toBe(4);
    expect(errors(res)).toEqual([]);
  });

  it("a 28\" brick wall runs through where walls meet it from each side 1'-6\" apart; a doorway's jambs don't close", () => {
    const T = 28 * IN, t = 4 * IN;
    const base = [
      ...box(30, 20, 6 * IN).map((w) => ({ a: { x: w.x1, y: w.y1 }, b: { x: w.x2, y: w.y2 }, t: w.t })),
      { a: { x: 0, y: 10 }, b: { x: 10.5, y: 10 }, t: T },
      { a: { x: 12, y: 10 }, b: { x: 30, y: 10 }, t: T },
    ];
    // a storage room's wall comes down onto the brick at x 12, a stair hall's up at x 10.5
    const crossing = runTrace({ bodies: [...base, { a: { x: 12, y: 0 }, b: { x: 12, y: 10 - T / 2 }, t }, { a: { x: 10.5, y: 10 + T / 2 }, b: { x: 10.5, y: 20 }, t: 12 * IN }] });
    expect(crossing.rooms.length).toBe(4);
    // both walls from the same side: the gap between them stays open to bridge
    const doorway = runTrace({ bodies: [...base, { a: { x: 12, y: 0 }, b: { x: 12, y: 10 - T / 2 }, t }, { a: { x: 10.5, y: 0 }, b: { x: 10.5, y: 10 - T / 2 }, t }] });
    expect(doorway.walls.some((w) => w.a.y === w.b.y && Math.abs(w.a.y - 10) < 0.01 && Math.min(w.a.x, w.b.x) >= 10.4 && Math.max(w.a.x, w.b.x) <= 12.1 && Math.abs(w.a.x - w.b.x) > 1)).toBe(false);
  });

  it('a room behind a narrow unmarked gap is a room, not an alcove of the room it opens into', () => {
    // a 15x10 stair hall reached from the storage room through a 2' slot
    const t = 6 * IN;
    const bodies = [
      ...box(30, 10, t).map((w) => ({ a: { x: w.x1, y: w.y1 }, b: { x: w.x2, y: w.y2 }, t: w.t })),
      { a: { x: 15, y: 0 }, b: { x: 15, y: 4 }, t },
      { a: { x: 15, y: 6 }, b: { x: 15, y: 10 }, t },
    ];
    const res = runTrace({ bodies, texts: [{ str: 'STORAGE', x: 7, y: 5 }] });
    expect(res.rooms.length).toBe(2);
  });

  it("an inferred opening never runs through a doorway (a ray from a counter's end across the living room)", () => {
    // a 16x14 living room; on its west side a 4'-deep laundry closet with a
    // door; a 3' counter stub sticks off the east wall level with the closet's
    // doorway — its end must not "open" 12' west through the closet door
    const t = 4 * IN;
    const lines = heavy(wallsToLines([
      ...box(16, 14, t),
      { x1: 0, y1: 4, x2: 4, y2: 4, t },          // closet's top wall
      { x1: 4, y1: 4, x2: 4, y2: 4.4, t, capB: 0 }, // door head jamb
      { x1: 4, y1: 7.4, x2: 4, y2: 8, t, capA: 0 },
      { x1: 0, y1: 8, x2: 4, y2: 8, t },
      { x1: 13, y1: 5, x2: 16, y2: 5, t: 5 * IN, capA: 0 },   // counter stub
    ], [], 16, 14));
    lines.push(...flatArc({ x: 4, y: 7.4 }, 3, -Math.PI / 2));
    const res = runTrace({ lines, arcs: arcsFromPolylines(lines).filter(isDoorSwing), texts: [{ str: 'LIVING', x: 10, y: 10 }, { str: 'W/D', x: 2, y: 6 }] });
    const living = res.rooms.find((r) => r.name === 'LIVING');
    expect(living.area).toBeGreaterThan(150);
    expect(res.openings.some((o) => o.openingType === 'opening' && Math.abs(o.a.x - o.b.x) > 6)).toBe(false);
  });

  it('a door the sheet draws (swing or door-layer leaves) stands even where it crosses an opening already placed; an inferred one does not', () => {
    // two gaps whose bridging lines cross: a swing door E-W, and a gap N-S
    const t = 4 * IN;
    const walls = [
      { a: { x: -6, y: 0 }, b: { x: -1.5, y: 0 }, t }, { a: { x: 1.5, y: 0 }, b: { x: 6, y: 0 }, t },
      { a: { x: 0, y: -6 }, b: { x: 0, y: -1.25 }, t }, { a: { x: 0, y: 1.25 }, b: { x: 0, y: 6 }, t },
    ];
    const arc = { c: { x: -1.5, y: 0.1 }, r: 3, sweepDeg: 90, p0: { x: 1.5, y: 0.1 }, p3: { x: -1.5, y: 3.1 } };
    const run = (hints) => {
      const j = joinWalls(walls.map((w) => ({ ...w, kind: 'wall' })));
      return bridgeOpenings(j.segs, j.ends, [arc], {}, [], hints);
    };
    // the N-S gap with bifold leaves drawn across it (door layer): kept
    const hinted = run([{ a: { x: 0.05, y: -1.25 }, b: { x: 0.05, y: 1.25 }, kind: 'door' }]);
    expect(hinted.some((o) => Math.abs(o.a.x - o.b.x) < 0.01 && Math.abs(o.a.x) < 0.01)).toBe(true);
    // nothing drawn across it: it would cross the door — not a doorway
    const bare = run([{ a: { x: 20, y: 20 }, b: { x: 21, y: 20 }, kind: 'door' }]);
    expect(bare.some((o) => Math.abs(o.a.x - o.b.x) < 0.01 && Math.abs(o.a.x) < 0.01)).toBe(false);
    expect(bare.some((o) => o.openingType === 'door')).toBe(true);
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

describe('trace — measured to the 1% (the accuracy benchmark\'s cases)', () => {
  const GYP = 0.72 / 36;   // a gypsum layer's pen

  it('a room stops at the heavy face line, not the gypsum line drawn 0.55" inside it', () => {
    // an 8x8 room, 5" walls: each room face drawn heavy with a light gypsum line
    // 0.55" into the wall — close enough that the two read as one line
    const W = 8, t = 5 * IN, g = 0.55 * IN;
    const lines = heavy(wallsToLines(box(W, W, t), [], W, W));
    const f = t / 2;
    lines.push(hline(f - g, f, W - f, { w: GYP }), hline(W - f + g, f, W - f, { w: GYP }), vline(f - g, f, W - f, { w: GYP }), vline(W - f + g, f, W - f, { w: GYP }));
    const want = (W - t) * (W - t);
    const res = runTrace({ lines });
    expect(res.rooms[0].area).toBeCloseTo(want, 1);
    const off = runTrace({ lines, options: { faceSnap: false } });
    expect(off.rooms[0].area - want).toBeGreaterThan(0.3);
  });

  it('a strip faced by a hairline lying along a wall is casework (a toilet tank), not wall', () => {
    const wall = { a: { x: 0, y: 0 }, b: { x: 12, y: 0 }, t: 5 * IN };
    const tank = { a: { x: 4, y: (5 * IN) / 2 + 0.65 }, b: { x: 5, y: (5 * IN) / 2 + 0.65 }, t: 1.3, lightFace: true };
    expect(dropCasework([wall, tank])).toEqual([wall]);
    // a hairline-faced wall standing on its own (an exterior wall drawn light inside) stays
    const alone = { ...tank, a: { x: 4, y: 6 }, b: { x: 9, y: 6 } };
    expect(dropCasework([wall, alone])).toEqual([wall, alone]);
  });

  it("a brick wall pairs even where its inner face is shared with a new wall built against it", () => {
    const T = 28 * IN, t = 5 * IN;
    const lines = [
      hline(-T, 0, 30, { w: 1.15 / 36 }), hline(0, 0, 30, { w: 1.15 / 36 }),   // brick faces (existing, gray)
      hline(t, 0, 30, { w: HEAVY }),                                         // the new wall's room face
      ...[3, 13, 23].flatMap((x) => [hline(-T + 3 * IN, x, x + 4, { w: GYP }), hline(-T + 6 * IN, x, x + 4, { w: GYP })]),  // window frames
    ];
    // other walls on the sheet set the heavy pen
    for (let k = 0; k < 4; k++) lines.push(hline(20 + 5 * k, 0, 12, { w: HEAVY }), hline(20 + 5 * k + t, 0, 12, { w: HEAVY }));
    const brick = (p) => p.bodies.some((b) => b.t >= T - 0.05 && Math.abs(b.a.y - b.b.y) < 0.01 && b.a.y < 0);
    expect(brick(pairWalls(lines))).toBe(true);
    expect(brick(pairWalls(lines, { shareThickFaces: false }))).toBe(false);
  });

  it("a closet's door bridges from its corner even when a 3\" scrap of the wall beyond sits at that corner", () => {
    // a 10x10 block: the office above, a closet (SW) and a bath (SE) below a
    // wall at y 7.5 — drawn as a 3" scrap then the rest. The closet's door runs
    // from the west wall to that corner; its leaf is drawn open into the office
    const t = 5 * IN;
    const bodies = [
      ...box(10, 10, t).map((w) => ({ a: { x: w.x1, y: w.y1 }, b: { x: w.x2, y: w.y2 }, t: w.t })),
      { a: { x: 2.5, y: 7.5 }, b: { x: 2.5, y: 10 }, t },            // the closet's east wall
      { a: { x: 2.5, y: 7.5 }, b: { x: 2.75, y: 7.5 }, t: 3.5 * IN },  // the scrap
      { a: { x: 2.75, y: 7.5 }, b: { x: 10, y: 7.5 }, t },          // the wall on to the east
    ];
    const hinge = { x: 0.3, y: 7.55 };
    const arc = { c: hinge, r: 2.1, sweepDeg: 90, p0: { x: 2.4, y: 7.55 }, p3: { x: 0.3, y: 5.45 }, closed: { x: 2.4, y: 7.55 } };
    const res = runTrace({ bodies, arcs: [arc], texts: [{ str: 'OFFICE', x: 5, y: 4 }, { str: 'CL', x: 1.2, y: 8.8 }, { str: 'BATH', x: 6, y: 8.8 }] });
    expect(res.rooms.map((r) => r.name).sort()).toEqual(['BATH', 'CL', 'OFFICE']);
    const cl = res.rooms.find((r) => r.name === 'CL');
    expect(res.openings.some((o) => o.openingType === 'door' && o.rooms.includes(cl.id))).toBe(true);
  });
});

describe('trace — doors read from their swings and leaves', () => {
  it("a swing's leaf is the edge as long as its radius (not a washer box's side starting at the hinge)", () => {
    const c = { x: 0, y: 0 }, r = 2.5;
    const swing = { c, r, sweepDeg: 90, p0: { x: 0, y: -r }, p3: { x: r, y: 0 } };
    const box = { a: { x: -0.05, y: -0.2 }, b: { x: -0.05, y: -2.28 } };   // 2.08' side, hinge to near p0
    const leaf = { a: { x: 0, y: 0 }, b: { x: r, y: 0 } };                 // 2.5' leaf, open toward p3
    expect(readLeaves([swing], [], [box, leaf])[0].closed).toEqual({ x: 0, y: -r });
  });

  it('a swing that closes north does not mark a doorway running east from its hinge', () => {
    // a wall stub's end with a swing hinged at it, leaf drawn open to the west,
    // closing north; a wall 2' east and a wall 2'-2" north
    const t = 4 * IN;
    const walls = [
      { a: { x: 0, y: 0 }, b: { x: 0, y: 6 }, t },
      { a: { x: 2.3, y: -6 }, b: { x: 2.3, y: 6 }, t },
      { a: { x: -6, y: -2.4 }, b: { x: 1.8, y: -2.4 }, t },
    ];
    const arc = { c: { x: -0.1, y: 0 }, r: 2.17, sweepDeg: 90, p0: { x: -0.1, y: -2.17 }, p3: { x: -2.27, y: 0 }, closed: { x: -0.1, y: -2.17 } };
    const j = joinWalls(walls.map((w) => ({ ...w, kind: 'wall' })));
    const ops = bridgeOpenings(j.segs, j.ends, [arc], {}, [], []);
    const door = ops.find((o) => o.openingType === 'door');
    expect(door).toBeTruthy();
    expect(Math.abs(door.a.x - door.b.x)).toBeLessThan(0.05);   // runs north, not east
  });

  it("a double door lands on a wall end its ray just misses (a jamb return too short to read), and that end is its jamb", () => {
    // a 12x12 room; a closet in its NE corner whose front is a 4'-4" double
    // door. The closet's top wall ends 2" east of the door line; the bottom
    // jamb is a wall stub. Without the door, the top wall's end would "open"
    // 10' west across the room.
    const t = 4 * IN;
    const bodies = [
      ...box(12, 12, t).map((w) => ({ a: { x: w.x1, y: w.y1 }, b: { x: w.x2, y: w.y2 }, t: w.t })),
      { a: { x: 7.17, y: 4 }, b: { x: 12, y: 4 }, t },        // closet top wall: ends at x 7.17
      { a: { x: 7, y: 8.45 }, b: { x: 7, y: 12 }, t },        // bottom jamb stub
    ];
    // the top leaf hinges on the jamb return, 0.7' from the wall's end
    const leafs = [
      { c: { x: 6.9, y: 4.66 }, r: 2.17, sweepDeg: 90, p0: { x: 6.9, y: 6.83 }, p3: { x: 4.73, y: 4.66 }, closed: { x: 6.9, y: 6.83 } },
      { c: { x: 6.9, y: 8.45 }, r: 2.17, sweepDeg: 90, p0: { x: 6.9, y: 6.28 }, p3: { x: 4.73, y: 8.45 }, closed: { x: 6.9, y: 6.28 } },
    ];
    const res = runTrace({ bodies, arcs: leafs, texts: [{ str: 'BEDROOM', x: 3, y: 6 }, { str: 'CL', x: 9.5, y: 8 }] });
    const cl = res.rooms.find((r) => r.name === 'CL');
    expect(res.openings.some((o) => (o.openingType === 'double_door' || o.openingType === 'door') && o.rooms.includes(cl?.id))).toBe(true);
    expect(res.openings.some((o) => o.openingType === 'opening' && Math.abs(o.a.x - o.b.x) > 5)).toBe(false);
    expect(res.rooms.map((r) => r.name).sort()).toEqual(['BEDROOM', 'CL']);
  });
});


describe('trace — one room, to its drawn faces (tub stubs, leaves, layers, pens)', () => {
  const t = 5 * IN;
  const asBodies = (walls) => walls.map((w) => ({ a: { x: w.x1, y: w.y1 }, b: { x: w.x2, y: w.y2 }, t: w.t }));
  const polyArea = (P) => Math.abs(P.reduce((s, p, i) => s + p.x * P[(i + 1) % P.length].y - P[(i + 1) % P.length].x * p.y, 0)) / 2;

  it("a bathroom split by the stub at the end of its tub is one room with its vanity area", () => {
    // ENTRY (west) and a 10x6.5 bathroom; a door between them, and a 2.6'
    // stub off the bathroom's south wall at the tub's end. The stub's ray
    // north splits off an unnamed vanity area holding the bathroom's door.
    const bodies = [
      ...asBodies(box(15, 6.5, t)),
      { a: { x: 5, y: 0 }, b: { x: 5, y: 1 }, t }, { a: { x: 5, y: 3.5 }, b: { x: 5, y: 6.5 }, t },
      { a: { x: 9, y: 3.9 }, b: { x: 9, y: 6.5 }, t: 4.4 * IN },
    ];
    const arc = { c: { x: 5, y: 1 }, r: 2.5, sweepDeg: 90, p0: { x: 5, y: 3.5 }, p3: { x: 7.5, y: 1 }, closed: { x: 5, y: 3.5 } };
    const res = runTrace({ bodies, arcs: [arc], texts: [{ str: 'ENTRY', x: 2.5, y: 3 }, { str: 'BATHROOM', x: 12.5, y: 2 }] });
    expect(res.rooms.map((r) => r.name).sort()).toEqual(['BATHROOM', 'ENTRY']);
  });

  it("a partition that dead-ends in a room takes its footprint off the floor (the outline is notched round it)", () => {
    // a 10x8 bath; a 4' pony wall, 4.5" thick, off the south wall
    const ts = 4.5 * IN;
    const bodies = [...asBodies(box(10, 8, t)), { a: { x: 4, y: 4 }, b: { x: 4, y: 8 }, t: ts }];
    const res = runTrace({ bodies, texts: [{ str: 'BATH', x: 7, y: 4 }] });
    expect(res.rooms.length).toBe(1);
    const r = res.rooms[0];
    const want = (10 - t) * (8 - t) - (4 - t / 2) * ts;
    expect(r.area).toBeCloseTo(want, 2);
    expect(polyArea(r.poly)).toBeCloseTo(want, 2);   // the app takes the floor from the outline
    // a stub whose sides leave different walls (or nothing) keeps the outline as it was
    expect(notchSpur([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }], { x: 9, y: 9 }, { x: 9, y: 12 }, ts)).toBe(null);
  });

  it("a door's leaf drawn standing open along a wall is not that wall's face", () => {
    // 4¼" and 14" walls are the sheet's common thicknesses; a 12x8 room's
    // north wall is 5.3". A door leaf (a 1¾" rectangle) stands open along it,
    // its far side 14" from the wall's outer face: paired with that face (a
    // common thickness, so first) it made a 14" wall eating a strip of the room
    const W = 12, H = 8, tw = 4.25 * IN, tn = 5.3 * IN, hy = -tn / 2 + 14 * IN;
    const walls = box(W, H, tw);
    walls[0].t = tn;
    const lines = heavy(wallsToLines(walls, [{ axis: 'v', c: 0, s: hy, w: 2.5, t: tw }], W, H));
    const LEAF = 1.3 / 36;
    lines.push(hline(hy, tw / 2, tw / 2 + 2.5, { w: LEAF }), hline(hy - 1.75 * IN, tw / 2, tw / 2 + 2.5, { w: LEAF }));
    for (let k = 0; k < 6; k++) lines.push(hline(20 + 4 * k, 0, 14, { w: HEAVY }), hline(20 + 4 * k + tw, 0, 14, { w: HEAVY }));
    for (let k = 0; k < 4; k++) lines.push(hline(50 + 4 * k, 0, 14, { w: HEAVY }), hline(50 + 4 * k + 14 * IN, 0, 14, { w: HEAVY }));
    const arc = { c: { x: tw / 2, y: hy }, r: 2.5, sweepDeg: 90, p0: { x: tw / 2, y: hy + 2.5 }, p3: { x: tw / 2 + 2.5, y: hy }, closed: { x: tw / 2, y: hy + 2.5 } };
    expect([...leafLines([arc], lines)].length).toBe(2);
    // a sheet in one pen can't tell a leaf from a short return wall it opens against: kept
    expect([...leafLines([arc], lines.map((l) => ({ ...l, w: HEAVY })))].length).toBe(0);
    const res = runTrace({ lines, arcs: [arc] });
    const room = res.rooms.find((r) => r.area > 50);
    expect(room.areaFaces).toBeCloseTo((W - tw) * (H - tn / 2 - tw / 2), 0);
  });

  it("a door's 6\" jamb drawn on two layers is one jamb", () => {
    // the partition's piece above a door, drawn twice (3.5" and 4.8", same
    // centre): left as two, each copy's end "touched" the other, so neither
    // was free and the door never found its jamb
    const a = { a: { x: 6, y: 0.1 }, b: { x: 6, y: 0.67 }, t: 3.5 * IN }, b = { a: { x: 6, y: 0.2 }, b: { x: 6, y: 0.67 }, t: 4.8 * IN };
    const atDoor = mergeLayers([a, b]).filter((o) => Math.max(o.a.y, o.b.y) > 0.66);
    expect(atDoor.length).toBe(1);
    expect(atDoor[0].t * 12).toBeCloseTo(4.8, 1);
  });

  it('a copy of part of a wall lying in it is that wall, as drawn (not two walls, not widened)', () => {
    const long = { a: { x: 0, y: 0 }, b: { x: 0, y: 28 }, t: 6.6 * IN };
    const copy = { a: { x: 1 * IN, y: 0 }, b: { x: 1 * IN, y: 11 }, t: 6.5 * IN };
    expect(mergeLayers([long, copy])).toEqual([long]);
    expect(mergeLayers([copy, long])).toEqual([long]);
    // a pilaster (a short, thicker body standing out of one side) stays
    const pilaster = { a: { x: 4 * IN, y: 5 }, b: { x: 4 * IN, y: 7 }, t: 14.6 * IN };
    expect(mergeLayers([long, pilaster]).length).toBe(2);
  });

  it('two bands sharing most of a wall\'s thickness (layer lines paired across each other) are one wall', () => {
    // faces at 0 and 5.6"; gypsum lines between them: one pair took the
    // outer face and the far gypsum line, the other the near one and the far face
    const p = { a: { x: 0, y: 2.1 * IN }, b: { x: 3, y: 2.1 * IN }, t: 4.2 * IN };
    const q = { a: { x: 0, y: 3.6 * IN }, b: { x: 3, y: 3.6 * IN }, t: 4.0 * IN };
    const out = mergeLayers([p, q]);
    expect(out.length).toBe(1);
    expect(out[0].t * 12).toBeCloseTo(5.6, 1);
  });

  it("a wall face running on as a vanity's hairline doesn't pair with the vanity along that stretch", () => {
    // the closet wall's face is drawn heavy to x 4, then the same line runs on
    // in a hairline to the vanity; the vanity's top is a hairline 13½" off it
    const lines = [
      hline(0, 0, 4, { w: HEAVY }), hline(0, 4.05, 5.85, { w: LIGHT }), hline(5 * IN, 0, 4, { w: HEAVY }),
      hline(13.5 * IN, 4.05, 6.5, { w: LIGHT }),
    ];
    for (let k = 0; k < 4; k++) lines.push(hline(20 + 4 * k, 0, 12, { w: HEAVY }), hline(20 + 4 * k + t, 0, 12, { w: HEAVY }));
    const bodies = pairWalls(lines).bodies.filter((b) => b.a.y < 5);
    expect(bodies.some((b) => b.t > 10 * IN)).toBe(false);
    expect(bodies.some((b) => Math.abs(b.t - 5 * IN) < 0.01 && Math.abs(b.b.x - b.a.x) > 3.9)).toBe(true);
    // a stretch drawn lighter between heavier ones is still the wall
    const mid = [
      vline(0, 0, 5, { w: 1.15 / 36 }), vline(0, 5.05, 12, { w: 0.72 / 36 }), vline(0, 12.05, 14, { w: 1.15 / 36 }),
      vline(6.8 * IN, 0, 5, { w: 1.15 / 36 }), vline(6.8 * IN, 5.05, 12, { w: 0.72 / 36 }), vline(6.8 * IN, 12.05, 14, { w: 1.15 / 36 }),
    ];
    for (let k = 0; k < 4; k++) mid.push(hline(20 + 4 * k, 0, 12, { w: HEAVY }), hline(20 + 4 * k + t, 0, 12, { w: HEAVY }));
    const wall = pairWalls(mid).bodies.filter((b) => Math.abs(b.a.x - b.b.x) < 0.01 && b.a.x < 1);
    expect(wall.reduce((s, b) => s + Math.abs(b.b.y - b.a.y), 0)).toBeGreaterThan(13.5);
  });

  it('a wall runs through walls meeting it from each side 7" apart (3" face to face)', () => {
    // a 12x10 block cut by a wall at y 5; a wall comes down onto it at x 5.6
    // and another leaves it downward at x 6.2. Its pieces each turned a corner
    // into a different one and the 7" between them stayed open
    const tc = 4.1 * IN;
    const bodies = [
      ...asBodies(box(12, 10, tc)),
      { a: { x: 0, y: 5 }, b: { x: 5.45, y: 5 }, t: tc }, { a: { x: 6.35, y: 5 }, b: { x: 12, y: 5 }, t: tc },
      { a: { x: 5.6, y: 0 }, b: { x: 5.6, y: 4.83 }, t: tc }, { a: { x: 6.2, y: 5.17 }, b: { x: 6.2, y: 10 }, t: tc },
    ];
    const res = runTrace({ bodies, texts: [{ str: 'CL', x: 3, y: 2 }, { str: 'HALL', x: 9, y: 2 }, { str: 'BEDROOM', x: 3, y: 8 }, { str: 'LIVING', x: 9, y: 8 }] });
    expect(res.rooms.map((r) => r.name).sort()).toEqual(['BEDROOM', 'CL', 'HALL', 'LIVING']);
  });

  it("what's drawn across a double door's opening (its threshold) is no wall: the pair is a double door", () => {
    // TURBINE above, STORAGE below; a 5'-8" opening with two leaves standing
    // open and the threshold drawn across it as a strip
    const bodies = [
      ...asBodies(box(20, 16, t)),
      { a: { x: 0, y: 8 }, b: { x: 7, y: 8 }, t }, { a: { x: 12.7, y: 8 }, b: { x: 20, y: 8 }, t },
      { a: { x: 7.1, y: 8 }, b: { x: 12.6, y: 8 }, t: 4.5 * IN },
    ];
    const arcs = [
      { c: { x: 7.1, y: 7.85 }, r: 2.83, sweepDeg: 90, p0: { x: 9.93, y: 7.85 }, p3: { x: 7.1, y: 5.02 }, closed: { x: 9.93, y: 7.85 } },
      { c: { x: 12.6, y: 7.85 }, r: 2.83, sweepDeg: 90, p0: { x: 9.77, y: 7.85 }, p3: { x: 12.6, y: 5.02 }, closed: { x: 9.77, y: 7.85 } },
    ];
    const res = runTrace({ bodies, arcs, texts: [{ str: 'TURBINE ROOM', x: 10, y: 3 }, { str: 'STORAGE', x: 10, y: 12 }] });
    expect(res.rooms.map((r) => r.name).sort()).toEqual(['STORAGE', 'TURBINE ROOM']);
    expect(res.openings.filter((o) => o.openingType === 'double_door').length).toBe(1);
  });
});
