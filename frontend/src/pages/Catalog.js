import React, { useState, useRef } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { api, apiErr } from "@/lib/api";
import { Plus, Trash2, Grid3x3, Upload, Download } from "lucide-react";
import { TILE_SIZE_GROUPS, fmtSize } from "@/lib/tileSizes";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";

const fetcher = (url) => api.get(url).then((r) => r.data);
const input = "w-full bg-slate-50 border border-slate-300 rounded-sm px-3 py-2 text-sm font-mono focus:outline-none focus:border-orange-600 focus:ring-1 focus:ring-orange-600";
const PATTERNS = ["Grid", "Brick", "Herringbone", "Diagonal", "Basketweave"];
const FINISHES = ["Matte", "Polished", "Gloss", "Textured", "Honed"];
const CSV_TEMPLATE = "name,sku,manufacturer,distributor,collection,width,height,unit,finish,color,pattern,grout_spacing,waste_pct,price_per_sqft,box_coverage_sqft\nCalacatta Gold,CG-2448,Daltile,ProSource,Marble Look,24,48,in,Polished,#e9e6df,Grid,0.0625,12,8.50,16\nNordic Oak,NO-848,MSI,Floor & Decor,Wood Plank,8,48,in,Matte,#c9a36a,Herringbone,0.125,15,5.75,21\n";

const blank = { name: "", collection: "", width: 12, height: 12, unit: "in", finish: "Matte", color: "#cbd5e1", image_url: "", grout_spacing: 0.125, pattern: "Grid", waste_factor: 0.10, price_per_sqft: 0, box_coverage_sqft: 10 };

