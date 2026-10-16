// ============================================================
// history.js — undo / redo for the takeoff.
//
// Every store change that touches the project's data (rooms, materials,
// markups, the trace, the scale, rates, the name) records the state before
// it. Edits in quick succession (typing a price, nudging a value) and every
// change inside one gesture (a drag on the plan) are one step. Opening or
// starting another project clears the history. View, selection and other
// UI state are not part of it.
// ============================================================

export const TRACKED = ['rooms', 'materials', 'markups', 'trace', 'scale', 'archScale', 'taxRate', 'laborRatePerSf', 'name'];

const snap = (st) => { const o = {}; for (const k of TRACKED) o[k] = st[k]; return o; };
const differs = (a, b) => TRACKED.some((k) => a[k] !== b[k]);

/**
 * @param {{ limit?: number, coalesceMs?: number, now?: () => number }} [opts]
 */
export function createHistory({ limit = 200, coalesceMs = 600, now = () => Date.now() } = {}) {
  const past = [], future = [];
  let lastAt = -Infinity, inGroup = false, groupPushed = false;

  return {
    /**
     * A change happened (store state before → after).
     * @returns {boolean} true when it changed what undo / redo can do
     */
    note(before, after) {
      if (before.id !== after.id) {                 // another project
        const had = past.length || future.length;
        past.length = 0; future.length = 0; lastAt = -Infinity;
        return !!had;
      }
      if (!differs(before, after)) return false;
      const hadFuture = future.length > 0;
      future.length = 0;
      const t = now();
      const merge = inGroup ? groupPushed : t - lastAt < coalesceMs;
      lastAt = t;
      if (merge) return hadFuture;
      past.push(snap(before));
      if (past.length > limit) past.shift();
      if (inGroup) groupPushed = true;
      return true;
    },
    /** Everything until end() is one step (a drag, a gesture). */
    begin() { inGroup = true; groupPushed = false; },
    end() { inGroup = false; lastAt = -Infinity; },
    /** The state to go back to, or null. Steps that change nothing are skipped. */
    undo(current) {
      while (past.length) {
        const prev = past.pop();
        if (differs(prev, current)) { future.push(snap(current)); lastAt = -Infinity; return prev; }
      }
      return null;
    },
    redo(current) {
      while (future.length) {
        const next = future.pop();
        if (differs(next, current)) { past.push(snap(current)); lastAt = -Infinity; return next; }
      }
      return null;
    },
    counts() { return { undoCount: past.length, redoCount: future.length }; },
    /** Forget every step (the takeoff on screen was swapped for another page's). */
    clear() { past.length = 0; future.length = 0; lastAt = -Infinity; inGroup = false; },
  };
}
