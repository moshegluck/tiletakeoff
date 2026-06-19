import React, { useEffect, useState } from "react";
import { api, apiErr, exportUrl, fileUrl } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { toast } from "sonner";
import { ChevronLeft, FolderOpen, FileText, LogOut, LayoutGrid, Ruler } from "lucide-react";

export default function MobileCompanion() {
  const { user, logout } = useAuth();
  const [view, setView] = useState("projects"); // projects | takeoffs | summary
  const [projects, setProjects] = useState([]);
  const [project, setProject] = useState(null);
  const [takeoffs, setTakeoffs] = useState([]);
  const [detail, setDetail] = useState(null); // {takeoff, drawing, summary}
  const [loading, setLoading] = useState(false);

  useEffect(() => { (async () => {
    try { const { data } = await api.get("/projects"); setProjects(data || []); }
    catch (e) { toast.error(apiErr(e)); }
  })(); }, []);

  const openProject = async (p) => {
    setLoading(true);
    try { const { data } = await api.get(`/projects/${p.id}`); setProject(data.project); setTakeoffs(data.takeoffs || []); setView("takeoffs"); }
    catch (e) { toast.error(apiErr(e)); } finally { setLoading(false); }
  };
  const openTakeoff = async (t) => {
    setLoading(true);
    try { const { data } = await api.get(`/takeoffs/${t.id}`); setDetail(data); setView("summary"); }
    catch (e) { toast.error(apiErr(e)); } finally { setLoading(false); }
  };

  const Header = ({ title, onBack }) => (
    <div className="sticky top-0 z-10 bg-slate-950 text-white flex items-center gap-2 px-3 h-14 shadow">
      {onBack ? <button data-testid="m-back" onClick={onBack} className="p-1.5 -ml-1.5"><ChevronLeft className="w-6 h-6" /></button>
        : <span className="w-8 h-8 rounded bg-orange-600 flex items-center justify-center font-black">T</span>}
      <div className="flex-1 min-w-0"><div className="font-black truncate">{title}</div><div className="text-[10px] font-mono text-slate-400 uppercase tracking-widest">TileTakeoff Field</div></div>
      <button data-testid="m-logout" onClick={logout} className="p-1.5 text-slate-300"><LogOut className="w-5 h-5" /></button>
    </div>
  );

  const t = detail?.summary?.totals;
  return (
    <div className="min-h-screen bg-slate-100 pb-10" data-testid="mobile-companion">
      {view === "projects" && (<>
        <Header title="Projects" />
        <div className="p-3 space-y-2" data-testid="m-projects">
          {projects.length === 0 && <div className="text-center text-slate-400 text-sm py-16">No projects yet.</div>}
          {projects.map((p) => (
            <button key={p.id} data-testid={`m-project-${p.id}`} onClick={() => openProject(p)}
              className="w-full bg-white rounded-lg border border-slate-200 p-4 flex items-center gap-3 active:bg-slate-50 text-left">
              <FolderOpen className="w-6 h-6 text-orange-600 shrink-0" />
              <div className="min-w-0 flex-1"><div className="font-bold truncate">{p.name}</div><div className="text-xs text-slate-500 truncate">{p.client || "—"} · {p.takeoff_count ?? 0} takeoffs</div></div>
            </button>
          ))}
        </div>
      </>)}

      {view === "takeoffs" && (<>
        <Header title={project?.name || "Project"} onBack={() => setView("projects")} />
        <div className="p-3 space-y-2" data-testid="m-takeoffs">
          {takeoffs.length === 0 && <div className="text-center text-slate-400 text-sm py-16">No takeoffs in this project.</div>}
          {takeoffs.map((tk) => (
            <button key={tk.id} data-testid={`m-takeoff-${tk.id}`} onClick={() => openTakeoff(tk)}
              className="w-full bg-white rounded-lg border border-slate-200 p-4 flex items-center gap-3 active:bg-slate-50 text-left">
              <LayoutGrid className="w-6 h-6 text-slate-700 shrink-0" />
              <div className="min-w-0 flex-1"><div className="font-bold truncate">{tk.name}</div><div className="text-xs text-slate-500 capitalize">{tk.type || "floor"} takeoff</div></div>
            </button>
          ))}
        </div>
      </>)}

      {view === "summary" && detail && (<>
        <Header title={detail.takeoff?.name || "Takeoff"} onBack={() => setView("takeoffs")} />
        <div className="p-3 space-y-3">
          {detail.drawing && (
            <div className="rounded-lg overflow-hidden border border-slate-200 bg-white">
              <img src={fileUrl(detail.drawing.id)} alt="plan" className="w-full max-h-56 object-contain bg-slate-50" onError={(e) => { e.target.style.display = "none"; }} />
            </div>
          )}
          <div className="grid grid-cols-3 gap-2" data-testid="m-totals">
            {[["NET AREA", t ? `${t.net_area}` : "—", "sf"], ["TILES", t?.tiles_needed ?? 0, "ea"], ["COST", `$${(t?.cost ?? 0).toLocaleString()}`, ""]].map(([k, v, u]) => (
              <div key={k} className="bg-white rounded-lg border border-slate-200 p-3 text-center"><div className="text-[9px] font-mono uppercase tracking-widest text-slate-500">{k}</div><div className="text-base font-black truncate">{v}<span className="text-[10px] text-slate-400">{u}</span></div></div>
            ))}
          </div>
          <div className="bg-white rounded-lg border border-slate-200 divide-y divide-slate-100" data-testid="m-breakdown">
            {(detail.summary?.lines || []).map((l, i) => (
              <div key={i} className="p-3">
                <div className="flex justify-between"><span className="font-bold text-sm">{l.tile_name}</span><span className="text-sm font-bold text-orange-600">${l.cost.toLocaleString()}</span></div>
                <div className="text-[11px] font-mono text-slate-500">{l.tile_size} · {l.pattern} · {l.net_area} sf · order {l.tiles_needed} · {l.true_waste_pct}% waste</div>
              </div>
            ))}
            {(detail.summary?.lines || []).length === 0 && <div className="p-4 text-sm text-slate-400 text-center">No measurements yet.</div>}
          </div>
          <a data-testid="m-export-pdf" href={exportUrl(detail.takeoff.id, "pdf")} target="_blank" rel="noreferrer"
            className="w-full bg-slate-900 text-white font-bold py-3 rounded-lg flex items-center justify-center gap-2"><FileText className="w-5 h-5" />Download PDF report</a>
          <a data-testid="m-open-studio" href={`/takeoff/${detail.takeoff.id}`}
            className="w-full border border-slate-300 text-slate-700 font-bold py-3 rounded-lg flex items-center justify-center gap-2"><Ruler className="w-5 h-5" />Open full studio</a>
        </div>
      </>)}
      {loading && <div className="fixed inset-0 bg-white/50 flex items-center justify-center text-slate-500 text-sm">Loading…</div>}
    </div>
  );
}
