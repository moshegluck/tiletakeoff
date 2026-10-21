import { describe, it, expect } from 'vitest';
import { imageToModel, inferScale, squareUp, outlineOk, detectionToRoom, overlapsExisting, visiblePlanRegion, snapToPreset, printedCheck } from '../src/engine/detectMap.js';
import { rectPoly, polygonArea } from '../src/engine/geometry.js';

// A detection image cropped from the underlay at (1000, 400), rendered at
// 2× the underlay's resolution → each image px is 0.5 model px.
const MAP = { ox: 1000, oy: 400, rx: 0.5, ry: 0.5 };
// Scale: 1/4" = 1'-0" on a 144-dpi underlay → 36 model px per foot.
const FPP = 1 / 36;
const det = (over = {}) => ({ name: 'KITCHEN', x: 200, y: 100, w: 864, h: 720, outline: [], dimText: '', dimWFt: 0, dimHFt: 0, confidence: 0.9, ...over });

describe('detectMap: mapping', () => {
  it('maps image px back to underlay px', () => {
    expect(imageToModel({ x: 0, y: 0 }, MAP)).toEqual({ x: 1000, y: 400 });
    expect(imageToModel({ x: 200, y: 100 }, MAP)).toEqual({ x: 1100, y: 450 });
  });
  it('places a boxed room in feet over the plan', () => {
    // box 864×720 image px = 432×360 model px = 12 × 10 ft at (1100, 450) model px
    const r = detectionToRoom(det(), MAP, FPP);
    expect(r.shape).toBe('rect');
    expect(r.wFt).toBeCloseTo(12, 6);
    expect(r.hFt).toBeCloseTo(10, 6);
    expect(r.points[0].x).toBeCloseTo(1100 / 36, 1);
    expect(r.points[0].y).toBeCloseTo(450 / 36, 1);
    expect(r.areaSf).toBeCloseTo(120, 1);
  });
  it('uses a traced L-shaped outline and squares slightly-off walls', () => {
    const outline = [{ x: 200, y: 100 }, { x: 1064, y: 102 }, { x: 1063, y: 460 }, { x: 632, y: 461 }, { x: 631, y: 820 }, { x: 201, y: 819 }];
    const r = detectionToRoom(det({ outline }), MAP, FPP);
    expect(r.shape).toBe('polygon');
    expect(r.points).toHaveLength(6);
    // every edge is now exactly horizontal or vertical
    for (let i = 0; i < r.points.length; i++) {
      const a = r.points[i], b = r.points[(i + 1) % r.points.length];
      expect(a.x === b.x || a.y === b.y).toBe(true);
    }
  });
  it('falls back to the box when the outline is garbage', () => {
    const r = detectionToRoom(det({ outline: [{ x: 0, y: 0 }, { x: 5000, y: 5000 }, { x: 0, y: 5000 }, { x: 5000, y: 0 }] }), MAP, FPP);
    expect(r.shape).toBe('rect');
  });
  it('flags a printed size that disagrees with the drawing', () => {
    expect(detectionToRoom(det({ dimWFt: 12, dimHFt: 10 }), MAP, FPP).labelMismatch).toBe(false);
    expect(detectionToRoom(det({ dimWFt: 10, dimHFt: 12 }), MAP, FPP).labelMismatch).toBe(false); // written the other way
    expect(detectionToRoom(det({ dimWFt: 16, dimHFt: 10 }), MAP, FPP).labelMismatch).toBe(true);
  });
});

describe('detectMap: scale from printed sizes', () => {
  it('recovers the scale and ignores a misread label', () => {
    const dets = [
      det({ w: 864, h: 720, dimWFt: 12, dimHFt: 10 }),
      det({ w: 720, h: 576, dimWFt: 8, dimHFt: 10 }),    // label written H × W
      det({ w: 360, h: 360, dimWFt: 5, dimHFt: 5 }),
      det({ w: 360, h: 360, dimWFt: 9, dimHFt: 9 }),     // misread — outvoted
      det({ w: 500, h: 500 }),                           // no label
    ];
    const s = inferScale(dets, MAP);
    expect(s.samples).toBe(3);
    expect(s.feetPerModelPx).toBeCloseTo(FPP, 6);
  });
  it('returns null with no usable labels', () => {
    expect(inferScale([det()], MAP)).toBeNull();
    expect(inferScale([det({ dimWFt: 30, dimHFt: 10 })], MAP)).toBeNull(); // proportions disagree
  });
});

