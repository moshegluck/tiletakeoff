// ============================================================
// projects.js — every project on this device, signed in or not.
//
// Each plan is its own project: its takeoff (rooms, markups, trace, scale,
// pages, job, materials) and its plan file never mix with another's. The
// project on screen lives in the store (and its localStorage slot, for a
// fast start); every project — that one included — is kept here: a small
// index in localStorage (name, plan, rooms, last change) and the full
// takeoff in IndexedDB (lib/planStore.js's store, keyed "project:<id>"),
// beside its plan file. Without IndexedDB (a private window on an old
// browser) each takeoff falls back to its own localStorage key.
// ============================================================

import { tx } from '../lib/planStore.js';

const INDEX_KEY = 'tiletakeoff.projects.v1';
const FALLBACK = (id) => `tiletakeoff.p.${id}`;
const hasIdb = () => typeof indexedDB !== 'undefined';

/** @typedef {{ id: string, name: string, cloudId: string|null, planName: string|null, rooms: number, pages: number, updatedAt: number }} ProjectMeta */

/** @returns {ProjectMeta[]} newest first */
export function projectIndex() {
  try {
    const list = JSON.parse(localStorage.getItem(INDEX_KEY) || '[]');
    return Array.isArray(list) ? list.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)) : [];
  } catch (_) { return []; }
}

function writeIndex(list) {
  try { localStorage.setItem(INDEX_KEY, JSON.stringify(list)); } catch (_) { /* full: the takeoffs themselves are in IndexedDB */ }
}

/** The index line for a project snapshot. @returns {ProjectMeta} */
export function metaOf(snap) {
  const pages = Object.keys(snap.pageData || {}).length + 1;
  const rooms = (snap.rooms || []).length + Object.values(snap.pageData || {}).reduce((n, pg) => n + (pg?.rooms?.length || 0), 0);
  return {
    id: snap.id, name: snap.name || 'Untitled Takeoff', cloudId: snap.cloudId || null,
    planName: snap.planName || snap.planFile?.name || null, rooms, pages, updatedAt: snap.updatedAt || Date.now(),
  };
}

/** A project worth keeping: it has a plan or any takeoff. */
export function hasContent(st) {
  return !!(st && (st.planName || st.planFile || st.planImage || st.rooms?.length || st.markups?.length || st.trace
    || Object.keys(st.pageData || {}).length));
}

/** Keep (or update) a project. @param {object} snap a store snapshot (store.js localSnapshot) */
export async function saveProjectLocal(snap) {
  if (!snap?.id) return;
  const meta = metaOf(snap);
  writeIndex([meta, ...projectIndex().filter((p) => p.id !== snap.id)]);
  if (hasIdb()) {
    try { await tx('readwrite', (s) => s.put({ id: `project:${snap.id}`, snapshot: snap, savedAt: Date.now() })); return; } catch (_) { /* fall back */ }
  }
  try { localStorage.setItem(FALLBACK(snap.id), JSON.stringify(snap)); } catch (_) {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('tt:toast', { detail: { msg: 'This browser is out of room to keep another project — sign in to save projects to the cloud, or delete old ones.' } }));
  }
}

/** @returns {Promise<object|null>} the project's snapshot */
export async function loadProjectLocal(id) {
  if (!id) return null;
  if (hasIdb()) {
    try { const rec = await tx('readonly', (s) => s.get(`project:${id}`)); if (rec?.snapshot) return rec.snapshot; } catch (_) { /* fall back */ }
  }
  try { const raw = localStorage.getItem(FALLBACK(id)); return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
}

/** Forget a project on this device (its plan file goes with it: lib/planStore.js deletePlan). */
export async function removeProjectLocal(id) {
  writeIndex(projectIndex().filter((p) => p.id !== id));
  try { localStorage.removeItem(FALLBACK(id)); } catch (_) { /* nothing kept there */ }
  if (hasIdb()) { try { await tx('readwrite', (s) => s.delete(`project:${id}`)); } catch (_) { /* nothing kept */ } }
}

/** A project kept here got its cloud id while another was on screen. */
export async function setCloudIdLocal(id, cloudId) {
  const snap = await loadProjectLocal(id);
  if (snap) await saveProjectLocal({ ...snap, cloudId });
}
