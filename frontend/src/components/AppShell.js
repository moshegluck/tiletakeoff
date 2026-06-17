import React from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { LayoutDashboard, FolderKanban, Grid3x3, Users, LogOut, Layers } from "lucide-react";
import { useAuth } from "@/context/AuthContext";

const NAV = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard, tid: "nav-dashboard" },
  { to: "/projects", label: "Projects", icon: FolderKanban, tid: "nav-projects" },
  { to: "/catalog", label: "Tile Catalog", icon: Grid3x3, tid: "nav-catalog" },
  { to: "/team", label: "Team", icon: Users, tid: "nav-team" },
];

export default function AppShell({ children }) {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <div className="min-h-screen flex bg-slate-50">
      <aside className="w-60 bg-slate-950 text-slate-300 flex flex-col fixed h-screen z-30 border-r border-slate-800">
        <div className="h-16 flex items-center gap-2 px-5 border-b border-slate-800">
          <div className="w-8 h-8 bg-orange-600 flex items-center justify-center rounded-sm">
            <Layers className="w-5 h-5 text-white" strokeWidth={2} />
          </div>
          <div className="leading-none">
            <div className="text-white font-black tracking-tight">TileTakeoff</div>
            <div className="text-[10px] font-mono uppercase tracking-widest text-orange-500">Estimating Studio</div>
          </div>
        </div>
        <nav className="flex-1 py-4">
          {NAV.map((n) => {
            const active = location.pathname.startsWith(n.to);
            const Icon = n.icon;
            return (
              <Link key={n.to} to={n.to} data-testid={n.tid}
                className={`flex items-center gap-3 px-5 py-2.5 text-sm font-medium transition-colors ${
                  active ? "bg-orange-600 text-white" : "text-slate-400 hover:text-white hover:bg-slate-900"
                }`}>
                <Icon className="w-4 h-4" strokeWidth={1.75} />
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-slate-800 p-4">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-8 h-8 rounded-sm bg-slate-800 flex items-center justify-center text-orange-500 font-bold text-sm">
              {(user?.name || "U")[0].toUpperCase()}
            </div>
            <div className="min-w-0">
              <div className="text-sm text-white truncate">{user?.name}</div>
              <div className="text-[10px] font-mono uppercase tracking-wider text-slate-500">{user?.role}</div>
            </div>
          </div>
          <button data-testid="logout-btn" onClick={async () => { await logout(); navigate("/login"); }}
            className="w-full flex items-center justify-center gap-2 text-xs font-bold text-slate-400 hover:text-white border border-slate-800 hover:border-slate-600 py-2 rounded-sm transition-colors">
            <LogOut className="w-3.5 h-3.5" /> Sign Out
          </button>
        </div>
      </aside>
      <main className="flex-1 ml-60 min-h-screen">{children}</main>
    </div>
  );
}
