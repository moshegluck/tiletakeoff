// ============================================================
// pdf.js — load and render PDF pages.
// Uses pdf.js's LEGACY build: the modern build calls brand-new JS
// built-ins (e.g. Map.prototype.getOrInsertComputed) that many browsers in
// use don't have yet, and a PDF then fails to open with "… is not a
// function". The legacy build ships those polyfills, main thread and worker.
// The worker ships as a SAME-ORIGIN bundled asset (not a CDN URL):
// Vite emits pdfjs-dist's worker with a content hash and hands us its
// URL. A CDN worker is a single point of failure — if cdnjs is blocked
// by a corporate network / CSP / ad-blocker, or is offline, pdf.js can't
// start its worker and every page renders blank. Bundling it removes that
// dependency, and the version always matches the installed pdfjs-dist.
// ============================================================

import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

let _lib = null;
let _workerSetup = false;

async function getLib() {
  if (_lib) return _lib;

  const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');

  if (!_workerSetup) {
    lib.GlobalWorkerOptions.workerSrc = workerUrl;
    _workerSetup = true;
  }

  _lib = lib;
  return lib;
}

export async function loadPdf(file) {
  const lib = await getLib();
  const buf = await file.arrayBuffer();
  const doc = await lib.getDocument({ data: buf }).promise;
  return { doc, numPages: doc.numPages };
}

// iOS Safari canvas limits
const MAX_AREA = 16777216 * 0.85; // ~14MP
const MAX_DIM  = 4096 * 0.9;      // ~3686px

/**
 * Render one PDF page → { dataUrl, width, height, renderScale }
 */
/**
 * The scale a page of this size is rendered at (px per PDF point). The
 * takeoff's feet ↔ px scale is tied to it, so the marked-up PDF export uses
 * the same rule to put the takeoff back on the page.
 * @param {number} w  page width at scale 1 (pt)
 * @param {number} h  page height at scale 1 (pt)
 * @param {number} [targetWidth]
 */
export function pageRenderScale(w, h, targetWidth = 1400) {
  let scale = targetWidth / w;
  if (w * h * scale * scale > MAX_AREA) scale = Math.sqrt(MAX_AREA / (w * h));
  if (w * scale > MAX_DIM) scale = MAX_DIM / w;
  if (h * scale > MAX_DIM) scale = MAX_DIM / h;
  return Math.max(0.3, Math.min(3, scale));
}

/** The width every plan page is rendered at (app, restore, export). */
export const PLAN_RENDER_WIDTH = 2000;

export async function renderPage(doc, pageNum, targetWidth = 1400) {
  const page   = await doc.getPage(pageNum);
  const base   = page.getViewport({ scale: 1 });
  const scale  = pageRenderScale(base.width, base.height, targetWidth);

  const viewport = page.getViewport({ scale });
  const W = Math.ceil(viewport.width);
  const H = Math.ceil(viewport.height);

  const canvas = document.createElement('canvas');
  canvas.width  = W;
  canvas.height = H;

  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error(`Canvas unavailable at ${W}x${H}`);

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  await page.render({ canvasContext: ctx, viewport }).promise;

  const dataUrl = await canvasToUrl(canvas);

  // Free the offscreen canvas backing store now that we have the URL.
  canvas.width = canvas.height = 0;

  return { dataUrl, width: W, height: H, renderScale: scale };
}

// PNG, not JPEG: plans are thin lines on white, which JPEG smears into
// grey halos (very visible zoomed in), and line art compresses well as PNG.
function canvasToUrl(canvas) {
  return new Promise((resolve) => {
    if (canvas.toBlob) {
      canvas.toBlob((blob) => {
        if (blob && blob.size > 500) resolve(URL.createObjectURL(blob));
        else resolve(canvas.toDataURL('image/png'));
      }, 'image/png');
    } else {
      resolve(canvas.toDataURL('image/png'));
    }
  });
}
