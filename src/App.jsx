import React, { useState, useEffect, lazy, Suspense } from 'react';
import { useStore } from './state/store.js';
import Canvas2D from './components/Canvas2D.jsx';
import { Panels } from './components/Panels.jsx';
import DetectModal from './components/DetectModal.jsx';
import AccountBar from './components/AccountBar.jsx';
import { UNIT_SYSTEMS } from './engine/units.js';
import { exportCSV } from './lib/export.js';
import { polygonArea } from './engine/geometry.js';

const Viewer3D = lazy(() => import('./components/Viewer3D.jsx'));

const TOOLS = [
  { id: 'select',    key: 'V', label: 'Select',   icon: 'M3 3l7.5 18 2.5-7.5L20.5 11z' },
  { id: 'room',      key: 'R', label: 'Rectangle', icon: 'M3 3h18v18H3z', sep: true },
  { id: 'polygon',   key: 'P', label: 'Polygon',   icon: 'M12 2l9 6-3 11H6L3 8z' },
  { id: 'ruler',     key: 'L', label: 'Scale',     icon: 'M2 8l6-6 14 14-6 6zM8 8l2 2M11 5l2 2M5 11l2 2', sep: true },
  { id: 'grid',      key: 'G', label: 'Grid',      icon: 'M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18' },
  { id: 'mk_length', key: 'M', label: 'Measure',   icon: 'M3 17L17 3M7 5l2 2M5 9l2 2M9 9l2 2M11 13l2 2', sep: true },
  { id: 'mk_area',   key: 'A', label: 'Meas Area', icon: 'M3 3h18v18H3zM3 3l18 18' },
  { id: 'mk_rect',   key: 'B', label: 'Meas Box',  icon: 'M4 6h16v12H4z' },
  { id: 'mk_count',  key: 'C', label: 'Count',     icon: 'M12 5v14M5 12h14' },
];

