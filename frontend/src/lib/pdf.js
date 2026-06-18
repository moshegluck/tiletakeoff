import * as pdfjsLib from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://unpkg.com/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs";

export async function loadPdf(arrayBuffer) {
  // slice() to avoid the buffer being detached/transferred by the worker
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }).promise;
  return pdf;
}

export async function renderPdfPage(pdf, pageNum, scale = 2) {
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;
  return { dataUrl: canvas.toDataURL("image/png"), width: viewport.width, height: viewport.height };
}

export async function renderPdfFirstPage(arrayBuffer, scale = 2) {
  const pdf = await loadPdf(arrayBuffer);
  const res = await renderPdfPage(pdf, 1, scale);
  return { ...res, pageCount: pdf.numPages };
}
