import { describe, it, expect } from 'vitest';
import { leakPoints } from '../src/engine/trace/leaks.js';
import { runTrace } from '../src/engine/trace/index.js';
import { wallsToLines } from './fixtures/planFactory.js';

const E = (ax, ay, bx, by) => ({ a: { x: ax, y: ay }, b: { x: bx, y: by } });
const nodesOf = (edges) => [...new Map(edges.flatMap((e) => [e.a, e.b]).map((p) => [`${p.x},${p.y}`, p])).values()];
const leaks = (edges, from) => leakPoints(edges, nodesOf(edges), from);
const span = (g) => [g.at, g.to].map((p) => [+p.x.toFixed(2), +p.y.toFixed(2)]).sort((p, q) => p[0] - q[0] || p[1] - q[1]);

describe('leakPoints: where a room that does not close opens', () => {
  // a 20 x 12 room, its east wall broken from y 4 to y 7
  const room = [E(0, 0, 20, 0), E(0, 12, 20, 12), E(0, 0, 0, 12), E(20, 0, 20, 4), E(20, 7, 20, 12)];

  it('finds the gap in the wall from anywhere in the room; a partition stopping in the room is no gap', () => {
    const [a, b, out] = leaks([...room, E(5, 12, 5, 9)], [{ x: 3, y: 6 }, { x: 10, y: 6 }, { x: 30, y: 6 }]);
    for (const r of [a, b]) {
      expect(span(r)).toEqual([[20, 4], [20, 7]]);
      expect(r.gap).toBeCloseTo(3, 6);
      expect(r.gaps.length).toBe(1);
    }
    // a name outside the walls: no gap to close
    expect(out).toBe(null);
  });

  it('two gaps: both', () => {
    // …and the west wall stopping 2 ft short of the north wall
    const walls = [...room.filter((e) => e.a.x !== 0 || e.b.x !== 0), E(0, 0, 0, 10)];
    const [r] = leaks(walls, [{ x: 10, y: 6 }]);
    expect(r.gaps.map(span).sort()).toEqual([[[0, 10], [0, 12]], [[20, 4], [20, 7]]].sort());
  });

  it('a vestibule open to the room, its door open to the outside: the door is the gap, not the mouth', () => {
    // the room's north wall broken 8–14 for a vestibule 6 ft deep; its door 9.5–12.5
    const walls = [E(0, 0, 20, 0), E(0, 0, 0, 12), E(20, 0, 20, 12), E(0, 12, 8, 12), E(14, 12, 20, 12),
      E(8, 12, 8, 18), E(14, 12, 14, 18), E(8, 18, 9.5, 18), E(12.5, 18, 14, 18)];
    const [r] = leaks(walls, [{ x: 10, y: 5 }]);
    expect(span(r)).toEqual([[9.5, 18], [12.5, 18]]);
    expect(r.gaps.length).toBe(1);
  });

  it('a window between two corners (walls turning in at both jambs, no open end) is a gap', () => {
    // the exterior wall x = 0 broken from y 4 to y 9, a WC's walls going east at both jambs
    const walls = [E(0, 0, 0, 4), E(0, 9, 0, 14), E(0, 4, 6, 4), E(0, 9, 6, 9), E(6, 4, 6, 9), E(0, 0, 20, 0), E(0, 14, 20, 14), E(20, 0, 20, 14)];
    const [wc] = leaks(walls, [{ x: 3, y: 6.5 }]);
    expect(span(wc)).toEqual([[0, 4], [0, 9]]);
    expect(wc.gap).toBeCloseTo(5, 6);
  });
});

describe('room_not_closed flags sit on the gap', () => {
  it('a missing wall piece too wide to bridge: the flag is at its end, with the gap, in no room', () => {
    const EXT = 8 / 12, INT = 4.5 / 12;
    const walls = [
      { x1: 0, y1: 0, x2: 44, y2: 0, t: EXT }, { x1: 0, y1: 20, x2: 44, y2: 20, t: EXT },
      { x1: 0, y1: 0, x2: 0, y2: 20, t: EXT }, { x1: 44, y1: 0, x2: 44, y2: 20, t: EXT },
      { x1: 12, y1: 0, x2: 12, y2: 20, t: INT }, { x1: 32, y1: 0, x2: 32, y2: 20, t: INT },
    ];
    // the den's south wall missing for 18 ft
    const lines = wallsToLines(walls, [{ axis: 'h', c: 20, s: 13, w: 18, t: EXT }], 44, 20);
    const res = runTrace({ lines, arcs: [], texts: [{ str: 'STUDY', x: 6, y: 10 }, { str: 'DEN', x: 22, y: 10 }, { str: 'OFFICE', x: 38, y: 10 }] });
    const f = res.flags.find((x) => x.kind === 'room_not_closed');
    expect(f.msg).toMatch(/"DEN".*18'-0" gap/);
    expect(f.label).toEqual({ x: 22, y: 10 });
    expect(span(f.gaps[0])).toEqual([[13, 20], [31, 20]]);
    // the rooms either side of the den keep their own status
    expect(res.rooms.map((r) => [r.name, r.status]).sort()).toEqual([['OFFICE', 'ok'], ['STUDY', 'ok']]);
  });
});
