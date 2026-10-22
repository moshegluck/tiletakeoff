import { useState, useEffect } from 'react';
import { useStore, setCloudSaver } from '../state/store.js';
import Modal from './Modal.jsx';
import { cloudEnabled } from '../lib/supabase.js';
import { movePlan } from '../lib/planStore.js';
import { uploadKeptPlan } from '../lib/planLoad.js';
import { setCloudIdLocal } from '../state/projects.js';
import {
  getUser, onAuthChange, signInWithPassword, signUp, signOut,
  resetPasswordForEmail, updatePassword, resendConfirmation, authErrorMessage,
  createProject, saveProject,
} from '../lib/cloud.js';

// Renders the cloud account control (the Projects list is ProjectsDrawer).
// When cloud isn't configured it renders nothing (app stays local-only).
export default function AccountBar() {
  const [user, setUser] = useState(null);
  const [showAuth, setShowAuth] = useState(false);
  const [authMode, setAuthMode] = useState('in');

  // register cloud saver whenever auth state allows it
  useEffect(() => {
    if (!cloudEnabled) return;
    getUser().then(setUser);
    return onAuthChange(setUser);
  }, []);
  // the phone menu shows the account too
  useEffect(() => { useStore.getState().setAuthUser(user ? { email: user.email } : null); }, [user]);

  // the landing page's "Sign in" opens the modal; App re-broadcasts a Supabase
  // password-recovery link as tt:recovery so we can open the set-new-password form
  useEffect(() => {
    const openSignIn = () => { setAuthMode('in'); setShowAuth(true); };
    const openRecovery = () => { setAuthMode('recovery'); setShowAuth(true); };
    window.addEventListener('tt:signin', openSignIn);
    window.addEventListener('tt:recovery', openRecovery);
    return () => {
      window.removeEventListener('tt:signin', openSignIn); window.removeEventListener('tt:recovery', openRecovery);
    };
  }, []);

  useEffect(() => {
    if (!cloudEnabled || !user) { setCloudSaver(null); return; }
    setCloudSaver(async (state) => {
      try {
        if (state.cloudId) await saveProject(state.cloudId, state);
        else {
          const id = await createProject(state);
          // the plan file follows the project to its cloud id, and up to the cloud
          await movePlan(state.cloudId || state.id, id).catch(() => {});
          // (another project may be on screen by now: the cloud id is this one's)
          if (useStore.getState().id === state.id) useStore.getState().setCloudId(id);
          else await setCloudIdLocal(state.id, id);
          uploadKeptPlan(id).catch(() => {});
        }
      } catch (e) { console.warn('cloud save failed', e.message); }
    });
    return () => setCloudSaver(null);
  }, [user]);

  if (!cloudEnabled) return null;

  return (
    <>
      <span className="acct-btns">
      {user ? (
        <>
          <button className="tbtn" title={`Signed in as ${user.email} — sign out`} onClick={() => { if (confirm(`Sign out of ${user.email}?`)) signOut(); }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 4-6 8-6s8 2 8 6" /></svg>
          </button>
        </>
      ) : (
        <button className="tbtn" onClick={() => { setAuthMode('in'); setShowAuth(true); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3" /></svg>Sign in
        </button>
      )}
      </span>
      {showAuth && <AuthModal initialMode={authMode} onClose={() => setShowAuth(false)} />}
    </>
  );
}

const AUTH_TITLE = { in: 'Sign in', up: 'Create account', reset: 'Reset password', recovery: 'Set a new password' };
const AUTH_CTA = { in: 'Sign in', up: 'Sign up', reset: 'Send reset link', recovery: 'Update password' };

function AuthModal({ onClose, initialMode = 'in' }) {
  const [mode, setMode] = useState(initialMode);
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);

  const needsEmail = mode !== 'recovery';
  const needsPw = mode !== 'reset';
  const canSubmit = (!needsEmail || !!email) && (!needsPw || !!pw);
  const to = (m) => () => { setMode(m); setErr(''); setMsg(''); setUnconfirmed(false); };

  async function go() {
    if (!canSubmit) return;
    setBusy(true); setErr(''); setMsg(''); setUnconfirmed(false);
    try {
      if (mode === 'in') { await signInWithPassword(email.trim(), pw); onClose(); }
      else if (mode === 'up') {
        const { session } = await signUp(email.trim(), pw);
        if (session) { onClose(); return; }
        // the project requires email confirmation: say so instead of closing
        setMode('in'); setPw('');
        setMsg(`Account created. We emailed a confirmation link to ${email.trim()} — open it (check spam), then sign in here.`);
      }
      else if (mode === 'reset') { await resetPasswordForEmail(email.trim()); setMsg('If that email has an account, a reset link is on its way. Check your inbox (and spam).'); }
      else if (mode === 'recovery') { await updatePassword(pw); setMsg('Password updated — you’re signed in.'); setTimeout(onClose, 1200); }
    } catch (e) {
      setErr(authErrorMessage(e));
      setUnconfirmed(e?.code === 'email_not_confirmed' || /email not confirmed/i.test(String(e?.message)));
    } finally { setBusy(false); }
  }

  async function resend() {
    setBusy(true); setErr(''); setMsg('');
    try { await resendConfirmation(email.trim()); setMsg('Confirmation email sent again. Open the link, then sign in.'); setUnconfirmed(false); }
    catch (e) { setErr(authErrorMessage(e)); }
    finally { setBusy(false); }
  }

  return (
    <Modal title={AUTH_TITLE[mode]} onClose={onClose} width={400} closeOnBackdrop={false}>
      <form className="auth-form" onSubmit={(e) => { e.preventDefault(); if (!busy && canSubmit) go(); }}>
        <div className="body">
          {mode === 'reset' && <div className="note">Enter your account email and we’ll send a password-reset link.</div>}
          {mode === 'recovery' && <div className="note">Choose a new password for your account.</div>}
          {needsEmail && (
            <div className="field"><label>Email</label>
              <input className="inp" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          )}
          {needsPw && (
            <div className="field"><label>{mode === 'recovery' ? 'New password' : 'Password'}</label>
              <input className="inp" type="password" autoComplete={mode === 'in' ? 'current-password' : 'new-password'} value={pw} onChange={(e) => setPw(e.target.value)} /></div>
          )}
          {err && <div className="note" style={{ color: 'var(--bad)' }}>{err}</div>}
          {unconfirmed && <div className="note"><button type="button" className="linkbtn" onClick={resend}>Resend confirmation email</button></div>}
          {msg && <div className="note" style={{ color: 'var(--ok)' }}>{msg}</div>}

          {mode === 'in' && (
            <>
              <div className="note"><button type="button" className="linkbtn" onClick={to('reset')}>Forgot password?</button></div>
              <div className="note">No account? <button type="button" className="linkbtn" onClick={to('up')}>Create one</button></div>
            </>
          )}
          {mode === 'up' && (
            <div className="note">Have an account? <button type="button" className="linkbtn" onClick={to('in')}>Sign in</button></div>
          )}
          {mode === 'reset' && (
            <div className="note"><button type="button" className="linkbtn" onClick={to('in')}>← Back to sign in</button></div>
          )}
        </div>
        <div className="foot">
          <button type="button" className="tbtn" onClick={onClose}>Cancel</button>
          <button type="submit" className="tbtn primary" disabled={busy || !canSubmit}>
            {busy ? '…' : AUTH_CTA[mode]}</button>
        </div>
      </form>
    </Modal>
  );
}
