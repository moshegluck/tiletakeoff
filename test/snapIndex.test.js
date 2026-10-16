import { describe, it, expect } from 'vitest';
import { buildSnapIndex } from '../src/engine/snapIndex.js';

const L = (ax, ay, bx, by) => ({ a: { x: ax, y: ay }, b: { x: bx, y: by } });

describe('snapIndex', () => {
  // a room's wall faces: 100..400 × 100..300, plus a partition that stops short
  const idx = buildSnapIndex([
    L(100, 100, 400, 100), L(400, 100, 400, 300), L(400, 300, 100, 300), L(100, 300, 100, 100),
    L(250, 100.5, 250, 180),                    // partition from the top wall
    L(500, 50, 500, 50.4),                      // a dot: too short to snap to
  ]);

  it('snaps to a line end (a wall corner) within reach', () => {
    expect(idx.query(104, 97, 8)).toEqual({ x: 100, y: 100, kind: 'end' });
    expect(idx.query(120, 140, 8)).toBeNull();
  });
  it('snaps onto a line when no corner is near', () => {
    const h = idx.query(180, 104, 8);
    expect(h.kind).toBe('edge');
    expect(h.x).toBeCloseTo(180, 9); expect(h.y).toBeCloseTo(100, 9);
  });
  it('finds a corner where two lines cross without sharing an end', () => {
    // the partition's line meets the bottom face's line at (250, 300) only if extended: both near?
    const b = buildSnapIndex([L(0, 0, 200, 0), L(100, -50, 100, 50)]);
    expect(b.query(103, 4, 8)).toEqual({ x: 100, y: 0, kind: 'corner' });
    // two faces that stop just short of meeting still give their corner
    const g = buildSnapIndex([L(0, 0, 96, 0), L(100, 4, 100, 100)]);
    const h = g.query(99, 1, 8);
    expect(h.kind).toBe('corner'); expect(h.x).toBeCloseTo(100, 9); expect(h.y).toBeCloseTo(0, 9);
  });
  it('ignores near-parallel lines for corners and tiny marks entirely', () => {
    const p = buildSnapIndex([L(0, 0, 200, 0), L(0, 2, 200, 3)]);
    expect(p.query(100, 1, 8).kind).toBe('edge');
    expect(idx.query(500, 50, 5)).toBeNull();
  });
  it('stays fast on a big sheet', () => {
    const lines = [];
    for (let i = 0; i < 20000; i++) { const x = (i * 37) % 4000, y = (i * 53) % 3000; lines.push(L(x, y, x + 40, y)); }
    const big = buildSnapIndex(lines);
    const t0 = performance.now();
    for (let q = 0; q < 2000; q++) big.query((q * 13) % 4000, (q * 7) % 3000, 10);
    expect(performance.now() - t0).toBeLessThan(400);
  });
});
