import dns from 'node:dns/promises';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { resolveSupabase } from './src/lib/supabasePublic.js';

export default defineConfig(async ({ mode }) => {
  // If the configured Supabase project no longer exists, build against the
  // app's live project instead of shipping a sign-in that can never work.
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const sb = await resolveSupabase(
    { url: env.VITE_SUPABASE_URL, anonKey: env.VITE_SUPABASE_ANON_KEY },
    (host) => dns.lookup(host),
  );
  if (sb.source === 'fallback') {
    console.warn(`[supabase] ${sb.reason}; building against ${sb.url}. Update VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY.`);
  }

  return {
    plugins: [react()],
    define: sb.source === 'fallback' ? {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(sb.url),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(sb.anonKey),
    } : {},
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
  };
});
