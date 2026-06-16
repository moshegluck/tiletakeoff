import { describe, it, expect } from 'vitest';
import {
  polygonArea, polygonPerimeter, bounds, centroid, pointInPolygon,
  classifyTile, rectPoly, clipPolygon, clippedTileArea,
} from '../src/engine/geometry.js';

const rect = (w, h) => rectPoly(0, 0, w, h);

describe('geometry: area & perimeter', () => {
  it('rectangle area and perimeter', () => {
    expect(polygonArea(rect(10, 12))).toBe(120);
    expect(polygonPerimeter(rect(10, 12))).toBe(44);
  });
  it('area is orientation-independent (CW vs CCW)', () => {
    const cw = [{ x: 0, y: 0 }, { x: 0, y: 12 }, { x: 10, y: 12 }, { x: 10, y: 0 }];
    expect(polygonArea(cw)).toBe(120);
  });
  it('triangle area (shoelace)', () => {
    expect(polygonArea([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 3 }])).toBe(6);
  });
  it('degenerate polygon has zero area, not NaN', () => {
    expect(polygonArea([{ x: 0, y: 0 }, { x: 5, y: 5 }])).toBe(0);
    expect(polygonArea([{ x: 1, y: 1 }])).toBe(0);
  });
});

describe('geometry: bounds & centroid', () => {
  it('bounds of an offset rect', () => {
    const b = bounds(rectPoly(2, 3, 10, 12));
    expect(b).toMatchObject({ minx: 2, miny: 3, maxx: 12, maxy: 15, w: 10, h: 12 });
  });
  it('centroid of a centered rect', () => {
    const c = centroid(rectPoly(-5, -5, 10, 10));
    expect(c.x).toBeCloseTo(0, 9);
    expect(c.y).toBeCloseTo(0, 9);
  });
});

describe('geometry: pointInPolygon', () => {
  const r = rect(10, 10);
  it('inside / outside', () => {
    expect(pointInPolygon(5, 5, r)).toBe(true);
    expect(pointInPolygon(15, 5, r)).toBe(false);
    expect(pointInPolygon(-1, 5, r)).toBe(false);
  });
});

describe('geometry: clipping', () => {
  const room = rect(10, 12);
  it('a fully-inside tile clips to its own area', () => {
    expect(clippedTileArea(2, 2, 1, 1, room)).toBeCloseTo(1, 6);
  });
  it('a half-out tile clips to half', () => {
    expect(clippedTileArea(9.5, 2, 1, 1, room)).toBeCloseTo(0.5, 6);
  });
  it('a corner tile clips to a quarter', () => {
    expect(clippedTileArea(9.5, 11.5, 1, 1, room)).toBeCloseTo(0.25, 6);
  });
  it('a fully-outside tile clips to zero', () => {
    expect(clippedTileArea(20, 20, 1, 1, room)).toBe(0);
  });
  it('clipPolygon returns empty for non-overlapping', () => {
    expect(clipPolygon(rectPoly(20, 20, 1, 1), room).length).toBe(0);
  });
});

describe('geometry: classifyTile', () => {
  const room = rect(10, 10);
  it('full when wholly inside', () => {
    expect(classifyTile(2, 2, 1, 1, room)).toBe('full');
  });
  it('out when wholly outside', () => {
    expect(classifyTile(20, 20, 1, 1, room)).toBe('out');
  });
  it('cut when straddling an edge', () => {
    expect(classifyTile(9.5, 2, 1, 1, room)).toBe('cut');
  });
  it('edge-flush tile counts as full (epsilon inset)', () => {
    // tile exactly filling the corner 0..1 should be full, not cut
    expect(classifyTile(0, 0, 1, 1, room)).toBe('full');
  });
});
