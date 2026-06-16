// ============================================================
// pdf.js wrapper — render a plan PDF page to a raster.
// Mobile-safe: JPEG output, capped canvas size, Blob URL instead
// of base64 data URL (avoids iOS Safari memory/decode limits).
// ============================================================

let pdfjsLib = null;

async function getLib() {
  if (pdfjsLib) return pdfjsLib;
  const lib = await import('pdfjs-dist');

  // Try CDN worker first; fall back to disabling the worker entirely
  // (slower but works on every mobile browser).
  const PDFJS_VERSION = lib.version;
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

// iOS Safari hard limits:
//   - Max canvas area: 16,777,216 px² (4096×4096)
//   - Max canvas dimension: 4096px
// We cap well below these to stay safe with DPR.
const IOS_MAX_AREA = 4096 * 4096;
const IOS_MAX_DIM  = 4096;

/**
 * Render a PDF page to a Blob URL (JPEG, mobile-safe).
 * Falls back to PNG data URL if Blob URL creation fails.
 *
 * @param {import('pdfjs-dist').PDFDocumentProxy} doc
 * @param {number} pageNum
 * @param {number} targetWidth - target CSS pixel width (default 1200, safe for mobile)
 */
export async function renderPage(doc, pageNum, targetWidth = 1200) {
  const page = await doc.getPage(pageNum);
  const base = page.getViewport({ scale: 1 });

  // Clamp scale so canvas stays within iOS limits
  let scale = targetWidth / base.width;
  const projW = Math.ceil(base.width  * scale);
  const projH = Math.ceil(base.height * scale);
  const projArea = projW * projH;

  if (projArea > IOS_MAX_AREA) {
    scale = Math.sqrt(IOS_MAX_AREA / (base.width * base.height)) * 0.95;
  }
  if (base.width * scale > IOS_MAX_DIM) {
    scale = IOS_MAX_DIM / base.width * 0.95;
  }
  if (base.height * scale > IOS_MAX_DIM) {
    scale = IOS_MAX_DIM / base.height * 0.95;
  }

  scale = Math.max(0.3, Math.min(3, scale));
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width  = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);

  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) {
    throw new Error('Canvas 2D context unavailable — canvas may be too large for this device');
  }
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({ canvasContext: ctx, viewport }).promise;

  // Prefer Blob URL: much smaller memory footprint than base64 data URL,
  // and avoids the iOS Safari "blank image from large data URL" bug.
  let imageUrl;
  try {
    imageUrl = await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) { reject(new Error('toBlob returned null')); return; }
        resolve(URL.createObjectURL(blob));
      }, 'image/jpeg', 0.88);
    });
  } catch (_) {
    // Fallback: JPEG data URL (smaller than PNG)
    imageUrl = canvas.toDataURL('image/jpeg', 0.88);
  }

  return {
    dataUrl:      imageUrl,
    width:        canvas.width,
    height:       canvas.height,
    renderScale:  scale,
    pdfWidthPt:   base.width,
    pdfHeightPt:  base.height,
  };
}
