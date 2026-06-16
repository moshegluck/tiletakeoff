import { describe, it, expect } from 'vitest';
import { materialArea, estimateMaterial, estimateProject } from '../src/engine/estimate.js';
import { rectPoly } from '../src/engine/geometry.js';

const room = (w, h, over = {}) => ({ id: 'r1', name: 'R', points: rectPoly(0, 0, w, h), assigned: ['M1'], wallHeight: 8, layout: { pattern: 'grid' }, ...over });
const floor = (over = {}) => ({ id: 'M1', name: 'F', type: 'floor', tw: 12, th: 12, grout: 0, pattern: 'grid', waste: 10, price: 5, priceUnit: 'sf', faceCoverage: 1, ...over });

describe('estimate: materialArea', () => {
  it('floor material sums room areas', () => {
    const { netSf } = materialArea(floor(), [room(10, 12)]);
    expect(netSf).toBe(120);
  });
  it('wall material uses perimeter × wall height', () => {
    const wall = floor({ type: 'wall' });
    const r = room(10, 12, { assigned: ['M1'], wallHeight: 8 });
    const { netSf } = materialArea(wall, [r]);
    expect(netSf).toBe(44 * 8); // perimeter 44 × 8
  });
  it('ignores rooms not assigned to the material', () => {
    const { netSf } = materialArea(floor(), [room(10, 12, { assigned: [] })]);
    expect(netSf).toBe(0);
  });
});

describe('estimate: waste-mode quantities', () => {
  it('120sf @ 10% waste, 1ft tile, $/sf', () => {
    const e = estimateMaterial(floor({ costMode: 'waste' }), [room(10, 12)]);
    expect(e.netSf).toBe(120);
    expect(e.grossSf).toBeCloseTo(132, 6);
    expect(e.tiles).toBe(132);
    expect(e.qty).toBeCloseTo(132, 6);   // sf priced
    expect(e.cost).toBeCloseTo(660, 6);  // 132 × $5
  });
  it('priced per tile', () => {
    const e = estimateMaterial(floor({ costMode: 'waste', priceUnit: 'tile', price: 2 }), [room(10, 12)]);
    expect(e.qty).toBe(132);
    expect(e.cost).toBe(264);
  });
  it('priced per box rounds up boxes', () => {
    const e = estimateMaterial(floor({ costMode: 'waste', priceUnit: 'box', price: 30, sfPerBox: 15 }), [room(10, 12)]);
    expect(e.qty).toBe(Math.ceil(132 / 15)); // 9 boxes
    expect(e.cost).toBe(9 * 30);
  });
});

describe('estimate: cut-mode quantities', () => {
  it('cut-reuse mode orders fewer than naive waste on a thin-strip room', () => {
    const r = room(12.25, 12.25);
    const waste = estimateMaterial(floor({ costMode: 'waste', priceUnit: 'tile' }), [r]);
    const cuts = estimateMaterial(floor({ costMode: 'cuts', priceUnit: 'tile', cutSafetyPct: 5 }), [r]);
    expect(cuts.cutInfo).toBeTruthy();
    expect(cuts.tiles).toBeLessThan(waste.tiles);
  });
  it('cut mode applies the safety margin', () => {
    const r = room(12.25, 12.25);
    const cuts = estimateMaterial(floor({ costMode: 'cuts', priceUnit: 'tile', cutSafetyPct: 5 }), [r]);
    // 151 real tiles × 1.05 = 158.55 → ceil 159
    expect(cuts.tiles).toBe(159);
  });
});

describe('estimate: defensive', () => {
  it('zero tile size does not throw and yields 0 tiles', () => {
    const e = estimateMaterial(floor({ tw: 0, th: 0 }), [room(10, 12)]);
    expect(Number.isFinite(e.tiles)).toBe(true);
    expect(e.tiles).toBe(0);
  });
  it('missing tw/th is handled (no NaN cost)', () => {
    const bad = { id: 'M1', name: 'F', type: 'floor', grout: 0, pattern: 'grid', waste: 10, price: 5, priceUnit: 'sf' };
    const e = estimateMaterial(bad, [room(10, 12)]);
    expect(Number.isNaN(e.cost)).toBe(false);
  });
});

describe('estimate: project rollup', () => {
  it('adds labor and tax', () => {
    const state = {
      materials: [floor({ costMode: 'waste' })],
      rooms: [room(10, 12)],
      laborRatePerSf: 3,
      taxRate: 10,
    };
    const e = estimateProject(state);
    expect(e.floorSf).toBe(120);
    expect(e.labor).toBe(360);          // 120 × 3
    expect(e.materialSubtotal).toBeCloseTo(660, 6);
    expect(e.subtotal).toBeCloseTo(1020, 6);
    expect(e.tax).toBeCloseTo(102, 6);  // 10%
    expect(e.total).toBeCloseTo(1122, 6);
  });
});
