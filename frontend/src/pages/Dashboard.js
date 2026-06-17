import React from "react";
import { Link } from "react-router-dom";
import useSWR from "swr";
import { api } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { FolderKanban, Grid3x3, Users, FileStack, Plus, ArrowRight } from "lucide-react";

const fetcher = (url) => api.get(url).then((r) => r.data);

export default function Dashboard() {
  const { user } = useAuth();
  const { data: projects } = useSWR("/projects", fetcher);
  const { data: tiles } = useSWR("/tiles", fetcher);
  const { data: ws } = useSWR("/workspace", fetcher);

  const totalDrawings = (projects || []).reduce((a, p) => a + (p.drawing_count || 0), 0);
  const totalTakeoffs = (projects || []).reduce((a, p) => a + (p.takeoff_count || 0), 0);

  const stats = [
    { label: "Projects", value: projects?.length ?? "–", icon: FolderKanban, to: "/projects" },
    { label: "Takeoff Sheets", value: totalTakeoffs, icon: FileStack, to: "/projects" },
    { label: "Catalog Tiles", value: tiles?.length ?? "–", icon: Grid3x3, to: "/catalog" },
    { label: "Team Members", value: ws?.members?.length ?? "–", icon: Users, to: "/team" },
  ];

  return (
    <div className="p-8 max-w-6xl">
      <div className="flex items-end justify-between mb-8">
        <div>
          <div className="text-[11px] font-mono uppercase tracking-widest text-orange-600 mb-1">{ws?.workspace?.name || "Workspace"}</div>
          <h1 className="text-3xl font-black tracking-tight">Welcome back, {user?.name?.split(" ")[0]}.</h1>
        </div>
        <Link to="/projects" data-testid="dashboard-new-project" className="inline-flex items-center gap-2 bg-orange-600 hover:bg-orange-700 text-white font-bold px-4 py-2.5 rounded-sm transition-colors">
          <Plus className="w-4 h-4" /> New Project
        </Link>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-slate-200 border border-slate-200 mb-10">
        {stats.map((s) => {
          const Icon = s.icon;
          return (
            <Link key={s.label} to={s.to} className="bg-white p-6 hover:bg-orange-50 transition-colors group">
              <Icon className="w-5 h-5 text-orange-600 mb-3" strokeWidth={1.5} />
              <div className="text-3xl font-black font-data text-slate-900">{s.value}</div>
              <div className="text-[11px] font-mono uppercase tracking-widest text-slate-500 mt-1">{s.label}</div>
            </Link>
          );
        })}
      </div>

      <div className="border border-slate-200 bg-white">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
          <h2 className="text-sm font-bold uppercase tracking-wider">Recent Projects</h2>
          <Link to="/projects" className="text-xs font-bold text-orange-600 inline-flex items-center gap-1">View all <ArrowRight className="w-3 h-3" /></Link>
        </div>
        {(projects || []).slice(0, 6).map((p) => (
          <Link key={p.id} to={`/projects/${p.id}`} className="flex items-center justify-between px-5 py-3 border-b border-slate-100 last:border-0 hover:bg-slate-50 transition-colors">
            <div>
              <div className="font-bold text-sm">{p.name}</div>
              <div className="text-xs text-slate-500 font-mono">{p.client || "—"} · {p.address || "no address"}</div>
            </div>
            <div className="flex gap-6 text-xs font-mono text-slate-500">
              <span>{p.drawing_count} plans</span>
              <span>{p.takeoff_count} takeoffs</span>
            </div>
          </Link>
        ))}
        {projects?.length === 0 && (
          <div className="px-5 py-12 text-center text-sm text-slate-400">No projects yet. Create your first one.</div>
        )}
      </div>
    </div>
  );
}
