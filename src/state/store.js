// ============================================================
// store.js — application state (Zustand) with localStorage.
// Canonical geometry units = FEET. Rooms are polygons.
// ============================================================

import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { nanoid } from 'nanoid';
import { rectPoly } from '../engine/geometry.js';
import { WASTE_BY_PATTERN } from '../data/tileCatalog.js';
import { migrateRoomLayouts } from '../engine/patterns.js';
import { slimTrace } from './slimTrace.js';
import { slimPages } from './pages.js';

export { allRooms, allMarkups, wholeProject, otherPages, slimPages } from './pages.js';
import { materialFields } from '../lib/library.js';
import { createHistory } from './history.js';

const KEY = 'tiletakeoff.project.v1';

const ROOM_COLORS = ['#1d4e6b', '#a8430f', '#3a6b35', '#6b3a72', '#1f6b6b', '#8a5a14', '#444f6b', '#6b2f4a'];
// floor design zones (borders / inlays) get their own colors so they read
// against the room tint even when every floor material shares one swatch
const ZONE_COLORS = ['#7a3fa0', '#b25e00', '#1d6fb0', '#1d7a4d', '#b8323f', '#5b6b1d'];
const MAT_FLOOR = '#caa46a', MAT_WALL = '#6b9cc4';

function blankProject() {
  return {
    id: nanoid(),
    name: 'Untitled Takeoff',
    unitSystem: 'imperial_ft_in',
    scale: null,           // feet per screen-px at zoom 1 (calibrated)
    archScale: null,       // optional architectural scale id
    showGrid: true,        // foot grid overlay visibility
    rooms: [],
    materials: [],
    markups: [],            // measurement markups (length/area/count/rect)
    layoutsV2: true,        // rooms inherit their tile's pattern (engine/patterns.js)
    taxRate: 8.625,
    laborRatePerSf: 0,
    job: { proposal: '', customer: '', address: '' },   // printed on the quantity list / proposal
    view: { x: 80, y: 80, zoom: 1 },
    planImage: null,       // dataURL of uploaded floor plan (optional)
    planWidth: 0,          // pixel width of loaded plan image
    planHeight: 0,         // pixel height of loaded plan image
    planDpi: 0,            // px per paper-inch of the plan (72 * pdf renderScale); 0 = unknown
    trace: null,           // reconstructed wall model: { result, settings, manual, removed, region, source, committedAt }
    // rooms / markups / trace / scale above belong to the plan page on screen
    // (pdfPage); every other page's are parked here: { [page]: { rooms,
    // markups, trace, scale, archScale } }. See switchPage / allRooms.
    pageData: {},
    pdfPage: 1,
    cloudId: null,         // supabase project id when saved to cloud
    planFile: null,        // the plan file kept in the cloud: { path, name, type, kind, page, size, at }
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function defaultTrace() {
  return {
    result: null,
    settings: { ceilingHeight: 8, doorHeight: 6 + 8 / 12, floorAtDoor: 'center', maxOpening: 16, defaultWallIn: 4.5 },
    manual: [], removed: [], edits: [], region: null, source: null, committedAt: null,
  };
}

// A saved project (raw, as stored) merged over a blank one and brought up to
// date (see engine/patterns.js). The raw data decides: a blank project
// already says layoutsV2, so the merged object can't.
function fromSaved(raw) {
  // saved before pages were tracked: its takeoff sits on the page the plan was on
  const blank = blankProject();
  const p = { ...blank, ...raw, job: { ...blank.job, ...(raw?.job || {}) }, pdfPage: raw?.pdfPage || raw?.planFile?.page || 1, pageKnown: raw?.pdfPage != null };
  return raw?.layoutsV2 ? p : { ...p, rooms: migrateRoomLayouts(p.rooms), layoutsV2: true };
}

function loadProject() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) { const p = JSON.parse(raw); if (p && p.rooms) return fromSaved(p); }
  } catch (_) {}
  return blankProject();
}

let saveTimer = null;
let cloudTimer = null;
let cloudSaver = null; // injected: (state) => Promise, set by App when signed in
export function setCloudSaver(fn) { cloudSaver = fn; }

