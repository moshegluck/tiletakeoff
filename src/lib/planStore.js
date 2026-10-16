// ============================================================
// planStore.js — keep each project's plan file (the PDF or image that was
// opened) in IndexedDB, so a reload, or reopening the project later on this
// device, brings the drawing back. Takeoff data lives in localStorage / the
// cloud; plan files are far too big for either, and IndexedDB stores Blobs
// as they are. Only the most recent plans are kept.
// ============================================================

const DB_NAME = 'tiletakeoff';
const STORE = 'plans';
const KEEP = 12;

/** @typedef {{ id: string, blob: Blob, name: string, type: string, kind: 'pdf'|'image', page: number, savedAt: number }} PlanRecord */

let dbp = null;
function db() {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB unavailable'));
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' }).createIndex('savedAt', 'savedAt');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbp.catch(() => { dbp = null; });
  }
  return dbp;
}

function tx(mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('aborted'));
  }));
}

/**
 * Remember the plan file opened in a project.
 * @param {string} projectId
 * @param {Blob} blob @param {{ name?: string, type?: string, kind: 'pdf'|'image', page?: number }} meta
 */
export async function savePlan(projectId, blob, meta) {
  if (!projectId || !blob) return;
  /** @type {PlanRecord} */
  const rec = { id: projectId, blob, name: meta.name || 'plan', type: meta.type || blob.type || '', kind: meta.kind, page: meta.page || 1, savedAt: Date.now() };
  await tx('readwrite', (s) => s.put(rec));
  await prune();
}

/** @returns {Promise<PlanRecord | null>} */
export async function getPlan(projectId) {
  if (!projectId) return null;
  try { return (await tx('readonly', (s) => s.get(projectId))) || null; } catch (_) { return null; }
}

/** Remember which page of the PDF is shown. */
export async function setPlanPage(projectId, page) {
  const rec = await getPlan(projectId);
  if (!rec || rec.page === page) return;
  await tx('readwrite', (s) => s.put({ ...rec, page, savedAt: Date.now() }));
}

/** Mark the plan kept here as current as of `at` (it matches the cloud copy). */
export async function touchPlan(projectId, at) {
  const rec = await getPlan(projectId);
  if (rec) await tx('readwrite', (s) => s.put({ ...rec, savedAt: Math.max(rec.savedAt || 0, at) }));
}

/** Give a plan to another project id (a local project saved to the cloud gets a new id). */
export async function movePlan(fromId, toId) {
  if (!fromId || !toId || fromId === toId) return;
  const rec = await getPlan(fromId);
  if (!rec) return;
  await tx('readwrite', (s) => { s.put({ ...rec, id: toId, savedAt: Date.now() }); s.delete(fromId); });
}

export async function deletePlan(projectId) {
  if (!projectId) return;
  try { await tx('readwrite', (s) => s.delete(projectId)); } catch (_) { /* nothing stored */ }
}

// keep the newest KEEP plans
async function prune() {
  const keys = await tx('readonly', (s) => s.index('savedAt').getAllKeys());
  // getAllKeys on an index returns primary keys in index (savedAt) order
  const old = (keys || []).slice(0, Math.max(0, keys.length - KEEP));
  if (old.length) await tx('readwrite', (s) => { for (const k of old) s.delete(k); });
}
