// What of a trace result is saved (locally and to the cloud).
// Keep what the overlay, 3D and re-trace need; drop the solver's debug output.
export function slimTrace(tr) {
  if (!tr?.result) return tr;
  const r = tr.result;
  return {
    ...tr,
    result: {
      ...r, log: [], voids: [],
      repairs: (r.repairs || []).slice(0, 400),
      rooms: r.rooms.map(({ centerPoly: _c, edgeIds: _e, labels: _l, ...x }) => x),
    },
  };
}
