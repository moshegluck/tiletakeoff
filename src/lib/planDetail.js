// ============================================================
// planDetail.js — keeps the plan sharp at any zoom.
//
// The underlay is one raster of the page (~2000 px). Zoomed in, that raster
// is magnified and goes soft; zoomed far out, it is shrunk and thin lines
// break up. For PDFs, the part of the page on screen is re-rendered from
// the vector drawing at device resolution once the view settles, and drawn
// over the underlay. A render that is overtaken by a newer view is
// cancelled. Image plans have no vectors, so they keep the underlay.
// ============================================================

import { detailRegion, detailCovers } from '../engine/viewMath.js';

const SETTLE_MS = 110;

/**
 * @param {() => void} onReady  called when a new sharp render is ready to draw
 */
export function createPlanDetail(onReady) {
  /** @type {{canvas: HTMLCanvasElement, x:number, y:number, w:number, h:number, k:number, key:string} | null} */
  let current = null;
  let timer = 0;
  let task = null;      // pdf.js RenderTask in flight
  let pending = null;   // region being rendered
  let scheduled = null; // region waiting for the view to settle
  let gen = 0;

  function cancel() {
    clearTimeout(timer);
    if (task) { try { task.cancel(); } catch (_) { /* already done */ } }
    task = null; pending = null; scheduled = null;
  }

  async function render(src, want, myGen) {
    const page = await src.doc.getPage(src.page);
    if (myGen !== gen) return;
    const rs = src.dpi / 72;                      // underlay px per PDF point
    const W = Math.max(1, Math.ceil(want.w * want.k)), H = Math.max(1, Math.ceil(want.h * want.k));
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    const scale = rs * want.k;
    const viewport = page.getViewport({ scale, offsetX: -want.x * want.k, offsetY: -want.y * want.k });
    task = page.render({ canvasContext: ctx, viewport });
    try { await task.promise; } catch (_) { canvas.width = canvas.height = 0; return; } // cancelled
    if (myGen !== gen) { canvas.width = canvas.height = 0; return; }
    if (current) current.canvas.width = current.canvas.height = 0;
    current = { canvas, ...want, key: src.key };
    task = null; pending = null;
    onReady();
  }

  return {
    /** The latest sharp render, if it belongs to this plan. */
    get(key) { return current && current.key === key ? current : null; },

    /**
     * Ask for the plan to be sharp for this view. Cheap to call every frame:
     * it only renders once the view has settled and the region changed.
     * @param {{doc:any, page:number, dpi:number, key:string} | null} src  null for non-PDF plans
     */
    update(src, view, stage, dpr, plan) {
      if (!src || !src.doc || !(src.dpi > 0)) { this.clear(); return; }
      if (current && current.key !== src.key) this.clear();
      const want = detailRegion(view, stage, dpr, plan);
      if (!want) { cancel(); return; }
      if (detailCovers(current, want) || detailCovers(pending, want)) return;
      // redraws that don't move the view (hover, selection) must not keep
      // pushing the render back
      if (detailCovers(scheduled, want)) return;
      cancel();
      const myGen = ++gen;
      scheduled = want;
      timer = setTimeout(() => {
        scheduled = null;
        pending = want;
        render(src, want, myGen).catch(() => { pending = null; });
      }, SETTLE_MS);
    },

    clear() {
      cancel(); gen++;
      if (current) current.canvas.width = current.canvas.height = 0;
      current = null;
    },
  };
}
