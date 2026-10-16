import { describe, it, expect } from 'vitest';
import { fitLabelLines, clusterPins } from '../src/components/canvasUtils.js';

// a fixed-width font: 0.6 × size per character
const measure = (t, size) => t.length * size * 0.6;
const lines = [
  { text: 'NEW PLAY AREA', size: 12, min: 8.5 },
  { text: '200.3 sf', size: 11, min: 8.5 },
];

describe('fitLabelLines', () => {
  it('keeps both lines at full size in a roomy room', () => {
    expect(fitLabelLines(lines, 200, 100, measure)).toEqual([
      { text: 'NEW PLAY AREA', size: 12, i: 0 }, { text: '200.3 sf', size: 11, i: 1 },
    ]);
  });
  it('shrinks a name that is a little too wide, never below the minimum', () => {
    const out = fitLabelLines(lines, 90, 100, measure);
    expect(out[0].text).toBe('NEW PLAY AREA');
    expect(out[0].size).toBeLessThan(12);
    expect(out[0].size).toBeGreaterThanOrEqual(8.5);
    expect(measure(out[0].text, out[0].size)).toBeLessThanOrEqual(90 - 8);
  });
  it('leaves out what cannot fit: a closet at low zoom gets no label', () => {
    expect(fitLabelLines(lines, 20, 14, measure)).toEqual([]);
  });
  it('drops the second line when the room is too short for two', () => {
    const out = fitLabelLines(lines, 200, 22, measure);
    expect(out.map((l) => l.text)).toEqual(['NEW PLAY AREA']);
  });
  it('shows the area alone when only the name is too long', () => {
    const out = fitLabelLines([{ text: 'NEW OFFICE / STUDY / GUEST', size: 12, min: 8.5 }, lines[1]], 70, 60, measure);
    expect(out.map((l) => l.text)).toEqual(['200.3 sf']);
  });
  it('wraps a long name onto two lines rather than hiding it', () => {
    const out = fitLabelLines([{ text: 'NEW OFFICE/ STUDY', size: 12, min: 8.5, wrap: true }, lines[1]], 70, 60, measure);
    expect(out.map((l) => l.text)).toEqual(['NEW OFFICE/', 'STUDY', '200.3 sf']);
    expect(out[0].size).toBe(out[1].size);
    expect(out[0].size).toBeGreaterThanOrEqual(8.5);
  });
  it('a sliver too short for even one line gets nothing', () => {
    expect(fitLabelLines(lines, 300, 8, measure)).toEqual([]);
  });
  it('skips empty lines (no scale yet → no area)', () => {
    expect(fitLabelLines([lines[0], { text: '', size: 11, min: 8.5 }], 200, 100, measure)).toHaveLength(1);
  });
});

describe('clusterPins', () => {
  it('leaves pins that are apart as they are', () => {
    const g = clusterPins([{ x: 0, y: 0, severity: 'warn' }, { x: 100, y: 0, severity: 'error' }], 20);
    expect(g).toHaveLength(2);
  });
  it('merges overlapping pins into one, counted, coloured by the worst', () => {
    const g = clusterPins([
      { x: 0, y: 0, severity: 'warn' }, { x: 8, y: 0, severity: 'error' }, { x: 4, y: 6, severity: 'warn' },
    ], 20);
    expect(g).toHaveLength(1);
    expect(g[0].items).toHaveLength(3);
    expect(g[0].severity).toBe('error');
    expect(g[0].x).toBeCloseTo(4); expect(g[0].y).toBeCloseTo(2);
  });
  it('never drops a pin', () => {
    const pins = Array.from({ length: 40 }, (_, i) => ({ x: (i % 7) * 9, y: Math.floor(i / 7) * 9, severity: i % 3 ? 'warn' : 'error' }));
    const g = clusterPins(pins, 20);
    expect(g.reduce((a, q) => a + q.items.length, 0)).toBe(40);
  });
});
