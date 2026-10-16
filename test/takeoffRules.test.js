import { describe, it, expect } from 'vitest';
import { floorTakeoff, wallTakeoff, parseShowers, roundUp, showersText } from '../src/engine/takeoffRules.js';
import { rectPoly } from '../src/engine/geometry.js';

// Moshe's Willow Tree job (proposal #41765): every number below is on the proposal
const bath = (w, d, fixtures = {}, over = {}) => ({ id: 'b', name: 'BATH', points: rectPoly(0, 0, w, d), assigned: [], fixtures: { doors: 1, ...fixtures }, ...over });

describe('Artistic takeoff rules', () => {
  it('guest shower bath 9.25x5, SH 5x2.75, 10\' fully tiled: floor 33, walls 271', () => {
    const r = bath(9.25, 5, { showers: [{ w: 5, d: 2.75 }] }, { wallHeight: 10 });
    const f = floorTakeoff(r);
    expect(f.net).toBeCloseTo(32.5, 9);
    expect(f.sf).toBe(33);
    expect(f.showers[0].sf).toBe(14);
    const w = wallTakeoff(r, 10);
    expect(w.lf).toBeCloseTo(28.5, 9);
    expect(w.sf).toBe(271);               // 105 shower walls + 166 rest of walls on the proposal
    expect(w.text).toBe("28.5 LF × 10' = 285 − 14 (door) = 271 → 271 SF");
  });

  it('master bath 14.75x11 at 9\': walls 463.5 − 14 = 449.5 → 450', () => {
    expect(wallTakeoff(bath(14.75, 11), 9).sf).toBe(450);
  });

  it('tub bath 10x5 at 9\': floor 50 − 10 = 40, walls 270 − 14 − 10 = 246', () => {
    const r = bath(10, 5, { tubs: 1 });
    expect(floorTakeoff(r).sf).toBe(40);
    expect(wallTakeoff(r, 9).sf).toBe(246);
  });

  it('a half-tiled wall (4\'-0") takes 8 SF a door', () => {
    expect(wallTakeoff(bath(10, 8), 4).sf).toBe(36 * 4 - 8);
  });

  it('a traced room: doorways go back into the perimeter; a standard door is 14 SF, a wide opening its width; windows stay', () => {
    const r = { id: 't', points: rectPoly(0, 0, 12, 10), wallHeight: 9, wallLf: 44 - 2.5 - 6, openings: [
      { width: 2.5, type: 'door' }, { width: 6, type: 'opening' }, { width: 3, type: 'window' },
    ] };
    const w = wallTakeoff(r, 9);
    expect(w.lf).toBeCloseTo(44, 9);
    expect(w.sf).toBe(44 * 9 - 14 - 6 * 7);
    expect(w.windows).toBe(1);
    expect(w.text).toMatch(/− 14 \(door\) − 42 \(6' opening\).*1 window cut \(not deducted\)/);
  });

  it('a double door comes off at its own width', () => {
    const r = { id: 't', points: rectPoly(0, 0, 10, 10), wallLf: 40 - 4, openings: [{ width: 4, type: 'double_door' }] };
    expect(wallTakeoff(r, 8).sf).toBe(40 * 8 - 4 * 7);
  });

  it('everything rounds up to whole SF, never down', () => {
    expect(roundUp(32.01)).toBe(33);
    expect(roundUp(33)).toBe(33);
    expect(roundUp(33.0000000001)).toBe(33);
  });

  it('reads the shower notation off the plan', () => {
    expect(parseShowers('SH 5x2.75')).toEqual([{ w: 5, d: 2.75 }]);
    expect(parseShowers("5'-0\" x 2'-9\", 4x3")).toEqual([{ w: 5, d: 2.75 }, { w: 4, d: 3 }]);
    expect(parseShowers('nonsense')).toEqual([]);
    expect(showersText([{ w: 5, d: 2.75 }, { w: 4, d: 3 }])).toBe('5x2.75, 4x3');
  });
});
