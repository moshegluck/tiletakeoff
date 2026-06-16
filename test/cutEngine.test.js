import { describe, it, expect } from 'vitest';
import { analyzeCuts, analyzeProject } from '../src/engine/cutEngine.js';
import { rectPoly } from '../src/engine/geometry.js';

const roomOf = (w, h, assigned = ['M1'], pattern = 'grid') =>
  ({ name: 'R', points: rectPoly(0, 0, w, h), layout: { pattern }, assigned });
const mat = (over = {}) => ({ id: 'M1', name: 'F', type: 'floor', tw: 12, th: 12, grout: 0, pattern: 'grid', ...over });

describe('cutEngine: exact fit', () => {
  it('10×12 with 1ft tile → 120 full, no cuts, nothing saved', () => {
    const r = analyzeCuts([roomOf(10, 12)], mat(), { mode: 'practical' });
    expect(r.fullTiles).toBe(120);
    expect(r.cutPieces).toBe(0);
    expect(r.tilesSavedByReuse).toBe(0);
    expect(r.totalTiles).toBe(120);
    expect(r.naiveTotal).toBe(120);
  });
});

describe('cutEngine: offcut redistribution', () => {
  it('thin-strip room chains offcuts and saves tiles', () => {
    // 12.25×12.25, 1ft tile: 144 full + 25 thin cuts; chained reuse → 7 broken.
    const r = analyzeCuts([roomOf(12.25, 12.25)], mat(), { mode: 'practical' });
    expect(r.fullTiles).toBe(144);
    expect(r.cutPieces).toBe(25);
    expect(r.newTilesBrokenForCuts).toBe(7);
    expect(r.reusedOffcuts).toBe(18);
    expect(r.tilesSavedByReuse).toBe(18);
    expect(r.pctSaved).toBeGreaterThan(10);
  });

  it('redistribution NEVER orders more than naive (core invariant)', () => {
    // fuzz a spread of room sizes; redistributed total must be <= naive total.
    // NOTE: best-fit-decreasing ("optimize") is a heuristic, so it is NOT
    // guaranteed to beat first-fit ("practical") on every single geometry —
    // it can tie or, rarely, order one more. The hard invariant is that
    // neither mode ever exceeds the naive (one-tile-per-cut) order.
    for (let w = 7; w <= 14; w += 0.37) {
      for (let h = 6; h <= 13; h += 0.53) {
        const r = analyzeCuts([roomOf(w, h)], mat(), { mode: 'practical' });
        expect(r.totalTiles).toBeLessThanOrEqual(r.naiveTotal);
        const o = analyzeCuts([roomOf(w, h)], mat(), { mode: 'optimize' });
        expect(o.totalTiles).toBeLessThanOrEqual(o.naiveTotal);
      }
    }
  });

  it('total tiles always = full + tiles broken for cuts', () => {
    const r = analyzeCuts([roomOf(11.3, 9.7)], mat(), { mode: 'practical' });
    expect(r.totalTiles).toBe(r.fullTiles + r.newTilesBrokenForCuts);
  });
});

describe('cutEngine: grain lock (planks)', () => {
  it('auto-detects grain lock for a 4:1 plank', () => {
    const r = analyzeCuts([roomOf(10, 9.3)], mat({ tw: 6, th: 24 }), { mode: 'optimize' });
    expect(r.grainLocked).toBe(true);
  });
  it('grain-locked planks do not reuse cross-grain offcuts', () => {
    // strips cut off plank length are wrong orientation to reuse → 0 reuse
    const r = analyzeCuts([roomOf(10, 9.3)], mat({ tw: 6, th: 24 }), { mode: 'optimize' });
    expect(r.reusedOffcuts).toBe(0);
  });
  it('square tile is NOT grain locked', () => {
    const r = analyzeCuts([roomOf(10, 10.5)], mat(), { mode: 'practical' });
    expect(r.grainLocked).toBe(false);
  });
});

describe('cutEngine: angled patterns flagged', () => {
  it('herringbone carries the conservative-estimate note', () => {
    const r = analyzeCuts([roomOf(8, 8.4, ['M1'], 'herringbone')], mat({ tw: 6, th: 24, pattern: 'herringbone' }), { mode: 'practical' });
    expect(r.note).toBeTruthy();
  });
});

describe('cutEngine: degenerate / defensive', () => {
  it('a room with no assigned material yields zero work', () => {
    const r = analyzeCuts([roomOf(10, 12, [])], mat(), { mode: 'practical' });
    expect(r.fullTiles).toBe(0);
    expect(r.totalTiles).toBe(0);
  });
  it('zero-area room does not throw and yields zero', () => {
    const z = { name: 'Z', points: rectPoly(0, 0, 0, 0), layout: { pattern: 'grid' }, assigned: ['M1'] };
    const r = analyzeCuts([z], mat(), { mode: 'practical' });
    expect(r.totalTiles).toBe(0);
  });
});

describe('cutEngine: analyzeProject', () => {
  it('rolls up naive/practical/optimized totals across materials', () => {
    const state = {
      materials: [mat()],
      rooms: [roomOf(11.5, 8), roomOf(11.5, 5)],
    };
    const p = analyzeProject(state);
    expect(p.rows.length).toBe(1);
    // naive is the upper bound for both heuristics
    expect(p.totals.naive).toBeGreaterThanOrEqual(p.totals.practical);
    expect(p.totals.naive).toBeGreaterThanOrEqual(p.totals.optimized);
  });
});
