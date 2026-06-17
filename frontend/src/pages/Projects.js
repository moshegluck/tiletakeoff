import React, { useState } from "react";
import { Link } from "react-router-dom";
import useSWR from "swr";
import { toast } from "sonner";
import { api, apiErr } from "@/lib/api";
import { Plus, FolderKanban, Trash2, FileStack, Map } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from "@/components/ui/dialog";

const fetcher = (url) => api.get(url).then((r) => r.data);
const input = "w-full bg-slate-50 border border-slate-300 rounded-sm px-3 py-2 text-sm font-mono focus:outline-none focus:border-orange-600 focus:ring-1 focus:ring-orange-600";

export default function Projects() {
  const { data: projects, mutate } = useSWR("/projects", fetcher);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", client: "", address: "", notes: "" });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const create = async () => {
    if (!form.name.trim()) return toast.error("Project name required");
    try {
      await api.post("/projects", form);
      toast.success("Project created");
      setOpen(false); setForm({ name: "", client: "", address: "", notes: "" });
      mutate();
    } catch (e) { toast.error(apiErr(e)); }
  };

  const remove = async (id) => {
    try { await api.delete(`/projects/${id}`); mutate(); toast.success("Deleted"); }
    catch (e) { toast.error(apiErr(e)); }
  };

  return (
    <div className="p-8 max-w-6xl">
      <div className="flex items-end justify-between mb-8">
        <div>
          <div className="text-[11px] font-mono uppercase tracking-widest text-orange-600 mb-1">Project Library</div>
          <h1 className="text-3xl font-black tracking-tight">Projects</h1>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <button data-testid="create-project-btn" className="inline-flex items-center gap-2 bg-orange-600 hover:bg-orange-700 text-white font-bold px-4 py-2.5 rounded-sm transition-colors">
              <Plus className="w-4 h-4" /> New Project
            </button>
          </DialogTrigger>
          <DialogContent className="rounded-sm">
            <DialogHeader><DialogTitle className="font-black tracking-tight">New Project</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <input data-testid="project-name-input" className={input} placeholder="Project name" value={form.name} onChange={set("name")} />
              <input data-testid="project-client-input" className={input} placeholder="Client" value={form.client} onChange={set("client")} />
              <input className={input} placeholder="Address" value={form.address} onChange={set("address")} />
              <textarea className={input} placeholder="Notes" rows={2} value={form.notes} onChange={set("notes")} />
            </div>
            <DialogFooter>
              <button data-testid="save-project-btn" onClick={create} className="bg-orange-600 hover:bg-orange-700 text-white font-bold px-4 py-2 rounded-sm transition-colors">Create Project</button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {projects?.length === 0 && (
        <div className="border border-dashed border-slate-300 rounded-sm py-20 text-center">
          <FolderKanban className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-500">No projects yet. Create your first project to start a takeoff.</p>
        </div>
      )}

      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
        {(projects || []).map((p) => (
          <div key={p.id} data-testid={`project-card-${p.id}`} className="border border-slate-200 bg-white rounded-sm hover:border-slate-900 transition-colors group">
            <Link to={`/projects/${p.id}`} className="block p-5">
              <div className="flex items-start justify-between">
                <FolderKanban className="w-6 h-6 text-orange-600" strokeWidth={1.5} />
                <span className="text-[10px] font-mono uppercase tracking-widest text-slate-400 border border-slate-200 px-2 py-0.5">{p.status}</span>
              </div>
              <h3 className="font-bold text-lg mt-4">{p.name}</h3>
              <p className="text-xs text-slate-500 font-mono mt-1">{p.client || "—"}</p>
              <p className="text-xs text-slate-400 mt-0.5 flex items-center gap-1"><Map className="w-3 h-3" />{p.address || "No address"}</p>
              <div className="flex gap-4 mt-4 pt-4 border-t border-slate-100 text-xs font-mono text-slate-500">
                <span>{p.drawing_count} plans</span>
                <span className="flex items-center gap-1"><FileStack className="w-3 h-3" /> {p.takeoff_count} takeoffs</span>
              </div>
            </Link>
            <div className="px-5 pb-4">
              <button onClick={() => remove(p.id)} className="text-xs text-slate-400 hover:text-red-600 inline-flex items-center gap-1"><Trash2 className="w-3 h-3" /> Delete</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
