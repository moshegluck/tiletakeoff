import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Three.js is large; split it into its own chunk so the 2D core loads fast
// and the 3D viewer is fetched on demand.
export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          xlsx: ['xlsx'],
          supabase: ['@supabase/supabase-js'],
        },
      },
    },
  },
  server: { port: 5173, host: true },
});
