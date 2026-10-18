import React, { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { useStore, useProject, allRooms } from './state/store.js';
import Canvas2D from './components/Canvas2D.jsx';
import { Panels } from './components/Panels.jsx';
import AccountBar from './components/AccountBar.jsx';
import { UNIT_SYSTEMS } from './engine/units.js';
import { exportCSV } from './lib/export.js';
import { onAuthEvent } from './lib/cloud.js';
import { roomArea } from './engine/geometry.js';
import Landing from './components/Landing.jsx';
import ScaleControl from './components/ScaleControl.jsx';
import { openPlanFile, restorePlan, planKey } from './lib/planLoad.js';
import { isStaleBuild, reloadForUpdate, takeUpdateNote, UPDATE_NOTE } from './lib/appUpdate.js';
import { setPlanPage } from './lib/planStore.js';
import { useBackLayer } from './lib/backStack.js';
import { zonesOf } from './engine/zones.js';
import { formatArea } from './engine/units.js';
import PhoneMenu from './components/PhoneMenu.jsx';

const Viewer3D = lazy(() => import('./components/Viewer3D.jsx'));
const Library = lazy(() => import('./components/Library.jsx'));
const DetectModal = lazy(() => import('./components/DetectModal.jsx'));

const TOOLS = [
  { id: 'select', key: 'V', label: 'Select / Move', icon: 'M3 3l7.5 18 2.5-7.5L20.5 11z' },
  { id: 'room', key: 'R', label: 'Draw Rectangle Room', icon: 'M3 3h18v18H3z', sep: true },
  { id: 'polygon', key: 'P', label: 'Trace Polygon Room', icon: 'M12 2l9 6-3 11H6L3 8z' },
  { id: 'zone_poly', key: 'D', label: 'Trace Floor Design (inlay, medallion)', icon: 'M3 3h18v18H3zM12 7l5 5-5 5-5-5z' },
  { id: 'zone_rect', key: 'I', label: 'Box Floor Design (rectangular inlay)', icon: 'M3 3h18v18H3zM8 8h8v8H8z' },
  { id: 'ruler', key: 'L', label: 'Set Scale (Ruler)', icon: 'M2 8l6-6 14 14-6 6zM8 8l2 2M11 5l2 2M5 11l2 2', sep: true },
  { id: 'grid', key: 'G', label: 'Tile Grid Overlay', icon: 'M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18' },
  { id: 'mk_length', key: 'M', label: 'Measure Length', icon: 'M3 17L17 3M7 5l2 2M5 9l2 2M9 9l2 2M11 13l2 2', sep: true },
  { id: 'mk_area', key: 'A', label: 'Measure Area (polygon)', icon: 'M3 3h18v18H3zM3 3l18 18' },
  { id: 'mk_rect', key: 'B', label: 'Measure Box', icon: 'M4 6h16v12H4z' },
  { id: 'mk_ellipse', key: 'E', label: 'Measure Ellipse', icon: 'M12 6c5 0 9 2.7 9 6s-4 6-9 6-9-2.7-9-6 4-6 9-6z' },
  { id: 'mk_count', key: 'C', label: 'Count Items', icon: 'M12 5v14M5 12h14' },
  { id: 'mk_arrow', key: 'W', label: 'Arrow', icon: 'M5 19L19 5M19 5h-7M19 5v7', sep: true },
  { id: 'mk_text', key: 'T', label: 'Text Note', icon: 'M5 5h14M12 5v14M9 19h6' },
];

export default function App() {
  const s = useProject();
  const [detect, setDetect] = useState(false);
  // tile library: null = closed, else its target ({ rooms, zones, itemKey })
  const [lib, setLib] = useState(null);
  useEffect(() => {
    const open = (e) => setLib(e.detail || {});
    window.addEventListener('tt:library', open);
    return () => window.removeEventListener('tt:library', open);
  }, []);
  const [toast, setToast] = useState(null);
  // phones: the right panel is a bottom sheet; tabs open/close it
  const [sheet, setSheet] = useState(false);
  const phone = useMedia('(max-width: 768px)');
  const isPhone = () => window.matchMedia('(max-width: 768px)').matches;
  const [menu, setMenu] = useState(false);
  const fileRef = useRef(null);
  const [landing, setLanding] = useState(() => {
    try { return localStorage.getItem('tt.entered') !== '1'; } catch (_) { return true; }
  });
  // Back closes the panel (phone) and the 3D view, instead of leaving the app
  useBackLayer(!landing && sheet && phone, () => setSheet(false));
  useBackLayer(!landing && !!s.view3d, () => s.toggle3d(false));
  // "Edit" on a selection opens its panel
  useEffect(() => {
    const open = (e) => { s.setTab(e.detail); setSheet(true); };
    window.addEventListener('tt:panel', open);
    return () => window.removeEventListener('tt:panel', open);
  }, [s]);
  const onTab = (id) => {
    if (!isPhone()) { s.setTab(id); return; }
    if (sheet && s.tab === id) setSheet(false);
    else { s.setTab(id); setSheet(true); }
  };
  // picking a drawing tool (e.g. "Trace inlay" in the panel) drops the sheet
  // so the plan is free to draw on
  useEffect(() => { if (s.tool !== 'select') setSheet(false); }, [s.tool]);
  const [pdfBusy, setPdfBusy] = useState(false);
  // the plan file is kept per project (lib/planStore.js): bring it back on
  // reload and whenever another project is opened
  const projectKey = planKey(s);
  useEffect(() => {
    let live = true;
    restorePlan()
      .then((ok) => { if (ok && live) window.dispatchEvent(new CustomEvent('tt:toast', { detail: { msg: 'Plan restored', ok: true } })); })
      .catch((e) => console.warn('plan restore failed:', e?.message));
    return () => { live = false; };
  }, [projectKey]);
  // came in from the home page: Back returns there; and the other way, the
  // logo opens the home page from the app and Back returns to the app
  const [fromLanding, setFromLanding] = useState(false);
  const [fromApp, setFromApp] = useState(false);
  useBackLayer(!landing && fromLanding, () => { setFromLanding(false); setLanding(true); });
  useBackLayer(landing && fromApp, () => { setFromApp(false); setLanding(false); });

  async function loadPdfPage(page) {
    const doc = useStore.getState().pdfDoc;
    if (!doc) return;
    setPdfBusy(true);
    try {
      const { renderPage, PLAN_RENDER_WIDTH } = await import('./lib/pdf.js');
      const out = await renderPage(doc, page, PLAN_RENDER_WIDTH);
      s.setPlanImage(out.dataUrl, out.width, out.height);
      s.setPlanDpi(72 * out.renderScale);
      // this page's takeoff comes up; the last page's is kept with that page
      const fresh = useStore.getState().switchPage(page);
      if (fresh) readSheetScale(page);
      setPlanPage(planKey(useStore.getState()), page).catch(() => {});
      const pf = useStore.getState().planFile;
      if (pf && pf.page !== page) useStore.getState().setPlanFile({ ...pf, page });
      setTimeout(() => window.dispatchEvent(new Event('tt:fit')), 60);
    } catch (e) {
      window.dispatchEvent(new CustomEvent('tt:toast', { detail: { msg: 'PDF render failed: ' + e.message } }));
    } finally { setPdfBusy(false); }
  }

  // a page not worked on yet: its own scale note beats the one carried over
  async function readSheetScale(page) {
    try {
      const { readPlan } = await import('./lib/traceClient.js');
      const { sheetScale } = await readPlan(useStore.getState());
      const st = useStore.getState();
      if (st.pdfPage !== page) return;
      if (sheetScale && Math.abs((st.scale || 0) - sheetScale.scale) > 1e-12) {
        st.setScale(sheetScale.scale); st.setArchScale(sheetScale.id);
        window.dispatchEvent(new CustomEvent('tt:toast', { detail: { msg: `Page ${page}: scale read from the sheet · ${sheetScale.label}`, ok: true } }));
      } else if (!sheetScale && st.scale) {
        window.dispatchEvent(new CustomEvent('tt:toast', { detail: { msg: `Page ${page}: no scale on the sheet — using the last page's. Check it before measuring.` } }));
      }
    } catch (_) { /* reading is best-effort */ }
  }

  // download the takeoff marked up on the plan (header, phone menu, estimate)
  useEffect(() => {
    let busy = false;
    const run = async () => {
      if (busy) return;
      busy = true;
      const toast = (msg, ok) => window.dispatchEvent(new CustomEvent('tt:toast', { detail: { msg, ok } }));
      toast('Building the marked-up PDF…', true);
      try {
        const { downloadMarkedPdf } = await import('./lib/markedPdf.js');
        const out = await downloadMarkedPdf(useStore.getState());
        toast(`Marked-up PDF ready · ${out.pages} page${out.pages > 1 ? 's' : ''} + summary${out.plan ? '' : ' (plan file not on this device: takeoff only)'}`, true);
      } catch (e) {
        toast('Could not build the PDF: ' + (e?.message || e));
      } finally { busy = false; }
    };
    window.addEventListener('tt:export-marked', run);
    return () => window.removeEventListener('tt:export-marked', run);
  }, []);

  // Artistic's Tile Quantity List (the ordering spreadsheet)
  useEffect(() => {
    const run = async () => {
      const toast = (msg, ok) => window.dispatchEvent(new CustomEvent('tt:toast', { detail: { msg, ok } }));
      try {
        const { downloadQuantityList } = await import('./lib/quantityList.js');
        const q = await downloadQuantityList(useStore.getState());
        const na = q.naRooms.length ? ` · NA (tile not picked): ${q.naRooms.length > 4 ? `${q.naRooms.length} rooms` : q.naRooms.join(', ')}` : '';
        toast(`Tile Quantity List ready · floor ${q.floorSf} SF · walls ${q.wallSf} SF${q.showerSf ? ` · shower floors ${q.showerSf} SF` : ''}${q.lf ? ` · ${q.lf} LF` : ''}${na}`, true);
      } catch (e) {
        toast('Could not build the quantity list: ' + (e?.message || e));
      }
    };
    window.addEventListener('tt:export-qty', run);
    return () => window.removeEventListener('tt:export-qty', run);
  }, []);

  // Artistic's priced proposal (QuickBooks-style lines at the rate card)
  useEffect(() => {
    const run = async () => {
      const toast = (msg, ok) => window.dispatchEvent(new CustomEvent('tt:toast', { detail: { msg, ok } }));
      try {
        const { downloadProposal } = await import('./lib/proposal.js');
        const q = await downloadProposal(useStore.getState());
        const money = `$${q.subtotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        const open = q.flags.length ? ` · ${q.flags.length} line${q.flags.length > 1 ? 's' : ''} need a look (no rate / size): ${q.flags.slice(0, 3).join('; ')}${q.flags.length > 3 ? '…' : ''}` : '';
        toast(`Proposal ready · ${money} · floor ${q.floorSf} SF · walls ${q.wallSf} SF${open}`, true);
      } catch (e) {
        toast('Could not build the proposal: ' + (e?.message || e));
      }
    };
    window.addEventListener('tt:export-proposal', run);
    return () => window.removeEventListener('tt:export-proposal', run);
  }, []);

  // a list's "also on pg N" button
  useEffect(() => {
    const go = (e) => { const n = +e.detail; if (n >= 1 && n <= (useStore.getState().pdfPages || 1)) loadPdfPage(n); };
    window.addEventListener('tt:page', go);
    return () => window.removeEventListener('tt:page', go);
  });

  async function onPdfPick(e) {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    setPdfBusy(true);
    try {
      const out = await openPlanFile(file);
      s.clearTrace();
      import('./lib/planEvidence.js').then((m) => m.clearEvidenceCache());
      s.setTab('trace');
      setSheet(true);   // the scale and Trace are the next step
      const what = out.kind === 'pdf' ? `PDF loaded · ${out.pages} page${out.pages > 1 ? 's' : ''}` : 'Plan image loaded';
      window.dispatchEvent(new CustomEvent('tt:toast', { detail: { msg: `${what}. Check the scale, then Trace plan or AI Detect.`, ok: true } }));
      setTimeout(() => window.dispatchEvent(new Event('tt:fit')), 60);
    } catch (err) {
      if (isStaleBuild(err) && reloadForUpdate(UPDATE_NOTE)) return;
      window.dispatchEvent(new CustomEvent('tt:toast', { detail: { msg: 'Could not open the plan: ' + err.message } }));
    } finally { setPdfBusy(false); }
  }

  useEffect(() => {
    let t = 0;
    const onToast = (e) => {
      // any failure that is a code file from an older deploy (Trace, exports…): reload onto the new one
      if (isStaleBuild(e.detail?.msg) && reloadForUpdate(UPDATE_NOTE)) return;
      clearTimeout(t);
      setToast(e.detail);
      t = setTimeout(() => setToast(null), e.detail?.action ? 5000 : 2400);
    };
    window.addEventListener('tt:toast', onToast);
    // reloaded onto a new version (see appUpdate.js): say so
    const note = takeUpdateNote();
    if (note) { setToast({ msg: note, ok: true }); t = setTimeout(() => setToast(null), 6000); }
    const onKey = (e) => {
      if (/input|select|textarea/i.test(e.target.tagName)) return;
      const k = e.key.toLowerCase();
      // Ctrl/Cmd+Z undo · Ctrl/Cmd+Shift+Z or Ctrl+Y redo (fields keep their own)
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        if (k === 'z' && !e.shiftKey) { e.preventDefault(); useStore.getState().undo(); }
        else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); useStore.getState().redo(); }
        return;   // other shortcuts are never tool keys
      }
      const t = TOOLS.find((t) => t.key.toLowerCase() === k);
      if (t) s.setTool(t.id);
      else if (k === 'f') window.dispatchEvent(new Event('tt:fit'));
      else if (k === 'delete' || k === 'backspace') {
        const st = useStore.getState();
        if (st.selRooms.length > 1) st.deleteRooms(st.selRooms);
        // a selected border/inlay goes first — never the whole room under it
        else if (s.selection.type === 'room' && st.selZone) st.deleteZone(s.selection.id, st.selZone);
        else if (s.selection.type === 'room') s.deleteRoom(s.selection.id);
        else if (s.selection.type === 'material') s.deleteMaterial(s.selection.id);
        else if (s.selection.type === 'markup') s.deleteMarkup(s.selection.id);
      } else if (k === 'escape') { s.setTool('select'); s.select(null, null); }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('tt:toast', onToast); window.removeEventListener('keydown', onKey); };
  }, [s]);

  // A Supabase password-reset link returns here and fires PASSWORD_RECOVERY.
  // Leave the landing page (so AccountBar is mounted) and ask it to show the
  // set-new-password form.
  useEffect(() => {
    return onAuthEvent((event) => {
      if (event === 'PASSWORD_RECOVERY') {
        try { localStorage.setItem('tt.entered', '1'); } catch (_) {}
        setLanding(false);
        setTimeout(() => window.dispatchEvent(new Event('tt:recovery')), 80);
      }
    });
  }, []);

  if (landing) {
    const enter = (signin) => {
      try { localStorage.setItem('tt.entered', '1'); } catch (_) {}
      if (fromApp) setFromApp(false);   // its Back entry becomes the app's
      else setFromLanding(true);
      setLanding(false);
      if (signin) setTimeout(() => window.dispatchEvent(new Event('tt:signin')), 60);
    };
    return <Landing onStart={() => enter(false)} onSignIn={() => enter(true)} />;
  }

  const totalSf = s.rooms.reduce((a, r) => a + (s.scale ? roomArea(r) : 0), 0);
  // the whole job, when other pages hold rooms too
  const jobSf = Object.keys(s.pageData || {}).length ? allRooms(s).reduce((a, r) => a + roomArea(r), 0) : totalSf;

  return (
    <div className="app">
      <header className="top">
        <div className="brand" onClick={() => { setMenu(false); setFromApp(true); setLanding(true); }} style={{ cursor: 'pointer' }} title="Back to home">
          <svg viewBox="0 0 32 32"><rect x="2" y="2" width="13" height="13" rx="2" fill="#0f2f47" /><rect x="17" y="2" width="13" height="13" rx="2" fill="#c8521f" /><rect x="2" y="17" width="13" height="13" rx="2" fill="#c8521f" /><rect x="17" y="17" width="13" height="13" rx="2" fill="#0f2f47" /></svg>
          <b>Tile<span>Takeoff</span></b>
        </div>
        <input className="docname" value={s.name} maxLength={60} onChange={(e) => s.setName(e.target.value)} />
        <div className="undo-redo">
          <button className="tbtn icon" disabled={!s.undoCount} onClick={() => s.undo()} title="Undo (Ctrl Z)" aria-label="Undo">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 14L4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></svg>
          </button>
          <button className="tbtn icon" disabled={!s.redoCount} onClick={() => s.redo()} title="Redo (Ctrl Shift Z)" aria-label="Redo">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 14l5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></svg>
          </button>
        </div>
        <select className="unit-sel hdr-full" value={s.unitSystem} onChange={(e) => s.setUnitSystem(e.target.value)}>
          {Object.values(UNIT_SYSTEMS).map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
        </select>
        <div className="spacer" />
        <button className="tbtn hdr-full" onClick={() => setLib({})} title="Tiles, sizes and patterns — lay them in rooms">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="8" height="8" rx="1" /><rect x="13" y="3" width="8" height="8" rx="1" /><rect x="3" y="13" width="8" height="8" rx="1" /><rect x="13" y="13" width="8" height="8" rx="1" /></svg><span className="tbtn-label">Library</span>
        </button>
        <AccountBar />
        <label className="tbtn hdr-plan" style={{ cursor: 'pointer' }} title="Open a plan (PDF or image)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 2h9l5 5v15H6zM15 2v5h5" /><path d="M9 13h6M9 17h4" /></svg><span className="tbtn-label">PDF</span>
          <input ref={fileRef} type="file" accept="application/pdf,image/png,image/jpeg,image/webp" style={{ display: 'none' }} onChange={onPdfPick} />
        </label>
        <button className={'tbtn hdr-full' + (s.tab === 'trace' ? ' on' : '')} onClick={() => s.setTab('trace')} title="Rebuild the walls from the plan and take off from the model">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 20V8l6-4 6 4v4h4v8z" /><path d="M10 20v-6h4v6" /></svg>Trace
        </button>
        <button className="tbtn hdr-full" onClick={() => setDetect(true)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l2.5 2.5M16.5 16.5L19 19M19 5l-2.5 2.5M7.5 16.5L5 19" /><circle cx="12" cy="12" r="3" /></svg>AI Detect
        </button>
        <button className={'tbtn hdr-full' + (s.view3d ? ' on' : '')} onClick={() => s.toggle3d()} title={s.view3d ? '2D plan' : '3D view'}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2l9 5v10l-9 5-9-5V7z M3 7l9 5 9-5 M12 12v10" /></svg><span className="tbtn-label">{s.view3d ? '2D' : '3D'}</span>
        </button>
        <ExportMenu />
        <button className="tbtn primary hdr-full" title="New takeoff" onClick={() => { if (confirm('Start a new takeoff? Current work is saved in this browser.')) s.newProject(); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg><span className="tbtn-label">New</span>
        </button>
        {s.view3d && (
          <button className="tbtn hdr-phone" onClick={() => s.toggle3d(false)} title="Back to the 2D plan">2D</button>
        )}
        <button className="tbtn icon hdr-phone hdr-menu" onClick={() => setMenu(true)} aria-label="Menu">
          <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
        </button>
      </header>

      <main>
        <nav className="toolbar">
          {TOOLS.map((t) => (
            <React.Fragment key={t.id}>
              {t.sep && <div className="toolsep" />}
              <button className={'tool' + (s.tool === t.id ? ' active' : '')} onClick={() => s.setTool(t.id)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"><path d={t.icon} /></svg>
                <span className="tip">{t.label}<kbd>{t.key}</kbd></span>
              </button>
            </React.Fragment>
          ))}
        </nav>

        {s.view3d ? (
          <Suspense fallback={<div className="stage" style={{ display: 'grid', placeItems: 'center', color: '#8b97a3' }}>Loading 3D…</div>}>
            <Viewer3D />
          </Suspense>
        ) : (
          <StageWrap totalSf={totalSf} jobSf={jobSf} onPdfPage={loadPdfPage} pdfBusy={pdfBusy} />
        )}

        <aside className={'right' + (sheet ? ' open' : '')}>
          <button className="sheet-handle" aria-label={sheet ? 'Close panel' : 'Open panel'} {...sheetSwipe(sheet, setSheet)} />
          <div className="tabs">
            {[['trace', 'Trace', s.trace?.result ? (s.trace.result.counts.error || s.trace.result.counts.warn || null) : null], ['rooms', 'Rooms', s.rooms.length], ['materials', 'Materials', s.materials.length], ['markups', 'Markups', s.markups.length], ['estimate', 'Estimate', null]].map(([id, label, ct]) => (
              <button key={id} className={'tab' + (s.tab === id ? ' active' : '')} onClick={() => onTab(id)}>
                {label}{ct != null && <span className="ct">{ct}</span>}
              </button>
            ))}
          </div>
          <Panels />
        </aside>
      </main>

      {detect && <Suspense fallback={null}><DetectModal onClose={() => setDetect(false)} /></Suspense>}
      {lib && <Suspense fallback={null}><Library target={lib} onClose={() => setLib(null)} /></Suspense>}
      {toast && (
        <div className={'toast show' + (toast.ok ? ' ok' : '')} role="status">
          {toast.ok && <b>✓</b>} {toast.msg}
          {toast.action && <button className="toast-act" onClick={() => { toast.action.run(); setToast(null); }}>{toast.action.label}</button>}
        </div>
      )}
      {menu && (
        <PhoneMenu onClose={() => setMenu(false)} onOpenPlan={() => fileRef.current?.click()} onLibrary={() => setLib({})}
          onDetect={() => setDetect(true)} onHome={() => { setFromApp(true); setLanding(true); }} />
      )}
    </div>
  );
}

// Export: the marked-up plan first (what goes to the customer / the office),
// then the estimate spreadsheets and the project file.
function ExportMenu() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (!e.target.closest?.('.export-menu')) setOpen(false); };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);
  const go = (fn) => () => { setOpen(false); fn(); };
  return (
    <div className="export-menu hdr-full">
      <button className={'tbtn' + (open ? ' on' : '')} onClick={() => setOpen(!open)} title="Download the takeoff" aria-expanded={open}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /></svg><span className="tbtn-label">Export</span>
      </button>
      {open && (
        <div className="export-pop" role="menu">
          <button role="menuitem" onClick={go(() => window.dispatchEvent(new Event('tt:export-marked')))}>
            <b>Marked-up plan (PDF)</b><span>Every page with its takeoff drawn on it, plus a summary</span>
          </button>
          <button role="menuitem" onClick={go(() => window.dispatchEvent(new Event('tt:export-qty')))}>
            <b>Tile Quantity List (Excel)</b><span>The ordering sheet: each tiled surface, waste, totals</span>
          </button>
          <button role="menuitem" onClick={go(() => window.dispatchEvent(new Event('tt:export-proposal')))}>
            <b>Proposal (Excel)</b><span>Priced lines at the Artistic rate card, ready for QuickBooks</span>
          </button>
          <button role="menuitem" onClick={go(() => import('./lib/export.js').then((m) => m.exportXLSX(useStore.getState())))}>
            <b>Estimate (Excel)</b><span>Estimate, rooms by page, markups, materials</span>
          </button>
          <button role="menuitem" onClick={go(() => exportCSV(useStore.getState()))}>
            <b>Estimate (CSV)</b><span>The same as one sheet</span>
          </button>
          <button role="menuitem" onClick={go(() => import('./lib/export.js').then((m) => m.exportJSON(useStore.getState())))}>
            <b>Project file (JSON)</b><span>Re-open this takeoff later</span>
          </button>
        </div>
      )}
    </div>
  );
}

function StageWrap({ totalSf, jobSf, onPdfPage, pdfBusy }) {
  const s = useStore();
  const coarse = useMedia('(pointer: coarse)');
  return (
    <div style={{ position: 'relative', minWidth: 0 }}>
      <Canvas2D />
      <div className="hud">
        <span className="chip">{Math.round(s.view.zoom * 100)}%</span>
        {s.tool === 'tr_wall' && <span className="chip warn">Add wall: click points · Shift = straight · Esc to stop</span>}
        {s.tool === 'tr_erase' && <span className="chip warn">Erase: click a traced wall that is not real</span>}
        {s.tool === 'tr_region' && <span className="chip warn">Drag a box around the floor plan to trace</span>}
        {s.traceBusy && <span className="chip">tracing…</span>}
        <ScaleControl />
        {s.scale && (
          <button className={'chip toggle' + (s.showGrid ? ' on' : '')} onClick={s.toggleGrid}
            title="Show or hide the foot grid">▦ Grid</button>
        )}
        {s.planImage && (
          <button className={'chip toggle' + (s.snapOn ? ' on' : '')} onClick={s.toggleSnap}
            title="Snap points to the plan's corners, line ends and edges (hold Alt to place freely)">⌖ Snap</button>
        )}
        {totalSf > 0 && <span className="chip">{totalSf.toFixed(1)} sf {jobSf > totalSf + 0.05 ? `this page · ${jobSf.toFixed(1)} sf job` : 'total'}</span>}
        {pdfBusy && <span className="chip">rendering PDF…</span>}
      </div>
      <SelectionBar s={s} />
      {coarse && s.tool !== 'select' && s.tool !== 'pan' && !s.selection.type && !s.selRooms.length && (
        <div className="touch-hint">Two fingers: move &amp; zoom</div>
      )}
      {s.pdfPages > 1 && (
        <div className="pdfnav">
          <button className="zbtn" disabled={s.pdfPage <= 1 || pdfBusy} onClick={() => onPdfPage(s.pdfPage - 1)}>‹</button>
          <span className="pdfpg">pg {s.pdfPage} / {s.pdfPages}</span>
          <button className="zbtn" disabled={s.pdfPage >= s.pdfPages || pdfBusy} onClick={() => onPdfPage(s.pdfPage + 1)}>›</button>
        </div>
      )}
      <div className="zoomwrap">
        <button className="zbtn" title="Zoom in (Ctrl +)" onClick={() => window.dispatchEvent(new CustomEvent('tt:zoomby', { detail: 1.4 }))}>+</button>
        <button className="zbtn" title="Zoom out (Ctrl −)" onClick={() => window.dispatchEvent(new CustomEvent('tt:zoomby', { detail: 1 / 1.4 }))}>−</button>
        <button className="zbtn" title="Fit (F or Ctrl 0)" onClick={() => window.dispatchEvent(new Event('tt:fit'))}><small>FIT</small></button>
      </div>
    </div>
  );
}


// true while a media query matches (re-renders when it changes)
function useMedia(q) {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener ? mq.addEventListener('change', on) : mq.addListener(on);
    return () => { mq.removeEventListener ? mq.removeEventListener('change', on) : mq.removeListener(on); };
  }, [q]);
  return m;
}

// The sheet's handle: a tap toggles it; a swipe up opens, a swipe down closes.
function sheetSwipe(open, setOpen) {
  let y0 = null;
  return {
    onPointerDown: (e) => { y0 = e.clientY; e.currentTarget.setPointerCapture?.(e.pointerId); },
    onPointerUp: (e) => {
      if (y0 == null) return;
      const dy = e.clientY - y0; y0 = null;
      if (Math.abs(dy) < 10) setOpen(!open);
      else setOpen(dy < 0);
    },
    onPointerCancel: () => { y0 = null; },
  };
}

// What is selected on the plan, with what you can do to it — the way to edit
// or delete on a phone (no keyboard), and a quicker one on a desktop.
function SelectionBar({ s }) {
  const multi = s.selRooms.length > 1;
  const room = !multi && s.selection.type === 'room' ? s.rooms.find((r) => r.id === s.selection.id) : null;
  const zone = room && s.selZone ? zonesOf(room).find((z) => z.id === s.selZone) : null;
  const markup = s.selection.type === 'markup' ? s.markups.find((m) => m.id === s.selection.id) : null;
  if (!multi && !room && !markup) return null;
  const undoToast = (msg) => window.dispatchEvent(new CustomEvent('tt:toast', {
    detail: { msg, ok: true, action: { label: 'Undo', run: () => useStore.getState().undo() } },
  }));
  const st = useStore.getState();
  let label, del, tab;
  if (multi) {
    label = <><b>{s.selRooms.length}</b> rooms</>;
    del = () => { const n = s.selRooms.length; st.historyEnd(); st.deleteRooms(s.selRooms); undoToast(`Deleted ${n} rooms`); };
    tab = 'rooms';
  } else if (zone) {
    label = <><b>{zone.name}</b> · {room.name}</>;
    del = () => { st.historyEnd(); st.deleteZone(room.id, zone.id); undoToast(`Deleted ${zone.name}`); };
    tab = 'rooms';
  } else if (room) {
    label = <><b>{room.name}</b>{s.scale ? ` · ${formatArea(roomArea(room), s.unitSystem)}` : ''}</>;
    del = () => { st.historyEnd(); st.deleteRoom(room.id); undoToast(`Deleted ${room.name}`); };
    tab = 'rooms';
  } else {
    label = <b>{markup.name || 'Markup'}</b>;
    del = () => { st.historyEnd(); st.deleteMarkup(markup.id); undoToast(`Deleted ${markup.name || 'markup'}`); };
    tab = 'markups';
  }
  return (
    <div className="selbar" role="toolbar" aria-label="Selection">
      <span className="selbar-label">{label}</span>
      <button onClick={() => window.dispatchEvent(new CustomEvent('tt:panel', { detail: tab }))}>Edit</button>
      <button className="danger" onClick={del}>Delete</button>
      <button onClick={() => { st.select(null, null); st.clearRoomSel(); }}>Done</button>
    </div>
  );
}
