// ============================================================
// planLoad.js — open a plan file (PDF or image) as the takeoff underlay.
// One loader for the toolbar's PDF button and AI Detect, so a plan is
// loaded once and every tool works from it.
// ============================================================

import { useStore } from '../state/store.js';

const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');
const isImage = (f) => /^image\/(png|jpe?g|webp|gif)$/i.test(f.type) || /\.(png|jpe?g|webp|gif)$/i.test(f.name || '');

/**
 * @param {File} file
 * @returns {Promise<{ kind: 'pdf', pages: number } | { kind: 'image' }>}
 */
export async function openPlanFile(file) {
  const st = useStore.getState();
  if (isPdf(file)) {
    const { loadPdf, renderPage } = await import('./pdf.js');
    const { doc, numPages } = await loadPdf(file);
    st.setPdf(doc, numPages);
    const out = await renderPage(doc, 1, 2000);
    st.setPlanImage(out.dataUrl, out.width, out.height);
    st.setPlanDpi(72 * out.renderScale);
    return { kind: 'pdf', pages: numPages };
  }
  if (isImage(file)) {
    const url = URL.createObjectURL(file);
    const { w, h } = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => reject(new Error('That image could not be read.'));
      img.src = url;
    });
    st.clearPdf();
    st.setPlanDpi(0);
    st.setPlanImage(url, w, h);
    return { kind: 'image' };
  }
  throw new Error('Choose a PDF or an image (PNG / JPG).');
}
