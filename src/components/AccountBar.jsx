import React, { useState, useEffect, useCallback } from 'react';
import { useStore, setCloudSaver } from '../state/store.js';
import { cloudEnabled } from '../lib/supabase.js';
import {
  getUser, onAuthChange, signInWithPassword, signUp, signOut,
  listProjects, loadProject, createProject, saveProject, deleteProject,
} from '../lib/cloud.js';

// Renders the cloud account control + projects drawer. When cloud isn't
// configured it renders nothing (app stays local-only).
export default function AccountBar() {
  const s = useStore();
  const [user, setUser] = useState(null);
  const [showAuth, setShowAuth] = useState(false);
  const [showProjects, setShowProjects] = useState(false);

  // register cloud saver whenever auth state allows it
  useEffect(() => {
    if (!cloudEnabled) return;
    getUser().then(setUser);
    return onAuthChange(setUser);
  }, []);

  useEffect(() => {
    if (!cloudEnabled || !user) { setCloudSaver(null); return; }
    setCloudSaver(async (state) => {
      try {
        if (state.cloudId) await saveProject(state.cloudId, state);
        else {
          const id = await createProject(state);
          useStore.getState().setCloudId(id);
        }
      } catch (e) { console.warn('cloud save failed', e.message); }
    });
    return () => setCloudSaver(null);
  }, [user]);

  if (!cloudEnabled) return null;

  return (
    <>
      {user ? (
        <>
          <button className="tbtn" onClick={() => setShowProjects(true)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7h6l2 2h10v9a2 2 0 0 1-2 2H3z" /></svg>Projects
          </button>
          <button className="tbtn" title={user.email} onClick={() => { signOut(); }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 4-6 8-6s8 2 8 6" /></svg>
          </button>
        </>
      ) : (
        <button className="tbtn" onClick={() => setShowAuth(true)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3" /></svg>Sign in
        </button>
      )}
      {showAuth && <AuthModal onClose={() => setShowAuth(false)} />}
      {showProjects && <ProjectsDrawer onClose={() => setShowProjects(false)} />}
    </>
  );
}

function AuthModal({ onClose }) {
  const [mode, setMode] = useState('in');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true); setErr('');
    try {
      if (mode === 'in') await signInWithPassword(email, pw);
      else { await signUp(email, pw); }
      onClose();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 380 }} onClick={(e) => e.stopPropagation()}>
        <h3>{mode === 'in' ? 'Sign in' : 'Create account'}</h3>
        <div className="body">
          <div className="field"><label>Email</label>
            <input className="inp" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <div className="field"><label>Password</label>
            <input className="inp" type="password" value={pw} onChange={(e) => setPw(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && go()} /></div>
          {err && <div className="note" style={{ color: 'var(--bad)' }}>{err}</div>}
          <div className="note">
            {mode === 'in' ? "No account? " : 'Have an account? '}
            <a style={{ color: 'var(--accent)', cursor: 'pointer' }} onClick={() => setMode(mode === 'in' ? 'up' : 'in')}>
              {mode === 'in' ? 'Create one' : 'Sign in'}</a>
          </div>
        </div>
        <div className="foot">
          <button className="tbtn" onClick={onClose}>Cancel</button>
          <button className="tbtn primary" disabled={busy || !email || !pw} onClick={go}>
            {busy ? '…' : mode === 'in' ? 'Sign in' : 'Sign up'}</button>
        </div>
      </div>
    </div>
  );
}

function ProjectsDrawer({ onClose }) {
  const s = useStore();
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');

  const refresh = useCallback(() => {
    listProjects().then(setRows).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  async function open(id) {
    try { const row = await loadProject(id); s.loadCloudDoc(row); onClose();
      window.dispatchEvent(new Event('tt:fit'));
    } catch (e) { setErr(e.message); }
  }
  async function saveCurrentAsNew() {
    try {
      useStore.getState().setCloudId(null);
      const id = await createProject(useStore.getState());
      useStore.getState().setCloudId(id); refresh();
    } catch (e) { setErr(e.message); }
  }
  async function remove(id, e) {
    e.stopPropagation();
    if (!confirm('Delete this project from the cloud?')) return;
    try { await deleteProject(id); refresh(); } catch (e) { setErr(e.message); }
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Cloud projects</h3>
        <div className="body">
          {err && <div className="note" style={{ color: 'var(--bad)' }}>{err}</div>}
          {!rows && <div className="note">Loading…</div>}
          {rows && rows.length === 0 && <div className="note">No saved projects yet. Your current work auto-saves once you’re signed in.</div>}
          {rows && rows.map((p) => (
            <div className="det-row" key={p.id} style={{ cursor: 'pointer' }} onClick={() => open(p.id)}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</div>
                <div style={{ fontSize: 11, color: '#8b97a3', fontFamily: 'var(--mono)' }}>
                  {Number(p.floor_sf).toFixed(0)} sf · ${Number(p.total_cost).toFixed(0)} · {new Date(p.updated_at).toLocaleDateString()}
                </div>
              </div>
              <button className="icon-btn" onClick={(e) => remove(p.id, e)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /></svg>
              </button>
            </div>
          ))}
        </div>
        <div className="foot">
          <button className="tbtn" onClick={onClose}>Close</button>
          <button className="tbtn primary" onClick={saveCurrentAsNew}>Save current as new</button>
        </div>
      </div>
    </div>
  );
}
