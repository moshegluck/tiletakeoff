// ============================================================
// supabase.js — client singleton. Uses the ANON key only (safe for
// the browser); RLS enforces per-user access server-side. If env vars
// are absent the app runs in local-only mode (no cloud, no auth).
// ============================================================

import { createClient } from '@supabase/supabase-js';

// The deployed env vars point at a Supabase project that has since been
// deleted (edsywvqtlnoyqtsamryn) — every sign-in failed with "Load failed".
// Until the env is updated, route that dead project to the live `tiletakeoff`
// project. The anon key is public by design (RLS protects the data).
const DEAD_REFS = ['edsywvqtlnoyqtsamryn'];
const LIVE_URL = 'https://qgvloanrqzuciuhpepjy.supabase.co';
const LIVE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFndmxvYW5ycXp1Y2l1aHBlcGp5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMzcyNjcsImV4cCI6MjA5OTgxMzI2N30.Q2zI4tSlW04HjOxHEqO9M7YmSLdF2kgOrHJ3Asiw6x0';
const envUrl = import.meta.env.VITE_SUPABASE_URL;
const dead = envUrl && DEAD_REFS.some((r) => envUrl.includes(r));
const url = dead ? LIVE_URL : envUrl;
const anon = dead ? LIVE_ANON : import.meta.env.VITE_SUPABASE_ANON_KEY;

export const cloudEnabled = Boolean(url && anon);

export const supabase = cloudEnabled
  ? createClient(url, anon, { auth: { persistSession: true, autoRefreshToken: true } })
  : null;
