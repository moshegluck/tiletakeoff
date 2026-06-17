import React from "react";
import { Link } from "react-router-dom";
import { Layers, Ruler, Grid3x3, Sparkles, FileSpreadsheet, Box, ArrowRight, Check } from "lucide-react";

const HERO_IMG = "https://images.unsplash.com/photo-1721244654392-9c912a6eb236?crop=entropy&cs=srgb&fm=jpg&q=85&w=1600";
const TAKEOFF_IMG = "https://images.unsplash.com/photo-1503387762-592deb58ef4e?crop=entropy&cs=srgb&fm=jpg&q=85&w=1200";
const MOBILE_IMG = "https://images.unsplash.com/photo-1778074762022-c33cc42f79ae?crop=entropy&cs=srgb&fm=jpg&q=85&w=1200";

const FEATURES = [
  { icon: Ruler, title: "Precision Measurement", desc: "Area, linear, perimeter, count, polygon room tracing, and wall elevations on calibrated plans." },
  { icon: Grid3x3, title: "Tile-First Catalog", desc: "Collections, sizes, finishes, grout spacing, pattern presets and waste-factor rules built in." },
  { icon: Sparkles, title: "AI Quantity Assist", desc: "Detect tileable regions and openings, suggest quantities, then review, correct and approve." },
  { icon: Box, title: "2D + 3D Preview", desc: "Bluebeam-style canvas with a live 3D floor and wall finish layout preview." },
  { icon: FileSpreadsheet, title: "Pro Exports", desc: "Excel, PDF and CSV material summaries — emailed straight to clients and crews." },
  { icon: Layers, title: "Workspace Control", desc: "Company workspaces with admin / estimator / viewer roles and a shared plan library." },
];