// The localStorage snapshot: durable takeoff data only. planImage (multi-MB PDF
// rasters) and runtime-only fields (pdfDoc, selection, tool, view3d…) are
// excluded so we never exceed the storage quota or try to serialize a live
// pdf.js document proxy.
function localSnapshot(s) {
  return {
    id: s.id, name: s.name, unitSystem: s.unitSystem, scale: s.scale,
    archScale: s.archScale, showGrid: s.showGrid, rooms: s.rooms, materials: s.materials, markups: s.markups, trace: slimTrace(s.trace),
    pageData: slimPages(s.pageData), pdfPage: s.pdfPage || 1,
    layoutsV2: true,
    taxRate: s.taxRate, laborRatePerSf: s.laborRatePerSf, job: s.job, view: s.view,
    planImage: null, planWidth: 0, planHeight: 0,
    createdAt: s.createdAt, updatedAt: Date.now(), cloudId: s.cloudId, planFile: s.planFile || null,
  };
}


let warnedQuota = false;
function persist(get) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(localSnapshot(get()))); warnedQuota = false; }
    catch (_) {
      // never fail silently: a project that stops saving is worse than a warning
      if (!warnedQuota && typeof window !== 'undefined') {
        warnedQuota = true;
        window.dispatchEvent(new CustomEvent('tt:toast', { detail: { msg: 'This project is too large to keep in browser storage — sign in to save it to the cloud, or export it.' } }));
      }
    }
  }, 350);
  // cloud save on a slower debounce to limit writes
  if (cloudSaver) {
    clearTimeout(cloudTimer);
    cloudTimer = setTimeout(() => { try { cloudSaver(get()); } catch (_) {} }, 1500);
  }
}

const history = createHistory();

