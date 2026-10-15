// ============================================================
// traceClient.js — run a trace end to end from the loaded plan.
// Evidence is gathered on the main thread (pdf.js / canvas), the
// solve runs in a Web Worker, and falls back to the main thread if
// workers are unavailable.
// ============================================================

import { gatherEvidence, evidenceToFeet, detectSheetScale } from './planEvidence.js';

let worker = null;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (worker !== null) return worker;
  try {
    worker = new Worker(new URL('./traceWorker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error)); else p.resolve(e.data.result);
    };
    worker.onerror = () => { for (const p of pending.values()) p.reject(new Error('Trace worker failed')); pending.clear(); worker = false; };
  } catch (_) { worker = false; }
  return worker;
}

export async function solve(input) {
  const w = getWorker();
  if (!w) {
    const { runTrace } = await import('../engine/trace/index.js');
    return runTrace(input);
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, input });
  });
}

/**
 * Read the plan and return { evidence, sheetScale } (px space).
 */
export async function readPlan(state) {
  const renderScale = state.planDpi ? state.planDpi / 72 : 1;
  const ev = await gatherEvidence({
    doc: state.pdfDoc, pageNum: state.pdfPage || 1, renderScale,
    planImage: state.planImage, pxPerFtHint: state.scale ? 1 / state.scale : null,
  });
  return { evidence: ev, sheetScale: detectSheetScale(ev, state.planDpi) };
}

/** Full run: evidence → feet → solve. */
export async function runPlanTrace(state, { evidence, region, options, manual, removed } = {}) {
  const ev = evidence || (await readPlan(state)).evidence;
  const input = evidenceToFeet(ev, state.scale, region);
  const result = await solve({ ...input, manual: manual || [], removed: removed || [], options });
  return { result, evidence: ev, input: { lines: input.lines.length, bodies: input.bodies.length, arcs: input.arcs.length, texts: input.texts.length } };
}
