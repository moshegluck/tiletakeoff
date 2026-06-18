import React, { useState, useRef, useEffect, useCallback, useMemo, lazy, Suspense } from "react";
import { useParams, Link } from "react-router-dom";
import useSWR from "swr";
import { toast } from "sonner";
import { api, apiErr, fileUrl, exportUrl } from "@/lib/api";
import { shoelace, pathLength, centroid, realValue, AREA_TYPES, LINEAR_TYPES } from "@/lib/geometry";
import { TilePattern, PATTERNS } from "@/lib/tilePatterns";
import {
  ArrowLeft, MousePointer2, Hand, Ruler, Square, SquareDashedBottom, Spline, Minus, Hash, Type,
  Sparkles, FileSpreadsheet, FileText, FileDown, Mail, Trash2, ZoomIn, ZoomOut, Maximize,
  Check, X, Undo2, Eye, EyeOff, Lock, LockOpen, Layers as LayersIcon, Grid3x3, Palette,
} from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";

const fetcher = (url) => api.get(url).then((r) => r.data);
const Room3D = lazy(() => import("@/components/Room3D"));
const input = "w-full bg-slate-50 border border-slate-300 rounded-sm px-2 py-1.5 text-sm font-mono focus:outline-none focus:border-orange-600 focus:ring-1 focus:ring-orange-600";

// tool -> { kind, color }
const TOOLS = {
  select: { icon: MousePointer2, label: "Select / Edit", kind: "select" },
  pan: { icon: Hand, label: "Pan", kind: "pan" },
  calibrate: { icon: Ruler, label: "Set Scale", kind: "line", color: "#0F172A" },
  area: { icon: Square, label: "Area (drag box)", kind: "rect", color: "#EA580C" },
  room: { icon: Spline, label: "Room (polygon)", kind: "poly", color: "#EA580C" },
  wall: { icon: LayersIcon, label: "Wall surface", kind: "poly", color: "#7C3AED" },
  cutout: { icon: SquareDashedBottom, label: "Cutout / Deduct (box)", kind: "rect", color: "#DC2626", deduct: true },
  linear: { icon: Minus, label: "Linear", kind: "line", color: "#2563EB" },
  perimeter: { icon: Spline, label: "Perimeter", kind: "poly", color: "#0EA5E9", openPath: true },
  count: { icon: Hash, label: "Count", kind: "count", color: "#16A34A" },
  text: { icon: Type, label: "Text note", kind: "text", color: "#0F172A" },
};
const TOOL_ORDER = ["select", "pan", "calibrate", "area", "room", "wall", "cutout", "linear", "perimeter", "count", "text"];

