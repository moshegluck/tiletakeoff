// ============================================================
// backStack.js — the phone / browser Back button closes what's open
// (a dialog, the menu, the panel, the 3D view) instead of leaving the app.
//
// Each open layer adds one browser history entry ({ tt: depth }). Back
// lands on the entry below, so every layer above that depth closes. A layer
// closed from the UI takes its entry back off (history.back()). That back is
// asynchronous, so a layer opened meanwhile (close the menu → open a dialog)
// waits for it to land before adding its own entry — otherwise the late
// "back" would close the new layer.
// ============================================================
import { useEffect, useRef } from 'react';

/** @type {{ id: symbol, close: () => void }[]} */
const stack = [];
let pendingBacks = 0;        // our own history.back() calls still in flight
/** @type {{ tt: number }[]} */
const queued = [];           // entries waiting for those to land
let safety = 0;

function flush() {
  pendingBacks = 0;
  clearTimeout(safety);
  while (queued.length) { try { history.pushState(queued.shift(), ''); } catch (_) { /* sandboxed */ } }
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', (e) => {
    if (pendingBacks > 0) {                  // the back we asked for has landed
      pendingBacks--;
      if (!pendingBacks) flush();
      return;
    }
    const depth = e.state && typeof e.state.tt === 'number' ? e.state.tt : 0;
    while (stack.length > depth) {
      const top = stack.pop();
      try { top.close(); } catch (err) { console.warn('closing on back failed:', err); }
    }
  });
}

function push(id, close) {
  stack.push({ id, close });
  const state = { tt: stack.length };
  if (pendingBacks) queued.push(state);
  else { try { history.pushState(state, ''); } catch (_) { /* sandboxed */ } }
}

function remove(id) {
  const i = stack.findIndex((l) => l.id === id);
  if (i < 0) return;                         // already closed by Back
  const wasTop = i === stack.length - 1;
  stack.splice(i, 1);
  if (!wasTop) return;
  const q = queued.findIndex((st) => st.tt === i + 1);
  if (q >= 0) { queued.splice(q, 1); return; }   // its entry was never added
  if (history.state && history.state.tt === i + 1) {
    pendingBacks++;
    clearTimeout(safety);
    safety = setTimeout(flush, 600);         // never leave pushes stuck
    history.back();
  }
}

/**
 * While `open`, Back calls onClose instead of leaving the page.
 * @param {boolean} open
 * @param {() => void} onClose
 */
export function useBackLayer(open, onClose) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    if (!open) return undefined;
    const id = Symbol('layer');
    push(id, () => ref.current && ref.current());
    return () => remove(id);
  }, [open]);
}
