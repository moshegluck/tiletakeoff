// ============================================================
// planLoad.js — open a plan file (PDF or image) as the takeoff underlay.
// One loader for the toolbar's PDF button and AI Detect, so a plan is
// loaded once and every tool works from it. The file is kept per project
// (lib/planStore.js) and brought back on reload.
// ============================================================

import { useStore, hasContent } from '../state/store.js';
import { savePlan, getPlan, touchPlan } from './planStore.js';
import { uploadPlanFile, downloadPlanFile } from './cloud.js';

/** The key a project's plan is kept under: its cloud id once it has one. */
export const planKey = (st) => st.cloudId || st.id;

// keep the file on this device, and in the cloud once the project is there
function remember(st, file, kind) {
  const meta = { name: file.name, type: file.type, kind };
  savePlan(planKey(st), file, meta).catch((e) => console.warn('plan not kept for reload:', e?.message));
  if (st.cloudId) uploadToCloud(st.cloudId, file, meta);
}

async function uploadToCloud(cloudId, blob, meta) {
  try {
    const rec = await uploadPlanFile(cloudId, blob, meta);
    if (!rec) return;
    await touchPlan(cloudId, rec.at).catch(() => {});   // this device already has it
    if (useStore.getState().cloudId === cloudId) useStore.getState().setPlanFile(rec);
  } catch (e) {
    console.warn('plan file not uploaded:', e?.message);
    // never silent: the takeoff saves, but the plan would be missing on any other device
    const msg = blob.size > 50 * 1024 * 1024
      ? 'This plan is over 50 MB, so it is kept on this device only.'
      : `The plan didn't save to your account (${e?.message || 'upload failed'}). It's kept on this device.`;
    window.dispatchEvent(new CustomEvent('tt:toast', { detail: { msg } }));
  }
}

/** A project just got its cloud id: send the plan kept on this device up too. */
export async function uploadKeptPlan(cloudId) {
  const rec = await getPlan(cloudId);
  if (rec?.blob) await uploadToCloud(cloudId, rec.blob, { name: rec.name, type: rec.type, kind: rec.kind, page: rec.page });
}

const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');
const isImage = (f) => /^image\/(png|jpe?g|webp|gif)$/i.test(f.type) || /\.(png|jpe?g|webp|gif)$/i.test(f.name || '');

/**
 * Each plan is its own project. A plan file other than the one this project
 * was opened on starts a new project (named after the file); the one on
 * screen is kept, untouched, in Projects. The same file again (a plan that
 * didn't come back, a fresh copy) stays in this project.
 * @param {File} file
 * @returns {Promise<boolean>} true when a new project was started
 */
export async function projectForPlan(file) {
  const st = useStore.getState();
  const name = String(file.name || '').replace(/\.[^.]+$/, '').trim() || 'Untitled Takeoff';
  let current = st.planName || st.planFile?.name || null;
  if (!current) current = (await getPlan(planKey(st)).catch(() => null))?.name || null;
  if (current && current === file.name) return false;
  if (hasContent(st)) { st.newProject({ name }); useStore.getState().setPlanName(file.name); return true; }
  if (!st.name || st.name === 'Untitled Takeoff') st.setName(name);
  st.setPlanName(file.name);
  return false;
}

/**
 * @param {File} file
 * @returns {Promise<({ kind: 'pdf', pages: number } | { kind: 'image' }) & { newProject: boolean }>}
 */
export async function openPlanFile(file) {
  if (!isPdf(file) && !isImage(file)) throw new Error('Choose a PDF or an image (PNG / JPG).');
  const newProject = await projectForPlan(file);
  const st = useStore.getState();
  if (isPdf(file)) {
    const { loadPdf, renderPage, PLAN_RENDER_WIDTH } = await import('./pdf.js');
    const { doc, numPages } = await loadPdf(file);
    st.setPdf(doc, numPages);
    // a new plan opens on its first page: that page's takeoff comes up with it
    if ((useStore.getState().pdfPage || 1) !== 1) useStore.getState().switchPage(1);
    const out = await renderPage(doc, 1, PLAN_RENDER_WIDTH);
    st.setPlanImage(out.dataUrl, out.width, out.height);
    st.setPlanDpi(72 * out.renderScale);
    remember(useStore.getState(), file, 'pdf');
    return { kind: 'pdf', pages: numPages, newProject };
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
    remember(useStore.getState(), file, 'image');
    return { kind: 'image', newProject };
  }
  throw new Error('Choose a PDF or an image (PNG / JPG).');
}

/**
 * Bring back the plan kept for the open project, if none is showing. The
 * page is re-rendered exactly as when it was opened, so rooms, markups and
 * the scale line up with it again. Gives up quietly if the user opens
 * another plan or project meanwhile.
 * @returns {Promise<boolean>} true when a plan was restored
 */
export async function restorePlan() {
  const st0 = useStore.getState();
  if (st0.planImage) return false;
  const key = planKey(st0);
  let rec = await getPlan(key);
  // not on this device (or replaced on another device since): fetch the
  // project's plan file from the cloud
  const cloudNewer = st0.planFile?.at && (!rec?.savedAt || st0.planFile.at > rec.savedAt + 5000);
  if ((!rec?.blob || cloudNewer) && st0.cloudId && st0.planFile?.path) {
    const blob = await downloadPlanFile(st0.planFile.path);
    const pf = st0.planFile;
    rec = { blob, kind: pf.kind, page: pf.page || 1, name: pf.name, type: pf.type };
    await savePlan(key, blob, { name: pf.name, type: pf.type, kind: pf.kind, page: pf.page }).catch(() => {});
  }
  if (!rec?.blob) return false;
  const stillWanted = () => { const now = useStore.getState(); return planKey(now) === key && !now.planImage; };
  if (rec.kind === 'pdf') {
    const { loadPdf, renderPage, PLAN_RENDER_WIDTH } = await import('./pdf.js');
    const { doc, numPages } = await loadPdf(rec.blob);
    // the page the takeoff on screen belongs to (older saves: the page the plan was on)
    const page = Math.min(Math.max(1, (st0.pageKnown ? st0.pdfPage : rec.page) || 1), numPages);
    const out = await renderPage(doc, page, PLAN_RENDER_WIDTH);
    if (!stillWanted()) return false;
    const st = useStore.getState();
    st.setPdf(doc, numPages);
    st.setPdfPage(page);
    st.keepViewOnce();
    st.setPlanImage(out.dataUrl, out.width, out.height);
    st.setPlanDpi(72 * out.renderScale);
    return true;
  }
  const url = URL.createObjectURL(rec.blob);
  const { w, h } = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => reject(new Error('The saved plan image could not be read.'));
    img.src = url;
  });
  if (!stillWanted()) { URL.revokeObjectURL(url); return false; }
  const st = useStore.getState();
  st.clearPdf();
  st.setPlanDpi(0);
  st.keepViewOnce();
  st.setPlanImage(url, w, h);
  return true;
}
