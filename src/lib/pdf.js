// ============================================================
// pdf.js — load and render PDF pages.
// Uses the LOCAL bundled worker (not CDN) to avoid version
// mismatches and network failures on first load.
// ============================================================

let _lib = null;
let _workerSetup = false;

async function getLib() {
  if (_lib) return _lib;

  // Dynamic import — Vite bundles this into its own chunk (pdfjs chunk)
  const lib = await import('pdfjs-dist');

  if (!_workerSetup) {
    // Use the local bundled worker file served from /assets/
    // This avoids CDN version mismatches and network failures.
    // Vite copies .mjs worker files to dist/assets automatically.
    try {
      // Try to use the worker via URL constructor (works in modern browsers)
      const workerUrl = new URL(
        'pdfjs-dist/build/pdf.worker.min.mjs',
        import.meta.url
      ).href;
      lib.GlobalWorkerOptions.workerSrc = workerUrl;
      console.log('[TT] pdf.js worker (local):', workerUrl.slice(0, 60));
    } catch (_) {
      // Fallback: disable worker (runs on main thread, slower but reliable)
      lib.GlobalWorkerOptions.workerSrc = '';
      console.log('[TT] pdf.js worker disabled (main thread mode)');
    }
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
export async function renderPage(doc, pageNum, targetWidth = 1400) {
  const page   = await doc.getPage(pageNum);
  const base   = page.getViewport({ scale: 1 });

  let scale = targetWidth / base.width;
  if (base.width * base.height * scale * scale > MAX_AREA) {
    scale = Math.sqrt(MAX_AREA / (base.width * base.height));
  }
  if (base.width  * scale > MAX_DIM) scale = MAX_DIM / base.width;
  if (base.height * scale > MAX_DIM) scale = MAX_DIM / base.height;
  scale = Math.max(0.3, Math.min(3, scale));

  const viewport = page.getViewport({ scale });
  const W = Math.ceil(viewport.width);
  const H = Math.ceil(viewport.height);

  console.log(`[TT] renderPage p=${pageNum} scale=${scale.toFixed(2)} ${W}x${H}`);

  const canvas = document.createElement('canvas');
  canvas.width  = W;
  canvas.height = H;

  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error(`Canvas unavailable at ${W}x${H}`);

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  await page.render({ canvasContext: ctx, viewport }).promise;
  console.log('[TT] pdf.js render complete');

  // Get image URL — try blob URL first, fall back to data URL
  const dataUrl = await canvasToUrl(canvas);
  console.log('[TT] image URL type:', dataUrl.slice(0, 10), 'len:', dataUrl.length);

  return { dataUrl, width: W, height: H, renderScale: scale };
}

function canvasToUrl(canvas) {
  return new Promise((resolve) => {
    // Try blob URL first (no size limit, fastest to decode)
    if (canvas.toBlob) {
      canvas.toBlob((blob) => {
        if (blob && blob.size > 500) {
          resolve(URL.createObjectURL(blob));
        } else {
          resolve(canvas.toDataURL('image/jpeg', 0.88));
        }
      }, 'image/jpeg', 0.88);
    } else {
      resolve(canvas.toDataURL('image/jpeg', 0.88));
    }
  });
}
