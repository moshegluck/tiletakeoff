import { describe, it, expect } from 'vitest';
import { hexA, axisLock, inPoly, makeTransforms } from '../src/components/canvasUtils.js';

describe('canvasUtils: hexA', () => {
  it('converts hex + alpha to rgba', () => {
    expect(hexA('#000000', 0.5)).toBe('rgba(0,0,0,0.5)');
    expect(hexA('#ffffff', 1)).toBe('rgba(255,255,255,1)');
    expect(hexA('#c8521f', 0.1)).toBe('rgba(200,82,31,0.1)');
  });
});

describe('canvasUtils: axisLock', () => {
  it('locks to horizontal when dx dominates', () => {
    expect(axisLock({ x: 0, y: 0 }, { x: 10, y: 2 })).toEqual({ x: 10, y: 0 });
  });
  it('locks to vertical when dy dominates', () => {
    expect(axisLock({ x: 0, y: 0 }, { x: 2, y: 10 })).toEqual({ x: 0, y: 10 });
  });
});

describe('canvasUtils: inPoly', () => {
  const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  it('detects inside and outside', () => {
    expect(inPoly(5, 5, sq)).toBe(true);
    expect(inPoly(15, 5, sq)).toBe(false);
  });
});

describe('canvasUtils: makeTransforms', () => {
  it('screen/model round-trip', () => {
    const view = { x: 80, y: 40, zoom: 2 };
    const { toScreen, toModel } = makeTransforms(view, 0.05);
    const s = toScreen(10, 20);
    const m = toModel(s.x, s.y);
    expect(m.x).toBeCloseTo(10, 9);
    expect(m.y).toBeCloseTo(20, 9);
  });
  it('ft/px uses scale', () => {
    const { ft2px, px2ft } = makeTransforms({ x: 0, y: 0, zoom: 1 }, 0.05);
    expect(ft2px(1)).toBeCloseTo(20, 9);   // 1ft / 0.05 = 20px
    expect(px2ft(20)).toBeCloseTo(1, 9);
  });
  it('no scale → identity ft/px', () => {
    const { ft2px } = makeTransforms({ x: 0, y: 0, zoom: 1 }, null);
    expect(ft2px(5)).toBe(5);
  });
});
