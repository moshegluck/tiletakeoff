import { describe, it, expect } from 'vitest';
import { runTrace } from '../src/engine/trace/index.js';
import { roomSeeds } from '../src/engine/trace/seeds.js';
import { wallsToLines } from './fixtures/planFactory.js';

// A bath whose door opens between two wall corners onto a narrow hall: with
// no swing or door drawing the trace leaves that doorway open (two corners
// face each other across every hallway too), and the bath and the hall come
// out as one space.
const EXT = 8 / 12, INT = 4.5 / 12;
const walls = [
  { x1: 0, y1: 0, x2: 20, y2: 0, t: EXT }, { x1: 0, y1: 20, x2: 20, y2: 20, t: EXT },
  { x1: 0, y1: 0, x2: 0, y2: 20, t: EXT }, { x1: 20, y1: 0, x2: 20, y2: 20, t: EXT },
  { x1: 8, y1: 0, x2: 8, y2: 8, t: INT },                                            // the bath's east wall
  { x1: 0, y1: 8, x2: 4, y2: 8, t: INT }, { x1: 6.5, y1: 8, x2: 8, y2: 8, t: INT },  // its north wall, the door between
  { x1: 4, y1: 8, x2: 4, y2: 20, t: INT },                                           // the linen closet's wall
  { x1: 6.5, y1: 8, x2: 6.5, y2: 20, t: INT },                                       // the hall's east wall
];
const lines = wallsToLines(walls, [], 20, 20);
const named = (res) => Object.fromEntries(res.rooms.map((r) => [r.name, +r.area.toFixed(1)]));

describe('seeds: rooms the plan tells apart where the walls do not', () => {
  const texts = [{ str: 'BATH', x: 3, y: 3 }, { str: 'HALL', x: 5.25, y: 16 }, { str: 'LINEN', x: 2, y: 14 }, { str: 'BEDROOM', x: 14, y: 10 }];

  it('two names in one space part at the narrowest gap between them — flagged there', () => {
    const before = runTrace({ lines, arcs: [], texts, options: { seedGaps: false, necks: false } });
    expect(before.rooms.find((r) => r.name === 'BATH').area).toBeGreaterThan(75);
    expect(before.flags.some((f) => f.kind === 'merged_rooms')).toBe(true);

    const res = runTrace({ lines, arcs: [], texts });
    const a = named(res);
    expect(a.BATH).toBeCloseTo(56, 0);
    expect(a.HALL).toBeCloseTo(24.4, 0);
    const f = res.flags.find((x) => x.kind === 'seeded_gap');
    expect(f.msg).toMatch(/2'-6" gap.*"BATH" and "HALL"/);
    expect(f.at.y).toBeCloseTo(8, 1);
    // both rooms carry the flag: neither number is silent
    expect(res.rooms.filter((r) => r.flags.includes(f.id)).map((r) => r.name).sort()).toEqual(['BATH', 'HALL']);
  });

  it('a point from a reading of the plan parts it too, and names the room it finds', () => {
    const res = runTrace({ lines, arcs: [], texts: texts.filter((t) => t.str !== 'HALL'), seeds: [{ x: 5.25, y: 15, name: 'hall', type: 'hall' }] });
    const a = named(res);
    expect(a.BATH).toBeCloseTo(56, 0);
    expect(a.hall).toBeCloseTo(24.4, 0);
  });

  it('two halls in one space stay one floor (a foyer and its hall, however narrow the passage)', () => {
    const res = runTrace({ lines, arcs: [], texts: [{ str: 'FOYER', x: 3, y: 3 }, { str: 'HALL', x: 5.25, y: 16 }] });
    expect(res.flags.some((f) => f.kind === 'seeded_gap')).toBe(false);
  });

  it("a reading's point for a room the sheet already names is that name's seed", () => {
    const spots = [{ x: 3, y: 3, name: 'MASTER BATH', type: 'bath', roomId: 'r1', typed: true }];
    const at = () => 'r1';
    expect(roomSeeds(spots, [{ x: 6, y: 6, name: 'Master Bath', type: 'bathroom' }], at)).toHaveLength(1);
    expect(roomSeeds(spots, [{ x: 9, y: 9, name: 'closet', type: 'closet' }], at).map((s) => s.type)).toEqual(['bath', 'closet']);
  });

  it('the reading says what a name of no known kind is: "ROOM #3" is a bath (19 Virginia\'s mikvah rooms)', () => {
    const spots = [{ x: 3, y: 3, name: 'ROOM #3', type: 'room', roomId: 'r1', typed: false }];
    const seeds = roomSeeds(spots, [{ x: 4, y: 4, name: 'ROOM #3', type: 'bathroom' }], () => 'r1');
    expect(seeds.map((s) => [s.name, s.type])).toEqual([['ROOM #3', 'bath']]);
  });
});

describe('necks: a doorway the trace left open, read by its width', () => {
  // a 12x15 bedroom; at its foot a recess 3 ft deep beside the bath, open to
  // the bedroom between the bath wall's stub and the exterior wall
  const recess = (open) => wallsToLines([
    { x1: 0, y1: 0, x2: 12, y2: 0, t: EXT }, { x1: 0, y1: 15, x2: 12, y2: 15, t: EXT },
    { x1: 0, y1: 0, x2: 0, y2: 15, t: EXT }, { x1: 12, y1: 0, x2: 12, y2: 15, t: EXT },
    { x1: open, y1: 12, x2: 12, y2: 12, t: INT, capA: 0 }, { x1: 7, y1: 12, x2: 7, y2: 15, t: INT },
  ], [], 12, 15);
  const texts = [{ str: 'BEDROOM', x: 6, y: 6 }, { str: 'BATH', x: 9.5, y: 13.5 }];
  const inside = (x, y, q) => {
    let c = false;
    for (let i = 0, j = q.length - 1; i < q.length; j = i++) if ((q[i].y > y) !== (q[j].y > y) && x < ((q[j].x - q[i].x) * (y - q[i].y)) / (q[j].y - q[i].y) + q[i].x) c = !c;
    return c;
  };
  const at = (res, x, y) => res.rooms.find((r) => r.poly && inside(x, y, r.poly));

  it("a door's width into a small space closes it off as its own area, flagged", () => {
    const res = runTrace({ lines: recess(2.75), texts });
    const nook = at(res, 2, 13.5);
    expect(nook.name).not.toBe('BEDROOM');
    const f = res.flags.find((x) => x.kind === 'seeded_gap');
    expect(f.msg).toMatch(/door's width/);
    expect(nook.flags).toContain(f.id);
  });
  it('an opening wider than a door stays part of the room (an open plan, a wide nook)', () => {
    const res = runTrace({ lines: recess(5.5), texts });
    expect(at(res, 2, 13.5)?.name).toBe('BEDROOM');
  });
  it('turned off, the doorway stays open', () => {
    const res = runTrace({ lines: recess(2.75), texts, options: { necks: false } });
    expect(at(res, 2, 13.5)?.name).toBe('BEDROOM');
  });
});
