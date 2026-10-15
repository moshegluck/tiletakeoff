// Runs the trace engine off the main thread so big plans never freeze the UI.
import { runTrace } from '../engine/trace/index.js';

self.onmessage = (e) => {
  const { id, input } = e.data || {};
  try {
    const result = runTrace(input);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};
