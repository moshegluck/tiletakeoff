import { describe, it, expect } from 'vitest';
import { clampZoom, zoomAround, wheelZoomFactor, pinchView, lerpView, detailRegion, detailCovers, ZOOM_MAX, ZOOM_MIN } from '../src/engine/viewMath.js';

const toModel = (v, p) => ({ x: (p.x - v.x) / v.zoom, y: (p.y - v.y) / v.zoom });
const close = (a, b) => { expect(a.x).toBeCloseTo(b.x, 6); expect(a.y).toBeCloseTo(b.y, 6); };

describe('viewMath: zoom about a point', () => {
  it('keeps the model point under the cursor fixed', () => {
    const v = { x: 40, y: -20, zoom: 0.5 }, sp = { x: 300, y: 210 };
    const m = toModel(v, sp);
    const v2 = zoomAround(v, sp, 2);
    expect(v2.zoom).toBe(2);
    close(toModel(v2, sp), m);
  });
  it('clamps to the zoom range', () => {
    expect(clampZoom(1000)).toBe(ZOOM_MAX);
    expect(clampZoom(0)).toBe(ZOOM_MIN);
    expect(zoomAround({ x: 0, y: 0, zoom: 1 }, { x: 0, y: 0 }, 99).zoom).toBe(ZOOM_MAX);
  });
});

describe('viewMath: wheel and pinch', () => {
  it('zooms in proportion to the scroll, both ways symmetrically', () => {
    const notch = wheelZoomFactor({ deltaY: -100 });
    expect(notch).toBeGreaterThan(1.1);
    expect(notch).toBeLessThan(1.2);
    expect(wheelZoomFactor({ deltaY: 100 }) * notch).toBeCloseTo(1, 10);
    // a trackpad's small delta is a small step
    expect(wheelZoomFactor({ deltaY: -4 })).toBeLessThan(1.01);
    // line-mode wheels and pinch (ctrlKey) are scaled up
    expect(wheelZoomFactor({ deltaY: -3, deltaMode: 1 })).toBeGreaterThan(1.05);
    expect(wheelZoomFactor({ deltaY: -10, ctrlKey: true })).toBeGreaterThan(1.1);
  });
  it('pinch follows the fingers: spread doubles the zoom, the midpoint pans', () => {
    const v0 = { x: 10, y: 20, zoom: 1 };
    const a0 = { x: 100, y: 100 }, b0 = { x: 200, y: 100 };
    const m0 = toModel(v0, { x: 150, y: 100 });
    const v = pinchView(v0, a0, b0, { x: 50, y: 160 }, { x: 250, y: 160 });
    expect(v.zoom).toBeCloseTo(2, 10);
    close(toModel(v, { x: 150, y: 160 }), m0);
  });
});

describe('viewMath: animation', () => {
  it('starts and ends on the two views', () => {
    const a = { x: 0, y: 0, zoom: 1 }, b = { x: -500, y: -300, zoom: 4 }, stage = { w: 800, h: 600 };
    const s = lerpView(a, b, 0, stage), e = lerpView(a, b, 1, stage);
    close(s, a); expect(s.zoom).toBeCloseTo(1, 10);
    close(e, b); expect(e.zoom).toBeCloseTo(4, 10);
    expect(lerpView(a, b, 0.5, stage).zoom).toBeCloseTo(2, 10); // geometric
  });
});

describe('viewMath: sharp re-render region', () => {
  const plan = { w: 2000, h: 1400 }, stage = { w: 1000, h: 700 };
  it('is not needed when the underlay is shown ~1:1', () => {
    expect(detailRegion({ x: 0, y: 0, zoom: 1 }, stage, 1, plan)).toBeNull();
    expect(detailRegion({ x: 0, y: 0, zoom: 0.5 }, stage, 2, plan)).toBeNull();
  });
  it('covers the screen (plus a margin) at device resolution when zoomed in', () => {
    const r = detailRegion({ x: -1000, y: -700, zoom: 4 }, stage, 2, plan);
    expect(r.k).toBe(8);
    // on screen: model 250..500 × 175..350, plus 12% of the screen each side
    expect(r.x).toBe(Math.floor(250 - 250 * 0.12));
    expect(r.x + r.w).toBe(Math.ceil(500 + 250 * 0.12));
    expect(r.w * r.h * r.k * r.k).toBeLessThanOrEqual(12_000_000 * 1.05);
  });
  it('caps the pixel count and clamps to the page', () => {
    // zoomed far out: the whole page, re-rendered small so thin lines stay clean
    const r = detailRegion({ x: 0, y: 0, zoom: 0.3 }, { w: 4000, h: 3000 }, 1, plan);
    expect(r.k).toBeCloseTo(0.3, 10);
    expect(r.x).toBe(0); expect(r.y).toBe(0); expect(r.w).toBe(2000); expect(r.h).toBe(1400);
    const big = detailRegion({ x: 0, y: 0, zoom: 3 }, { w: 6000, h: 4000 }, 2, plan);
    expect(big.w * big.h * big.k * big.k).toBeLessThanOrEqual(12_000_000 * 1.01);
  });
  it('a render still serves a pan within its margin, but not a zoom change', () => {
    const want = (v) => detailRegion(v, stage, 2, plan);
    const r = want({ x: -1000, y: -700, zoom: 4 });
    expect(detailCovers(r, r)).toBe(true);
    // margin = 12% of the screen = 30 model px = 120 screen px
    expect(detailCovers(r, want({ x: -1100, y: -650, zoom: 4 }))).toBe(true);
    expect(detailCovers(r, want({ x: -1200, y: -700, zoom: 4 }))).toBe(false);
    expect(detailCovers(r, want({ x: -1000, y: -700, zoom: 5 }))).toBe(false);
  });
});
