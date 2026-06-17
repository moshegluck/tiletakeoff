import React, { useState, useRef, useEffect, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import useSWR from "swr";
import { toast } from "sonner";
import { api, apiErr, fileUrl, exportUrl } from "@/lib/api";
import { TOOLS, AREA_TYPES, LINEAR_TYPES, shoelace, pathLength, centroid, realValue } from "@/lib/geometry";
import {
  ArrowLeft, MousePointer2, Ruler, Square, Layers as LayersIcon, Spline, Minus, Hash, Scan,
  Sparkles, Box, FileSpreadsheet, FileText, FileDown, Mail, Trash2, ZoomIn, ZoomOut, Maximize,
  Check, X, Undo2,
} from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";

const fetcher = (url) => api.get(url).then((r) => r.data);
const TOOL_ICONS = { select: MousePointer2, calibrate: Ruler, area: Square, wall: LayersIcon, perimeter: Spline, linear: Minus, opening: Scan, count: Hash };
const input = "w-full bg-slate-50 border border-slate-300 rounded-sm px-2 py-1.5 text-sm font-mono focus:outline-none focus:border-orange-600 focus:ring-1 focus:ring-orange-600";

export default function TakeoffStudio() {
  const { id } = useParams();
  const { data, mutate } = useSWR(`/takeoffs/${id}`, fetcher);
  const [tool, setTool] = useState("select");
  const [draft, setDraft] = useState([]);
  const [zoom, setZoom] = useState(1);
  const [canvas, setCanvas] = useState({ w: 1200, h: 800 });
  const [hasImg, setHasImg] = useState(false);
  const [bgUrl, setBgUrl] = useState(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [calibOpen, setCalibOpen] = useState(false);
  const [calibLine, setCalibLine] = useState(null);
  const [calibForm, setCalibForm] = useState({ feet: "", inches: "", unit: "ft" });
  const [emailOpen, setEmailOpen] = useState(false);
  const [emailTo, setEmailTo] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [tab, setTab] = useState("measure");
  const svgRef = useRef();
  const containerRef = useRef();

  const fitToScreen = useCallback(() => {
    const el = containerRef.current;
    if (!el || !canvas.w) return;
    const z = Math.min((el.clientWidth - 48) / canvas.w, (el.clientHeight - 96) / canvas.h);
    setZoom(Math.max(Math.min(z, 1.5), 0.08));
  }, [canvas]);

  useEffect(() => { const t = setTimeout(fitToScreen, 60); return () => clearTimeout(t); }, [canvas.w, canvas.h, fitToScreen]);

  const takeoff = data?.takeoff;
  const drawing = data?.drawing;
  const summary = data?.summary;
  const scale = drawing?.calibration?.scale || null;
  const unit = drawing?.calibration?.unit || "ft";
  const measurements = takeoff?.measurements || [];

  useEffect(() => {
    let cancelled = false;
    setHasImg(false);
    setBgUrl(null);
    if (!drawing) { setCanvas({ w: 1200, h: 800 }); return; }
    const ct = drawing.content_type || "";
    if (ct.startsWith("image")) {
      const im = new Image();
      im.onload = () => { if (cancelled) return; setCanvas({ w: im.naturalWidth, h: im.naturalHeight }); setBgUrl(fileUrl(drawing.id)); setHasImg(true); };
      im.src = fileUrl(drawing.id);
    } else if (ct.includes("pdf")) {
      setPlanLoading(true);
      (async () => {
        try {
          const { data: buf } = await api.get(`/drawings/${drawing.id}/file`, { responseType: "arraybuffer" });
          const { renderPdfFirstPage } = await import("@/lib/pdf");
          const res = await renderPdfFirstPage(buf, 2);
          if (cancelled) return;
          setCanvas({ w: res.width, h: res.height });
          setBgUrl(res.dataUrl);
          setHasImg(true);
        } catch (e) {
          if (!cancelled) { toast.error("Could not render PDF plan"); setCanvas({ w: 1200, h: 800 }); }
        } finally {
          if (!cancelled) setPlanLoading(false);
        }
      })();
    } else {
      setCanvas({ w: 1200, h: 800 });
    }
    return () => { cancelled = true; };
  }, [drawing]);

  const save = useCallback(async (patch) => {
    try {
      const { data: res } = await api.put(`/takeoffs/${id}`, patch);
      mutate({ ...data, takeoff: res.takeoff, summary: res.summary }, false);
    } catch (e) { toast.error(apiErr(e)); }
  }, [id, data, mutate]);

  const toCoords = (e) => {
    const r = svgRef.current.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width * canvas.w, (e.clientY - r.top) / r.height * canvas.h];
  };

  const closeThreshold = Math.max(canvas.w * 0.012, 8);
  const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= closeThreshold;
  const dedupe = (pts) => pts.filter((p, i) => i === 0 || !near(p, pts[i - 1]));

  const addMeasurement = (m) => save({ measurements: [...measurements, m] });

  const onCanvasClick = (e) => {
    if (tool === "select") return;
    const p = toCoords(e);
    if (tool === "count") {
      addMeasurement({ id: `m_${Date.now()}`, type: "count", points: [p], count: 1, color: TOOLS.count.color, label: `Count ${measurements.filter(m => m.type === "count").length + 1}` });
      return;
    }
    if (tool === "calibrate") {
      const np = [...draft, p];
      if (np.length === 2) { setCalibLine(np); setDraft([]); setCalibOpen(true); }
      else setDraft(np);
      return;
    }
    const meta = TOOLS[tool];
    if (meta.kind === "line") {
      const np = [...draft, p];
      if (np.length === 2) { finishShape(np); } else setDraft(np);
      return;
    }
    // polygon / path: click near first point closes the shape
    if (meta.kind === "polygon" && draft.length >= 3 && near(p, draft[0])) {
      finishShape(draft);
      return;
    }
    setDraft([...draft, p]);
  };

  const onCanvasDoubleClick = (e) => {
    if (tool === "select" || tool === "count" || tool === "calibrate") return;
    e.preventDefault();
    e.stopPropagation();
    const meta = TOOLS[tool];
    if (meta.kind === "polygon" && draft.length >= 3) finishShape(draft);
  };

  const finishShape = (raw) => {
    const meta = TOOLS[tool];
    const pts = dedupe(raw);
    const minPts = meta.kind === "polygon" ? 3 : 2;
    if (pts.length < minPts) { toast.error(`Add at least ${minPts} points first`); return; }
    const labelBase = { area: "Room", wall: "Wall", opening: "Opening", perimeter: "Perimeter", linear: "Line" }[tool] || tool;
    addMeasurement({
      id: `m_${Date.now()}`, type: tool, points: pts, color: meta.color,
      is_deduction: tool === "opening",
      label: `${labelBase} ${measurements.filter(m => m.type === tool).length + 1}`,
    });
    setDraft([]);
    toast.success("Measurement added");
  };

  const finishDraft = () => { if (draft.length) finishShape(draft); };
  const undoDraft = () => setDraft((d) => d.slice(0, -1));
  const cancelDraft = () => setDraft([]);

  // keyboard: Enter = finish, Esc = cancel, Backspace = undo last point
  useEffect(() => {
    const onKey = (e) => {
      if (tool === "select") return;
      if (e.key === "Enter") { e.preventDefault(); finishDraft(); }
      else if (e.key === "Escape") { setDraft([]); }
      else if (e.key === "Backspace") { e.preventDefault(); undoDraft(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const confirmCalibration = async () => {
    const feet = parseFloat(calibForm.feet) || 0;
    const inches = parseFloat(calibForm.inches) || 0;
    let realLen, unit;
    if (calibForm.unit === "ft") { realLen = feet + inches / 12; unit = "ft"; }
    else { realLen = feet; unit = calibForm.unit; }  // for in/m, "feet" field holds the value
    if (!realLen || !calibLine) { toast.error("Enter the real length of the line"); return; }
    const px = pathLength(calibLine);
    try {
      await api.post(`/drawings/${drawing.id}/calibrate`, { pixel_length: px, real_length: realLen, unit });
      toast.success(`Scale set · ${realLen.toFixed(2)} ${unit}`);
      setCalibOpen(false); setCalibLine(null); setTool("select"); setCalibForm({ feet: "", inches: "", unit: "ft" });
      mutate();
    } catch (e) { toast.error(apiErr(e)); }
  };

  const deleteMeasurement = (mid) => save({ measurements: measurements.filter((m) => m.id !== mid) });
  const assignTile = (mid, tileId) => save({ measurements: measurements.map((m) => m.id === mid ? { ...m, tile_id: tileId || null } : m) });
  const setDefaultTile = (tileId) => save({ default_tile_id: tileId || null });

  const runAI = async () => {
    setAiLoading(true);
    try {
      await api.post(`/takeoffs/${id}/ai-analyze`);
      toast.success("AI analysis complete");
      mutate();
      setTab("ai");
    } catch (e) { toast.error(apiErr(e)); }
    finally { setAiLoading(false); }
  };

  const sendEmail = async () => {
    if (!emailTo) return toast.error("Enter recipient");
    try { await api.post(`/takeoffs/${id}/email`, { recipient_email: emailTo }); toast.success("Report emailed"); setEmailOpen(false); }
    catch (e) { toast.error(apiErr(e)); }
  };

  const { data: tiles } = useSWR("/tiles", fetcher);
  const tilesMap = Object.fromEntries((tiles || []).map((t) => [t.id, t]));
  const defaultTile = tilesMap[takeoff?.default_tile_id];

  if (!data) return <div className="h-screen flex items-center justify-center font-mono text-sm text-slate-400">Loading studio…</div>;

  return (
    <div className="h-screen flex flex-col bg-slate-100 overflow-hidden">
      {/* Top bar */}
      <header className="h-12 bg-slate-950 text-white flex items-center justify-between px-4 shrink-0 border-b border-slate-800 z-30">
        <div className="flex items-center gap-3 min-w-0">
          <Link to={`/projects/${takeoff.project_id}`} className="text-slate-400 hover:text-white"><ArrowLeft className="w-4 h-4" /></Link>
          <div className="min-w-0">
            <div className="text-sm font-bold truncate">{takeoff.name}</div>
            <div className="text-[10px] font-mono uppercase tracking-widest text-orange-500">{takeoff.type} takeoff</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-[10px] font-mono uppercase tracking-wider px-2 py-1 rounded-sm ${scale ? "bg-green-900/60 text-green-400" : "bg-amber-900/60 text-amber-400"}`}>
            {scale ? `Scale set · ${unit}` : "Not calibrated"}
          </span>
          <a data-testid="export-pdf" href={exportUrl(id, "pdf")} target="_blank" rel="noreferrer" className="text-xs font-bold bg-slate-800 hover:bg-slate-700 px-2.5 py-1.5 rounded-sm inline-flex items-center gap-1"><FileText className="w-3.5 h-3.5" />PDF</a>
          <a data-testid="export-xlsx" href={exportUrl(id, "xlsx")} target="_blank" rel="noreferrer" className="text-xs font-bold bg-slate-800 hover:bg-slate-700 px-2.5 py-1.5 rounded-sm inline-flex items-center gap-1"><FileSpreadsheet className="w-3.5 h-3.5" />Excel</a>
          <a data-testid="export-csv" href={exportUrl(id, "csv")} target="_blank" rel="noreferrer" className="text-xs font-bold bg-slate-800 hover:bg-slate-700 px-2.5 py-1.5 rounded-sm inline-flex items-center gap-1"><FileDown className="w-3.5 h-3.5" />CSV</a>
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        {/* Left tool rail */}
        <div className="w-14 bg-slate-950 flex flex-col items-center py-3 gap-1 border-r border-slate-800 z-20">
          {Object.keys(TOOLS).map((t) => {
            const Icon = TOOL_ICONS[t];
            const active = tool === t;
            return (
              <button key={t} data-testid={`tool-${t}`} onClick={() => { setTool(t); setDraft([]); }} title={TOOLS[t].label}
                className={`w-10 h-10 flex items-center justify-center rounded-sm transition-colors ${active ? "bg-orange-600 text-white" : "text-slate-400 hover:bg-slate-800 hover:text-white"}`}>
                <Icon className="w-5 h-5" strokeWidth={1.75} />
              </button>
            );
          })}
          <div className="mt-auto flex flex-col gap-1">
            <button onClick={() => setZoom((z) => Math.min(z + 0.2, 3))} className="w-10 h-10 flex items-center justify-center rounded-sm text-slate-400 hover:bg-slate-800 hover:text-white"><ZoomIn className="w-4 h-4" /></button>
            <button onClick={() => setZoom((z) => Math.max(z - 0.15, 0.08))} className="w-10 h-10 flex items-center justify-center rounded-sm text-slate-400 hover:bg-slate-800 hover:text-white"><ZoomOut className="w-4 h-4" /></button>
            <button onClick={fitToScreen} title="Fit to screen" className="w-10 h-10 flex items-center justify-center rounded-sm text-slate-400 hover:bg-slate-800 hover:text-white"><Maximize className="w-4 h-4" /></button>
          </div>
        </div>

        {/* Canvas */}
        <div ref={containerRef} className="flex-1 relative overflow-auto dot-grid">
          {tool !== "select" && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 bg-slate-950 text-white text-xs font-mono px-3 py-1.5 rounded-sm flex items-center gap-3 shadow-lg">
              <span className="text-orange-400 font-bold">{TOOLS[tool].label}</span>
              {TOOLS[tool].kind === "polygon" && <span className="text-slate-400">click corners · double-click or Enter to finish</span>}
              {TOOLS[tool].kind === "line" && <span className="text-slate-400">click start & end point</span>}
              {tool === "count" && <span className="text-slate-400">click each item to count</span>}
              {tool === "calibrate" && <span className="text-slate-400">draw a line along a known dimension</span>}
            </div>
          )}

          {/* Prominent draft action toolbar */}
          {draft.length > 0 && TOOLS[tool]?.kind === "polygon" && (
            <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-30 bg-white border border-slate-300 shadow-xl rounded-sm flex items-stretch overflow-hidden">
              <div className="px-4 flex items-center text-xs font-mono text-slate-600 border-r border-slate-200">
                {draft.length} point{draft.length !== 1 ? "s" : ""}{draft.length < 3 && <span className="text-amber-600 ml-1">· need {3 - draft.length} more</span>}
              </div>
              <button data-testid="finish-shape-btn" onClick={finishDraft} disabled={draft.length < 3}
                className="px-5 py-2.5 bg-green-600 hover:bg-green-700 disabled:bg-slate-200 disabled:text-slate-400 text-white font-bold text-sm inline-flex items-center gap-2 transition-colors">
                <Check className="w-4 h-4" /> Finish Shape
              </button>
              <button data-testid="undo-point-btn" onClick={undoDraft} className="px-3 hover:bg-slate-100 text-slate-600 inline-flex items-center gap-1 text-xs font-bold border-l border-slate-200"><Undo2 className="w-3.5 h-3.5" /> Undo</button>
              <button data-testid="cancel-shape-btn" onClick={cancelDraft} className="px-3 hover:bg-red-50 text-slate-500 hover:text-red-600 inline-flex items-center gap-1 text-xs font-bold border-l border-slate-200"><X className="w-3.5 h-3.5" /> Cancel</button>
            </div>
          )}

          <div style={{ width: canvas.w * zoom, height: canvas.h * zoom }} className="relative mx-auto my-8">
            {hasImg && bgUrl && <img src={bgUrl} alt="plan" className="absolute inset-0 w-full h-full object-contain pointer-events-none select-none bg-white" draggable={false} />}
            {!hasImg && (
              <div className="absolute inset-0 blueprint-grid border border-slate-700 flex items-center justify-center">
                <div className="text-center text-slate-400 font-mono text-xs">
                  {planLoading ? "Rendering plan…" : !drawing ? "No drawing attached to this takeoff" : "Plan preview unavailable"}
                  {!drawing && <div className="text-[10px] mt-1 text-slate-500">Attach a drawing from the project page, or measure on this blank canvas.</div>}
                </div>
              </div>
            )}
            <svg ref={svgRef} viewBox={`0 0 ${canvas.w} ${canvas.h}`} preserveAspectRatio="none"
              onClick={onCanvasClick} onDoubleClick={onCanvasDoubleClick} className={`absolute inset-0 w-full h-full ${tool !== "select" ? "crosshair-cursor" : ""}`}
              style={{ cursor: TOOLS[tool]?.cursor }} data-testid="takeoff-canvas">
              {measurements.map((m) => <MeasurementShape key={m.id} m={m} scale={scale} unit={unit} />)}
              {/* draft */}
              {draft.length > 0 && (
                <g>
                  {(TOOLS[tool]?.kind === "polygon") ? (
                    <polygon points={draft.map((p) => p.join(",")).join(" ")} fill="rgba(234,88,12,0.15)" stroke="#EA580C" strokeWidth={2 * (canvas.w / 1000)} strokeDasharray="6 4" />
                  ) : (
                    <polyline points={draft.map((p) => p.join(",")).join(" ")} fill="none" stroke="#EA580C" strokeWidth={2 * (canvas.w / 1000)} strokeDasharray="6 4" />
                  )}
                  {draft.map((p, i) => (
                    <circle key={i} cx={p[0]} cy={p[1]} r={(i === 0 && draft.length >= 3 ? 7 : 4) * (canvas.w / 1000)}
                      fill={i === 0 && draft.length >= 3 ? "#16A34A" : "#fff"} stroke="#EA580C" strokeWidth={2 * (canvas.w / 1000)} />
                  ))}
                </g>
              )}
            </svg>
          </div>
        </div>

        {/* Right panel */}
        <div className="w-96 bg-white border-l border-slate-200 flex flex-col z-20">
          {/* Totals */}
          <div className="grid grid-cols-3 gap-px bg-slate-200 border-b border-slate-200 shrink-0">
            {[["NET AREA", scale ? `${summary.totals.net_area}` : "—", "sf"], ["TILES", summary.totals.tiles_needed, "ea"], ["COST", `$${summary.totals.cost.toLocaleString()}`, ""]].map(([k, v, u]) => (
              <div key={k} className="bg-white p-3 text-center">
                <div className="text-[9px] font-mono uppercase tracking-widest text-slate-500">{k}</div>
                <div className="text-base font-black font-data text-slate-900 truncate">{v}<span className="text-[10px] text-slate-400 ml-0.5">{u}</span></div>
              </div>
            ))}
          </div>

          <Tabs value={tab} onValueChange={setTab} className="flex-1 flex flex-col min-h-0">
            <TabsList className="grid grid-cols-4 rounded-none bg-slate-100 border-b border-slate-200 h-9 shrink-0">
              <TabsTrigger value="measure" data-testid="tab-measure" className="text-xs rounded-none data-[state=active]:bg-white">Measure</TabsTrigger>
              <TabsTrigger value="tiles" data-testid="tab-tiles" className="text-xs rounded-none data-[state=active]:bg-white">Tile</TabsTrigger>
              <TabsTrigger value="ai" data-testid="tab-ai" className="text-xs rounded-none data-[state=active]:bg-white">AI</TabsTrigger>
              <TabsTrigger value="3d" data-testid="tab-3d" className="text-xs rounded-none data-[state=active]:bg-white">3D</TabsTrigger>
            </TabsList>

            {/* Measurements */}
            <TabsContent value="measure" className="flex-1 overflow-y-auto m-0 p-0">
              {measurements.length === 0 && <div className="p-6 text-center text-sm text-slate-400">Pick a tool and start measuring on the canvas.</div>}
              {measurements.map((m) => {
                const val = realValue(m, scale);
                return (
                  <div key={m.id} data-testid={`measurement-${m.id}`} className="px-4 py-2.5 border-b border-slate-100 flex items-center justify-between hover:bg-slate-50">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: m.color }} />
                      <div className="min-w-0">
                        <div className="text-sm font-bold truncate flex items-center gap-1">{m.label}{m.is_deduction && <span className="text-[9px] text-red-600 font-mono">DEDUCT</span>}</div>
                        <div className="text-[11px] font-mono text-slate-500">
                          {m.type === "count" ? `${m.count} ea` :
                            val != null ? `${val.toFixed(2)} ${AREA_TYPES.includes(m.type) ? "sf" : unit}` : `${m.type} · calibrate to size`}
                        </div>
                      </div>
                    </div>
                    <button onClick={() => deleteMeasurement(m.id)} className="text-slate-300 hover:text-red-600 shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                );
              })}
            </TabsContent>

            {/* Tiles */}
            <TabsContent value="tiles" className="flex-1 overflow-y-auto m-0 p-4 space-y-4">
              <div>
                <label className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Default Tile (all surfaces)</label>
                <select data-testid="default-tile-select" className={input + " mt-1"} value={takeoff.default_tile_id || ""} onChange={(e) => setDefaultTile(e.target.value)}>
                  <option value="">— none —</option>
                  {(tiles || []).map((t) => <option key={t.id} value={t.id}>{`${t.name} (${t.width}×${t.height})`}</option>)}
                </select>
                {defaultTile && (
                  <div className="mt-2 flex items-center gap-3 border border-slate-200 p-2 rounded-sm">
                    <div className="w-12 h-12 rounded-sm border border-slate-200" style={{ background: defaultTile.color }}>{defaultTile.image_url && <img src={defaultTile.image_url} alt="" className="w-full h-full object-cover" />}</div>
                    <div className="text-[11px] font-mono text-slate-600">
                      <div>{defaultTile.pattern} · {defaultTile.finish}</div>
                      <div>waste {Math.round(defaultTile.waste_factor * 100)}% · ${defaultTile.price_per_sqft}/sf</div>
                    </div>
                  </div>
                )}
              </div>
              <div className="space-y-2">
                <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Quantity Breakdown</div>
                {summary.lines.length === 0 && <div className="text-sm text-slate-400">Add measurements + assign a tile.</div>}
                {summary.lines.map((l, i) => (
                  <div key={i} className="border border-slate-200 rounded-sm p-2.5 text-xs font-mono">
                    <div className="font-bold text-sm font-sans">{l.tile_name}</div>
                    <div className="grid grid-cols-2 gap-1 mt-1 text-slate-600">
                      <span>Net: {l.net_area} sf</span><span>Waste: {l.waste_pct}%</span>
                      <span>Tiles: <b className="text-slate-900">{l.tiles_needed}</b></span><span>Boxes: <b className="text-slate-900">{l.boxes}</b></span>
                      <span className="col-span-2 text-orange-600 font-bold">Cost: ${l.cost.toLocaleString()}</span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="border-t border-slate-200 pt-3">
                <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2">Per-Surface Override</div>
                {measurements.filter((m) => AREA_TYPES.includes(m.type) && !m.is_deduction).map((m) => (
                  <div key={m.id} className="flex items-center gap-2 mb-1.5">
                    <span className="text-xs flex-1 truncate">{m.label}</span>
                    <select className={input + " w-40"} value={m.tile_id || ""} onChange={(e) => assignTile(m.id, e.target.value)}>
                      <option value="">default</option>
                      {(tiles || []).map((t) => <option key={t.id} value={t.id}>{String(t.name)}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            </TabsContent>

            {/* AI */}
            <TabsContent value="ai" className="flex-1 overflow-y-auto m-0 p-4">
              <button data-testid="run-ai-btn" onClick={runAI} disabled={aiLoading}
                className="w-full bg-orange-600 hover:bg-orange-700 disabled:opacity-60 text-white font-bold py-2.5 rounded-sm transition-colors inline-flex items-center justify-center gap-2 mb-4">
                <Sparkles className="w-4 h-4" /> {aiLoading ? "Analyzing drawing…" : "Run AI Takeoff Assist"}
              </button>
              {!takeoff.ai_suggestions && <p className="text-xs text-slate-400 text-center">AI detects tileable regions, openings, and a recommended waste allowance from an image drawing. Review & approve below.</p>}
              {takeoff.ai_suggestions && (
                <div className="space-y-3">
                  <div className="bg-orange-50 border border-orange-200 rounded-sm p-3 text-xs text-slate-700">{takeoff.ai_suggestions.summary}</div>
                  <div className="flex items-center justify-between text-[11px] font-mono uppercase tracking-wider text-slate-500">
                    <span>Recommended waste</span><span className="text-orange-600 font-bold text-sm">{takeoff.ai_suggestions.recommended_waste_pct}%</span>
                  </div>
                  <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Detected Regions</div>
                  {(takeoff.ai_suggestions.regions || []).map((r, i) => (
                    <div key={i} className="border border-slate-200 rounded-sm p-2.5" data-testid={`ai-region-${i}`}>
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-sm">{r.label}</span>
                        <span className="text-[11px] font-mono text-slate-500">{r.est_area_sqft} sf</span>
                      </div>
                      <div className="mt-1.5 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                        <div className="h-full bg-green-500" style={{ width: `${Math.round((r.confidence || 0) * 100)}%` }} />
                      </div>
                      <div className="text-[10px] font-mono text-slate-400 mt-1">confidence {Math.round((r.confidence || 0) * 100)}% · {r.notes}</div>
                    </div>
                  ))}
                  {(takeoff.ai_suggestions.openings || []).length > 0 && (
                    <>
                      <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Openings to Deduct</div>
                      {takeoff.ai_suggestions.openings.map((o, i) => (
                        <div key={i} className="flex justify-between text-xs font-mono border border-red-100 bg-red-50 rounded-sm px-2.5 py-1.5">
                          <span>{o.label}</span><span className="text-red-600">-{o.est_area_sqft} sf</span>
                        </div>
                      ))}
                    </>
                  )}
                  <p className="text-[10px] text-slate-400 italic">AI is assistive. Trace surfaces on the canvas to lock in approved quantities.</p>
                </div>
              )}
            </TabsContent>

            {/* 3D */}
            <TabsContent value="3d" className="flex-1 overflow-hidden m-0 p-0">
              <Preview3D tile={defaultTile} type={takeoff.type} />
            </TabsContent>
          </Tabs>

          {/* Email footer */}
          <div className="border-t border-slate-200 p-3 shrink-0">
            <button data-testid="email-report-btn" onClick={() => setEmailOpen(true)} className="w-full border border-slate-300 hover:border-slate-900 text-slate-800 font-bold py-2 rounded-sm transition-colors inline-flex items-center justify-center gap-2 text-sm">
              <Mail className="w-4 h-4" /> Email Report
            </button>
          </div>
        </div>
      </div>

      {/* Bottom status bar */}
      <div className="h-7 bg-white border-t border-slate-200 flex items-center px-4 text-[10px] font-mono text-slate-500 justify-between shrink-0">
        <span>{measurements.length} measurements · {hasImg ? `${canvas.w}×${canvas.h}px` : "blank canvas"}</span>
        <span>{scale ? `1px = ${scale.toFixed(4)} ${unit}` : "uncalibrated"} · zoom {Math.round(zoom * 100)}%</span>
      </div>

      {/* Calibration dialog */}
      <Dialog open={calibOpen} onOpenChange={setCalibOpen}>
        <DialogContent className="rounded-sm">
          <DialogHeader><DialogTitle className="font-black tracking-tight">Set Drawing Scale</DialogTitle></DialogHeader>
          <p className="text-sm text-slate-500">You drew a reference line of <b className="font-mono">{calibLine ? pathLength(calibLine).toFixed(0) : 0}px</b>. Enter its real-world length — trace along a known dimension on the plan (e.g. a labeled wall) for best accuracy.</p>
          <div className="flex items-end gap-2">
            <select className={input + " w-28"} value={calibForm.unit} onChange={(e) => setCalibForm({ ...calibForm, unit: e.target.value })}>
              <option value="ft">feet + in</option><option value="in">inches</option><option value="m">meters</option>
            </select>
            {calibForm.unit === "ft" ? (
              <>
                <div className="flex-1"><label className="text-[10px] font-mono uppercase tracking-wider text-slate-500">Feet</label>
                  <input data-testid="calib-length-input" type="number" className={input} placeholder="0" value={calibForm.feet} onChange={(e) => setCalibForm({ ...calibForm, feet: e.target.value })} /></div>
                <div className="flex-1"><label className="text-[10px] font-mono uppercase tracking-wider text-slate-500">Inches</label>
                  <input type="number" className={input} placeholder="0" value={calibForm.inches} onChange={(e) => setCalibForm({ ...calibForm, inches: e.target.value })} /></div>
              </>
            ) : (
              <div className="flex-1"><label className="text-[10px] font-mono uppercase tracking-wider text-slate-500">Length</label>
                <input data-testid="calib-length-input" type="number" className={input} placeholder="0" value={calibForm.feet} onChange={(e) => setCalibForm({ ...calibForm, feet: e.target.value })} /></div>
            )}
          </div>
          <DialogFooter><button data-testid="confirm-calib-btn" onClick={confirmCalibration} className="bg-orange-600 hover:bg-orange-700 text-white font-bold px-4 py-2 rounded-sm">Apply Scale</button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Email dialog */}
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

function MeasurementShape({ m, scale, unit }) {
  const sw = 2;
  const val = realValue(m, scale);
  const label = m.type === "count" ? `${m.count}` : (val != null ? `${val.toFixed(1)} ${AREA_TYPES.includes(m.type) ? "sf" : unit}` : "");
  if (m.type === "count") {
    const [x, y] = m.points[0];
    return (
      <g>
        <circle cx={x} cy={y} r={10} fill={m.color} />
        <text x={x} y={y + 4} textAnchor="middle" fontSize={12} fill="#fff" fontFamily="JetBrains Mono">{m.count}</text>
      </g>
    );
  }
  const isArea = AREA_TYPES.includes(m.type);
  const [cx, cy] = centroid(m.points);
  return (
    <g>
      {isArea ? (
        <polygon points={m.points.map((p) => p.join(",")).join(" ")} fill={m.color + "33"} stroke={m.color} strokeWidth={sw} />
      ) : (
        <polyline points={m.points.map((p) => p.join(",")).join(" ")} fill="none" stroke={m.color} strokeWidth={sw} />
      )}
      {m.points.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={3} fill="#fff" stroke={m.color} strokeWidth={1.5} />)}
      {label && <text x={cx} y={cy} textAnchor="middle" fontSize={11} fill={m.color} fontFamily="JetBrains Mono" stroke="#fff" strokeWidth={0.5} paintOrder="stroke">{label}</text>}
    </g>
  );
}

function Preview3D({ tile, type }) {
  const color = tile?.color || "#cbd5e1";
  const cells = Array.from({ length: 100 });
  const cols = 10;
  return (
    <div className="h-full bg-gradient-to-b from-slate-100 to-slate-300 flex items-center justify-center overflow-hidden relative">
      <div className="absolute top-3 left-3 text-[10px] font-mono uppercase tracking-widest text-slate-500">3D {type} preview</div>
      <div className={type === "wall" ? "tile-3d-wall" : "tile-3d-floor"}>
        <div className="grid gap-[2px] p-1 bg-slate-400/40" style={{ gridTemplateColumns: `repeat(${cols}, 36px)` }}>
          {cells.map((_, i) => (
            <div key={i} className="w-9 h-9 border border-white/30 shadow-sm" style={{ background: color, backgroundImage: tile?.image_url ? `url(${tile.image_url})` : "none", backgroundSize: "cover" }} />
          ))}
        </div>
      </div>
      {!tile && <div className="absolute bottom-4 text-xs text-slate-500 font-mono">Assign a default tile to preview the finish</div>}
    </div>
  );
}
