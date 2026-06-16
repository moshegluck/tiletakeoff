import React from 'react';

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error('App crashed:', error, info);
  }
  render() {
    if (this.state.error) {
      const e = this.state.error;
      return (
        <div style={{
          minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: '#0f2f47', color: '#eef3f7', padding: 24,
          fontFamily: '-apple-system, Segoe UI, Roboto, sans-serif',
        }}>
          <div style={{ maxWidth: 460, textAlign: 'center' }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>⚠️</div>
            <h1 style={{ fontSize: 20, margin: '0 0 8px' }}>Something went wrong</h1>
            <p style={{ color: '#aebfcd', fontSize: 14, lineHeight: 1.5, margin: '0 0 20px' }}>
              The app hit an unexpected error. Your work is saved in this browser —
              reloading the page usually clears it.
            </p>
            <button
              onClick={() => window.location.reload()}
              style={{
                background: '#c8521f', color: '#fff', border: 'none', borderRadius: 8,
                padding: '10px 22px', fontSize: 14, fontWeight: 600, cursor: 'pointer',
              }}
            >
              Reload app
            </button>
            <details style={{ marginTop: 24, textAlign: 'left' }}>
              <summary style={{ cursor: 'pointer', color: '#8ba3b8', fontSize: 12 }}>
                Technical details
              </summary>
              <div style={{
                marginTop: 10, padding: 12, background: '#0a2235', borderRadius: 6,
                fontFamily: 'ui-monospace, monospace', fontSize: 11, color: '#cdd8e2',
                whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto',
              }}>
                <div style={{ color: '#ffb3a0', marginBottom: 6 }}>{e.message}</div>
                {e.stack}
              </div>
            </details>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
