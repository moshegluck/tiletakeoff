import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/app.css';

function MinimalApp() {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      flexDirection: 'column',
      gap: 16,
      fontFamily: 'Inter, sans-serif',
      background: '#0f172a',
      color: '#f1f5f9',
    }}>
      <div style={{fontSize: 48}}>🏠</div>
      <div style={{fontSize: 28, fontWeight: 700}}>TileTakeoff</div>
      <div style={{fontSize: 16, color: '#94a3b8'}}>Loading app... (test build)</div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<MinimalApp />);
