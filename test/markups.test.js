import { describe, it, expect } from 'vitest';
import {
  MARKUP_TYPES, markupValue, markupDims, markupUnit, markupCost, summarizeMarkups,
} from '../src/engine/markups.js';

describe('markups: measured value', () => {
  it('length sums polyline segments', () => {
    const mk = { type: 'length', points: [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 4 }] };
    expect(markupValue(mk)).toBe(7);
  });
  it('area uses polygon area', () => {
    const mk = { type: 'area', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 12 }, { x: 0, y: 12 }] };
    expect(markupValue(mk)).toBe(120);
  });
  it('rect uses corner span', () => {
    const mk = { type: 'rect', points: [{ x: 2, y: 3 }, { x: 8, y: 9 }] };
    expect(markupValue(mk)).toBe(36); // 6×6
  });
  it('count is number of points', () => {
    const mk = { type: 'count', points: [1, 2, 3, 4, 5].map((i) => ({ x: i, y: 0 })) };
    expect(markupValue(mk)).toBe(5);
  });
});

describe('markups: defensive value', () => {
  it('length with <2 points is 0', () => {
    expect(markupValue({ type: 'length', points: [{ x: 1, y: 1 }] })).toBe(0);
  });
  it('area with <3 points is 0', () => {
    expect(markupValue({ type: 'area', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })).toBe(0);
  });
  it('missing points array is 0, not a throw', () => {
    expect(markupValue({ type: 'count' })).toBe(0);
    expect(markupValue({ type: 'area' })).toBe(0);
  });
  it('unknown type is 0', () => {
    expect(markupValue({ type: 'wat', points: [] })).toBe(0);
  });
});

describe('markups: dims, unit, cost', () => {
  it('rect dims report w×h', () => {
    const d = markupDims({ type: 'rect', points: [{ x: 0, y: 0 }, { x: 6, y: 4 }] });
    expect(d).toEqual({ w: 6, h: 4 });
  });
  it('non-rect has no dims', () => {
    expect(markupDims({ type: 'length', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] })).toBeNull();
  });
  it('unit follows type', () => {
    expect(markupUnit({ type: 'length' })).toBe('lf');
    expect(markupUnit({ type: 'area' })).toBe('sf');
    expect(markupUnit({ type: 'count' })).toBe('ea');
  });
  it('cost = value × unitCost', () => {
    expect(markupCost({ type: 'count', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], unitCost: 25 })).toBe(50);
  });
  it('cost defaults to 0 unitCost', () => {
    expect(markupCost({ type: 'area', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] })).toBe(0);
  });
});

describe('markups: summary', () => {
  it('groups by type and totals cost', () => {
    const list = [
      { type: 'length', points: [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 4 }], unitCost: 2 }, // 7lf × 2 = 14
      { type: 'area', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 12 }, { x: 0, y: 12 }], unitCost: 0.5 }, // 120 × .5 = 60
      { type: 'count', points: [1, 2, 3].map((i) => ({ x: i, y: 0 })), unitCost: 25 }, // 3 × 25 = 75
    ];
    const s = summarizeMarkups(list);
    expect(s.totalCost).toBe(149);
    expect(s.byType.length).toBe(3);
  });
  it('empty list → zero', () => {
    const s = summarizeMarkups([]);
    expect(s.totalCost).toBe(0);
    expect(s.byType.length).toBe(0);
  });
});
