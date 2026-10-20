import { describe, it, expect } from 'vitest';
import { storefronts } from '../src/engine/trace/glass.js';

// Bais Rochel's lobby and vestibules: storefronts of thin glazing between
// mullions, with door pairs in them, 20–30 ft between the wall stubs
const IN = 1 / 12;
const glazing = (x0, x1, y = 0) => [0, 1, 2].map((k) => ({ a: { x: x0, y: y + k * IN }, b: { x: x1, y: y + k * IN } }));
// the wall stubs a front stands between, in line with it
const stubs = (x0, x1, y = IN) => [{ a: { x: x0 - 3, y }, b: { x: x0, y } }, { a: { x: x1, y }, b: { x: x1 + 3, y } }];
const door = (x0, x1, y = 0) => [{ a: { x: x0, y }, b: { x: x0, y: y + 3 } }, { a: { x: x1, y }, b: { x: x1, y: y + 3 } }, { a: { x: x0, y: y + 3 }, b: { x: (x0 + x1) / 2, y } }];

describe('storefronts: glazing wider than any opening is wall', () => {
  it('sidelights and door pairs across a 22 ft front: each run of glass is a thin wall, the doors left to bridge', () => {
    const win = [...glazing(0, 3), ...glazing(9, 12), ...glazing(18, 21)];
    const doors = [...door(3.2, 8.8), ...door(12.2, 17.8)];
    const bodies = storefronts(win, doors, stubs(0, 21));
    expect(bodies.map((b) => [+b.a.x.toFixed(2), +b.b.x.toFixed(2)])).toEqual([[0, 3], [9, 12], [18, 21]]);
    expect(bodies.every((b) => Math.abs(b.a.y - IN) < 1e-9 && b.t >= 2 * IN && b.t < 3 * IN)).toBe(true);
  });

  it('pieces meeting across mullions are one run; entrance doors at either end count in the span', () => {
    // a sidelight between two pairs of entrance doors: 18.5 ft from stub to stub
    expect(storefronts([...glazing(7.3, 11)], [...door(0.2, 7.2), ...door(11.1, 18.3)], stubs(0, 18.5)).length).toBe(1);
    // a 22 ft run of glass in 5.4 ft pieces between mullions
    const run = [0, 5.5, 11, 16.5].flatMap((x) => glazing(x, x + 5.4));
    const [b] = storefronts(run, [], stubs(0, 21.9));
    expect(b.a.x).toBeCloseTo(0, 6);
    expect(b.b.x).toBeCloseTo(21.9, 6);
  });

  it('an ordinary window stays a window; windows and doors between wall piers are no chain', () => {
    expect(storefronts(glazing(0, 6), [], stubs(0, 6))).toEqual([]);
    // three 5 ft windows 3 ft apart (piers between, no doors): no storefront
    expect(storefronts([...glazing(0, 5), ...glazing(8, 13), ...glazing(16, 21)], [], stubs(0, 21))).toEqual([]);
    // …nor with a door beside each pier (4 Howard's rear wall): the pier's faces run along the line
    const piers = [{ a: { x: 5, y: -0.2 }, b: { x: 6, y: -0.2 } }, { a: { x: 5, y: 0.3 }, b: { x: 6, y: 0.3 } }, { a: { x: 13, y: -0.2 }, b: { x: 14, y: -0.2 } }, { a: { x: 13, y: 0.3 }, b: { x: 14, y: 0.3 } }];
    expect(storefronts([...glazing(0, 5), ...glazing(8, 13), ...glazing(16, 21)], [...door(6, 8), ...door(14, 16)], [...stubs(0, 21), ...piers])).toEqual([]);
  });

  it('glazing floating in a room (a skylight drawn overhead) is no front: no wall at its ends', () => {
    expect(storefronts(glazing(0, 22), [])).toEqual([]);
    expect(storefronts(glazing(0, 22), [], stubs(0, 22)).length).toBe(1);
  });
});