export default function Landing() {
  return (
    <div className="min-h-screen bg-white text-slate-900 font-sans">
      <header className="fixed top-0 inset-x-0 z-50 bg-slate-950/90 backdrop-blur border-b border-slate-800">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-orange-600 flex items-center justify-center rounded-sm">
              <Layers className="w-5 h-5 text-white" />
            </div>
            <span className="text-white font-black tracking-tight text-lg">TileTakeoff</span>
          </div>
          <div className="flex items-center gap-3">
            <Link to="/login" data-testid="header-login" className="text-sm font-bold text-slate-300 hover:text-white px-4 py-2">Sign In</Link>
            <Link to="/register" data-testid="header-signup" className="text-sm font-bold bg-orange-600 hover:bg-orange-700 text-white px-4 py-2 rounded-sm transition-colors">Start Free</Link>
          </div>
        </div>
      </header>

      {/* HERO */}
      <section className="relative pt-16 bg-slate-950 text-white overflow-hidden">
        <div className="absolute inset-0 opacity-25">
          <img src={HERO_IMG} alt="blueprint" className="w-full h-full object-cover" />
        </div>
        <div className="absolute inset-0 bg-gradient-to-r from-slate-950 via-slate-950/85 to-transparent" />
        <div className="relative max-w-7xl mx-auto px-6 py-28 grid lg:grid-cols-12 gap-10 items-center">
          <div className="lg:col-span-7 anim-rise">
            <div className="inline-flex items-center gap-2 border border-orange-600/50 bg-orange-600/10 text-orange-400 text-[11px] font-mono uppercase tracking-widest px-3 py-1.5 rounded-sm mb-6">
              <span className="w-1.5 h-1.5 bg-orange-500 rounded-full" /> Tile takeoff & estimating platform
            </div>
            <h1 className="text-5xl sm:text-6xl font-black tracking-tighter leading-[0.95]">
              Measure plans.<br />Quantify tile.<br /><span className="text-orange-500">Win the bid.</span>
            </h1>
            <p className="mt-6 text-lg text-slate-300 max-w-xl leading-relaxed">
              The takeoff studio built specifically for tile contractors and estimators — upload drawings, measure floors and walls, apply layouts, and export precise material reports.
            </p>
            <div className="mt-8 flex flex-wrap gap-4">
              <Link to="/register" data-testid="hero-cta" className="inline-flex items-center gap-2 bg-orange-600 hover:bg-orange-700 text-white font-bold px-6 py-3 rounded-sm transition-colors">
                Start estimating <ArrowRight className="w-4 h-4" />
              </Link>
              <Link to="/login" className="inline-flex items-center gap-2 border border-slate-700 hover:border-slate-500 text-white font-bold px-6 py-3 rounded-sm transition-colors">
                Sign in
              </Link>
            </div>
            <div className="mt-10 flex flex-wrap gap-6 text-sm text-slate-400 font-mono">
              {["AI-assisted", "Excel / PDF / CSV", "3D finish preview"].map((t) => (
                <span key={t} className="inline-flex items-center gap-2"><Check className="w-4 h-4 text-orange-500" /> {t}</span>
              ))}
            </div>
          </div>
          <div className="lg:col-span-5 anim-rise">
            <div className="border border-slate-800 bg-slate-900/60 rounded-sm overflow-hidden shadow-2xl">
              <img src={TAKEOFF_IMG} alt="takeoff" className="w-full h-72 object-cover" />
              <div className="p-4 grid grid-cols-3 gap-px bg-slate-800">
                {[["AREA", "1,248 sf"], ["TILES", "2,140"], ["WASTE", "10%"]].map(([k, v]) => (
                  <div key={k} className="bg-slate-900 p-3 text-center">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">{k}</div>
                    <div className="text-lg font-black text-orange-500 font-data">{v}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* FEATURES */}
      <section className="max-w-7xl mx-auto px-6 py-24">
        <div className="max-w-2xl">
          <div className="text-[11px] font-mono uppercase tracking-widest text-orange-600 mb-3">The toolkit</div>
          <h2 className="text-3xl sm:text-4xl font-black tracking-tight">Everything an estimating crew needs, nothing it doesn't.</h2>
        </div>
        <div className="grid md:grid-cols-3 gap-px bg-slate-200 border border-slate-200 mt-12">
          {FEATURES.map((f) => {
            const Icon = f.icon;
            return (
              <div key={f.title} className="bg-white p-8 hover:bg-orange-50 transition-colors group">
                <Icon className="w-7 h-7 text-orange-600 mb-5" strokeWidth={1.5} />
                <h3 className="text-lg font-bold mb-2">{f.title}</h3>
                <p className="text-sm text-slate-600 leading-relaxed">{f.desc}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* MOBILE / FIELD */}
      <section className="bg-slate-950 text-white">
        <div className="max-w-7xl mx-auto px-6 py-24 grid lg:grid-cols-2 gap-12 items-center">
          <div>
            <div className="text-[11px] font-mono uppercase tracking-widest text-orange-500 mb-3">Field companion</div>
            <h2 className="text-3xl sm:text-4xl font-black tracking-tight">From the office to the jobsite.</h2>
            <p className="mt-5 text-slate-300 leading-relaxed max-w-lg">
              Review plans, check quantities and access project assets from the field. The web studio handles the heavy takeoff work; the companion keeps your crew aligned.
            </p>
            <Link to="/register" className="mt-8 inline-flex items-center gap-2 bg-orange-600 hover:bg-orange-700 text-white font-bold px-6 py-3 rounded-sm transition-colors">
              Create your workspace <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
          <div className="border border-slate-800 rounded-sm overflow-hidden">
            <img src={MOBILE_IMG} alt="field" className="w-full h-80 object-cover" />
          </div>
        </div>
      </section>

      <footer className="bg-slate-950 border-t border-slate-800 text-slate-500 text-xs font-mono py-8 text-center">
        © {new Date().getFullYear()} TileTakeoff — Tile estimating & takeoff platform.
      </footer>
    </div>
  );
}
