// ============================================================
// viewMath.js — the canvas view: zoom about a point, wheel / pinch
// gestures, animation, and which part of the plan needs a sharp
// re-render. Pure; no DOM.
//
// A view is { x, y, zoom }: screen px = model px × zoom + (x, y).
// Model px are underlay (plan image) pixels.
// ============================================================

export const ZOOM_MIN = 0.02;
export const ZOOM_MAX = 32;

export const clampZoom = (z) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

/**
 * The view zoomed to `zoom`, keeping the model point under screen point
 * `sp` where it is.
 * @param {{x:number,y:number,zoom:number}} view
 * @param {{x:number,y:number}} sp
 * @param {number} zoom
 */
export function zoomAround(view, sp, zoom) {
  const z = clampZoom(zoom);
  const mx = (sp.x - view.x) / view.zoom, my = (sp.y - view.y) / view.zoom;
  return { x: sp.x - mx * z, y: sp.y - my * z, zoom: z };
}

/**
 * Zoom factor for one wheel event, proportional to how far it scrolled
 * (d3-zoom's constants, tuned across mice and trackpads): a mouse notch is
 * ~15%, a trackpad's small deltas zoom smoothly, and a trackpad pinch
 * (reported as a wheel event with ctrlKey) follows the fingers.
 * @param {{deltaY:number, deltaMode?:number, ctrlKey?:boolean}} e
 */
export function wheelZoomFactor(e) {
  const perUnit = e.deltaMode === 1 ? 0.05 : e.deltaMode ? 1 : 0.002;   // lines / pages / px
  const d = Math.max(-1, Math.min(1, (e.deltaY || 0) * perUnit * (e.ctrlKey ? 10 : 1)));
  return Math.pow(2, -d);
}

/**
 * Two-finger pinch: the view that keeps the model point under the fingers'
 * starting midpoint under their current midpoint, zoomed by how far they
 * spread.
 * @param {{x:number,y:number,zoom:number}} view0  view when the pinch began
 * @param {{x:number,y:number}} a0 @param {{x:number,y:number}} b0  fingers then
 * @param {{x:number,y:number}} a1 @param {{x:number,y:number}} b1  fingers now
 */
export function pinchView(view0, a0, b0, a1, b1) {
  const d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y) || 1;
  const d1 = Math.hypot(b1.x - a1.x, b1.y - a1.y) || 1;
  const m0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
  const m1 = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 };
  const z = clampZoom(view0.zoom * (d1 / d0));
  const mx = (m0.x - view0.x) / view0.zoom, my = (m0.y - view0.y) / view0.zoom;
  return { x: m1.x - mx * z, y: m1.y - my * z, zoom: z };
}

/**
 * In-between view for an animated zoom: zoom moves geometrically, and the
 * model point at the screen centre glides in a straight line.
 * @param {{x:number,y:number,zoom:number}} a @param {{x:number,y:number,zoom:number}} b
 * @param {number} t 0..1 @param {{w:number,h:number}} stage
 */
export function lerpView(a, b, t, stage) {
  const z = a.zoom * Math.pow(b.zoom / a.zoom, t);
  const cx = stage.w / 2, cy = stage.h / 2;
  const ca = { x: (cx - a.x) / a.zoom, y: (cy - a.y) / a.zoom };
  const cb = { x: (cx - b.x) / b.zoom, y: (cy - b.y) / b.zoom };
  const mx = ca.x + (cb.x - ca.x) * t, my = ca.y + (cb.y - ca.y) * t;
  return { x: cx - mx * z, y: cy - my * z, zoom: z };
}

export const easeOut = (t) => 1 - Math.pow(1 - t, 3);

// The sharp re-render covers the screen plus this margin, so a small pan
// stays sharp, and is capped at this many device pixels.
const DETAIL_MARGIN = 0.12;
const DETAIL_MAX_PIX = 12_000_000;

/**
 * Where the plan needs a sharp re-render from the PDF: the on-screen part
 * of the page (plus a margin), at device resolution. null when the plain
 * underlay already looks right (it is shown at ~1 underlay px per device
 * px), or the plan is off screen.
 * @param {{x:number,y:number,zoom:number}} view
 * @param {{w:number,h:number}} stage  CSS px
 * @param {number} dpr
 * @param {{w:number,h:number}} plan   underlay px
 * @returns {{x:number,y:number,w:number,h:number,k:number,vis:{x:number,y:number,w:number,h:number}} | null}
 *   the region to render (model px, with margin), k = device px per model px,
 *   and `vis`, the part actually on screen
 */
export function detailRegion(view, stage, dpr, plan) {
  if (!(plan.w > 0 && plan.h > 0 && view.zoom > 0)) return null;
  let k = view.zoom * dpr;
  if (k > 0.8 && k < 1.2) return null;    // the underlay is already ~1:1
  const vx0 = Math.max(0, -view.x / view.zoom), vy0 = Math.max(0, -view.y / view.zoom);
  const vx1 = Math.min(plan.w, (stage.w - view.x) / view.zoom), vy1 = Math.min(plan.h, (stage.h - view.y) / view.zoom);
  if (vx1 - vx0 < 4 || vy1 - vy0 < 4) return null;
  const mw = (stage.w / view.zoom) * DETAIL_MARGIN, mh = (stage.h / view.zoom) * DETAIL_MARGIN;
  const x0 = Math.max(0, vx0 - mw), y0 = Math.max(0, vy0 - mh);
  const x1 = Math.min(plan.w, vx1 + mw), y1 = Math.min(plan.h, vy1 + mh);
  const w = x1 - x0, h = y1 - y0;
  if (w * h * k * k > DETAIL_MAX_PIX) k = Math.sqrt(DETAIL_MAX_PIX / (w * h));
  // floor so the canvas never exceeds the cap; keep the origin on whole px
  const X = Math.floor(x0), Y = Math.floor(y0);
  return { x: X, y: Y, w: Math.ceil(x1) - X, h: Math.ceil(y1) - Y, k, vis: { x: vx0, y: vy0, w: vx1 - vx0, h: vy1 - vy0 } };
}

/**
 * True when `have` (a render, or one under way) still serves `want`: it
 * covers what is on screen now at about the same resolution. A pan within
 * the render's margin needs no new render.
 */
export function detailCovers(have, want) {
  if (!have || !want) return false;
  const v = want.vis || want;
  return have.x <= v.x + 0.5 && have.y <= v.y + 0.5 &&
    have.x + have.w >= v.x + v.w - 0.5 && have.y + have.h >= v.y + v.h - 0.5 &&
    Math.abs(have.k - want.k) / want.k < 0.08;
}
