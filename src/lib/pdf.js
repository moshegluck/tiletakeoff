// ============================================================
// pdf.js wrapper — render a plan PDF page to a raster.
// Uses CDN worker URL to avoid mobile MIME-type issues with
// dynamic ?url imports of .mjs worker files.
// ============================================================

let pdfjsLib = null;

async function getLib() {
  if (pdfjsLib) return pdfjsLib;
  const lib = await import('pdfjs-dist');

  // Use the CDN-hosted worker — avoids mobile Safari/Firefox issues
  // with dynamic import of bundled .mjs worker files
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

/**
 * Render a PDF page to a dataURL.
 * @param {import('pdfjs-dist').PDFDocumentProxy} doc
 * @param {number} pageNum
 * @param {number} targetWidth - target pixel width for the raster
 */
export async function renderPage(doc, pageNum, targetWidth = 1600) {
  const page = await doc.getPage(pageNum);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(3, Math.max(0.5, targetWidth / base.width));
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width  = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({ canvasContext: ctx, viewport }).promise;

  return {
    dataUrl:      canvas.toDataURL('image/png'),
    width:        canvas.width,
    height:       canvas.height,
    renderScale:  scale,
    pdfWidthPt:   base.width,
    pdfHeightPt:  base.height,
  };
}
