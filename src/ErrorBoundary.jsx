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
          padding: 24, fontFamily: 'monospace', background: '#1e1e1e', color: '#f44',
          minHeight: '100vh', whiteSpace: 'pre-wrap', fontSize: 13
        }}>
          <div style={{fontSize: 18, fontWeight: 'bold', marginBottom: 12}}>
            🔴 App Error (please screenshot this)
          </div>
          <div style={{color: '#ff8', marginBottom: 8}}>{e.message}</div>
          <div style={{color: '#aaa', fontSize: 11}}>{e.stack}</div>
        </div>
      );
    }
    return this.props.children;
  }
}
