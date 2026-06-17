import React, { useState, useRef } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import useSWR from "swr";
import { toast } from "sonner";
import { api, apiErr, fileUrl } from "@/lib/api";
import { Upload, FileText, Image as ImageIcon, Plus, ArrowLeft, Ruler, PencilRuler, Trash2, CheckCircle2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";

const fetcher = (url) => api.get(url).then((r) => r.data);
const input = "w-full bg-slate-50 border border-slate-300 rounded-sm px-3 py-2 text-sm font-mono focus:outline-none focus:border-orange-600 focus:ring-1 focus:ring-orange-600";

export default function ProjectDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, mutate } = useSWR(`/projects/${id}`, fetcher);
  const fileRef = useRef();
  const [uploading, setUploading] = useState(false);
  const [tkOpen, setTkOpen] = useState(false);
  const [tk, setTk] = useState({ name: "", type: "floor", drawing_id: "" });

  if (!data) return <div className="p-8 font-mono text-sm text-slate-400">Loading project…</div>;
  const { project, drawings, takeoffs } = data;

  const upload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    const fd = new FormData();
    fd.append("file", file);
    try {
      await api.post(`/projects/${id}/drawings`, fd, { headers: { "Content-Type": "multipart/form-data" } });
      toast.success("Drawing uploaded");
      mutate();
    } catch (err) { toast.error(apiErr(err)); }
    finally { setUploading(false); e.target.value = ""; }
  };

  const createTakeoff = async () => {
    if (!tk.name.trim()) return toast.error("Name required");
    try {
      const { data: created } = await api.post(`/projects/${id}/takeoffs`, tk);
      toast.success("Takeoff created");
      setTkOpen(false);
      navigate(`/takeoff/${created.id}`);
    } catch (e) { toast.error(apiErr(e)); }
  };

  const isImg = (d) => (d.content_type || "").startsWith("image");

  return (
    <div className="p-8 max-w-6xl">
      <Link to="/projects" className="inline-flex items-center gap-1 text-xs font-mono text-slate-500 hover:text-slate-900 mb-4"><ArrowLeft className="w-3 h-3" /> Projects</Link>
      <div className="flex items-end justify-between mb-8">
        <div>
          <div className="text-[11px] font-mono uppercase tracking-widest text-orange-600 mb-1">{project.status} · {project.client || "—"}</div>
          <h1 className="text-3xl font-black tracking-tight">{project.name}</h1>
          <p className="text-sm text-slate-500 mt-1">{project.address}</p>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Drawings */}
        <div className="border border-slate-200 bg-white">
          <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
            <h2 className="text-sm font-bold uppercase tracking-wider">Plan / Drawing Library</h2>
            <button data-testid="upload-drawing-btn" onClick={() => fileRef.current.click()} disabled={uploading}
              className="inline-flex items-center gap-1.5 text-xs font-bold bg-slate-900 hover:bg-slate-800 text-white px-3 py-1.5 rounded-sm transition-colors disabled:opacity-60">
              <Upload className="w-3.5 h-3.5" /> {uploading ? "Uploading…" : "Upload"}
            </button>
            <input ref={fileRef} type="file" accept="image/*,application/pdf" className="hidden" onChange={upload} data-testid="drawing-file-input" />
          </div>
          <div className="divide-y divide-slate-100">
            {drawings.length === 0 && <div className="px-5 py-10 text-center text-sm text-slate-400">No drawings. Upload a PDF or image plan.</div>}
            {drawings.map((d) => (
              <div key={d.id} className="flex items-center gap-3 px-5 py-3">
                <div className="w-12 h-12 border border-slate-200 rounded-sm overflow-hidden bg-slate-50 flex items-center justify-center shrink-0">
                  {isImg(d) ? <img src={fileUrl(d.id)} alt="" className="w-full h-full object-cover" /> : <FileText className="w-5 h-5 text-slate-400" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-bold truncate">{d.name}</div>
                  <div className="text-[11px] font-mono text-slate-500 flex items-center gap-2">
                    {isImg(d) ? <ImageIcon className="w-3 h-3" /> : <FileText className="w-3 h-3" />}
                    {(d.size / 1024).toFixed(0)} KB
                    {d.calibration?.scale ? <span className="text-green-600 inline-flex items-center gap-0.5"><CheckCircle2 className="w-3 h-3" /> calibrated</span> : <span className="text-amber-600">not calibrated</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Takeoffs */}
        <div className="border border-slate-200 bg-white">
          <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
            <h2 className="text-sm font-bold uppercase tracking-wider">Takeoff Sheets</h2>
            <Dialog open={tkOpen} onOpenChange={setTkOpen}>
              <DialogTrigger asChild>
                <button data-testid="create-takeoff-btn" className="inline-flex items-center gap-1.5 text-xs font-bold bg-orange-600 hover:bg-orange-700 text-white px-3 py-1.5 rounded-sm transition-colors">
                  <Plus className="w-3.5 h-3.5" /> New Takeoff
                </button>
              </DialogTrigger>
              <DialogContent className="rounded-sm">
                <DialogHeader><DialogTitle className="font-black tracking-tight">New Takeoff Sheet</DialogTitle></DialogHeader>
                <div className="space-y-3">
                  <input data-testid="takeoff-name-input" className={input} placeholder="e.g. Level 1 Floor Tile" value={tk.name} onChange={(e) => setTk({ ...tk, name: e.target.value })} />
                  <div className="grid grid-cols-2 gap-2">
                    {["floor", "wall"].map((t) => (
                      <button key={t} data-testid={`takeoff-type-${t}`} onClick={() => setTk({ ...tk, type: t })}
                        className={`py-2 text-sm font-bold rounded-sm border capitalize ${tk.type === t ? "bg-slate-900 text-white border-slate-900" : "border-slate-300 text-slate-600"}`}>
                        {t === "floor" ? "Floor" : "Wall Elevation"}
                      </button>
                    ))}
                  </div>
                  <select data-testid="takeoff-drawing-select" className={input} value={tk.drawing_id} onChange={(e) => setTk({ ...tk, drawing_id: e.target.value })}>
                    <option value="">Attach a drawing (optional)</option>
                    {drawings.map((d) => <option key={d.id} value={d.id}>{String(d.name)}</option>)}
                  </select>
                </div>
                <DialogFooter>
                  <button data-testid="save-takeoff-btn" onClick={createTakeoff} className="bg-orange-600 hover:bg-orange-700 text-white font-bold px-4 py-2 rounded-sm transition-colors">Open Studio</button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
          <div className="divide-y divide-slate-100">
            {takeoffs.length === 0 && <div className="px-5 py-10 text-center text-sm text-slate-400">No takeoffs yet.</div>}
            {takeoffs.map((t) => (
              <Link key={t.id} to={`/takeoff/${t.id}`} data-testid={`takeoff-row-${t.id}`} className="flex items-center justify-between px-5 py-3 hover:bg-slate-50 transition-colors">
                <div className="flex items-center gap-3">
                  {t.type === "floor" ? <Ruler className="w-4 h-4 text-orange-600" /> : <PencilRuler className="w-4 h-4 text-orange-600" />}
                  <div>
                    <div className="text-sm font-bold">{t.name}</div>
                    <div className="text-[11px] font-mono uppercase tracking-wider text-slate-500">{t.type} · {t.measurements?.length || 0} measurements</div>
                  </div>
                </div>
                <span className="text-xs font-bold text-orange-600">Open →</span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
