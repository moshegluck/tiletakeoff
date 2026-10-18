import { describe, it, expect } from 'vitest';
import { findStairs, clipToConvex, area } from '../src/engine/trace/stairs.js';
import { runTrace } from '../src/engine/trace/index.js';

// Stairs: an estimator takes a stair's landings, not its treads (Moshe's
// marked takeoffs: "Stair Landing" areas, the run left out). The trace finds
// a run by its treads and its note, and takes it off the floor it stands in.

const treads = (x0, y0, width, going, n) => Array.from({ length: n }, (_, i) => ({ a: { x: x0, y: y0 + i * going }, b: { x: x0 + width, y: y0 + i * going } }));

describe('stair runs', () => {
  it('finds a run by its treads and its note', () => {
    const lines = treads(10, 10, 4, 11 / 12, 12);
    const [st] = findStairs(lines, [{ str: 'UP 22R', x: 12, y: 13 }]);
    expect(st.treads).toBe(12);
    expect(st.going * 12).toBeCloseTo(11, 1);
    expect(st.width).toBeCloseTo(4, 2);
    expect(Math.abs(area(st.poly))).toBeCloseTo(4 * 11 * (11 / 12), 1);
    // doubled treads are the same run, once
    expect(findStairs([...lines, ...lines.map((l) => ({ a: { ...l.a }, b: { ...l.b } }))], [{ str: 'DN', x: 12, y: 13 }]).length).toBe(1);
  });

  it('no note, no stair: a field of even lines is a pattern, not a run', () => {
    expect(findStairs(treads(10, 10, 4, 11 / 12, 12), [{ str: 'LIVING ROOM', x: 12, y: 13 }])).toEqual([]);
    // too far apart for treads (a 2' tile grid)
    expect(findStairs(treads(10, 10, 4, 2, 12), [{ str: 'UP', x: 12, y: 13 }])).toEqual([]);
  });

  it('clips a room to a run', () => {
    const sq = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
    expect(Math.abs(area(clipToConvex(sq(0, 0, 10, 10), sq(5, 5, 20, 20))))).toBeCloseTo(25, 6);
    expect(Math.abs(area(clipToConvex(sq(0, 0, 10, 10), sq(5, 5, 20, 20).reverse())))).toBeCloseTo(25, 6);
  });

  it("takes the run off the floor of the room it's in; the room's tag area keeps it", () => {
    // a 20' x 12' hall (6" walls) with a 4' x 10'-1" run of 12 treads against its east wall
    const t = 0.5, W = 20, H = 12;
    const bodies = [[0, 0, W, 0], [0, H, W, H], [0, 0, 0, H], [W, 0, W, H]].map(([x1, y1, x2, y2]) => ({ a: { x: x1, y: y1 }, b: { x: x2, y: y2 }, t }));
    const stairs = findStairs(treads(W - t / 2 - 4, 1, 4, 11 / 12, 12), [{ str: 'DN', x: W - 2, y: 6 }]);
    const res = runTrace({ bodies, texts: [{ str: 'HALL', x: 6, y: 6 }], stairs });
    const room = res.rooms[0];
    const run = 4 * 11 * (11 / 12);
    expect(room.area).toBeCloseTo((W - t) * (H - t) - run, 0);
    expect(room.stairSf).toBeCloseTo(run, 0);
    expect(room.areaFaces).toBeCloseTo((W - t) * (H - t), 0);
    expect(res.flags.some((f) => f.kind === 'stair' && f.roomId === room.id)).toBe(true);
    expect(res.totals.floorSf).toBeCloseTo(room.area, 6);
  });
});
