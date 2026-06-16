// ============================================================
// supabase.js — client singleton. Uses the ANON key only (safe for
// the browser); RLS enforces per-user access server-side. If env vars
// are absent the app runs in local-only mode (no cloud, no auth).
// ============================================================

import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const cloudEnabled = Boolean(url && anon);

export const supabase = cloudEnabled
  ? createClient(url, anon, { auth: { persistSession: true, autoRefreshToken: true } })
  : null;
