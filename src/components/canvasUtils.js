// ============================================================
// canvasUtils.js — pure helpers for the 2D canvas. No React, no
// store, no DOM state: just math and small drawing primitives that
// take everything they need as arguments. Extracted from Canvas2D so
// the component shrinks to refs + handlers + effects, and so these are
// independently testable.
// ============================================================

export const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/** rgba() string from a #rrggbb hex + alpha. */
export function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Lock a segment to the dominant axis (for shift-constrained ruler). */
export function axisLock(a, b) {
  return Math.abs(b.x - a.x) > Math.abs(b.y - a.y) ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
}

/** Even-odd point-in-polygon on an array of screen points. */
export function inPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const hit = (pts[i].y > y) !== (pts[j].y > y) &&
      x < ((pts[j].x - pts[i].x) * (y - pts[i].y)) / (pts[j].y - pts[i].y) + pts[i].x;
    if (hit) inside = !inside;
  }
  return inside;
}

/** Trace a rounded rectangle path (caller fills/strokes). */
export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Build the view transform helpers for a given view {x,y,zoom} and
 * scale (feet per model-px). Returns the four conversions the canvas
 * uses everywhere. Pure: same inputs → same functions.
 */
export function makeTransforms(view, scale) {
  const ft2px = (ft) => (scale ? ft / scale : ft);
  const px2ft = (px) => (scale ? px * scale : px);
  const toScreen = (mx, my) => ({ x: mx * view.zoom + view.x, y: my * view.zoom + view.y });
  const toModel = (sx, sy) => ({ x: (sx - view.x) / view.zoom, y: (sy - view.y) / view.zoom });
  return { ft2px, px2ft, toScreen, toModel };
}
