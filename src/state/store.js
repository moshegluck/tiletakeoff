// ============================================================
// store.js — application state (Zustand) with localStorage.
// Canonical geometry units = FEET. Rooms are polygons.
// ============================================================

import { create } from 'zustand';
import { nanoid } from 'nanoid';
import { rectPoly } from '../engine/geometry.js';
import { WASTE_BY_PATTERN } from '../data/tileCatalog.js';

const KEY = 'tiletakeoff.project.v1';

const ROOM_COLORS = ['#1d4e6b', '#a8430f', '#3a6b35', '#6b3a72', '#1f6b6b', '#8a5a14', '#444f6b', '#6b2f4a'];
const MAT_FLOOR = '#caa46a', MAT_WALL = '#6b9cc4';

function blankProject() {
  return {
    id: nanoid(),
    name: 'Untitled Takeoff',
    unitSystem: 'imperial_ft_in',
    scale: null,           // feet per screen-px at zoom 1 (calibrated)
    archScale: null,       // optional architectural scale id
    rooms: [],
    materials: [],
    markups: [],            // measurement markups (length/area/count/rect)
    taxRate: 8.625,
    laborRatePerSf: 0,
    view: { x: 80, y: 80, zoom: 1 },
    planImage: null,       // dataURL of uploaded floor plan (optional)
    cloudId: null,         // supabase project id when saved to cloud
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function loadProject() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) { const p = JSON.parse(raw); if (p && p.rooms) return { ...blankProject(), ...p }; }
  } catch (_) {}
  return blankProject();
}

let saveTimer = null;
let cloudTimer = null;
let cloudSaver = null; // injected: (state) => Promise, set by App when signed in
export function setCloudSaver(fn) { cloudSaver = fn; }

function persist(get) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const s = get();
    const build = (withImage) => JSON.stringify({
      id: s.id, name: s.name, unitSystem: s.unitSystem, scale: s.scale,
      archScale: s.archScale, rooms: s.rooms, materials: s.materials, markups: s.markups,
      taxRate: s.taxRate, laborRatePerSf: s.laborRatePerSf, view: s.view,
      planImage: withImage ? s.planImage : null, createdAt: s.createdAt, updatedAt: Date.now(),
      cloudId: s.cloudId,
    });
    try {
      localStorage.setItem(KEY, build(true));
    } catch (e) {
      // quota exceeded (large rendered PDF raster) — persist the takeoff
      // data without the image rather than losing everything.
      try { localStorage.setItem(KEY, build(false)); } catch (_) {}
    }
  }, 350);
  // cloud save on a slower debounce to limit writes
  if (cloudSaver) {
    clearTimeout(cloudTimer);
    cloudTimer = setTimeout(() => { try { cloudSaver(get()); } catch (_) {} }, 1500);
  }
}

export const useStore = create((set, get) => ({
  ...loadProject(),

  // runtime-only UI state (not persisted)
  tool: 'select',
  tab: 'rooms',
  selection: { type: null, id: null },
  gridMaterialId: null,
  view3d: false,
  pdfDoc: null,        // loaded pdf.js doc (runtime only)
  pdfPages: 0,
  pdfPage: 1,

  // ---- generic ----
  setName: (name) => { set({ name }); persist(get); },
  setUnitSystem: (u) => { set({ unitSystem: u }); persist(get); },
  setScale: (s) => { set({ scale: s }); persist(get); },
  setArchScale: (id) => { set({ archScale: id }); persist(get); },
  setTax: (t) => { set({ taxRate: t }); persist(get); },
  setLabor: (r) => { set({ laborRatePerSf: r }); persist(get); },
  setView: (v) => { set({ view: v }); persist(get); },
  setPlanImage: (d) => { set({ planImage: d }); persist(get); },
  setPdf: (doc, pages) => set({ pdfDoc: doc, pdfPages: pages, pdfPage: 1 }),
  setPdfPage: (n) => set({ pdfPage: n }),
  clearPdf: () => set({ pdfDoc: null, pdfPages: 0, pdfPage: 1 }),
  setTool: (tool) => set({ tool }),
  setTab: (tab) => set({ tab }),
  select: (type, id) => set({ selection: { type, id } }),
  setGridMaterial: (id) => set({ gridMaterialId: id }),
  toggle3d: (v) => set({ view3d: v ?? !get().view3d }),

  newProject: () => { const p = blankProject(); set({ ...p, selection: { type: null, id: null }, gridMaterialId: null, tool: 'select' }); persist(get); },
  loadSnapshot: (snap) => { set({ ...blankProject(), ...snap }); persist(get); },
  setCloudId: (cloudId) => { set({ cloudId }); persist(get); },
  // load a project row fetched from Supabase into the working store
  loadCloudDoc: (row) => {
    const doc = row.doc || {};
    set({
      ...blankProject(),
      id: row.id, cloudId: row.id, name: row.name, unitSystem: row.unit_system,
      scale: doc.scale ?? null, archScale: doc.archScale ?? null,
      rooms: doc.rooms || [], materials: doc.materials || [], markups: doc.markups || [],
      taxRate: doc.taxRate ?? 8.625, laborRatePerSf: doc.laborRatePerSf ?? 0,
      view: doc.view || { x: 80, y: 80, zoom: 1 }, planImage: doc.planImage ?? null,
      selection: { type: null, id: null }, gridMaterialId: null, tool: 'select',
    });
    // local mirror only; don't trigger a cloud write of what we just read
    try { localStorage.setItem(KEY, JSON.stringify({ ...get(), updatedAt: Date.now() })); } catch (_) {}
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
      layout: { pattern: 'grid', angleDeg: 0, origin: { x: 0, y: 0 } },
    };
    const floor = get().materials.find((m) => m.type === 'floor');
    if (floor) room.assigned.push(floor.id);
    set({ rooms: [...rooms, room], selection: { type: 'room', id: room.id }, tab: 'rooms' });
    persist(get);
    return room.id;
  },
  addRect: (x, y, w, h, name) => get().addRoom(rectPoly(x, y, w, h), name),
  updateRoom: (id, patch) => { set({ rooms: get().rooms.map((r) => r.id === id ? { ...r, ...patch } : r) }); persist(get); },
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
    set({ rooms: get().rooms.filter((r) => r.id !== id), selection: sel.id === id ? { type: null, id: null } : sel });
    persist(get);
  },

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
      rooms: get().rooms.map((r) => ({ ...r, assigned: r.assigned.filter((x) => x !== id) })),
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
}));

export { ROOM_COLORS, MAT_FLOOR, MAT_WALL };
