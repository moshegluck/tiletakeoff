import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { ErrorBoundary } from './ErrorBoundary.jsx';
import './styles/app.css';
import { isStaleBuild, reloadForUpdate, UPDATE_NOTE } from './lib/appUpdate.js';

// "tiletakeoff.vercel.app." (with a trailing dot) is a separate origin: some
// browsers reject its certificate, it has its own saved data, and sign-up
// links would point back to it. Move to the canonical host before starting.
if (window.location.hostname.endsWith('.')) {
  const url = new URL(window.location.href);
  url.hostname = url.hostname.replace(/\.+$/, '');
  window.location.replace(url.href);
} else {
  // iPhone Safari zooms the whole page on a pinch even where the app handles
  // its own pinch (the plan); a zoomed page leaves the app stuck magnified.
  for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
  }
  // a code file from before the latest deploy is gone: reload onto the new one
  window.addEventListener('vite:preloadError', () => { reloadForUpdate(UPDATE_NOTE); });
  window.addEventListener('unhandledrejection', (e) => { if (isStaleBuild(e.reason)) reloadForUpdate(UPDATE_NOTE); });
  createRoot(document.getElementById('root')).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}