export const useStore = create((rawSet, get) => {
  const initial = loadProject();
  // every change goes through here so undo / redo can record it
  const set = (partial, replace) => {
    const before = get();
    rawSet(partial, replace);
    if (history.note(before, get())) rawSet(history.counts());
  };
  // after undo / redo, drop selections of things that no longer exist
  const tidySelection = (st) => {
    const rooms = new Set(st.rooms.map((r) => r.id));
    const ok = (sel) => !sel.type || (sel.type === 'room' ? rooms.has(sel.id)
      : sel.type === 'material' ? st.materials.some((m) => m.id === sel.id)
        : sel.type === 'markup' ? st.markups.some((m) => m.id === sel.id) : true);
    return {
      selection: ok(st.selection) ? st.selection : { type: null, id: null },
      selRooms: st.selRooms.filter((id) => rooms.has(id)),
      selZone: st.selZone && st.rooms.some((r) => (r.zones || []).some((z) => z.id === st.selZone)) ? st.selZone : null,
    };
  };
  const travel = (step) => {
    const to = step(get());
    if (!to) return false;
    rawSet({ ...to, ...history.counts() });
    rawSet(tidySelection(get()));
    persist(get);
    return true;
  };
  return {
  ...initial,

  // ---- undo / redo (state/history.js) ----
  undoCount: 0,
  redoCount: 0,
  undo: () => travel((cur) => history.undo(cur)),
  redo: () => travel((cur) => history.redo(cur)),
  // a gesture on the plan (a drag) is one step
  historyBegin: () => history.begin(),
  historyEnd: () => history.end(),

  // runtime-only UI state (not persisted)
  tool: 'select',
  tab: 'rooms',
  selection: { type: null, id: null },
  selRooms: [],          // multi-selected room ids (Bluebeam-style marquee/shift)
  selZone: null,         // selected floor design zone id (its room is the selection)
  gridMaterialId: null,
  view3d: false,
  pdfDoc: null,        // loaded pdf.js doc (runtime only)
  pdfPages: 0,
  pdfPage: initial.pdfPage || 1,
  showTrace: true,
  traceBusy: false,
  traceFocus: null,      // { type: 'flag' | 'room', id }

  // ---- generic ----
  setName: (name) => { set({ name }); persist(get); },
  setJob: (patch) => { set({ job: { ...get().job, ...patch } }); persist(get); },
  setUnitSystem: (u) => { set({ unitSystem: u }); persist(get); },
  setScale: (s) => { set({ scale: s }); persist(get); },
  setArchScale: (id) => { set({ archScale: id }); persist(get); },
  setShowGrid: (v) => { set({ showGrid: v }); persist(get); },
  toggleGrid: () => { set({ showGrid: !get().showGrid }); persist(get); },
  setPlanDpi: (dpi) => set({ planDpi: dpi || 0 }),
  setTax: (t) => { set({ taxRate: t }); persist(get); },
  setLabor: (r) => { set({ laborRatePerSf: r }); persist(get); },
  // panning / zooming is not an edit: no save (the view rides along with the
  // next real change), so navigation stays smooth on big projects
  setView: (v) => set({ view: v }),
  setPlanImage: (d, w, h) => {
    // Revoke the PREVIOUS blob URL to free memory — but never when it's the same
    // URL we're re-setting (e.g. backfilling width/height), or we'd revoke the
    // object URL still backing the on-screen image and blank the canvas.
    const prev = get().planImage;
    if (prev && prev !== d && prev.startsWith('blob:')) { try { URL.revokeObjectURL(prev); } catch(_) {} }
    set({ planImage: d, planWidth: w || 0, planHeight: h || 0 });
    persist(get);
  },
  setPdf: (doc, pages) => set({ pdfDoc: doc, pdfPages: pages }),
  // the page on screen, when its takeoff is already the one loaded (restoring a plan)
  setPdfPage: (n) => { set({ pdfPage: n, pageKnown: true }); persist(get); },
  /**
   * Go to another page of the plan: this page's rooms, markups, trace and
   * scale are parked and that page's come back. A page not worked on yet
   * starts empty and keeps the current scale (sets usually share one; the
   * sheet's own scale note replaces it, see App). Undo doesn't cross pages.
   * @returns {boolean} true when the page had no takeoff of its own yet
   */
  switchPage: (n) => {
    const st = get(), cur = st.pdfPage || 1;
    if (n === cur) return false;
    const pd = { ...st.pageData };
    if (st.rooms.length || st.markups.length || st.trace || st.scale) {
      pd[cur] = { rooms: st.rooms, markups: st.markups, trace: st.trace, scale: st.scale, archScale: st.archScale };
    } else delete pd[cur];
    const next = pd[n];
    delete pd[n];
    rawSet({
      pageData: pd, pdfPage: n, pageKnown: true,
      rooms: next?.rooms || [], markups: next?.markups || [], trace: next?.trace || null,
      scale: next?.scale ?? st.scale, archScale: next?.scale ? next.archScale : st.archScale,
      selection: { type: null, id: null }, selRooms: [], selZone: null, traceFocus: null,
    });
    history.clear();
    rawSet(history.counts());
    persist(get);
    return !next?.scale;
  },
  // who is signed in (set by AccountBar; the phone menu shows it)
  authUser: null,
  setAuthUser: (u) => set({ authUser: u }),
  // snap drawing points to the plan's lines (a preference, kept per device)
  snapOn: (() => { try { return localStorage.getItem('tt.snap') !== '0'; } catch (_) { return true; } })(),
  toggleSnap: () => { const v = !get().snapOn; set({ snapOn: v }); try { localStorage.setItem('tt.snap', v ? '1' : '0'); } catch (_) { /* private mode */ } },
  // a restored plan keeps the saved view instead of fitting (Canvas2D)
  keepView: false,
  keepViewOnce: () => set({ keepView: true }),
  // an image plan has one page: the first
  clearPdf: () => { if ((get().pdfPage || 1) !== 1) get().switchPage(1); set({ pdfDoc: null, pdfPages: 0 }); },
  setTool: (tool) => set({ tool }),
  setTab: (tab) => set({ tab }),
  // Selecting a single room mirrors it into selRooms so the two stay in sync;
  // selecting anything else clears the multi-selection.
  select: (type, id) => set({ selection: { type, id }, selRooms: type === 'room' && id ? [id] : [], selZone: null }),
  // ---- multi-select (rooms) ----
  selectRooms: (ids) => set({
    selRooms: ids, selZone: null,
    selection: { type: ids.length ? 'room' : null, id: ids.length ? ids[ids.length - 1] : null },
    tab: ids.length ? 'rooms' : get().tab,
  }),
  toggleRoomSel: (id) => {
    const cur = get().selRooms;
    const has = cur.includes(id);
    const next = has ? cur.filter((x) => x !== id) : [...cur, id];
    set({ selRooms: next, selZone: null, selection: { type: next.length ? 'room' : null, id: next.length ? next[next.length - 1] : null } });
  },
  clearRoomSel: () => set({ selRooms: [], selection: { type: null, id: null }, selZone: null }),
  deleteRooms: (ids) => {
    const kill = new Set(ids);
    const sel = get().selection;
    set({
      rooms: get().rooms.filter((r) => !kill.has(r.id)),
      selRooms: get().selRooms.filter((x) => !kill.has(x)),
      selection: kill.has(sel.id) ? { type: null, id: null } : sel,
      selZone: kill.has(sel.id) ? null : get().selZone,
    });
    persist(get);
  },
  setGridMaterial: (id) => set({ gridMaterialId: id }),
  toggle3d: (v) => set({ view3d: v ?? !get().view3d }),

  newProject: () => { const p = blankProject(); set({ ...p, pageKnown: true, pdfDoc: null, pdfPages: 0, selection: { type: null, id: null }, selRooms: [], selZone: null, gridMaterialId: null, tool: 'select' }); persist(get); },
  loadSnapshot: (snap) => { set({ ...fromSaved(snap), selZone: null }); persist(get); },
  setCloudId: (cloudId) => { set({ cloudId }); persist(get); },
  setPlanFile: (planFile) => { set({ planFile }); persist(get); },
  // load a project row fetched from Supabase into the working store
  loadCloudDoc: (row) => {
    const doc = row.doc || {};
    set({
      ...blankProject(),
      id: row.id, cloudId: row.id, name: row.name, unitSystem: row.unit_system, planFile: doc.planFile || null,
      scale: doc.scale ?? null, archScale: doc.archScale ?? null, showGrid: doc.showGrid ?? true,
      rooms: doc.layoutsV2 ? (doc.rooms || []) : migrateRoomLayouts(doc.rooms), layoutsV2: true,
      materials: doc.materials || [], markups: doc.markups || [], trace: doc.trace || null,
      pageData: doc.pageData || {}, pdfPage: doc.pdfPage || doc.planFile?.page || 1, pageKnown: doc.pdfPage != null,
      taxRate: doc.taxRate ?? 8.625, laborRatePerSf: doc.laborRatePerSf ?? 0, job: { ...blankProject().job, ...(doc.job || {}) },
      view: doc.view || { x: 80, y: 80, zoom: 1 }, planImage: doc.planImage ?? null, planWidth: doc.planWidth || 0, planHeight: doc.planHeight || 0,
      selection: { type: null, id: null }, selRooms: [], selZone: null, gridMaterialId: null, tool: 'select',
    });
    // local mirror only; don't trigger a cloud write of what we just read.
    // Use the trimmed snapshot so we don't serialize planImage / the live
    // pdfDoc proxy into localStorage.
    try { localStorage.setItem(KEY, JSON.stringify(localSnapshot(get()))); } catch (_) {}
  },

  // ---- rooms ----
  addRoom: (points, name) => {
    const rooms = get().rooms;
    const room = {
      id: nanoid(),
      name: name || `Room ${rooms.length + 1}`,
      color: ROOM_COLORS[rooms.length % ROOM_COLORS.length],
      points,                 // [{x,y}] feet
      assigned: [],
      wallHeight: 8,
      // no pattern: the room lays its tile in the tile's own pattern
      layout: { angleDeg: 0, origin: { x: 0, y: 0 } },
    };
    const floor = get().materials.find((m) => m.type === 'floor');
    if (floor) room.assigned.push(floor.id);
    set({ rooms: [...rooms, room], selection: { type: 'room', id: room.id }, tab: 'rooms' });
    persist(get);
    return room.id;
  },
  addRect: (x, y, w, h, name) => get().addRoom(rectPoly(x, y, w, h), name),
  updateRoom: (id, patch) => {
    set({ rooms: get().rooms.map((r) => {
      if (r.id !== id) return r;
      const next = { ...r, ...patch };
      // a traced room whose outline is hand-edited no longer matches the traced wall LF
      if (patch.points && r.traceId && !('wallLf' in patch)) { next.wallLf = undefined; next.spurLf = 0; next.edited = true; }
      return next;
    }) });
    persist(get);
  },
  setRoomLayout: (id, patch) => {
    set({ rooms: get().rooms.map((r) => r.id === id ? { ...r, layout: { ...r.layout, ...patch } } : r) });
    persist(get);
  },
  toggleAssign: (roomId, matId) => {
    set({ rooms: get().rooms.map((r) => {
      if (r.id !== roomId) return r;
      const on = r.assigned.includes(matId);
      return { ...r, assigned: on ? r.assigned.filter((x) => x !== matId) : [...r.assigned, matId] };
    }) });
    persist(get);
  },
  deleteRoom: (id) => {
    const sel = get().selection;
    set({
      rooms: get().rooms.filter((r) => r.id !== id),
      selRooms: get().selRooms.filter((x) => x !== id),
      selection: sel.id === id ? { type: null, id: null } : sel,
      selZone: sel.id === id ? null : get().selZone,
    });
    persist(get);
  },

  // ---- trace (reconstructed wall model) ----
  setTrace: (patch) => { set({ trace: { ...defaultTrace(), ...(get().trace || {}), ...patch } }); persist(get); },
  clearTrace: () => { set({ trace: null, traceFocus: null }); persist(get); },
  setShowTrace: (v) => set({ showTrace: v ?? !get().showTrace }),
  setTraceBusy: (b) => set({ traceBusy: b }),
  setTraceFocus: (f) => set({ traceFocus: f }),
  setTraceSettings: (patch) => {
    const tr = { ...defaultTrace(), ...(get().trace || {}) };
    tr.settings = { ...tr.settings, ...patch };
    // ceiling height drives every traced room's wall height
    const rooms = ('ceilingHeight' in patch || 'doorHeight' in patch)
      ? get().rooms.map((r) => (r.traceId ? {
        ...r,
        ...('ceilingHeight' in patch ? { wallHeight: patch.ceilingHeight } : {}),
        ...('doorHeight' in patch ? { doorHeight: patch.doorHeight } : {}),
      } : r))
      : get().rooms;
    set({ trace: tr, rooms }); persist(get);
  },
  addTraceWall: (a, b, t) => {
    const tr = { ...defaultTrace(), ...(get().trace || {}) };
    set({ trace: { ...tr, manual: [...tr.manual, { a, b, t }], edits: [...(tr.edits || []), 'manual'] } }); persist(get);
  },
  eraseTraceWall: (a, b) => {
    const tr = { ...defaultTrace(), ...(get().trace || {}) };
    set({ trace: { ...tr, removed: [...tr.removed, { a, b }], edits: [...(tr.edits || []), 'removed'] } }); persist(get);
  },
  undoTraceEdit: () => {
    const tr = get().trace; if (!tr) return;
    const last = tr.edits?.[tr.edits.length - 1];
    if (!last) return;
    const edits = tr.edits.slice(0, -1);
    if (last === 'manual') set({ trace: { ...tr, manual: tr.manual.slice(0, -1), edits } });
    else set({ trace: { ...tr, removed: tr.removed.slice(0, -1), edits } });
    persist(get);
  },
  /** Turn the traced rooms into takeoff rooms (keeps hand-drawn rooms and prior material picks). */
  commitTrace: () => {
    const tr = get().trace; const res = tr?.result; if (!res) return 0;
    const keep = get().rooms.filter((r) => !r.traceId);
    // Match each traced room to the previously committed room it replaces: same
    // name AND nearest centre (two BEDROOMs must never collapse into one id).
    const prevRooms = get().rooms.filter((r) => r.traceId);
    const used = new Set();
    const matchPrev = (t) => {
      let best = null, bd = Infinity;
      for (const r of prevRooms) {
        if (used.has(r.id)) continue;
        const c = r.labelAt || r.points[0];
        const d = Math.hypot(c.x - t.center.x, c.y - t.center.y);
        const sameName = r.traceName === t.name;
        if ((sameName && d < 25) || d < 2) { const score = d - (sameName ? 1000 : 0); if (score < bd) { bd = score; best = r; } }
      }
      if (best) used.add(best.id);
      return best;
    };
    const floor = get().materials.find((m) => m.type === 'floor');
    const H = tr.settings?.ceilingHeight ?? 8;
    const DH = tr.settings?.doorHeight ?? 6 + 8 / 12;
    // a space that is no floor (unexcavated, a shaft) stays in the model, not the takeoff
    const rooms = res.rooms.filter((t) => t.type !== 'nofloor').map((t, i) => {
      const p = matchPrev(t);
      return {
        id: p?.id || nanoid(),
        name: p?.name || t.name,
        color: p?.color || ROOM_COLORS[(keep.length + i) % ROOM_COLORS.length],
        points: t.poly, holes: t.holes || [],
        assigned: p?.assigned || (floor ? [floor.id] : []),
        wallHeight: H,
        layout: p?.layout || { angleDeg: 0, origin: { x: 0, y: 0 } },
        finish: p?.finish,
        zones: p?.zones,
        fixtures: p?.fixtures,
        traceId: t.id, traceName: t.name, roomType: t.type,
        wallLf: t.wallLf, spurLf: t.spurLf, openings: t.openings, labelAt: t.center, doorHeight: DH,
      };
    });
    set({ rooms: [...keep, ...rooms], trace: { ...tr, committedAt: Date.now() }, tab: 'rooms', selection: { type: null, id: null }, selRooms: [] });
    persist(get);
    return rooms.length;
  },

  // ---- design (3D) — finishes tie back to estimating materials ----
  /**
   * patch: { floorPreset, floorMaterialId, paint, wallTilePreset, wallMaterialId, wallTileHeight }
   */
  applyFinish: (roomId, patch) => {
    let mats = get().materials;
    const ensure = (preset, type) => {
      let m = mats.find((x) => x.presetId === preset.id && x.type === type);
      if (!m) {
        m = {
          id: nanoid(), name: preset.name, type, color: preset.color,
          tw: preset.tw, th: preset.th, grout: preset.grout ?? 0.125, pattern: preset.pattern || 'grid',
          waste: WASTE_BY_PATTERN[preset.pattern] ?? 10, price: preset.price ?? 0, priceUnit: 'sf', sfPerBox: 15,
          faceCoverage: preset.faceCoverage ?? 1, costMode: 'waste', optimizeWholeJob: false, cutSafetyPct: 5,
          presetId: preset.id, finishStyle: preset.style,
        };
        mats = [...mats, m];
      }
      return m;
    };
    const rooms = get().rooms.map((r) => {
      if (r.id !== roomId) return r;
      const fin = { ...(r.finish || {}) };
      let assigned = r.assigned.slice();
      const typeOf = (id) => mats.find((m) => m.id === id)?.type;
      const setOnly = (type, id) => { assigned = assigned.filter((x) => typeOf(x) !== type); if (id) assigned.push(id); };
      let layout = r.layout;
      // a floor picked in 3D is laid in its own pattern
      const dropPattern = () => { if (layout?.pattern) { const { pattern: _p, ...rest } = layout; layout = rest; } };
      if (patch.floorPreset) { const m = ensure(patch.floorPreset, 'floor'); setOnly('floor', m.id); fin.floor = patch.floorPreset.id; dropPattern(); }
      if (patch.floorMaterialId) { setOnly('floor', patch.floorMaterialId); dropPattern(); }
      if (patch.paint) fin.paint = patch.paint;
      if (patch.wallTilePreset) {
        const m = ensure(patch.wallTilePreset, 'wall'); setOnly('wall', m.id); fin.wallTile = patch.wallTilePreset.id;
        if (fin.wallTileHeight === undefined || fin.wallTileHeight === 0) fin.wallTileHeight = 4;
      }
      if (patch.wallMaterialId) { setOnly('wall', patch.wallMaterialId); if (!fin.wallTileHeight) fin.wallTileHeight = 4; }
      // which wall tile covers a bath's shower / tub walls (the other: the rest)
      if ('wetWallMaterialId' in patch) fin.wetWallMaterialId = patch.wetWallMaterialId;
      // the shower floors' tile; a tiled base { heightIn, materialId } (null = none);
      // accent walls [{ id, label, lf, materialId }] (tub BW, vanity BW…)
      if ('showerFloorMaterialId' in patch) fin.showerFloorMaterialId = patch.showerFloorMaterialId || null;
      if ('base' in patch) fin.base = patch.base ? { heightIn: +patch.base.heightIn || 6, materialId: patch.base.materialId || null } : null;
      if ('accents' in patch) fin.accents = (patch.accents || []).map((a) => ({ id: a.id || nanoid(), label: a.label || 'Accent wall', lf: +a.lf || 0, materialId: a.materialId || null }));
      if ('wallTileHeight' in patch) {
        fin.wallTileHeight = patch.wallTileHeight;
        if (patch.wallTileHeight === 0) { setOnly('wall', null); fin.wallTile = null; }
      }
      return { ...r, finish: fin, assigned, layout };
    });
    set({ materials: mats, rooms });
    persist(get);
  },
  // ---- floor design zones (borders / inlays inside a room) ----
  // Zones are floor-only design details, not walls: a border band derived
  // from the room's walls, or an inlay traced on the floor. Their area is
  // carved out of the room's field (engine/zones.js).
  addZone: (roomId, zone) => {
    const room = get().rooms.find((r) => r.id === roomId);
    if (!room) return null;
    const zones = room.zones || [];
    const n = zones.filter((z) => z.kind === zone.kind).length + 1;
    // default to a floor material that isn't already this room's field tile
    const floors = get().materials.filter((m) => m.type !== 'wall');
    const pick = floors.find((m) => !room.assigned.includes(m.id)) || null;
    const z = {
      id: nanoid(),
      name: zone.kind === 'border' ? `Border ${n}` : `Inlay ${n}`,
      color: ZONE_COLORS[zones.length % ZONE_COLORS.length],
      materialId: pick ? pick.id : null,
      ...zone,
    };
    set({
      rooms: get().rooms.map((r) => r.id === roomId ? { ...r, zones: [...zones, z] } : r),
      selection: { type: 'room', id: roomId }, selRooms: [roomId], selZone: z.id, tab: 'rooms',
    });
    persist(get);
    return z.id;
  },
  updateZone: (roomId, zoneId, patch) => {
    set({ rooms: get().rooms.map((r) => r.id !== roomId ? r : {
      ...r, zones: (r.zones || []).map((z) => z.id === zoneId ? { ...z, ...patch } : z),
    }) });
    persist(get);
  },
  deleteZone: (roomId, zoneId) => {
    set({
      rooms: get().rooms.map((r) => r.id !== roomId ? r : { ...r, zones: (r.zones || []).filter((z) => z.id !== zoneId) }),
      selZone: get().selZone === zoneId ? null : get().selZone,
    });
    persist(get);
  },
  clearZoneSel: () => set({ selZone: null }),
  selectZone: (roomId, zoneId, openPanel = true) => set({
    selection: { type: 'room', id: roomId }, selRooms: [roomId], selZone: zoneId, ...(openPanel ? { tab: 'rooms' } : {}),
  }),

  // ---- materials ----
  addMaterial: (type = 'floor') => {
    const isFloor = type !== 'wall';
    const mat = {
      id: nanoid(),
      name: isFloor ? 'Floor Tile' : 'Wall Tile',
      type: isFloor ? 'floor' : 'wall',
      color: isFloor ? MAT_FLOOR : MAT_WALL,
      tw: 12, th: 12, grout: 0.125,
      pattern: 'grid',
      waste: isFloor ? 10 : 10,
      price: 4.5, priceUnit: 'sf', sfPerBox: 15, faceCoverage: 1,
      costMode: 'waste', optimizeWholeJob: false, cutSafetyPct: 5,
    };
    const mats = [...get().materials, mat];
    let rooms = get().rooms;
    if (isFloor) rooms = rooms.map((r) =>
      r.assigned.some((id) => get().materials.find((m) => m.id === id)?.type === 'floor')
        ? r : { ...r, assigned: [...r.assigned, mat.id] });
    set({ materials: mats, rooms, selection: { type: 'material', id: mat.id }, tab: 'materials', gridMaterialId: isFloor ? mat.id : get().gridMaterialId });
    persist(get);
  },
  /**
   * Lay a library tile (lib/library.js item) in rooms and floor design zones.
   * The tile becomes (or updates) one project material; in each target room it
   * replaces the room's tile of the same kind (floor or wall). Pattern: a room
   * follows its tile's pattern, so a new tile's pattern is the tile's; but
   * re-applying a tile in a different pattern must not quietly change rooms
   * that already use it, so then only the targets get the new pattern.
   * @param {import('../lib/library.js').LibItem} item
   * @param {{ rooms?: string[], zones?: {roomId:string, zoneId:string}[] }} [targets]
   * @returns {{ materialId: string, rooms: number, zones: number }}
   */
  applyTile: (item, targets = {}) => {
    const fields = materialFields(item);
    const kind = fields.type;
    const roomIds = new Set(targets.rooms || []);
    const zoneKeys = new Set((kind === 'floor' ? targets.zones || [] : []).map((z) => `${z.roomId}|${z.zoneId}`));
    let mats = get().materials;
    let mat = item.materialId ? mats.find((m) => m.id === item.materialId)
      : mats.find((m) => m.libKey === item.key && m.type === kind);
    let roomPatternOverride = null;
    if (!mat) {
      mat = { id: nanoid(), ...fields, faceCoverage: 1, costMode: 'waste', optimizeWholeJob: false, cutSafetyPct: 5, libKey: item.key };
      mats = [...mats, mat];
    } else {
      const usedElsewhere = get().rooms.some((r) => !roomIds.has(r.id) && (r.assigned.includes(mat.id) ||
        (r.zones || []).some((z) => z.materialId === mat.id && !zoneKeys.has(`${r.id}|${z.id}`))));
      const keepPattern = usedElsewhere && (mat.pattern || 'grid') !== fields.pattern;
      if (keepPattern) roomPatternOverride = fields.pattern;
      mat = { ...mat, ...fields, name: mat.name, ...(keepPattern ? { pattern: mat.pattern } : {}) };
      mats = mats.map((m) => (m.id === mat.id ? mat : m));
    }
    const typeOf = (id) => mats.find((m) => m.id === id)?.type;
    let nRooms = 0, nZones = 0;
    const rooms = get().rooms.map((r) => {
      let next = r;
      if (roomIds.has(r.id)) {
        nRooms++;
        const assigned = [...r.assigned.filter((id) => typeOf(id) !== kind), mat.id];
        let layout = { ...(r.layout || {}) };
        if (kind === 'floor') {
          if (roomPatternOverride) layout.pattern = roomPatternOverride; else delete layout.pattern;
          layout.angleDeg = +item.angleDeg || 0;
        }
        next = { ...next, assigned, layout };
      }
      if (zoneKeys.size && (r.zones || []).some((z) => zoneKeys.has(`${r.id}|${z.id}`))) {
        next = { ...next, zones: next.zones.map((z) => {
          if (!zoneKeys.has(`${r.id}|${z.id}`)) return z;
          nZones++;
          return { ...z, materialId: mat.id, layout: { ...(z.layout || {}), pattern: fields.pattern, angleDeg: +item.angleDeg || 0 } };
        }) };
      }
      return next;
    });
    set({ materials: mats, rooms, gridMaterialId: kind === 'floor' ? mat.id : get().gridMaterialId });
    persist(get);
    return { materialId: mat.id, rooms: nRooms, zones: nZones };
  },
  updateMaterial: (id, patch) => {
    // if pattern changes, suggest waste
    if (patch.pattern && WASTE_BY_PATTERN[patch.pattern] != null) {
      const cur = get().materials.find((m) => m.id === id);
      if (cur && cur.waste === (WASTE_BY_PATTERN[cur.pattern] ?? cur.waste)) {
        patch = { ...patch, waste: WASTE_BY_PATTERN[patch.pattern] };
      }
    }
    set({ materials: get().materials.map((m) => m.id === id ? { ...m, ...patch } : m) });
    persist(get);
  },
  deleteMaterial: (id) => {
    const sel = get().selection;
    set({
      materials: get().materials.filter((m) => m.id !== id),
      rooms: get().rooms.map((r) => ({
        ...r,
        assigned: r.assigned.filter((x) => x !== id),
        ...(r.zones ? { zones: r.zones.map((z) => z.materialId === id ? { ...z, materialId: null } : z) } : {}),
      })),
      gridMaterialId: get().gridMaterialId === id ? null : get().gridMaterialId,
      selection: sel.id === id ? { type: null, id: null } : sel,
    });
    persist(get);
  },

  // ---- markups (Bluebeam-style measurement log) ----
  addMarkup: (markup) => {
    const mk = { id: nanoid(), color: '#c8521f', unitCost: 0, note: '', ...markup };
    set({ markups: [...get().markups, mk], selection: { type: 'markup', id: mk.id }, tab: 'markups' });
    persist(get);
    return mk.id;
  },
  updateMarkup: (id, patch) => { set({ markups: get().markups.map((m) => m.id === id ? { ...m, ...patch } : m) }); persist(get); },
  deleteMarkup: (id) => {
    const sel = get().selection;
    set({ markups: get().markups.filter((m) => m.id !== id), selection: sel.id === id ? { type: null, id: null } : sel });
    persist(get);
  },
};
});

export { ROOM_COLORS, ZONE_COLORS, MAT_FLOOR, MAT_WALL };

// The whole store except the 2D view. Panels and dialogs use this so that
// panning and zooming (dozens of view updates a second) don't re-render them.
const withoutView = (st) => { const { view: _v, ...rest } = st; return rest; };
export const useProject = () => useStore(useShallow(withoutView));

// test hook for end-to-end checks (dev server only)
if (import.meta.env?.DEV && typeof window !== 'undefined') window.__store = useStore;
