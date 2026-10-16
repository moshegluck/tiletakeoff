// ============================================================
// PhoneMenu — on a phone the header keeps only the essentials (name,
// undo / redo, open plan); everything else lives here: the account, the
// tools that open their own screens, export, units, new takeoff, home.
// A sheet from the bottom; Back or a tap outside closes it.
// ============================================================
import { createPortal } from 'react-dom';
import { useProject } from '../state/store.js';
import { useBackLayer } from '../lib/backStack.js';
import { cloudEnabled } from '../lib/supabase.js';
import { signOut } from '../lib/cloud.js';
import { UNIT_SYSTEMS } from '../engine/units.js';
import { exportCSV, exportXLSX } from '../lib/export.js';

const Icon = ({ d }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
);
const I = {
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 4-6 8-6s8 2 8 6',
  folder: 'M3 7h6l2 2h10v9a2 2 0 0 1-2 2H3z',
  out: 'M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4M16 17l5-5-5-5M21 12H9',
  in: 'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3',
  file: 'M6 2h9l5 5v15H6zM15 2v5h5M9 13h6M9 17h4',
  lib: 'M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z',
  trace: 'M4 20V8l6-4 6 4v4h4v8zM10 20v-6h4v6',
  ai: 'M12 2v4M12 18v4M2 12h4M18 12h4M5 5l2.5 2.5M16.5 16.5L19 19M19 5l-2.5 2.5M7.5 16.5L5 19',
  cube: 'M12 2l9 5v10l-9 5-9-5V7zM3 7l9 5 9-5M12 12v10',
  down: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  plus: 'M12 5v14M5 12h14',
  home: 'M3 11l9-8 9 8v10H3zM9 21v-7h6v7',
};

/**
 * @param {{ onClose: () => void, onOpenPlan: () => void, onLibrary: () => void, onDetect: () => void, onHome: () => void }} p
 */
export default function PhoneMenu({ onClose, onOpenPlan, onLibrary, onDetect, onHome }) {
  const s = useProject();
  useBackLayer(true, onClose);
  const go = (fn) => () => { onClose(); setTimeout(fn, 30); };
  const item = (icon, label, fn, cls = '') => (
    <button className={'pm-item' + (cls ? ' ' + cls : '')} onClick={go(fn)}><Icon d={I[icon]} /><span>{label}</span></button>
  );
  return createPortal(
    <div className="pm-bg" onClick={onClose}>
      <div className="pm" role="dialog" aria-label="Menu" onClick={(e) => e.stopPropagation()}>
        <div className="pm-grab" />
        {cloudEnabled && (s.authUser ? (
          <div className="pm-group">
            <div className="pm-who"><Icon d={I.user} /><span>{s.authUser.email}</span></div>
            {item('folder', 'Your projects', () => window.dispatchEvent(new Event('tt:projects')))}
            {item('out', 'Sign out', () => { if (confirm(`Sign out of ${s.authUser.email}?`)) signOut(); })}
          </div>
        ) : (
          <div className="pm-group">
            {item('in', 'Sign in or create an account', () => window.dispatchEvent(new Event('tt:signin')), 'strong')}
          </div>
        ))}
        <div className="pm-group">
          {item('file', s.planImage ? 'Open another plan (PDF or image)' : 'Open a plan (PDF or image)', onOpenPlan)}
          {item('lib', 'Tile library', onLibrary)}
          {item('trace', 'Trace the plan', () => window.dispatchEvent(new CustomEvent('tt:panel', { detail: 'trace' })))}
          {item('ai', 'AI room detection', onDetect)}
          {item('cube', s.view3d ? 'Back to the 2D plan' : '3D walk-through', () => s.toggle3d())}
        </div>
        <div className="pm-group">
          {item('down', 'Download marked-up plan (PDF)', () => window.dispatchEvent(new Event('tt:export-marked')))}
          {item('down', 'Tile Quantity List (Excel)', () => window.dispatchEvent(new Event('tt:export-qty')))}
          {item('down', 'Export estimate (Excel)', () => exportXLSX(s))}
          {item('down', 'Export estimate (CSV)', () => exportCSV(s))}
          <label className="pm-item pm-select">
            <Icon d="M3 12h18M3 6h18M3 18h12" /><span>Units</span>
            <select value={s.unitSystem} onChange={(e) => s.setUnitSystem(e.target.value)}>
              {Object.values(UNIT_SYSTEMS).map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
            </select>
          </label>
        </div>
        <div className="pm-group">
          {item('plus', 'New takeoff', () => { if (confirm('Start a new takeoff? This one stays saved.')) s.newProject(); })}
          {item('home', 'Home page', onHome)}
        </div>
        <button className="pm-close" onClick={onClose}>Close</button>
      </div>
    </div>,
    document.body,
  );
}
