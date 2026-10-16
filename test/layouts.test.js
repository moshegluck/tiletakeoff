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

// Sample a 9 × 7 ft floor: every point must sit in exactly one tile.
function coverage(pattern, tileW, tileH, angleDeg = 0, origin = { x: 0.37, y: -0.21 }) {
  const poly = room(9, 7);
  const tiles = generateLayout(poly, { pattern, tileW, tileH, angleDeg, origin });
  let gaps = 0, overlaps = 0, n = 0;
  for (let y = 0.011; y < 7; y += 0.137) for (let x = 0.017; x < 9; x += 0.129) {
    n++;
    let hits = 0, inside = 0;
    for (const t of tiles) {
      const dx = x - t.cx, dy = y - t.cy, c = Math.cos(t.rot), s = Math.sin(t.rot);
      const lx = Math.abs(dx * c + dy * s), ly = Math.abs(-dx * s + dy * c);
      if (lx <= t.w / 2 + 1e-9 && ly <= t.h / 2 + 1e-9) hits++;            // on or in
      if (lx < t.w / 2 - 1e-9 && ly < t.h / 2 - 1e-9) inside++;            // strictly in
    }
    if (hits === 0) gaps++;
    if (inside > 1) overlaps++;
  }
  return { gap: gaps / n, overlap: overlaps / n };
}

describe('layouts: every pattern tiles the floor exactly (no gaps, no overlaps)', () => {
  const cases = [
    ['grid', 1, 1], ['grid', 2, 1], ['brick_50', 0.5, 0.25], ['brick_33', 4, 0.5],
    ['diagonal', 1, 1], ['diagonal', 2, 1],
    ['herringbone', 2, 1 / 3], ['herringbone', 1 / 3, 2], ['herringbone', 0.5, 0.25], ['herringbone', 4, 0.75],
    ['basketweave', 8 / 12, 4 / 12], ['basketweave', 0.5, 1.5], ['basketweave', 1, 1],
  ];
  for (const [p, w, h] of cases) {
    for (const ang of [0, 30, 90]) {
      it(`${p} ${(w * 12).toFixed(0)}×${(h * 12).toFixed(0)} at ${ang}°`, () => {
        const c = coverage(p, w, h, ang);
        expect(c.gap).toBe(0);
        expect(c.overlap).toBe(0);
      });
    }
  }

  it('a grid at an angle keeps a tile corner on the origin', () => {
    const o = { x: 1.25, y: 2.5 };
    const tiles = generateLayout(room(6, 6), { pattern: 'grid', tileW: 1, tileH: 1, angleDeg: 30, origin: o });
    const corner = (t) => {
      const c = Math.cos(t.rot), s = Math.sin(t.rot);
      return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => ({ x: t.cx + (a * t.w / 2) * c - (b * t.h / 2) * s, y: t.cy + (a * t.w / 2) * s + (b * t.h / 2) * c }));
    };
    expect(tiles.some((t) => corner(t).some((p) => Math.hypot(p.x - o.x, p.y - o.y) < 1e-9))).toBe(true);
  });
});
