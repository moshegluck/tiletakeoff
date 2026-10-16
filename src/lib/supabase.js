// ============================================================
// supabase.js — client singleton. Uses the ANON key only (safe for
// the browser); RLS enforces per-user access server-side. If env vars
// are absent the app runs in local-only mode (no cloud, no auth).
// ============================================================

import { createClient } from '@supabase/supabase-js';
import { SUPABASE_PROJECT } from './supabasePublic.js';

// The deployed env vars may still name a deleted Supabase project
// (edsywvqtlnoyqtsamryn); every sign-in then fails with "Load failed". The
// build (vite.config.js) already swaps a project whose host is gone for the
// live one; this catches that project even if the build-time check couldn't
// tell. The anon key is public by design (RLS protects the data).
const DEAD_REFS = ['edsywvqtlnoyqtsamryn'];
const envUrl = import.meta.env.VITE_SUPABASE_URL;
const dead = envUrl && DEAD_REFS.some((r) => envUrl.includes(r));
const url = dead ? SUPABASE_PROJECT.url : envUrl;
const anon = dead ? SUPABASE_PROJECT.anonKey : import.meta.env.VITE_SUPABASE_ANON_KEY;

export const cloudEnabled = Boolean(url && anon);

export const supabase = cloudEnabled
  ? createClient(url, anon, { auth: { persistSession: true, autoRefreshToken: true } })
  : null;
