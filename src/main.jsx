import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { ErrorBoundary } from './ErrorBoundary.jsx';
import './styles/app.css';

// "tiletakeoff.vercel.app." (with a trailing dot) is a separate origin: some
// browsers reject its certificate, it has its own saved data, and sign-up
// links would point back to it. Move to the canonical host before starting.
if (window.location.hostname.endsWith('.')) {
  const url = new URL(window.location.href);
  url.hostname = url.hostname.replace(/\.+$/, '');
  window.location.replace(url.href);
} else {
  createRoot(document.getElementById('root')).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}
