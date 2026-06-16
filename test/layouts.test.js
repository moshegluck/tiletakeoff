import { describe, it, expect } from 'vitest';
import { PATTERNS, generateLayout, tally } from '../src/engine/layouts.js';
import { rectPoly } from '../src/engine/geometry.js';

const room = (w, h) => rectPoly(0, 0, w, h);
const opts = (over = {}) => ({ pattern: 'grid', tileW: 1, tileH: 1, angleDeg: 0, origin: { x: 0, y: 0 }, ...over });

describe('layouts: patterns', () => {
  it('exposes the documented pattern set', () => {
    const ids = PATTERNS.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['grid', 'brick_50', 'brick_33', 'herringbone', 'diagonal', 'basketweave']));
  });
});

describe('layouts: generateLayout + tally', () => {
  it('exact-fit grid → all full, zero cut', () => {
    const t = tally(generateLayout(room(10, 12), opts()), room(10, 12));
    expect(t.full).toBe(120);
    expect(t.cut).toBe(0);
    expect(t.total).toBe(120);
  });

  it('half-strip on one edge nets the right cut count', () => {
    // 11.5 wide × 12 tall, 1ft tile: 11 full cols + 1 half col → 12 cuts/row? no:
    // 132 full + 12 half-width cuts on the right edge.
    const r = rectPoly(0, 0, 11.5, 12);
    const t = tally(generateLayout(r, opts()), r);
    expect(t.full).toBe(132);
    expect(t.cut).toBe(12);
  });

  it('2ft tile in a 13×11 room → known full/cut split', () => {
    const r = rectPoly(0, 0, 13, 11);
    const t = tally(generateLayout(r, opts({ tileW: 2, tileH: 2 })), r);
    // interior 6×5 = 30 full; cuts along right (13 odd) and top (11 odd) edges
    expect(t.full).toBe(30);
    expect(t.cut).toBe(12);
  });

  it('every generated tile carries center, size, rotation', () => {
    const tiles = generateLayout(room(4, 4), opts());
    expect(tiles.length).toBeGreaterThan(0);
    for (const t of tiles) {
      expect(t).toHaveProperty('cx');
      expect(t).toHaveProperty('cy');
      expect(t.w).toBeGreaterThan(0);
      expect(t.h).toBeGreaterThan(0);
      expect(typeof t.rot).toBe('number');
    }
  });

  it('herringbone produces tiles without throwing', () => {
    const r = room(8, 8);
    const tiles = generateLayout(r, opts({ pattern: 'herringbone', tileW: 0.5, tileH: 2 }));
    expect(tiles.length).toBeGreaterThan(0);
    const t = tally(tiles, r);
    expect(t.total).toBeGreaterThan(0);
  });
});
