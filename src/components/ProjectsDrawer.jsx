import { useState, useEffect, useCallback } from 'react';
import { useStore, projectIndex } from '../state/store.js';
import Modal from './Modal.jsx';
import { cloudEnabled } from '../lib/supabase.js';
import { listProjects, loadProject, deleteProject } from '../lib/cloud.js';

const toast = (msg, ok) => window.dispatchEvent(new CustomEvent('tt:toast', { detail: { msg, ok } }));
const when = (t) => (t ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '');

/**
 * Every project: the ones on this device (each plan is its own project —
 * state/projects.js) and, signed in, the ones in the account that aren't
 * here yet. Opening one keeps the project on screen as it stands.
 */
export default function ProjectsDrawer({ onClose }) {
  const s = useStore();
  const [local, setLocal] = useState(() => projectIndex());
  const [cloud, setCloud] = useState(null);
  const [err, setErr] = useState('');
  const signedIn = cloudEnabled && !!s.authUser;

  const refresh = useCallback(() => {
    setLocal(projectIndex());
    if (signedIn) listProjects().then(setCloud).catch((e) => setErr(e.message));
  }, [signedIn]);
  useEffect(() => { refresh(); }, [refresh]);

  const here = new Set(local.flatMap((p) => [p.id, p.cloudId]).filter(Boolean));
  const cloudOnly = (cloud || []).filter((r) => !here.has(r.id));
  const cloudRow = (meta) => (cloud || []).find((r) => r.id === (meta.cloudId || meta.id));

  const done = () => { onClose(); setTimeout(() => window.dispatchEvent(new Event('tt:fit')), 60); };
  async function openLocal(meta) {
    if (meta.id === s.id) { onClose(); return; }
    // changed on another device since: the account's copy is the newer one
    const row = cloudRow(meta);
    if (row && new Date(row.updated_at).getTime() > (meta.updatedAt || 0) + 5000) return openCloud(row.id);
    try {
      if (await useStore.getState().openProject(meta.id)) done();
      else if (row) await openCloud(row.id);
      else setErr(`"${meta.name}" isn't on this device any more.`);
    } catch (e) { setErr(e.message); }
  }
  async function openCloud(id) {
    try { const row = await loadProject(id); useStore.getState().loadCloudDoc(row); done(); } catch (e) { setErr(e.message); }
  }
  async function removeLocal(meta, e) {
    e.stopPropagation();
    const inCloud = signedIn && !!cloudRow(meta);
    if (!confirm(`Delete "${meta.name}"${meta.planName ? ` (${meta.planName})` : ''}${inCloud ? ' from this device and your account' : ' from this device'}? Its takeoff and plan file go with it.`)) return;
    try {
      await useStore.getState().removeProject(meta.id);
      if (inCloud) await deleteProject(meta.cloudId || meta.id);
      refresh();
    } catch (e2) { setErr(e2.message); }
  }
  async function removeCloud(row, e) {
    e.stopPropagation();
    if (!confirm(`Delete "${row.name}" from your account?`)) return;
    try { await deleteProject(row.id); refresh(); } catch (e2) { setErr(e2.message); }
  }
  function startNew() {
    useStore.getState().newProject();
    toast('New project started — the last one is in Projects.', true);
    onClose();
  }

  const Trash = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /></svg>;
  return (
    <Modal title="Projects" onClose={onClose}>
      <div className="body">
        {err && <div className="note" style={{ color: 'var(--bad)' }}>{err}</div>}
        <div className="note">Each plan is its own project: opening another plan starts a new one, and this one stays here as it is.</div>
        {local.length === 0 && <div className="note">No projects on this device yet — open a plan to start one.</div>}
        {local.map((p) => (
          <div className={'det-row' + (p.id === s.id ? ' on' : '')} key={p.id} style={{ cursor: 'pointer', ...(p.id === s.id ? { borderColor: 'var(--accent, #c8521f)' } : {}) }} onClick={() => openLocal(p)}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.id === s.id ? s.name : p.name}{p.id === s.id && <span style={{ fontWeight: 400, color: '#8b97a3' }}> · open now</span>}
              </div>
              <div style={{ fontSize: 11, color: '#8b97a3', fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {[p.planName, `${p.rooms} room${p.rooms === 1 ? '' : 's'}`, p.pages > 1 ? `${p.pages} pages` : null, when(p.updatedAt), p.cloudId ? 'in account' : null].filter(Boolean).join(' · ')}
              </div>
            </div>
            <button className="icon-btn danger" aria-label={`Delete ${p.name}`} onClick={(e) => removeLocal(p, e)}><Trash /></button>
          </div>
        ))}
        {signedIn && cloudOnly.length > 0 && (
          <>
            <div className="note" style={{ marginTop: 14, fontWeight: 600 }}>In your account</div>
            {cloudOnly.map((r) => (
              <div className="det-row" key={r.id} style={{ cursor: 'pointer' }} onClick={() => openCloud(r.id)}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{r.name}</div>
                  <div style={{ fontSize: 11, color: '#8b97a3', fontFamily: 'var(--mono)' }}>
                    {Number(r.floor_sf).toFixed(0)} sf · ${Number(r.total_cost).toFixed(0)} · {when(r.updated_at)}
                  </div>
                </div>
                <button className="icon-btn danger" aria-label={`Delete ${r.name}`} onClick={(e) => removeCloud(r, e)}><Trash /></button>
              </div>
            ))}
          </>
        )}
        {signedIn && cloud === null && !err && <div className="note">Loading your account&rsquo;s projects…</div>}
      </div>
      <div className="foot">
        <button className="tbtn" onClick={onClose}>Close</button>
        <button className="tbtn primary" onClick={startNew}>New project</button>
      </div>
    </Modal>
  );
}
