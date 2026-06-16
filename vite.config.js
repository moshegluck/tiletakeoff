import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks: {
          three:    ['three'],
          xlsx:     ['xlsx'],
          supabase: ['@supabase/supabase-js'],
          pdfjs:    ['pdfjs-dist'],
        },
      },
    },
  },
  server: { port: 5173, host: true },
  // Allow Vite to process pdfjs-dist normally (do NOT exclude from optimizeDeps)
  // The worker file is referenced via new URL(..., import.meta.url) so Vite
  // will copy it to dist/assets automatically.
  worker: {
    format: 'es',
  },
});