export default function App() {
  const s = useStore();
  const [detect, setDetect]       = useState(false);
  const [toast, setToast]         = useState(null);
  const [pdfBusy, setPdfBusy]     = useState(false);
  const [panelOpen, setPanelOpen] = useState(false); // mobile panel sheet

  // close sheet when switching to canvas tab on mobile
  function openPanel() { setPanelOpen(true); }
  function closePanel() { setPanelOpen(false); }

  async function loadPdfPage(page) {
    const doc = useStore.getState().pdfDoc;
    if (!doc) return;
    setPdfBusy(true);
    try {
      const { renderPage } = await import('./lib/pdf.js');
      const out = await renderPage(doc, page, 2000);
      s.setPlanImage(out.dataUrl, out.width, out.height);
      s.setPdfPage(page);
      setTimeout(() => window.dispatchEvent(new Event('tt:fit')), 60);
    } catch (e) {
      window.dispatchEvent(new CustomEvent('tt:toast', { detail: { msg: 'PDF render failed: ' + e.message } }));
    } finally { setPdfBusy(false); }
  }

  async function onPdfPick(e) {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    setPdfBusy(true);
    try {
      const { loadPdf } = await import('./lib/pdf.js');
      const { doc, numPages } = await loadPdf(file);
      s.setPdf(doc, numPages);
      const { renderPage } = await import('./lib/pdf.js');
      const out = await renderPage(doc, 1, 2000);
      s.setPlanImage(out.dataUrl, out.width, out.height);
      window.dispatchEvent(new CustomEvent('tt:toast', { detail: { msg: `PDF loaded · ${numPages} page${numPages > 1 ? 's' : ''}. Calibrate scale with the ruler.`, ok: true } }));
      setTimeout(() => window.dispatchEvent(new Event('tt:fit')), 60);
    } catch (err) {
      window.dispatchEvent(new CustomEvent('tt:toast', { detail: { msg: 'Could not open PDF: ' + err.message } }));
    } finally { setPdfBusy(false); }
  }

  useEffect(() => {
    const onToast = (e) => { setToast(e.detail); setTimeout(() => setToast(null), 2200); };
    window.addEventListener('tt:toast', onToast);
    const onKey = (e) => {
      if (/input|select|textarea/i.test(e.target.tagName)) return;
      const k = e.key.toLowerCase();
      const t = TOOLS.find((t) => t.key.toLowerCase() === k);
      if (t) s.setTool(t.id);
      else if (k === 'f') window.dispatchEvent(new Event('tt:fit'));
      else if (k === 'delete' || k === 'backspace') {
        if (s.selection.type === 'room')     s.deleteRoom(s.selection.id);
        else if (s.selection.type === 'material') s.deleteMaterial(s.selection.id);
        else if (s.selection.type === 'markup')   s.deleteMarkup(s.selection.id);
      } else if (k === 'escape') { s.setTool('select'); s.select(null, null); }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('tt:toast', onToast);
      window.removeEventListener('keydown', onKey);
    };
  }, [s]);

  const totalSf = s.rooms.reduce((a, r) => a + (s.scale ? polygonArea(r.points) : 0), 0);

  return (
    <div className="app">
      {/* ── HEADER ── */}
      <header className="top">
        <div className="brand">
          <svg viewBox="0 0 32 32">
            <rect x="2"  y="2"  width="13" height="13" rx="2" fill="#0f2f47" />
            <rect x="17" y="2"  width="13" height="13" rx="2" fill="#c8521f" />
            <rect x="2"  y="17" width="13" height="13" rx="2" fill="#c8521f" />
            <rect x="17" y="17" width="13" height="13" rx="2" fill="#0f2f47" />
          </svg>
          <b>Tile<span>Takeoff</span></b>
        </div>

        <input
          className="docname"
          value={s.name}
          maxLength={60}
          onChange={(e) => s.setName(e.target.value)}
        />

        <select className="unit-sel" value={s.unitSystem} onChange={(e) => s.setUnitSystem(e.target.value)}>
          {Object.values(UNIT_SYSTEMS).map((u) => (
            <option key={u.id} value={u.id}>{u.label}</option>
          ))}
        </select>

        <div className="spacer" />
        <AccountBar />

        <label className="tbtn" style={{ cursor: 'pointer' }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M6 2h9l5 5v15H6zM15 2v5h5"/><path d="M9 13h6M9 17h4"/>
          </svg>
          <span className="tbtn-label">PDF</span>
          <input type="file" accept="application/pdf" style={{ display: 'none' }} onChange={onPdfPick} />
        </label>

        <button className="tbtn" onClick={() => setDetect(true)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l2.5 2.5M16.5 16.5L19 19M19 5l-2.5 2.5M7.5 16.5L5 19"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
          <span className="tbtn-label">AI Detect</span>
        </button>

        <button className={'tbtn' + (s.view3d ? ' on' : '')} onClick={() => s.toggle3d()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 2l9 5v10l-9 5-9-5V7z M3 7l9 5 9-5 M12 12v10"/>
          </svg>
          <span className="tbtn-label">{s.view3d ? '2D' : '3D'}</span>
        </button>

        <button className="tbtn" onClick={() => exportCSV(s)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
          </svg>
          <span className="tbtn-label">Export</span>
        </button>

        <button className="tbtn primary" onClick={() => {
          if (confirm('Start a new takeoff? Current work is saved in this browser.')) s.newProject();
        }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 5v14M5 12h14"/>
          </svg>
          <span className="tbtn-label">New</span>
        </button>
      </header>

      {/* ── MAIN ── */}
      <main>
        {/* Left toolbar */}
        <nav className="toolbar">
          {TOOLS.map((t) => (
            <React.Fragment key={t.id}>
              {t.sep && <div className="toolsep" />}
              <button
                className={'tool' + (s.tool === t.id ? ' active' : '')}
                onClick={() => s.setTool(t.id)}
                title={t.label}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round">
                  <path d={t.icon} />
                </svg>
                <span className="tip">{t.label}<kbd>{t.key}</kbd></span>
              </button>
            </React.Fragment>
          ))}
        </nav>

        {/* Canvas / 3D */}
        {s.view3d ? (
          <Suspense fallback={<div className="stage" style={{ display: 'grid', placeItems: 'center', color: '#8b97a3' }}>Loading 3D…</div>}>
            <Viewer3D />
          </Suspense>
        ) : (
          <StageWrap totalSf={totalSf} onPdfPage={loadPdfPage} pdfBusy={pdfBusy} />
        )}

        {/* Right panel — desktop always visible, mobile slides up */}
        <aside className={'right' + (panelOpen ? ' open' : '')}>
          <div className="tabs">
            {[['rooms','Rooms',s.rooms.length],['materials','Materials',s.materials.length],['markups','Markups',s.markups.length],['estimate','Estimate',null]].map(([id,label,ct]) => (
              <button
                key={id}
                className={'tab' + (s.tab === id ? ' active' : '')}
                onClick={() => { s.setTab(id); openPanel(); }}
              >
                {label}{ct != null && <span className="ct">{ct}</span>}
              </button>
            ))}
          </div>
          <Panels />
        </aside>
      </main>

      {/* ── MOBILE BOTTOM NAV ── */}
      <nav className="mobile-nav">
        {/* Canvas */}
        <button className={!panelOpen ? 'active' : ''} onClick={closePanel}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <path d="M3 9h18M9 3v18"/>
          </svg>
          Canvas
        </button>

        {/* Rooms */}
        <button className={panelOpen && s.tab==='rooms' ? 'active' : ''} onClick={() => { s.setTab('rooms'); openPanel(); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
            <polyline points="9 22 9 12 15 12 15 22"/>
          </svg>
          Rooms
          {s.rooms.length > 0 && <span style={{fontSize:'9px',fontWeight:700,color:'var(--accent)'}}>{s.rooms.length}</span>}
        </button>

        {/* Materials */}
        <button className={panelOpen && s.tab==='materials' ? 'active' : ''} onClick={() => { s.setTab('materials'); openPanel(); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="2" y="2" width="9" height="9"/><rect x="13" y="2" width="9" height="9"/>
            <rect x="2" y="13" width="9" height="9"/><rect x="13" y="13" width="9" height="9"/>
          </svg>
          Materials
        </button>

        {/* Estimate */}
        <button className={panelOpen && s.tab==='estimate' ? 'active' : ''} onClick={() => { s.setTab('estimate'); openPanel(); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
            <polyline points="10 9 9 9 8 9"/>
          </svg>
          Estimate
        </button>
      </nav>

      {detect && <DetectModal onClose={() => setDetect(false)} />}
      {toast && <div className={'toast show' + (toast.ok ? ' ok' : '')}>{toast.ok && <b>✓ </b>}{toast.msg}</div>}
    </div>
  );
}

function StageWrap({ totalSf, onPdfPage, pdfBusy }) {
  const s = useStore();
  return (
    <div style={{ position: 'relative', minWidth: 0, overflow: 'hidden' }}>
      <Canvas2D />
      <div className="hud">
        <span className="chip">{Math.round(s.view.zoom * 100)}%</span>
        {s.scale
          ? <span className="chip scale">1px = {s.scale.toFixed(3)} ft</span>
          : <span className="chip warn">⚠ no scale</span>}
        {totalSf > 0 && <span className="chip">{totalSf.toFixed(1)} sf</span>}
        {pdfBusy && <span className="chip">rendering…</span>}
      </div>
      {s.pdfPages > 1 && (
        <div className="pdfnav">
          <button className="zbtn" disabled={s.pdfPage <= 1 || pdfBusy} onClick={() => onPdfPage(s.pdfPage - 1)}>‹</button>
          <span className="pdfpg">pg {s.pdfPage} / {s.pdfPages}</span>
          <button className="zbtn" disabled={s.pdfPage >= s.pdfPages || pdfBusy} onClick={() => onPdfPage(s.pdfPage + 1)}>›</button>
        </div>
      )}
      <div className="zoomwrap">
        <button className="zbtn" onClick={() => zoom(s, 1.25)}>+</button>
        <button className="zbtn" onClick={() => zoom(s, 0.8)}>−</button>
        <button className="zbtn" onClick={() => window.dispatchEvent(new Event('tt:fit'))}><small>FIT</small></button>
      </div>
    </div>
  );
}

function zoom(s, f) {
  const z = Math.max(0.15, Math.min(8, s.view.zoom * f));
  s.setView({ ...s.view, zoom: z });
}