describe('detectMap: helpers', () => {
  it('squareUp clusters near-equal coordinates only', () => {
    const p = squareUp([{ x: 0, y: 0 }, { x: 10, y: 1 }, { x: 11, y: 10 }, { x: 1, y: 11 }], 2);
    expect(p[0].y).toBe(p[1].y);
    expect(p[1].x).toBe(p[2].x);
    expect(p[0].x).not.toBe(p[1].x);
  });
  it('outlineOk rejects too-small and out-of-box outlines', () => {
    const box = { x: 0, y: 0, w: 100, h: 100 };
    expect(outlineOk(rectPoly(0, 0, 100, 100), box)).toBe(true);
    expect(outlineOk(rectPoly(0, 0, 30, 30), box)).toBe(false);
    expect(outlineOk(rectPoly(50, 50, 100, 100), box)).toBe(false);
  });
  it('overlapsExisting catches rooms already drawn', () => {
    const rooms = [{ points: rectPoly(10, 10, 12, 10) }];
    expect(overlapsExisting(rectPoly(10.2, 10.1, 11.8, 9.9), rooms)).toBe(true);
    expect(overlapsExisting(rectPoly(30, 10, 12, 10), rooms)).toBe(false);
    expect(polygonArea(rooms[0].points)).toBe(120);
  });
});

describe('detectMap: visiblePlanRegion', () => {
  it('returns the on-screen part of the plan, clamped to the page', () => {
    // plan 4000×3000 px; view zoomed 2× and panned so model (500, 250) is at the screen origin
    expect(visiblePlanRegion({ x: -1000, y: -500, zoom: 2 }, { w: 800, h: 600 }, { w: 4000, h: 3000 }))
      .toEqual({ x: 500, y: 250, w: 400, h: 300 });
    // zoomed out past the page: whole page
    expect(visiblePlanRegion({ x: 100, y: 50, zoom: 0.1 }, { w: 800, h: 600 }, { w: 4000, h: 3000 }))
      .toEqual({ x: 0, y: 0, w: 4000, h: 3000 });
    // panned off the page
    expect(visiblePlanRegion({ x: 5000, y: 0, zoom: 1 }, { w: 800, h: 600 }, { w: 4000, h: 3000 })).toBeNull();
  });
});

describe('detectMap: snapToPreset', () => {
  it('snaps a label-derived scale to the standard preset it is close to', () => {
    // 144 dpi underlay at 1/4" = 1'-0": 4 ft per paper inch → 4/144 ft per px
    const r = snapToPreset((4 / 144) * 1.025, 144);
    expect(r.id).toBe('1/4');
    expect(r.feetPerModelPx).toBeCloseTo(4 / 144, 12);
    expect(snapToPreset((4 / 144) * 1.2, 144).id).toBeNull();
    expect(snapToPreset(0.03, 0)).toEqual({ feetPerModelPx: 0.03, id: null, label: null });
  });
});

describe('detectMap: printedCheck', () => {
  // Mill 2 A101 (1/8"): AI Detect cut MEETING ROOM short at 528 SF where the plan prints 720 SF,
  // and the marked-up export carried it as takeoff with no flag.
  const room = (x, y, w, h) => { const points = rectPoly(x, y, w, h); return { points, areaSf: polygonArea(points) }; };
  const PX = 1 / 9;   // ft per plan px (1/8" on a 72-dpi underlay)
  const tag = (sf, xFt, yFt) => ({ str: `${sf} SF`, x: xFt / PX, y: yFt / PX });
  it('checks each room against the area the plan prints inside it', () => {
    // a 580 SF room outlined right; MEETING ROOM outlined 24 × 22 = 528 SF over a 720 SF tag;
    // one outline over LOUNGE / GAMING and LOUNGE
    const rooms = [room(0, 0, 29, 20), room(30, 0, 24, 22), room(80, 0, 40, 20)];
    const texts = [tag(580, 12, 10), { str: 'MEETING ROOM', x: 42 / PX, y: 8 / PX }, tag(720, 42, 12), tag(1457, 90, 10), tag(1623, 110, 10)];
    expect(printedCheck(rooms, texts, PX)).toEqual([
      { check: 'match', printed: [580] },
      { check: 'off', printed: [720] },
      { check: 'merged', printed: [1457, 1623] },
    ]);
  });
  it('allows 3% or 2 SF, and leaves rooms with no printed area unchecked', () => {
    const texts = [tag(100, 5, 5), tag(40, 25, 3)];
    expect(printedCheck([room(0, 0, 10, 10.29)], texts, PX)[0].check).toBe('match');   // 102.9 SF: 2.9%
    expect(printedCheck([room(0, 0, 10, 10.4)], texts, PX)[0].check).toBe('off');      // 104 SF: 4%
    expect(printedCheck([room(20, 0, 10, 4.19)], texts, PX)[0].check).toBe('match');   // 41.9 SF: 2 SF on a closet
    expect(printedCheck([room(20, 0, 10, 12.9)], texts, PX)[0]).toEqual({ check: 'off', printed: [40] });  // MECH 129 vs 40
    expect(printedCheck([room(50, 50, 10, 10)], texts, PX)[0]).toBeNull();
  });
});
