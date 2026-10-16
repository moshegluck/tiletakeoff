import { describe, it, expect } from 'vitest';
import { roomPattern, wasteFor, migrateRoomLayouts } from '../src/engine/patterns.js';
import { estimateMaterial } from '../src/engine/estimate.js';
import { rectPoly } from '../src/engine/geometry.js';

const herring = { id: 'H', name: 'Oak', type: 'floor', tw: 4, th: 24, grout: 0, pattern: 'herringbone', waste: 15, price: 10, priceUnit: 'sf' };

describe('patterns: a room lays its tile in the tile\'s pattern unless it says otherwise', () => {
  it('inherits, and an explicit room pattern wins', () => {
    expect(roomPattern({ layout: {} }, herring)).toBe('herringbone');
    expect(roomPattern({ layout: { pattern: 'grid' } }, herring)).toBe('grid');
    expect(roomPattern(null, null)).toBe('grid');
  });
  it('waste: the tile\'s own waste for its own pattern, the rule of thumb otherwise', () => {
    expect(wasteFor(herring, 'herringbone')).toBe(15);
    expect(wasteFor({ ...herring, waste: 18 }, 'herringbone')).toBe(18);   // estimator's tuning kept
    expect(wasteFor(herring, 'grid')).toBe(10);
    expect(wasteFor(herring, 'border')).toBe(15);
    expect(wasteFor({ ...herring, type: 'wall' }, 'grid')).toBe(15);
  });
  it('waste in the estimate follows each room\'s pattern', () => {
    const rooms = [
      { id: 'a', name: 'A', points: rectPoly(0, 0, 10, 10), assigned: ['H'], layout: {} },                   // herringbone: 15%
      { id: 'b', name: 'B', points: rectPoly(20, 0, 10, 10), assigned: ['H'], layout: { pattern: 'grid' } }, // grid: 10%
    ];
    const e = estimateMaterial(herring, rooms);
    expect(e.netSf).toBeCloseTo(200, 9);
    expect(e.grossSf).toBeCloseTo(100 * 1.15 + 100 * 1.10, 9);
    expect(e.wastePct).toBeCloseTo(12.5, 9);
    expect(e.usedRooms.map((u) => u.pattern)).toEqual(['herringbone', 'grid']);
  });
});

describe('patterns: old projects', () => {
  it('drop the default straight grid that hid the tile\'s pattern, keep real choices', () => {
    const rooms = [
      { id: '1', layout: { pattern: 'grid', angleDeg: 0, origin: { x: 0, y: 0 } } },
      { id: '2', layout: { pattern: 'grid', angleDeg: 15, origin: { x: 0, y: 0 } } },
      { id: '3', layout: { pattern: 'grid', angleDeg: 0, origin: { x: 2, y: 0 } } },
      { id: '4', layout: { pattern: 'brick_50', angleDeg: 0 } },
      { id: '5' },
    ];
    const out = migrateRoomLayouts(rooms);
    expect(out[0].layout).toEqual({ angleDeg: 0, origin: { x: 0, y: 0 } });
    expect(out.slice(1)).toEqual(rooms.slice(1));
  });
});
