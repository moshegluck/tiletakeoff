// ============================================================
// planModels.js — which Claude model(s) /api/detect-plan may use.
//
// Detection depends on three things older models lack: high-resolution
// vision (up to 2576 px, coordinates 1:1 with image pixels — older models
// downscale to ~1568 px and answer in the downscaled pixels, so rooms would
// land in the wrong place), adaptive thinking, and the effort setting.
// ANTHROPIC_MODEL still picks the model, but only a model that has all
// three; anything older is ignored (and logged) in favour of the default.
// ============================================================

export const DEFAULT_MODEL = 'claude-opus-5-5';

// Models that accept server-side refusal fallbacks ("default" routing).
export const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

/**
 * True for models that read plans at full resolution: Opus 4.7 and later,
 * and any Opus, Sonnet or Fable model from generation 5 on. Accepts dated
 * ids (claude-opus-4-7-20260301). Old-style ids (claude-3-5-sonnet-…) and
 * Haiku are treated as not capable.
 * @param {string} id
 */
export function readsPlans(id) {
  const m = /^claude-(opus|sonnet|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(String(id || '').trim());
  if (!m) return false;
  const major = +m[2], minor = +(m[3] || 0);
  return major >= 5 || (m[1] === 'opus' && major === 4 && minor >= 7);
}

/**
 * The models to try, in order: the configured one when it can read plans,
 * then the default. `ignored` names a configured model that was skipped.
 * @param {string} [configured]  ANTHROPIC_MODEL
 * @returns {{ chain: string[], ignored: string | null }}
 */
export function planModels(configured) {
  const id = String(configured || '').trim();
  if (!id || id === DEFAULT_MODEL) return { chain: [DEFAULT_MODEL], ignored: null };
  if (!readsPlans(id)) return { chain: [DEFAULT_MODEL], ignored: id };
  return { chain: [id, DEFAULT_MODEL], ignored: null };
}

/**
 * True when an API error means "this model can't serve this request" (the
 * model doesn't exist for this key, or lacks a feature the request uses),
 * so the next model in the chain should be tried. Image or quota problems
 * are not model problems.
 * @param {{ status?: number, message?: string }} err
 */
export function isModelProblem(err) {
  if (err?.status === 404) return true;
  if (err?.status !== 400) return false;
  return /model|thinking|effort|output_config|structured output/i.test(String(err?.message || ''));
}