export default function TakeoffStudio() {
  const { id } = useParams();
  const { data, mutate } = useSWR(`/takeoffs/${id}`, fetcher);
  const { data: tiles } = useSWR("/tiles", fetcher);

  const [tool, setTool] = useState("select");
  const [items, setItems] = useState([]);
  const [summary, setSummary] = useState(null);
  const [selId, _setSelId] = useState(null);
  const [selIds, setSelIds] = useState([]);
  const setSelId = (id) => { _setSelId(id); setSelIds(id ? [id] : []); };
  const [draft, setDraft] = useState([]);
  const [rectDrag, setRectDrag] = useState(null); // {p0,p1}
  const [view, setView] = useState({ z: 1, tx: 0, ty: 0 });
  const [canvas, setCanvas] = useState({ w: 1200, h: 800 });
  const [hasImg, setHasImg] = useState(false);
  const [bgUrl, setBgUrl] = useState(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [showFill, setShowFill] = useState(true);
  const [tab, setTab] = useState("layers");
  const [aiLoading, setAiLoading] = useState(false);
  const [calibOpen, setCalibOpen] = useState(false);
  const [calibLine, setCalibLine] = useState(null);
  const [calibForm, setCalibForm] = useState({ feet: "", inches: "", unit: "ft" });
  const [emailOpen, setEmailOpen] = useState(false);
  const [emailTo, setEmailTo] = useState("");
  const [saving, setSaving] = useState(false);
  const [show3dTiles, setShow3dTiles] = useState(true);
  const [mode3d, setMode3d] = useState("flat");
  const [wallHeight, setWallHeight] = useState(8);

  const svgRef = useRef();
  const containerRef = useRef();
  const initRef = useRef(null);
  const panRef = useRef(null);
  const editRef = useRef(null);
  const moveRef = useRef(null);
  const spaceRef = useRef(false);
  const saveTimer = useRef(null);

  const takeoff = data?.takeoff;
  const drawing = data?.drawing;
  const scale = drawing?.calibration?.scale || null;
  const unit = drawing?.calibration?.unit || "ft";
  const tilesMap = useMemo(() => Object.fromEntries((tiles || []).map((t) => [t.id, t]), [tiles]), [tiles]);
  const defaultTileId = takeoff?.default_tile_id || null;
  const defaultTile = tilesMap[defaultTileId];

  // init local items from server once per takeoff
  useEffect(() => {
    if (takeoff && initRef.current !== takeoff.id) {
      initRef.current = takeoff.id;
      setItems(takeoff.measurements || []);
      setSummary(data.summary);
    }
  }, [takeoff, data]);

  // load plan (image or pdf)
  useEffect(() => {
    let cancelled = false;
    setHasImg(false); setBgUrl(null);
    if (!drawing) { setCanvas({ w: 1200, h: 800 }); return; }
    const ct = drawing.content_type || "";
    if (ct.startsWith("image")) {
      const im = new Image();
      im.onload = () => { if (!cancelled) { setCanvas({ w: im.naturalWidth, h: im.naturalHeight }); setBgUrl(fileUrl(drawing.id)); setHasImg(true); } };
      im.src = fileUrl(drawing.id);
    } else if (ct.includes("pdf")) {
      setPlanLoading(true);
      (async () => {
        try {
          const { data: buf } = await api.get(`/drawings/${drawing.id}/file`, { responseType: "arraybuffer" });
          const { renderPdfFirstPage } = await import("@/lib/pdf");
          const res = await renderPdfFirstPage(buf, 2);
          if (cancelled) return;
          setCanvas({ w: res.width, h: res.height }); setBgUrl(res.dataUrl); setHasImg(true);
        } catch { if (!cancelled) { toast.error("Could not render PDF"); setCanvas({ w: 1200, h: 800 }); } }
        finally { if (!cancelled) setPlanLoading(false); }
      })();
    } else setCanvas({ w: 1200, h: 800 });
    return () => { cancelled = true; };
  }, [drawing]);

  const fitToScreen = useCallback(() => {
    const el = containerRef.current; if (!el || !canvas.w) return;
    const z = Math.min((el.clientWidth - 40) / canvas.w, (el.clientHeight - 60) / canvas.h);
    const zoom = Math.max(Math.min(z, 1.5), 0.05);
    setView({ z: zoom, tx: (el.clientWidth - canvas.w * zoom) / 2, ty: (el.clientHeight - canvas.h * zoom) / 2 });
  }, [canvas]);
  useEffect(() => { const t = setTimeout(fitToScreen, 80); return () => clearTimeout(t); }, [canvas.w, canvas.h, fitToScreen]);

  // persist measurements (debounced, optimistic — no reload/jump)
  const persist = useCallback((nextItems, extra = {}) => {
    setSaving(true);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        const { data: res } = await api.put(`/takeoffs/${id}`, { measurements: nextItems, ...extra });
        setSummary(res.summary);
      } catch (e) { toast.error(apiErr(e)); }
      finally { setSaving(false); }
    }, 450);
  }, [id]);

  const commit = (next, extra) => { setItems(next); persist(next, extra); };
  const updateItem = (mid, patch) => commit(items.map((m) => m.id === mid ? { ...m, ...patch } : m));
  const removeItem = (mid) => { commit(items.filter((m) => m.id !== mid)); if (selId === mid) setSelId(null); };

  const setDefaultTile = async (tileId) => {
    try { const { data: res } = await api.put(`/takeoffs/${id}`, { default_tile_id: tileId || null }); setSummary(res.summary); mutate(); }
    catch (e) { toast.error(apiErr(e)); }
  };
  const setReuse = async (val) => {
    try { const { data: res } = await api.put(`/takeoffs/${id}`, { cut_reuse: val }); setSummary(res.summary); mutate(); }
    catch (e) { toast.error(apiErr(e)); }
  };

  // ---- coordinate + snapping ----
  const toWorld = (e) => {
    const r = svgRef.current.getBoundingClientRect();
    return [(e.clientX - r.left - view.tx) / view.z, (e.clientY - r.top - view.ty) / view.z];
  };
  const allVertices = () => {
    const vs = [];
    items.forEach((m) => { if (m.visible !== false) (m.points || []).forEach((p) => vs.push(p)); });
    return vs;
  };
  const snap = (p, useDraft) => {
    const thr = 12 / view.z;
    let best = null, bd = thr;
    for (const v of allVertices()) { const d = Math.hypot(v[0] - p[0], v[1] - p[1]); if (d < bd) { bd = d; best = v; } }
    if (best) return [best[0], best[1]];
    if (useDraft && draft.length && spaceRef.current === false) {
      // ortho lock when Shift
      const last = draft[draft.length - 1];
      if (window.__shift) { return Math.abs(p[0] - last[0]) > Math.abs(p[1] - last[1]) ? [p[0], last[1]] : [last[0], p[1]]; }
    }
    return p;
  };

  // ---- pointer handlers ----
  const onPointerDown = (e) => {
    if (e.button === 1 || tool === "pan" || spaceRef.current) {
      panRef.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty }; return;
    }
    if (e.button !== 0) return;
    const meta = TOOLS[tool];
    const p = snap(toWorld(e), false);
    if (meta.kind === "rect") { setRectDrag({ p0: p, p1: p }); }
    else if (meta.kind === "select") {
      const hit = hitTest(toWorld(e));
      if (!hit) { if (!e.shiftKey) setSelIds([]); return; }
      let next;
      if (e.shiftKey) next = selIds.includes(hit.id) ? selIds.filter((x) => x !== hit.id) : [...selIds, hit.id];
      else next = selIds.includes(hit.id) ? selIds : [hit.id];
      setSelIds(next); _setSelId(next[0] || null); setTab("style");
      if (!hit.locked) moveRef.current = { start: toWorld(e), ids: next, orig: Object.fromEntries(items.filter((m) => next.includes(m.id)).map((m) => [m.id, m.points])), moved: false };
    }
  };
  const onPointerMove = (e) => {
    if (panRef.current) {
      const dx = e.clientX - panRef.current.x, dy = e.clientY - panRef.current.y;
      setView((v) => ({ ...v, tx: panRef.current.tx + dx, ty: panRef.current.ty + dy })); return;
    }
    if (editRef.current) {
      const { mid, idx } = editRef.current; const p = snap(toWorld(e), false);
      setItems((prev) => prev.map((x) => x.id === mid ? { ...x, points: x.points.map((pt, k) => k === idx ? p : pt) } : x)); return;
    }
    if (moveRef.current) {
      const cur = toWorld(e); const dx = cur[0] - moveRef.current.start[0], dy = cur[1] - moveRef.current.start[1];
      if (Math.abs(dx) + Math.abs(dy) > 0.5 / view.z) moveRef.current.moved = true;
      const { ids, orig } = moveRef.current;
      setItems((prev) => prev.map((m) => ids.includes(m.id) ? { ...m, points: orig[m.id].map(([x, y]) => [x + dx, y + dy]) } : m)); return;
    }
    if (rectDrag) { setRectDrag({ ...rectDrag, p1: snap(toWorld(e), false) }); }
  };
  const onPointerUp = (e) => {
    if (panRef.current) { panRef.current = null; return; }
    if (editRef.current) { editRef.current = null; setItems((prev) => { persist(prev); return prev; }); return; }
    if (moveRef.current) { const moved = moveRef.current.moved; moveRef.current = null; if (moved) setItems((prev) => { persist(prev); return prev; }); return; }
    const meta = TOOLS[tool];
    if (meta.kind === "rect" && rectDrag) {
      const { p0, p1 } = rectDrag; setRectDrag(null);
      if (Math.abs(p1[0] - p0[0]) * view.z < 4 || Math.abs(p1[1] - p0[1]) * view.z < 4) return;
      const pts = [[p0[0], p0[1]], [p1[0], p0[1]], [p1[0], p1[1]], [p0[0], p1[1]]];
      addShape(meta.deduct ? "area" : "area", pts, { is_deduction: !!meta.deduct, color: meta.color });
      return;
    }
    if (meta.kind === "poly") { setDraft((d) => [...d, snap(toWorld(e), true)]); }
    else if (meta.kind === "line") {
      const np = [...draft, snap(toWorld(e), true)];
      if (np.length === 2) {
        if (tool === "calibrate") { setCalibLine(np); setDraft([]); setCalibOpen(true); }
        else { addShape("linear", np, { color: meta.color }); setDraft([]); }
      } else setDraft(np);
    }
    else if (meta.kind === "count") { addShape("count", [toWorld(e)], { color: meta.color, count: 1 }); }
    else if (meta.kind === "text") {
      const txt = window.prompt("Note text:"); if (txt) addShape("text", [toWorld(e)], { color: meta.color, text: txt });
    }
  };

  const hitTest = (p) => {
    for (let i = items.length - 1; i >= 0; i--) {
      const m = items[i]; if (m.visible === false) continue;
      if (AREA_TYPES.includes(m.type) && m.points.length >= 3 && pointInPoly(p, m.points)) return m;
      if (m.type === "count" || m.type === "text") { const d = Math.hypot(m.points[0][0] - p[0], m.points[0][1] - p[1]); if (d < 14 / view.z) return m; }
    }
    return null;
  };

  // control-point editing
  const onVtxDown = (e, mid, idx) => {
    e.stopPropagation();
    const m = items.find((x) => x.id === mid);
    if (e.altKey) {
      const minP = AREA_TYPES.includes(m.type) ? 4 : 3;
      if (m.points.length >= minP) commit(items.map((x) => x.id === mid ? { ...x, points: x.points.filter((_, k) => k !== idx) } : x));
      else toast.error("Can't delete — minimum points reached");
      return;
    }
    editRef.current = { mid, idx };
  };
  const onMidDown = (e, mid, idx, mp) => {
    e.stopPropagation();
    const m = items.find((x) => x.id === mid);
    const np = [...m.points]; np.splice(idx + 1, 0, mp);
    setItems(items.map((x) => x.id === mid ? { ...x, points: np } : x));
    editRef.current = { mid, idx: idx + 1 };
  };

  const addShape = (type, points, extra = {}) => {
    const labelBase = { area: extra.is_deduction ? "Cutout" : (tool === "wall" ? "Wall" : tool === "room" ? "Room" : "Area"), linear: "Line", perimeter: "Perimeter", count: "Count", text: "Note" }[tool] || type;
    const realType = tool === "wall" ? "wall" : tool === "perimeter" ? "perimeter" : tool === "linear" ? "linear" : tool === "count" ? "count" : tool === "text" ? "text" : "area";
    const m = {
      id: `m_${Date.now()}_${Math.floor(Math.random() * 999)}`, type: realType, points,
      label: `${labelBase} ${items.filter((x) => x.type === realType).length + 1}`,
      color: extra.color || TOOLS[tool].color, fillOpacity: 0.22, lineWidth: 2, visible: true, locked: false,
      is_deduction: !!extra.is_deduction, count: extra.count, text: extra.text, tile_id: null, pattern: null,
    };
    commit([...items, m]);
    setSelId(m.id);
    if (realType === "area" && !extra.is_deduction) setTab("tile"); else setTab("style");
    toast.success(`${labelBase} added`);
  };

  const finishPoly = () => {
    const meta = TOOLS[tool];
    if (meta.kind !== "poly" || draft.length < (meta.openPath ? 2 : 3)) { toast.error("Add more points first"); return; }
    const type = tool === "wall" ? "wall" : tool === "perimeter" ? "perimeter" : "area";
    addShape(type, draft, { color: meta.color });
    setDraft([]);
  };
  const cancelDraft = () => setDraft([]);
  const undoDraft = () => setDraft((d) => d.slice(0, -1));

  // keyboard
  useEffect(() => {
    const kd = (e) => {
      if (e.key === "Shift") window.__shift = true;
      if (e.code === "Space" && !["INPUT", "TEXTAREA"].includes(e.target.tagName)) { spaceRef.current = true; e.preventDefault(); }
      if (["INPUT", "TEXTAREA"].includes(e.target.tagName)) return;
      if (e.key === "Enter" && draft.length) { e.preventDefault(); finishPoly(); }
      else if (e.key === "Escape") { setDraft([]); setSelId(null); }
      else if (e.key === "Backspace" && draft.length) { e.preventDefault(); undoDraft(); }
      else if ((e.key === "Delete") && selIds.length) { commit(items.filter((m) => !selIds.includes(m.id))); setSelIds([]); _setSelId(null); }
      else if (e.key === "v") setTool("select");
    };
    const ku = (e) => { if (e.key === "Shift") window.__shift = false; if (e.code === "Space") spaceRef.current = false; };
    window.addEventListener("keydown", kd); window.addEventListener("keyup", ku);
    return () => { window.removeEventListener("keydown", kd); window.removeEventListener("keyup", ku); };
  });

  // wheel zoom to cursor
  useEffect(() => {
    const el = containerRef.current; if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      setView((v) => {
        const factor = Math.exp(-e.deltaY * 0.0012);
        const nz = Math.max(0.05, Math.min(v.z * factor, 6));
        const wx = (sx - v.tx) / v.z, wy = (sy - v.ty) / v.z;
        return { z: nz, tx: sx - wx * nz, ty: sy - wy * nz };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const confirmCalibration = async () => {
    const feet = parseFloat(calibForm.feet) || 0, inches = parseFloat(calibForm.inches) || 0;
    let realLen, u;
    if (calibForm.unit === "ft") { realLen = feet + inches / 12; u = "ft"; } else { realLen = feet; u = calibForm.unit; }
    if (!realLen || !calibLine) { toast.error("Enter the real length"); return; }
    try {
      await api.post(`/drawings/${drawing.id}/calibrate`, { pixel_length: pathLength(calibLine), real_length: realLen, unit: u });
      toast.success(`Scale set · ${realLen.toFixed(2)} ${u}`);
      setCalibOpen(false); setCalibLine(null); setTool("select"); setCalibForm({ feet: "", inches: "", unit: "ft" });
      mutate();
    } catch (e) { toast.error(apiErr(e)); }
  };

  const addAIRoom = (r) => {
    if (!r.polygon || r.polygon.length < 3) { toast.error("No outline provided for this region"); return; }
    const pts = r.polygon.map(([x, y]) => [Math.max(0, Math.min(1, x)) * canvas.w, Math.max(0, Math.min(1, y)) * canvas.h]);
    const m = { id: `m_${Date.now()}_${Math.floor(Math.random() * 999)}`, type: "area", points: pts,
      label: r.label || "AI Room", color: "#EA580C", fillOpacity: 0.22, lineWidth: 2, visible: true, locked: false, is_deduction: false };
    commit([...items, m]); setSelId(m.id); setTab("style");
    toast.success(`Added “${r.label}” — drag the handles to adjust`);
  };
  const addAllAIRooms = () => {
    const regs = (takeoff.ai_suggestions?.regions || []).filter((r) => r.polygon && r.polygon.length >= 3);
    if (!regs.length) { toast.error("No room outlines to add"); return; }
    const news = regs.map((r, i) => ({ id: `m_${Date.now()}_${i}`, type: "area",
      points: r.polygon.map(([x, y]) => [Math.max(0, Math.min(1, x)) * canvas.w, Math.max(0, Math.min(1, y)) * canvas.h]),
      label: r.label || `AI Room ${i + 1}`, color: "#EA580C", fillOpacity: 0.22, lineWidth: 2, visible: true, locked: false, is_deduction: false }));
    commit([...items, ...news]); setTab("layers");
    toast.success(`Added ${news.length} AI rooms — review & edit on the plan`);
  };

  const runAI = async () => {
    setAiLoading(true);
    try { await api.post(`/takeoffs/${id}/ai-analyze`); toast.success("AI analysis complete"); mutate(); setTab("ai"); }
    catch (e) { toast.error(apiErr(e)); } finally { setAiLoading(false); }
  };
  const sendEmail = async () => {
    if (!emailTo) return toast.error("Enter recipient");
    try { await api.post(`/takeoffs/${id}/email`, { recipient_email: emailTo }); toast.success("Report emailed"); setEmailOpen(false); }
    catch (e) { toast.error(apiErr(e)); }
  };

  if (!data) return <div className="h-screen flex items-center justify-center font-mono text-sm text-slate-400">Loading studio…</div>;

  const sel = items.find((m) => m.id === selId);
  const sw = (m) => (m.lineWidth || 2) / view.z;
  const areaTileFor = (m) => tilesMap[m.tile_id] || defaultTile;
  const cursorClass = tool === "pan" ? "cursor-grab" : tool === "select" ? "cursor-default" : "cursor-crosshair";

  return (
    <div className="h-screen flex flex-col bg-slate-100 overflow-hidden select-none">
      {/* Top bar */}
      <header className="h-12 bg-slate-950 text-white flex items-center justify-between px-4 shrink-0 border-b border-slate-800 z-30">
        <div className="flex items-center gap-3 min-w-0">
          <Link to={`/projects/${takeoff.project_id}`} className="text-slate-400 hover:text-white"><ArrowLeft className="w-4 h-4" /></Link>
          <div className="min-w-0"><div className="text-sm font-bold truncate">{takeoff.name}</div>
            <div className="text-[10px] font-mono uppercase tracking-widest text-orange-500">{takeoff.type} takeoff {saving && <span className="text-slate-500">· saving…</span>}</div></div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowFill((s) => !s)} className={`text-xs font-bold px-2.5 py-1.5 rounded-sm inline-flex items-center gap-1 ${showFill ? "bg-orange-600" : "bg-slate-800 hover:bg-slate-700"}`}><Grid3x3 className="w-3.5 h-3.5" />Tile Fill</button>
          <span className={`text-[10px] font-mono uppercase tracking-wider px-2 py-1 rounded-sm ${scale ? "bg-green-900/60 text-green-400" : "bg-amber-900/60 text-amber-400"}`}>{scale ? `Scale · ${unit}` : "Not calibrated"}</span>
          <a href={exportUrl(id, "pdf")} target="_blank" rel="noreferrer" className="text-xs font-bold bg-slate-800 hover:bg-slate-700 px-2.5 py-1.5 rounded-sm inline-flex items-center gap-1"><FileText className="w-3.5 h-3.5" />PDF</a>
          <a href={exportUrl(id, "xlsx")} target="_blank" rel="noreferrer" className="text-xs font-bold bg-slate-800 hover:bg-slate-700 px-2.5 py-1.5 rounded-sm inline-flex items-center gap-1"><FileSpreadsheet className="w-3.5 h-3.5" />Excel</a>
          <a href={exportUrl(id, "csv")} target="_blank" rel="noreferrer" className="text-xs font-bold bg-slate-800 hover:bg-slate-700 px-2.5 py-1.5 rounded-sm inline-flex items-center gap-1"><FileDown className="w-3.5 h-3.5" />CSV</a>
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        {/* Left tool rail */}
        <div className="w-14 bg-slate-950 flex flex-col items-center py-3 gap-1 border-r border-slate-800 z-20">
          {TOOL_ORDER.map((t) => { const Icon = TOOLS[t].icon; const active = tool === t;
            return <button key={t} data-testid={`tool-${t}`} title={TOOLS[t].label} onClick={() => { setTool(t); setDraft([]); }}
              className={`w-10 h-10 flex items-center justify-center rounded-sm transition-colors ${active ? "bg-orange-600 text-white" : "text-slate-400 hover:bg-slate-800 hover:text-white"}`}><Icon className="w-5 h-5" strokeWidth={1.7} /></button>;
          })}
          <div className="mt-auto flex flex-col gap-1">
            <button onClick={() => setView((v) => ({ ...v, z: Math.min(v.z * 1.2, 6) }))} className="w-10 h-10 flex items-center justify-center rounded-sm text-slate-400 hover:bg-slate-800 hover:text-white"><ZoomIn className="w-4 h-4" /></button>
            <button onClick={() => setView((v) => ({ ...v, z: Math.max(v.z / 1.2, 0.05) }))} className="w-10 h-10 flex items-center justify-center rounded-sm text-slate-400 hover:bg-slate-800 hover:text-white"><ZoomOut className="w-4 h-4" /></button>
            <button onClick={fitToScreen} title="Fit" className="w-10 h-10 flex items-center justify-center rounded-sm text-slate-400 hover:bg-slate-800 hover:text-white"><Maximize className="w-4 h-4" /></button>
          </div>
        </div>

        {/* Canvas */}
        <div ref={containerRef} className="flex-1 relative overflow-hidden dot-grid">
          {tool !== "select" && tool !== "pan" && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 bg-slate-950 text-white text-xs font-mono px-3 py-1.5 rounded-sm flex items-center gap-3 shadow-lg">
              <span className="text-orange-400 font-bold">{TOOLS[tool].label}</span>
              {TOOLS[tool].kind === "rect" && <span className="text-slate-400">click-drag a box</span>}
              {TOOLS[tool].kind === "poly" && <span className="text-slate-400">click corners · Enter/double-click to finish · Shift = straight</span>}
              {TOOLS[tool].kind === "line" && <span className="text-slate-400">click two points</span>}
            </div>
          )}
          {draft.length > 0 && TOOLS[tool]?.kind === "poly" && (
            <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-30 bg-white border border-slate-300 shadow-xl rounded-sm flex items-stretch overflow-hidden">
              <div className="px-4 flex items-center text-xs font-mono text-slate-600 border-r border-slate-200">{draft.length} pt{draft.length !== 1 ? "s" : ""}</div>
              <button data-testid="finish-shape-btn" onClick={finishPoly} className="px-5 py-2.5 bg-green-600 hover:bg-green-700 text-white font-bold text-sm inline-flex items-center gap-2"><Check className="w-4 h-4" />Finish</button>
              <button onClick={undoDraft} className="px-3 hover:bg-slate-100 text-slate-600 inline-flex items-center gap-1 text-xs font-bold border-l border-slate-200"><Undo2 className="w-3.5 h-3.5" />Undo</button>
              <button onClick={cancelDraft} className="px-3 hover:bg-red-50 text-slate-500 hover:text-red-600 inline-flex items-center gap-1 text-xs font-bold border-l border-slate-200"><X className="w-3.5 h-3.5" />Cancel</button>
            </div>
          )}

          <svg ref={svgRef} className={`absolute inset-0 w-full h-full ${cursorClass}`} data-testid="takeoff-canvas"
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
            onDoubleClick={() => { if (TOOLS[tool]?.kind === "poly") finishPoly(); }}>
            <defs>
              {showFill && items.filter((m) => AREA_TYPES.includes(m.type) && !m.is_deduction && m.visible !== false && areaTileFor(m)).map((m) => (
                <TilePattern key={m.id} id={`tilepat_${m.id}`} tile={areaTileFor(m)} pattern={m.pattern || areaTileFor(m)?.pattern} scale={scale} />
              ))}
            </defs>
            <g transform={`translate(${view.tx} ${view.ty}) scale(${view.z})`}>
              {hasImg && bgUrl && <image href={bgUrl} x={0} y={0} width={canvas.w} height={canvas.h} />}
              {!hasImg && <rect x={0} y={0} width={canvas.w} height={canvas.h} className="blueprint-grid" fill="#0b1220" />}
              {items.map((m) => m.visible === false ? null : (
                <ShapeRender key={m.id} m={m} sw={sw(m)} z={view.z} scale={scale} unit={unit} selected={m.id === selId}
                  fillTile={showFill && AREA_TYPES.includes(m.type) && !m.is_deduction && areaTileFor(m)} />
              ))}
              {/* control-point handles for selected shape */}
              {tool === "select" && sel && sel.points && sel.type !== "count" && sel.type !== "text" && (
                <g data-testid="control-points">
                  {AREA_TYPES.includes(sel.type) && sel.points.map((p, i) => {
                    const n = sel.points[(i + 1) % sel.points.length]; const mx = (p[0] + n[0]) / 2, my = (p[1] + n[1]) / 2;
                    return <circle key={`mid${i}`} cx={mx} cy={my} r={4.5 / view.z} fill="#16A34A" stroke="#fff" strokeWidth={1.2 / view.z} style={{ cursor: "copy" }} onPointerDown={(e) => onMidDown(e, sel.id, i, [mx, my])} />;
                  })}
                  {sel.points.map((p, i) => (
                    <rect key={`v${i}`} data-testid={`vertex-${i}`} x={p[0] - 5.5 / view.z} y={p[1] - 5.5 / view.z} width={11 / view.z} height={11 / view.z}
                      fill="#fff" stroke="#0F172A" strokeWidth={1.6 / view.z} style={{ cursor: "move" }} onPointerDown={(e) => onVtxDown(e, sel.id, i)} />
                  ))}
                </g>
              )}
              {/* rect drag preview */}
              {rectDrag && (() => { const { p0, p1 } = rectDrag; return (
                <rect x={Math.min(p0[0], p1[0])} y={Math.min(p0[1], p1[1])} width={Math.abs(p1[0] - p0[0])} height={Math.abs(p1[1] - p0[1])}
                  fill={`${TOOLS[tool].color}22`} stroke={TOOLS[tool].color} strokeWidth={2 / view.z} strokeDasharray={`${6 / view.z} ${4 / view.z}`} />); })()}
              {/* poly/line draft */}
              {draft.length > 0 && (
                <g>
                  {TOOLS[tool]?.kind === "poly" && !TOOLS[tool].openPath
                    ? <polygon points={draft.map((p) => p.join(",")).join(" ")} fill="rgba(234,88,12,0.12)" stroke="#EA580C" strokeWidth={2 / view.z} strokeDasharray={`${6 / view.z} ${4 / view.z}`} />
                    : <polyline points={draft.map((p) => p.join(",")).join(" ")} fill="none" stroke="#EA580C" strokeWidth={2 / view.z} strokeDasharray={`${6 / view.z} ${4 / view.z}`} />}
                  {draft.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={(i === 0 && draft.length >= 3 ? 6 : 4) / view.z} fill={i === 0 && draft.length >= 3 ? "#16A34A" : "#fff"} stroke="#EA580C" strokeWidth={2 / view.z} />)}
                </g>
              )}
            </g>
          </svg>
        </div>

        {/* Right panel */}
        <div className="w-96 bg-white border-l border-slate-200 flex flex-col z-20">
          <div className="grid grid-cols-3 gap-px bg-slate-200 border-b border-slate-200 shrink-0">
            {[["NET AREA", summary && scale ? summary.totals.net_area : "—", "sf"], ["TILES", summary?.totals.tiles_needed ?? 0, "ea"], ["COST", `$${(summary?.totals.cost ?? 0).toLocaleString()}`, ""]].map(([k, v, u]) => (
              <div key={k} className="bg-white p-3 text-center"><div className="text-[9px] font-mono uppercase tracking-widest text-slate-500">{k}</div>
                <div className="text-base font-black font-data text-slate-900 truncate">{v}<span className="text-[10px] text-slate-400 ml-0.5">{u}</span></div></div>
            ))}
          </div>

          <Tabs value={tab} onValueChange={setTab} className="flex-1 flex flex-col min-h-0">
            <TabsList className="grid grid-cols-5 rounded-none bg-slate-100 border-b border-slate-200 h-9 shrink-0">
              {[["layers", "Layers"], ["style", "Style"], ["tile", "Tile"], ["ai", "AI"], ["3d", "3D"]].map(([v, l]) => (
                <TabsTrigger key={v} value={v} data-testid={`tab-${v}`} className="text-xs rounded-none data-[state=active]:bg-white">{l}</TabsTrigger>
              ))}
            </TabsList>

            {/* LAYERS */}
            <TabsContent value="layers" className="flex-1 overflow-y-auto m-0 p-0">
              {items.length === 0 && <div className="p-6 text-center text-sm text-slate-400">Pick a tool and draw on the plan. Drag a box for areas/cutouts, click corners for rooms.</div>}
              {items.map((m) => {
                const val = realValue(m, scale);
                return (
                  <div key={m.id} data-testid={`measurement-${m.id}`} onClick={() => { setSelId(m.id); setTab("style"); }}
                    className={`px-3 py-2 border-b border-slate-100 flex items-center gap-2 cursor-pointer ${selIds.includes(m.id) ? "bg-orange-50" : "hover:bg-slate-50"}`}>
                    <button onClick={(e) => { e.stopPropagation(); updateItem(m.id, { visible: m.visible === false }); }} className="text-slate-400 hover:text-slate-900">
                      {m.visible === false ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}</button>
                    <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: m.color }} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-bold truncate flex items-center gap-1">{m.label}{m.is_deduction && <span className="text-[9px] text-red-600 font-mono">DEDUCT</span>}</div>
                      <div className="text-[11px] font-mono text-slate-500">{m.type === "count" ? `${m.count} ea` : m.type === "text" ? "note" : val != null ? `${val.toFixed(1)} ${AREA_TYPES.includes(m.type) ? "sf" : unit}` : m.type}</div>
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); updateItem(m.id, { locked: !m.locked }); }} className="text-slate-300 hover:text-slate-700">{m.locked ? <Lock className="w-3.5 h-3.5" /> : <LockOpen className="w-3.5 h-3.5" />}</button>
                    <button onClick={(e) => { e.stopPropagation(); removeItem(m.id); }} className="text-slate-300 hover:text-red-600"><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                );
              })}
            </TabsContent>

            {/* STYLE (properties of selected) */}
            <TabsContent value="style" className="flex-1 overflow-y-auto m-0 p-4 space-y-3">
              {!sel ? <div className="text-sm text-slate-400 text-center mt-6">Select a measurement (Select tool) to edit its properties — color, fill, line width, label.</div> : (
                <>
                  <div><label className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Label</label>
                    <input className={input} value={sel.label || ""} onChange={(e) => updateItem(sel.id, { label: e.target.value })} data-testid="style-label" /></div>
                  {sel.type === "text" && <div><label className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Note text</label>
                    <input className={input} value={sel.text || ""} onChange={(e) => updateItem(sel.id, { text: e.target.value })} /></div>}
                  <div className="grid grid-cols-2 gap-3">
                    <div><label className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Line / Text Color</label>
                      <input type="color" className="w-full h-9 border border-slate-300 rounded-sm" value={sel.color || "#EA580C"} onChange={(e) => updateItem(sel.id, { color: e.target.value })} data-testid="style-color" /></div>
                    <div><label className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Line Width</label>
                      <input type="range" min="1" max="8" value={sel.lineWidth || 2} onChange={(e) => updateItem(sel.id, { lineWidth: +e.target.value })} className="w-full mt-3 accent-orange-600" /></div>
                  </div>
                  {AREA_TYPES.includes(sel.type) && (
                    <div className="grid grid-cols-2 gap-3">
                      <div><label className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Fill Color</label>
                        <input type="color" className="w-full h-9 border border-slate-300 rounded-sm" value={sel.fillColor || sel.color || "#EA580C"} onChange={(e) => updateItem(sel.id, { fillColor: e.target.value })} data-testid="style-fill" /></div>
                      <div><label className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Fill Opacity</label>
                        <input type="range" min="0" max="0.8" step="0.05" value={sel.fillOpacity ?? 0.22} onChange={(e) => updateItem(sel.id, { fillOpacity: +e.target.value })} className="w-full mt-3 accent-orange-600" /></div>
                    </div>
                  )}
                  <div className="flex items-center justify-between pt-2">
                    <label className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Deduction (cutout)</label>
                    <input type="checkbox" checked={!!sel.is_deduction} onChange={(e) => updateItem(sel.id, { is_deduction: e.target.checked })} className="accent-red-600 w-4 h-4" />
                  </div>
                  <button onClick={() => removeItem(sel.id)} className="w-full border border-red-200 text-red-600 hover:bg-red-50 font-bold py-2 rounded-sm inline-flex items-center justify-center gap-2 text-sm"><Trash2 className="w-4 h-4" />Delete</button>
                </>
              )}
            </TabsContent>

            {/* TILE */}
            <TabsContent value="tile" className="flex-1 overflow-y-auto m-0 p-4 space-y-4">
              <div>
                <label className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Default Tile (all areas)</label>
                <select data-testid="default-tile-select" className={input + " mt-1"} value={defaultTileId || ""} onChange={(e) => setDefaultTile(e.target.value)}>
                  <option value="">— none —</option>
                  {(tiles || []).map((t) => <option key={t.id} value={t.id}>{`${t.name} (${t.width}×${t.height})`}</option>)}
                </select>
              </div>
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Cut reuse (waste optimization)</label>
                <input type="checkbox" checked={takeoff.cut_reuse !== false} onChange={(e) => setReuse(e.target.checked)} className="accent-orange-600 w-4 h-4" />
              </div>
              {/* per-area layout */}
              <div className="border-t border-slate-200 pt-3 space-y-2">
                <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Per-Room Layout</div>
                {items.filter((m) => AREA_TYPES.includes(m.type) && !m.is_deduction).map((m) => (
                  <div key={m.id} className="border border-slate-200 rounded-sm p-2 space-y-1.5">
                    <div className="text-xs font-bold">{m.label}</div>
                    <div className="grid grid-cols-2 gap-1.5">
                      <select className={input} value={m.tile_id || ""} onChange={(e) => updateItem(m.id, { tile_id: e.target.value || null })}>
                        <option value="">{defaultTile ? `default (${defaultTile.name})` : "default"}</option>
                        {(tiles || []).map((t) => <option key={t.id} value={t.id}>{String(t.name)}</option>)}
                      </select>
                      <select className={input} value={m.pattern || ""} onChange={(e) => updateItem(m.id, { pattern: e.target.value || null })}>
                        <option value="">pattern (tile default)</option>
                        {PATTERNS.map((p) => <option key={p} value={p}>{p}</option>)}
                      </select>
                    </div>
                  </div>
                ))}
              </div>
              {/* quantity breakdown */}
              <div className="border-t border-slate-200 pt-3 space-y-2">
                <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Quantity & Cut Breakdown</div>
                {(summary?.lines || []).length === 0 && <div className="text-sm text-slate-400">Draw areas and assign tiles.</div>}
                {(summary?.lines || []).map((l, i) => (
                  <div key={i} className="border border-slate-200 rounded-sm p-2.5 text-xs font-mono">
                    <div className="font-bold text-sm font-sans">{l.tile_name} <span className="text-slate-400 font-normal">· {l.pattern}</span></div>
                    <div className="grid grid-cols-2 gap-1 mt-1 text-slate-600">
                      <span>Net: {l.net_area} sf</span><span>Full: <b className="text-slate-900">{l.full_tiles}</b></span>
                      <span>Cuts: <b className="text-slate-900">{l.cut_tiles}</b></span><span>Reused: <b className="text-green-700">{l.reused_cuts}</b></span>
                      <span>Order: <b className="text-slate-900">{l.tiles_needed}</b></span><span>Boxes: <b className="text-slate-900">{l.boxes}</b></span>
                      <span>Waste: {l.true_waste_pct}%</span><span className="text-orange-600 font-bold">${l.cost.toLocaleString()}</span>
                    </div>
                  </div>
                ))}
              </div>
            </TabsContent>

            {/* AI */}
            <TabsContent value="ai" className="flex-1 overflow-y-auto m-0 p-4">
              <button data-testid="run-ai-btn" onClick={runAI} disabled={aiLoading} className="w-full bg-orange-600 hover:bg-orange-700 disabled:opacity-60 text-white font-bold py-2.5 rounded-sm inline-flex items-center justify-center gap-2 mb-4"><Sparkles className="w-4 h-4" />{aiLoading ? "Analyzing…" : "Run AI Takeoff Assist"}</button>
              {!takeoff.ai_suggestions && <p className="text-xs text-slate-400 text-center">Works on PDF & image plans. Detects tileable regions, openings, and recommends a waste allowance to review.</p>}
              {takeoff.ai_suggestions && (
                <div className="space-y-3">
                  <div className="bg-orange-50 border border-orange-200 rounded-sm p-3 text-xs text-slate-700">{takeoff.ai_suggestions.summary}</div>
                  <div className="flex items-center justify-between text-[11px] font-mono uppercase tracking-wider text-slate-500"><span>Recommended waste</span><span className="text-orange-600 font-bold text-sm">{takeoff.ai_suggestions.recommended_waste_pct}%</span></div>
                  {(takeoff.ai_suggestions.regions || []).some((r) => r.polygon?.length >= 3) && (
                    <button data-testid="ai-add-all" onClick={addAllAIRooms} className="w-full bg-slate-900 hover:bg-slate-800 text-white font-bold py-2 rounded-sm text-sm inline-flex items-center justify-center gap-2"><Check className="w-4 h-4" />Add all rooms as editable polygons</button>
                  )}
                  {(takeoff.ai_suggestions.regions || []).map((r, i) => (
                    <div key={i} className="border border-slate-200 rounded-sm p-2.5" data-testid={`ai-region-${i}`}>
                      <div className="flex items-center justify-between"><span className="font-bold text-sm">{r.label}</span><span className="text-[11px] font-mono text-slate-500">{r.est_area_sqft} sf</span></div>
                      <div className="mt-1.5 h-1.5 bg-slate-100 rounded-full overflow-hidden"><div className="h-full bg-green-500" style={{ width: `${Math.round((r.confidence || 0) * 100)}%` }} /></div>
                      <div className="text-[10px] font-mono text-slate-400 mt-1">confidence {Math.round((r.confidence || 0) * 100)}% · {r.notes}</div>
                      {r.polygon?.length >= 3 && <button data-testid={`ai-add-${i}`} onClick={() => addAIRoom(r)} className="mt-2 text-xs font-bold text-orange-600 hover:text-orange-700 inline-flex items-center gap-1">+ Add to plan</button>}
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>

            {/* 3D */}
            <TabsContent value="3d" className="flex-1 overflow-hidden m-0 p-0 flex flex-col">
              <div className="flex items-center gap-1 p-2 border-b border-slate-200 shrink-0">
                <button data-testid="3d-flat" onClick={() => setMode3d("flat")} className={`flex-1 text-xs font-bold py-1.5 rounded-sm ${mode3d === "flat" ? "bg-slate-900 text-white" : "border border-slate-300 text-slate-600"}`}>2.5D Plan</button>
                <button data-testid="3d-walk" onClick={() => setMode3d("walk")} className={`flex-1 text-xs font-bold py-1.5 rounded-sm ${mode3d === "walk" ? "bg-orange-600 text-white" : "border border-slate-300 text-slate-600"}`}>3D Walkthrough</button>
              </div>
              {mode3d === "flat" ? (
                <>
                  <div className="flex items-center gap-1 px-2 py-1.5 border-b border-slate-200 shrink-0">
                    <button onClick={() => setShow3dTiles(false)} className={`flex-1 text-[11px] font-bold py-1 rounded-sm ${!show3dTiles ? "bg-slate-700 text-white" : "border border-slate-300 text-slate-600"}`}>Before</button>
                    <button data-testid="3d-after" onClick={() => setShow3dTiles(true)} className={`flex-1 text-[11px] font-bold py-1 rounded-sm ${show3dTiles ? "bg-orange-600 text-white" : "border border-slate-300 text-slate-600"}`}>After (tiled)</button>
                  </div>
                  <div className="flex-1 min-h-0"><Plan3D items={items} tilesMap={tilesMap} defaultTile={defaultTile} scale={scale} type={takeoff.type} withTiles={show3dTiles} /></div>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2 px-3 py-1.5 border-b border-slate-200 shrink-0 text-[11px] font-mono text-slate-600">
                    <span>Wall ht</span>
                    <input type="range" min="0" max="12" step="0.5" value={wallHeight} onChange={(e) => setWallHeight(+e.target.value)} className="flex-1 accent-orange-600" />
                    <span className="w-8 text-right">{wallHeight}'</span>
                  </div>
                  <div className="flex-1 min-h-0" data-testid="walkthrough-3d">
                    {(() => { const rooms = items.filter((m) => AREA_TYPES.includes(m.type) && !m.is_deduction && (m.points || []).length >= 3 && m.visible !== false);
                      return rooms.length === 0
                        ? <div className="h-full flex items-center justify-center text-center text-xs font-mono text-slate-400 px-6">Draw room areas to walk through them in 3D.</div>
                        : <Suspense fallback={<div className="h-full flex items-center justify-center text-xs font-mono text-slate-400">Loading 3D engine…</div>}>
                            <Room3D rooms={rooms} scale={scale} wallHeight={wallHeight} tilesMap={tilesMap} defaultTile={defaultTile} />
                          </Suspense>; })()}
                  </div>
                  <div className="px-3 py-1.5 text-[10px] font-mono text-slate-400 border-t border-slate-200 shrink-0">Drag to orbit · scroll to zoom · right-drag to pan</div>
                </>
              )}
            </TabsContent>
          </Tabs>

          <div className="border-t border-slate-200 p-3 shrink-0">
            <button data-testid="email-report-btn" onClick={() => setEmailOpen(true)} className="w-full border border-slate-300 hover:border-slate-900 text-slate-800 font-bold py-2 rounded-sm inline-flex items-center justify-center gap-2 text-sm"><Mail className="w-4 h-4" />Email Report</button>
          </div>
        </div>
      </div>

      {/* Status bar */}
      <div className="h-7 bg-white border-t border-slate-200 flex items-center px-4 text-[10px] font-mono text-slate-500 justify-between shrink-0">
        <span>{items.length} markups · {hasImg ? `${canvas.w}×${canvas.h}px` : "blank canvas"} · {summary?.totals.cut_tiles ?? 0} cuts ({summary?.totals.reused_cuts ?? 0} reused)</span>
        <span>{scale ? `1px = ${scale.toFixed(4)} ${unit}` : "uncalibrated"} · zoom {Math.round(view.z * 100)}% · Space/middle-drag = pan</span>
      </div>

      {/* Calibration dialog */}
      <Dialog open={calibOpen} onOpenChange={setCalibOpen}>
        <DialogContent className="rounded-sm">
          <DialogHeader><DialogTitle className="font-black tracking-tight">Set Drawing Scale</DialogTitle></DialogHeader>
          <p className="text-sm text-slate-500">Reference line: <b className="font-mono">{calibLine ? pathLength(calibLine).toFixed(0) : 0}px</b>. Trace along a labeled dimension for accuracy.</p>
          <div className="flex items-end gap-2">
            <select className={input + " w-28"} value={calibForm.unit} onChange={(e) => setCalibForm({ ...calibForm, unit: e.target.value })}><option value="ft">feet + in</option><option value="in">inches</option><option value="m">meters</option></select>
            {calibForm.unit === "ft" ? (<>
              <div className="flex-1"><label className="text-[10px] font-mono uppercase tracking-wider text-slate-500">Feet</label><input data-testid="calib-length-input" type="number" className={input} value={calibForm.feet} onChange={(e) => setCalibForm({ ...calibForm, feet: e.target.value })} /></div>
              <div className="flex-1"><label className="text-[10px] font-mono uppercase tracking-wider text-slate-500">Inches</label><input type="number" className={input} value={calibForm.inches} onChange={(e) => setCalibForm({ ...calibForm, inches: e.target.value })} /></div>
            </>) : (<div className="flex-1"><label className="text-[10px] font-mono uppercase tracking-wider text-slate-500">Length</label><input data-testid="calib-length-input" type="number" className={input} value={calibForm.feet} onChange={(e) => setCalibForm({ ...calibForm, feet: e.target.value })} /></div>)}
          </div>
          <DialogFooter><button data-testid="confirm-calib-btn" onClick={confirmCalibration} className="bg-orange-600 hover:bg-orange-700 text-white font-bold px-4 py-2 rounded-sm">Apply Scale</button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={emailOpen} onOpenChange={setEmailOpen}>
        <DialogContent className="rounded-sm">
          <DialogHeader><DialogTitle className="font-black tracking-tight">Email Estimate Report</DialogTitle></DialogHeader>
          <input data-testid="email-recipient-input" type="email" className={input} placeholder="client@example.com" value={emailTo} onChange={(e) => setEmailTo(e.target.value)} />
          <DialogFooter><button data-testid="send-email-btn" onClick={sendEmail} className="bg-orange-600 hover:bg-orange-700 text-white font-bold px-4 py-2 rounded-sm inline-flex items-center gap-2"><Mail className="w-4 h-4" />Send</button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > p[1]) !== (yj > p[1])) && (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function ShapeRender({ m, sw, z, scale, unit, selected, fillTile }) {
  const val = realValue(m, scale);
  const label = m.type === "count" ? `${m.count}` : m.type === "text" ? m.text : (val != null ? `${val.toFixed(1)} ${AREA_TYPES.includes(m.type) ? "sf" : unit}` : "");
  const fs = 13 / z;
  if (m.type === "count") {
    const [x, y] = m.points[0];
    return <g><circle cx={x} cy={y} r={10 / z} fill={m.color} stroke={selected ? "#0F172A" : "none"} strokeWidth={2 / z} /><text x={x} y={y + 4 / z} textAnchor="middle" fontSize={fs} fill="#fff" fontFamily="JetBrains Mono">{m.count}</text></g>;
  }
  if (m.type === "text") {
    const [x, y] = m.points[0];
    return <text x={x} y={y} fontSize={16 / z} fill={m.color} fontFamily="Chivo" fontWeight="700" stroke="#fff" strokeWidth={0.6 / z} paintOrder="stroke" style={{ textDecoration: selected ? "underline" : "none" }}>{m.text}</text>;
  }
  const isArea = AREA_TYPES.includes(m.type);
  const [cx, cy] = centroid(m.points);
  const ptsStr = m.points.map((p) => p.join(",")).join(" ");
  const fill = fillTile ? `url(#tilepat_${m.id})` : isArea ? (m.fillColor || m.color) : "none";
  const fo = fillTile ? 1 : (m.fillOpacity ?? 0.22);
  return (
    <g>
      {isArea ? <polygon points={ptsStr} fill={fill} fillOpacity={fo} stroke={m.color} strokeWidth={sw} />
        : <polyline points={ptsStr} fill="none" stroke={m.color} strokeWidth={sw} />}
      {label && <text x={cx} y={cy} textAnchor="middle" fontSize={fs} fill={m.color} fontFamily="JetBrains Mono" stroke="#fff" strokeWidth={0.6 / z} paintOrder="stroke" fontWeight="700">{label}</text>}
    </g>
  );
}

function Plan3D({ items, tilesMap, defaultTile, scale, type, withTiles }) {
  const areas = items.filter((m) => AREA_TYPES.includes(m.type) && !m.is_deduction && (m.points || []).length >= 3 && m.visible !== false);
  const deds = items.filter((m) => m.is_deduction && (m.points || []).length >= 3 && m.visible !== false);
  if (!areas.length) return <div className="h-full flex items-center justify-center text-center text-xs font-mono text-slate-400 px-6">Draw room areas on the plan — the 3D layout builds automatically.<br />Toggle Before / After to preview the tile finish.</div>;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  areas.forEach((m) => m.points.forEach(([x, y]) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }));
  const w = Math.max(maxX - minX, 1), h = Math.max(maxY - minY, 1);
  const tileFor = (m) => tilesMap[m.tile_id] || defaultTile;
  const vizScale = (m) => { const t = tileFor(m); const twFt = (t?.width || 12) / 12; return (twFt * 14) / w; }; // ~14 tiles across, always visible
  const W = 460, H = Math.max(Math.min(W * h / w, 420), 120);
  return (
    <div className="h-full bg-gradient-to-b from-slate-200 to-slate-400 flex items-center justify-center overflow-hidden relative">
      <div className="absolute top-3 left-3 text-[10px] font-mono uppercase tracking-widest text-slate-600 z-10">3D {type} · {withTiles ? "tiled" : "bare"} · {areas.length} room{areas.length !== 1 ? "s" : ""}</div>
      <div className={type === "wall" ? "tile-3d-wall" : "tile-3d-floor"}>
        <svg viewBox={`${minX} ${minY} ${w} ${h}`} width={W} height={H} style={{ filter: "drop-shadow(0 18px 24px rgba(0,0,0,0.35))" }}>
          <defs>{withTiles && areas.filter((m) => tileFor(m)).map((m) => (
            <TilePattern key={m.id} id={`p3d_${m.id}`} tile={tileFor(m)} pattern={m.pattern || tileFor(m)?.pattern} scale={vizScale(m)} opacity={1} />
          ))}</defs>
          {areas.map((m) => (
            <polygon key={m.id} points={m.points.map((p) => p.join(",")).join(" ")}
              fill={withTiles && tileFor(m) ? `url(#p3d_${m.id})` : "#e7eaef"} stroke="#475569" strokeWidth={w * 0.004} strokeLinejoin="round" />
          ))}
          {deds.map((m) => (
            <polygon key={m.id} points={m.points.map((p) => p.join(",")).join(" ")} fill="#cbd5e1" stroke="#94a3b8" strokeWidth={w * 0.003} />
          ))}
        </svg>
      </div>
      {withTiles && !defaultTile && !areas.some((m) => tilesMap[m.tile_id]) && (
        <div className="absolute bottom-3 text-[11px] font-mono text-slate-700 bg-white/70 px-2 py-1 rounded-sm">Assign tiles in the Tile tab to see the finish</div>
      )}
    </div>
  );
}
