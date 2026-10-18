// ============================================================
// appUpdate.js — a page loaded before a deploy asks for code files the new
// deploy no longer has (their names carry a content hash). Opening a plan
// then fails ("Importing a module script failed" on iPhone Safari). Reload
// once onto the new version instead, and say so after the reload.
// ============================================================

const STALE = /Importing a module script failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Unable to preload CSS|Loading chunk \S+ failed|Load failed for the module script/i;
const KEY = 'tt:reloaded-for-update';

/** Is this error a code file from an older deploy that's gone? */
export const isStaleBuild = (err) => STALE.test(String(err?.message || err || ''));

/**
 * Reload onto the new version — at most once a minute (a file that's really
 * missing must not reload forever), and never without storage to remember
 * that by. Returns true when the page is reloading.
 */
export function reloadForUpdate(note, store = globalThis.sessionStorage, loc = globalThis.location) {
  try {
    if (!store || !loc) return false;
    const at = +(store.getItem(KEY) || 0);
    if (Date.now() - at < 60000) return false;
    store.setItem(KEY, String(Date.now()));
    if (note) store.setItem(`${KEY}:note`, note);
  } catch { return false; }
  loc.reload();
  return true;
}

/** The note left for after the reload (once). */
export function takeUpdateNote(store = globalThis.sessionStorage) {
  try {
    const note = store?.getItem(`${KEY}:note`);
    if (note) store.removeItem(`${KEY}:note`);
    return note || null;
  } catch { return null; }
}

export const UPDATE_NOTE = 'TileTakeoff was updated to the latest version — if you were opening a plan, open it again.';
