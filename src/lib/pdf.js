// ============================================================
// pdf.js wrapper — render a plan PDF page to a raster the canvas
// can use as an underlay, and expose page metadata. pdf.js is heavy
// so it's dynamically imported (its own chunk, loaded on first use).
//
// Workflow:
//   loadPdf(file)        -> { doc, numPages }
//   renderPage(doc, n)   -> { dataUrl, width, height, pdfScale }
// The rendered raster's pixel size feeds the existing planImage
// underlay path. Scale calibration still happens with the ruler tool,
// so we don't have to trust the PDF's embedded scale.
// ============================================================

let pdfjsLib = null;

async function getLib() {
  if (pdfjsLib) return pdfjsLib;
  const lib = await import('pdfjs-dist');
  // worker: use the bundled worker via Vite's ?url so it ships with the app
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  lib.GlobalWorkerOptions.workerSrc = workerUrl;
  pdfjsLib = lib;
  return lib;
}

export async function loadPdf(file) {
  const lib = await getLib();
  const buf = await file.arrayBuffer();
  const doc = await lib.getDocument({ data: buf }).promise;
  return { doc, numPages: doc.numPages };
}

// Render a page at a target on-screen width (px). Returns a dataURL plus
// the raster dimensions so the canvas can place/scale it.
export async function renderPage(doc, pageNum, targetWidth = 1600) {
  const page = await doc.getPage(pageNum);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(3, Math.max(0.5, targetWidth / base.width));
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({ canvasContext: ctx, viewport }).promise;

  return {
    dataUrl: canvas.toDataURL('image/png'),
    width: canvas.width,
    height: canvas.height,
    renderScale: scale,
    // points-per-inch info if we ever want to read embedded scale
    pdfWidthPt: base.width,
    pdfHeightPt: base.height,
  };
}
