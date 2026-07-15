import { useState, useEffect, useCallback } from 'react';
import { useStore, setCloudSaver } from '../state/store.js';
import { cloudEnabled } from '../lib/supabase.js';
import {
  getUser, onAuthChange, signInWithPassword, signUp, signOut,
  resetPasswordForEmail, updatePassword,
  listProjects, loadProject, createProject, saveProject, deleteProject,
} from '../lib/cloud.js';
import LibraryModal from './LibraryModal.jsx';

// Renders the cloud account control + projects drawer. When cloud isn't
// configured it renders nothing (app stays local-only).
export default function AccountBar() {
  const [user, setUser] = useState(null);
  const [showAuth, setShowAuth] = useState(false);
  const [authMode, setAuthMode] = useState('in');
  const [showProjects, setShowProjects] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);

  // register cloud saver whenever auth state allows it
  useEffect(() => {
    if (!cloudEnabled) return;
    getUser().then(setUser);
    return onAuthChange(setUser);
  }, []);

  // the landing page's "Sign in" opens the modal; App re-broadcasts a Supabase
  // password-recovery link as tt:recovery so we can open the set-new-password form
  useEffect(() => {
    const openSignIn = () => { setAuthMode('in'); setShowAuth(true); };
    const openRecovery = () => { setAuthMode('recovery'); setShowAuth(true); };
    window.addEventListener('tt:signin', openSignIn);
    window.addEventListener('tt:recovery', openRecovery);
    return () => { window.removeEventListener('tt:signin', openSignIn); window.removeEventListener('tt:recovery', openRecovery); };
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
          <button className="tbtn" onClick={() => setShowLibrary(true)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="8" height="8" rx="1" /><rect x="13" y="3" width="8" height="8" rx="1" /><rect x="3" y="13" width="8" height="8" rx="1" /><rect x="13" y="13" width="8" height="8" rx="1" /></svg>Library
          </button>
          <button className="tbtn" onClick={() => setShowProjects(true)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7h6l2 2h10v9a2 2 0 0 1-2 2H3z" /></svg>Projects
          </button>
          <button className="tbtn" title={user.email} onClick={() => { signOut(); }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 4-6 8-6s8 2 8 6" /></svg>
          </button>
        </>
      ) : (
        <button className="tbtn" onClick={() => { setAuthMode('in'); setShowAuth(true); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3" /></svg>Sign in
        </button>
      )}
      {showAuth && <AuthModal initialMode={authMode} onClose={() => setShowAuth(false)} />}
      {showProjects && <ProjectsDrawer onClose={() => setShowProjects(false)} />}
      {showLibrary && <LibraryModal onClose={() => setShowLibrary(false)} />}
    </>
  );
}

const AUTH_TITLE = { in: 'Sign in', up: 'Create account', reset: 'Reset password', recovery: 'Set a new password' };
const AUTH_CTA = { in: 'Sign in', up: 'Sign up', reset: 'Send reset link', recovery: 'Update password' };
const link = { color: 'var(--accent)', cursor: 'pointer' };

function AuthModal({ onClose, initialMode = 'in' }) {
  const [mode, setMode] = useState(initialMode);
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const needsEmail = mode !== 'recovery';
  const needsPw = mode !== 'reset';
  const canSubmit = (!needsEmail || !!email) && (!needsPw || !!pw);
  const to = (m) => () => { setMode(m); setErr(''); setMsg(''); };

  async function go() {
    if (!canSubmit) return;
    setBusy(true); setErr(''); setMsg('');
    try {
      if (mode === 'in') { await signInWithPassword(email, pw); onClose(); }
      else if (mode === 'up') { await signUp(email, pw); onClose(); }
      else if (mode === 'reset') { await resetPasswordForEmail(email); setMsg('If that email has an account, a reset link is on its way. Check your inbox (and spam).'); }
      else if (mode === 'recovery') { await updatePassword(pw); setMsg('Password updated — you’re signed in.'); setTimeout(onClose, 1200); }
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 380 }} onClick={(e) => e.stopPropagation()}>
        <h3>{AUTH_TITLE[mode]}</h3>
        <div className="body">
          {mode === 'reset' && <div className="note">Enter your account email and we’ll send a password-reset link.</div>}
          {mode === 'recovery' && <div className="note">Choose a new password for your account.</div>}
          {needsEmail && (
            <div className="field"><label>Email</label>
              <input className="inp" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && go()} /></div>
          )}
          {needsPw && (
            <div className="field"><label>{mode === 'recovery' ? 'New password' : 'Password'}</label>
              <input className="inp" type="password" value={pw} onChange={(e) => setPw(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && go()} /></div>
          )}
          {err && <div className="note" style={{ color: 'var(--bad)' }}>{err}</div>}
          {msg && <div className="note" style={{ color: 'var(--ok)' }}>{msg}</div>}

          {mode === 'in' && (
            <>
              <div className="note"><a style={link} onClick={to('reset')}>Forgot password?</a></div>
              <div className="note">No account? <a style={link} onClick={to('up')}>Create one</a></div>
            </>
          )}
          {mode === 'up' && (
            <div className="note">Have an account? <a style={link} onClick={to('in')}>Sign in</a></div>
          )}
          {mode === 'reset' && (
            <div className="note"><a style={link} onClick={to('in')}>← Back to sign in</a></div>
          )}
        </div>
        <div className="foot">
          <button className="tbtn" onClick={onClose}>Cancel</button>
          <button className="tbtn primary" disabled={busy || !canSubmit} onClick={go}>
            {busy ? '…' : AUTH_CTA[mode]}</button>
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
