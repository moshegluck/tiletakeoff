// ============================================================
// pages.js — a plan's pages each keep their own takeoff.
//
// The store holds the page on screen as rooms / markups / trace / scale (so
// the canvas, 3D and panels only ever see that page) and parks every other
// page's under pageData[page]. The estimate and exports use the whole job.
// ============================================================

import { slimTrace } from './slimTrace.js';

/** Other pages' takeoff, with each trace trimmed for storage. */
export function slimPages(pageData) {
  const out = {};
  for (const [k, d] of Object.entries(pageData || {})) out[k] = { ...d, trace: slimTrace(d.trace) };
  return out;
}

/** Every page's rooms, each tagged with its page (the estimate, exports). */
export function allRooms(st) {
  const cur = st.pdfPage || 1;
  return [
    ...Object.entries(st.pageData || {}).filter(([k]) => +k !== cur).flatMap(([k, d]) => (d.rooms || []).map((r) => ({ ...r, page: +k }))),
    ...st.rooms.map((r) => ({ ...r, page: cur })),
  ].sort((a, b) => a.page - b.page);
}
/** Every page's markups, each tagged with its page. */
export function allMarkups(st) {
  const cur = st.pdfPage || 1;
  return [
    ...Object.entries(st.pageData || {}).filter(([k]) => +k !== cur).flatMap(([k, d]) => (d.markups || []).map((m) => ({ ...m, page: +k }))),
    ...st.markups.map((m) => ({ ...m, page: cur })),
  ].sort((a, b) => a.page - b.page);
}
/** The project as the estimate / exports see it: all pages at once. */
export const wholeProject = (st) => ({ ...st, rooms: allRooms(st), markups: allMarkups(st) });
/** Pages other than the one on screen that hold takeoff: [{ page, rooms, markups }]. */
export function otherPages(st) {
  const cur = st.pdfPage || 1;
  return Object.entries(st.pageData || {})
    .filter(([k, d]) => +k !== cur && ((d.rooms || []).length || (d.markups || []).length))
    .map(([k, d]) => ({ page: +k, rooms: (d.rooms || []).length, markups: (d.markups || []).length }))
    .sort((a, b) => a.page - b.page);
}
