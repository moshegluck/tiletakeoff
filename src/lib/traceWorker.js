// Runs the trace engine off the main thread so big plans never freeze the UI.
import { runTrace } from '../engine/trace/index.js';
import { applyLabels } from '../engine/trace/labels.js';

self.onmessage = (e) => {
  const { id, input, plan } = e.data || {};
  try {
    // with a plan: the AI's labels, each kept only when the plan agrees better
    const result = plan ? labelsResult(input, plan) : runTrace(input);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};

function labelsResult(input, plan) {
  const out = applyLabels(input, runTrace(input), plan);
  const notes = out.res.flags.filter((f) => f.kind === 'ai_label');
  const res = { ...out.res, flags: out.res.flags.filter((f) => f.kind !== 'ai_label') };
  const seeds = (out.input.seeds || []).length > (input.seeds || []).length ? out.input.seeds : [];
  return { res, kept: out.kept, declined: out.declined.length, notes, seeds, tried: out.tried };
}
