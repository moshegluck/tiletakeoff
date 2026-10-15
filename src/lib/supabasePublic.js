// ============================================================
// supabasePublic.js — the app's Supabase project, and how the build
// (vite.config.js) and the API (api/detect-plan.js) pick which project
// to talk to. The URL and anon key are PUBLIC by design: they ship in
// every browser bundle, and Row Level Security protects the data.
//
// The env vars (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY, or SUPABASE_*
// on the server) still choose the project. But when they name a project
// whose host no longer exists (a deleted project's subdomain stops
// resolving), nobody can sign in and AI Detect is locked, so we fall back
// to this live project and say so in the build/function logs.
// ============================================================

export const SUPABASE_PROJECT = {
  // Supabase project "tiletakeoff"
  url: 'https://qgvloanrqzuciuhpepjy.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFndmxvYW5ycXp1Y2l1aHBlcGp5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMzcyNjcsImV4cCI6MjA5OTgxMzI2N30.Q2zI4tSlW04HjOxHEqO9M7YmSLdF2kgOrHJ3Asiw6x0',
};

// DNS answers that mean "this host does not exist" (vs. a transient failure).
const GONE = new Set(['ENOTFOUND', 'ENODATA']);

/**
 * Pick the Supabase project to use.
 *  - no env config  → none (the app runs local-only, as before)
 *  - env host exists → the env project
 *  - env host gone / URL invalid → the live project above
 * A transient DNS error keeps the env config rather than guessing.
 * @param {{ url?: string, anonKey?: string }} env
 * @param {(host: string) => Promise<unknown>} lookup  rejects when the host doesn't resolve
 * @returns {Promise<{ url: string, anonKey: string, source: 'env'|'fallback'|'none', reason?: string }>}
 */
export async function resolveSupabase(env, lookup) {
  const url = String(env?.url || '').trim();
  const anonKey = String(env?.anonKey || '').trim();
  if (!url || !anonKey) return { url: '', anonKey: '', source: 'none' };
  let host;
  try { host = new URL(url).hostname; } catch (_) {
    return { ...SUPABASE_PROJECT, source: 'fallback', reason: `"${url}" is not a valid URL` };
  }
  if (host === new URL(SUPABASE_PROJECT.url).hostname) return { url, anonKey, source: 'env' };
  try {
    await lookup(host);
    return { url, anonKey, source: 'env' };
  } catch (e) {
    if (GONE.has(e?.code)) return { ...SUPABASE_PROJECT, source: 'fallback', reason: `${host} no longer exists` };
    return { url, anonKey, source: 'env' };
  }
}
