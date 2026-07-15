import { cloudEnabled } from '../lib/supabase.js';

// Front-door splash. "Get started" opens the takeoff tool; "Sign in" (only when
// cloud is configured) opens the tool and triggers the auth modal. Shown on the
// first visit; App remembers the choice so returning users skip straight in.
const FEATURES = [
  { t: '2D & PDF takeoff', d: 'Trace rooms to scale or measure directly on a plan PDF.' },
  { t: 'Cut-reuse engine', d: 'Sizes every cut and reuses offcuts, so you order what you actually need.' },
  { t: '3D viewer', d: 'Extrude rooms to walls and tile the floors — live.' },
  { t: 'AI plan detection', d: 'Upload a floor plan; Claude proposes editable rooms.' },
  { t: 'Estimate & export', d: 'Waste or cut costing, labor and tax → CSV, Excel, JSON.' },
];

const Logo = () => (
  <svg viewBox="0 0 32 32" aria-hidden>
    <rect x="2" y="2" width="13" height="13" rx="2" fill="#e0762f" />
    <rect x="17" y="2" width="13" height="13" rx="2" fill="#fff" />
    <rect x="2" y="17" width="13" height="13" rx="2" fill="#fff" />
    <rect x="17" y="17" width="13" height="13" rx="2" fill="#e0762f" />
  </svg>
);

export default function Landing({ onStart, onSignIn }) {
  return (
    <div className="landing">
      <div className="landing-grid" aria-hidden />

      <header className="landing-top">
        <div className="brand"><Logo /><b>Tile<span>Takeoff</span></b></div>
        {cloudEnabled && <button className="lbtn ghost sm" onClick={onSignIn}>Sign in</button>}
      </header>

      <main className="landing-hero">
        <div className="tagline-pill">Professional flooring takeoff</div>
        <h1>Flooring takeoff, estimating<br />&amp; 3D — right in your browser.</h1>
        <p className="lead">
          Trace rooms to scale, optimize tile cuts with real offcut reuse, visualize the
          job in 3D, and export a complete estimate. No installs, no spreadsheets.
        </p>
        <div className="landing-cta">
          <button className="lbtn primary" onClick={onStart}>Get started →</button>
          {cloudEnabled && <button className="lbtn ghost" onClick={onSignIn}>Sign in</button>}
        </div>
        <div className="landing-features">
          {FEATURES.map((f) => (
            <div className="lfeat" key={f.t}>
              <div className="lfeat-t">{f.t}</div>
              <div className="lfeat-d">{f.d}</div>
            </div>
          ))}
        </div>
      </main>

      <footer className="landing-foot">
        Runs entirely in your browser · your work saves locally{cloudEnabled ? ' · sign in to sync to the cloud' : ''}
      </footer>
    </div>
  );
}
