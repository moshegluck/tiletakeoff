import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Keep React in its own chunk — avoids TDZ when Rollup inlines
          // CJS react-dom.production.min.js alongside our ES module code
          if (id.includes('node_modules/react/') ||
              id.includes('node_modules/react-dom/') ||
              id.includes('node_modules/scheduler/')) {
            return 'react-vendor';
          }
          if (id.includes('node_modules/three/'))    return 'three';
          if (id.includes('node_modules/exceljs/'))  return 'exceljs';
          if (id.includes('node_modules/@supabase/')) return 'supabase';
          if (id.includes('node_modules/pdfjs-dist/')) return 'pdfjs';
        },
      },
    },
  },
  server: { port: 5173, host: true },
});