export default function Catalog() {
  const { data: tiles, mutate } = useSWR("/tiles", fetcher);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(blank);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef(null);
  const set = (k, num) => (e) => setForm({ ...form, [k]: num ? parseFloat(e.target.value) || 0 : e.target.value });

  const save = async () => {
    if (!form.name.trim()) return toast.error("Tile name required");
    try { await api.post("/tiles", form); toast.success("Tile added"); setOpen(false); setForm(blank); mutate(); }
    catch (e) { toast.error(apiErr(e)); }
  };
  const remove = async (id) => { try { await api.delete(`/tiles/${id}`); mutate(); } catch (e) { toast.error(apiErr(e)); } };

  const downloadTemplate = () => {
    const blob = new Blob([CSV_TEMPLATE], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "tile-catalog-template.csv"; a.click();
    URL.revokeObjectURL(url);
  };
  const onImportFile = async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    setImporting(true);
    try {
      const fd = new FormData(); fd.append("file", file);
      const { data } = await api.post("/tiles/import", fd, { headers: { "Content-Type": "multipart/form-data" } });
      toast.success(`Imported ${data.imported} tile${data.imported === 1 ? "" : "s"}${data.errors?.length ? ` · ${data.errors.length} skipped` : ""}`);
      mutate();
    } catch (err) { toast.error(apiErr(err)); }
    finally { setImporting(false); if (fileRef.current) fileRef.current.value = ""; }
  };

  return (
    <div className="p-8 max-w-6xl">
      <div className="flex items-end justify-between mb-8">
        <div>
          <div className="text-[11px] font-mono uppercase tracking-widest text-orange-600 mb-1">Layout Library</div>
          <h1 className="text-3xl font-black tracking-tight">Tile Catalog</h1>
        </div>
        <div className="flex items-center gap-2">
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" data-testid="csv-import-input" onChange={onImportFile} />
          <button data-testid="csv-template-btn" onClick={downloadTemplate} className="inline-flex items-center gap-2 border border-slate-300 hover:border-slate-900 text-slate-700 font-bold px-3 py-2.5 rounded-sm transition-colors text-sm"><Download className="w-4 h-4" /> Template</button>
          <button data-testid="csv-import-btn" disabled={importing} onClick={() => fileRef.current?.click()} className="inline-flex items-center gap-2 border border-slate-300 hover:border-slate-900 disabled:opacity-60 text-slate-700 font-bold px-3 py-2.5 rounded-sm transition-colors text-sm"><Upload className="w-4 h-4" /> {importing ? "Importing…" : "Import CSV"}</button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <button data-testid="add-tile-btn" className="inline-flex items-center gap-2 bg-orange-600 hover:bg-orange-700 text-white font-bold px-4 py-2.5 rounded-sm transition-colors"><Plus className="w-4 h-4" /> Add Tile</button>
            </DialogTrigger>
          <DialogContent className="rounded-sm max-w-lg max-h-[90vh] overflow-y-auto">
            <DialogHeader><DialogTitle className="font-black tracking-tight">Add Tile to Catalog</DialogTitle></DialogHeader>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2"><label className="text-xs font-bold uppercase tracking-wider text-slate-500">Name</label><input data-testid="tile-name-input" className={input} value={form.name} onChange={set("name")} /></div>
              <div className="col-span-2"><label className="text-xs font-bold uppercase tracking-wider text-slate-500">Collection</label><input className={input} value={form.collection} onChange={set("collection")} /></div>
              <div className="col-span-2">
                <label className="text-xs font-bold uppercase tracking-wider text-slate-500">Size Library — quick pick</label>
                <select data-testid="tile-size-preset" className={input}
                  onChange={(e) => { if (!e.target.value) return; const [w, h] = e.target.value.split("x").map(Number); setForm((f) => ({ ...f, width: w, height: h })); }}>
                  <option value="">— choose a standard size ({TILE_SIZE_GROUPS.reduce((a, g) => a + g.sizes.length, 0)} sizes) —</option>
                  {TILE_SIZE_GROUPS.map((g) => (
                    <optgroup key={g.category} label={g.category}>
                      {g.sizes.map(([w, h]) => <option key={`${w}x${h}`} value={`${w}x${h}`}>{fmtSize(w, h)}</option>)}
                    </optgroup>
                  ))}
                </select>
              </div>
              <div><label className="text-xs font-bold uppercase tracking-wider text-slate-500">Width (in)</label><input type="number" className={input} value={form.width} onChange={set("width", true)} /></div>
              <div><label className="text-xs font-bold uppercase tracking-wider text-slate-500">Height (in)</label><input type="number" className={input} value={form.height} onChange={set("height", true)} /></div>
              <div><label className="text-xs font-bold uppercase tracking-wider text-slate-500">Finish</label>
                <select className={input} value={form.finish} onChange={set("finish")}>{FINISHES.map((f) => <option key={f}>{f}</option>)}</select></div>
              <div><label className="text-xs font-bold uppercase tracking-wider text-slate-500">Pattern</label>
                <select className={input} value={form.pattern} onChange={set("pattern")}>{PATTERNS.map((p) => <option key={p}>{p}</option>)}</select></div>
              <div><label className="text-xs font-bold uppercase tracking-wider text-slate-500">Grout (in)</label><input type="number" step="0.0625" className={input} value={form.grout_spacing} onChange={set("grout_spacing", true)} /></div>
              <div><label className="text-xs font-bold uppercase tracking-wider text-slate-500">Waste %</label><input type="number" className={input} value={Math.round(form.waste_factor * 100)} onChange={(e) => setForm({ ...form, waste_factor: (parseFloat(e.target.value) || 0) / 100 })} /></div>
              <div><label className="text-xs font-bold uppercase tracking-wider text-slate-500">$/sqft</label><input type="number" step="0.01" className={input} value={form.price_per_sqft} onChange={set("price_per_sqft", true)} /></div>
              <div><label className="text-xs font-bold uppercase tracking-wider text-slate-500">Box coverage (sf)</label><input type="number" className={input} value={form.box_coverage_sqft} onChange={set("box_coverage_sqft", true)} /></div>
              <div className="flex items-end gap-2"><div className="flex-1"><label className="text-xs font-bold uppercase tracking-wider text-slate-500">Color</label><input type="color" className="w-full h-9 border border-slate-300 rounded-sm" value={form.color} onChange={set("color")} /></div></div>
              <div className="col-span-2"><label className="text-xs font-bold uppercase tracking-wider text-slate-500">Image URL (optional)</label><input className={input} value={form.image_url} onChange={set("image_url")} placeholder="https://…" /></div>
            </div>
            <DialogFooter><button data-testid="save-tile-btn" onClick={save} className="bg-orange-600 hover:bg-orange-700 text-white font-bold px-4 py-2 rounded-sm transition-colors">Add Tile</button></DialogFooter>
          </DialogContent>
        </Dialog>
        </div>
      </div>

      {tiles?.length === 0 && <div className="border border-dashed border-slate-300 rounded-sm py-20 text-center"><Grid3x3 className="w-10 h-10 text-slate-300 mx-auto mb-3" /><p className="text-slate-500">No tiles yet.</p></div>}

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {(tiles || []).map((t) => (
          <div key={t.id} data-testid={`tile-card-${t.id}`} className="border border-slate-200 bg-white rounded-sm overflow-hidden group">
            <div className="aspect-square relative overflow-hidden" style={{ background: t.color }}>
              {t.image_url && <img src={t.image_url} alt={t.name} className="w-full h-full object-cover" onError={(e) => { e.target.style.display = "none"; }} />}
              <button onClick={() => remove(t.id)} className="absolute top-2 right-2 w-7 h-7 bg-white/90 hover:bg-red-600 hover:text-white rounded-sm flex items-center justify-center opacity-0 group-hover:opacity-100 transition"><Trash2 className="w-3.5 h-3.5" /></button>
              <div className="absolute bottom-2 left-2 bg-slate-950/80 text-white text-[10px] font-mono px-2 py-0.5 rounded-sm">{t.width}×{t.height} {t.unit}</div>
            </div>
            <div className="p-3">
              <div className="font-bold text-sm truncate">{t.name}</div>
              <div className="text-[11px] font-mono text-slate-500 truncate">{t.collection || "—"}</div>
              {(t.sku || t.manufacturer) && <div className="text-[10px] font-mono text-slate-400 truncate" data-testid={`tile-sku-${t.id}`}>{[t.manufacturer, t.sku].filter(Boolean).join(" · ")}</div>}
              <div className="flex justify-between mt-2 text-[11px] font-mono">
                <span className="text-slate-500">{t.pattern} · {t.finish}</span>
                <span className="font-bold text-orange-600">${t.price_per_sqft?.toFixed(2)}</span>
              </div>
              <div className="text-[10px] font-mono text-slate-400 mt-1">waste {Math.round((t.waste_factor || 0) * 100)}% · grout {t.grout_spacing}"</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
