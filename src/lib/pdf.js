// ============================================================
// pdf.js wrapper — render a plan PDF page to a raster image.
// Mobile-safe: explicit canvas lifecycle, JPEG output, capped
// canvas size. Returns a data URL (most compatible) or blob URL.
// ============================================================

let pdfjsLib = null;

async function getLib() {
  if (pdfjsLib) return pdfjsLib;
  const lib = await import('pdfjs-dist');
  const PDFJS_VERSION = lib.version;
  // CDN worker (avoids bundling the 700KB worker into main chunk)
  lib.GlobalWorkerOptions.workerSrc =
    `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.mjs`;
  pdfjsLib = lib;
  return lib;
}

export async function loadPdf(file) {
  const lib = await getLib();
  const buf = await file.arrayBuffer();
  const doc = await lib.getDocument({ data: buf }).promise;
  return { doc, numPages: doc.numPages };
}

// iOS Safari hard limits per WebKit source:
//   area  ≤ 16,777,216 px²
//   width ≤ 4096 px, height ≤ 4096 px
// We use 90% of these to leave headroom.
const MAX_AREA = 16777216 * 0.9;
const MAX_DIM  = 4096 * 0.9;

/**
 * Render one PDF page to a raster image URL.
 * Returns { dataUrl, width, height, renderScale }
 */
export async function renderPage(doc, pageNum, targetWidth = 1200) {
  const page   = await doc.getPage(pageNum);
  const base   = page.getViewport({ scale: 1 });

  // Compute a safe scale
  let scale = targetWidth / base.width;
  // Clamp by area
  const area = base.width * base.height * scale * scale;
  if (area > MAX_AREA) scale = Math.sqrt(MAX_AREA / (base.width * base.height));
  // Clamp by dimension
  if (base.width  * scale > MAX_DIM) scale = MAX_DIM / base.width;
  if (base.height * scale > MAX_DIM) scale = MAX_DIM / base.height;
  scale = Math.max(0.3, Math.min(3, scale));

  const viewport = page.getViewport({ scale });
  const W = Math.ceil(viewport.width);
  const H = Math.ceil(viewport.height);

  console.log(`[TT] renderPage page=${pageNum} scale=${scale.toFixed(3)} size=${W}x${H}`);

  const canvas = document.createElement('canvas');
  canvas.width  = W;
  canvas.height = H;

  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error(`Canvas 2D unavailable — size ${W}x${H} may exceed device limit`);

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  await page.render({ canvasContext: ctx, viewport }).promise;

  // Build the image URL. We try three approaches in order:
  // 1. Blob URL (no size limit, but requires URL.createObjectURL)
  // 2. JPEG data URL (smaller than PNG, works everywhere)
  // 3. PNG data URL (last resort)
  let imageUrl = null;

  // Approach 1 — blob URL
  if (typeof URL !== 'undefined' && URL.createObjectURL) {
    try {
      imageUrl = await new Promise((resolve, reject) => {
        // Keep a reference to canvas so it won't be GC'd before toBlob completes
        const c = canvas;
        c.toBlob((blob) => {
          if (blob && blob.size > 0) {
            resolve(URL.createObjectURL(blob));
          } else {
            reject(new Error('toBlob produced empty blob'));
          }
        }, 'image/jpeg', 0.88);
      });
      console.log('[TT] using blob URL');
    } catch (e) {
      console.warn('[TT] toBlob failed, trying dataURL:', e.message);
    }
  }

  // Approach 2 — JPEG data URL
  if (!imageUrl) {
    try {
      const d = canvas.toDataURL('image/jpeg', 0.88);
      if (d && d.length > 100) { imageUrl = d; console.log('[TT] using JPEG dataURL len=', d.length); }
    } catch (e) {
      console.warn('[TT] JPEG dataURL failed:', e.message);
    }
  }

  // Approach 3 — PNG data URL
  if (!imageUrl) {
    imageUrl = canvas.toDataURL('image/png');
    console.log('[TT] using PNG dataURL len=', imageUrl.length);
  }

  if (!imageUrl || imageUrl.length < 100) {
    throw new Error(`Failed to extract image from canvas (${W}x${H})`);
  }

  return { dataUrl: imageUrl, width: W, height: H, renderScale: scale };
}
