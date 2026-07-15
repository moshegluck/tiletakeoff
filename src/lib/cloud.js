// ============================================================
// cloud.js — project persistence against Supabase.
// The store remains the source of truth; this maps the store's
// document shape <-> the projects table. Auth helpers included.
// All functions no-op safely when cloud is disabled.
// ============================================================

import { supabase, cloudEnabled } from './supabase.js';
import { estimateProject } from '../engine/estimate.js';
import { polygonArea } from '../engine/geometry.js';

// ---- auth ----
export async function getUser() {
  if (!cloudEnabled) return null;
  const { data } = await supabase.auth.getUser();
  return data?.user ?? null;
}
export async function signInWithEmail(email) {
  if (!cloudEnabled) throw new Error('Cloud not configured');
  const { error } = await supabase.auth.signInWithOtp({
    email, options: { emailRedirectTo: window.location.origin },
  });
  if (error) throw error;
}
export async function signInWithPassword(email, password) {
  if (!cloudEnabled) throw new Error('Cloud not configured');
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.user;
}
export async function signUp(email, password) {
  if (!cloudEnabled) throw new Error('Cloud not configured');
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
  return data.user;
}
export async function signOut() {
  if (cloudEnabled) await supabase.auth.signOut();
}
// Email the account a password-reset link. The link returns to this origin with
// a recovery token; supabase-js then fires a PASSWORD_RECOVERY auth event.
export async function resetPasswordForEmail(email) {
  if (!cloudEnabled) throw new Error('Cloud not configured');
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin,
  });
  if (error) throw error;
}
// Set a new password for the current (recovery or signed-in) session.
export async function updatePassword(password) {
  if (!cloudEnabled) throw new Error('Cloud not configured');
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw error;
}
export function onAuthChange(cb) {
  if (!cloudEnabled) return () => {};
  const { data } = supabase.auth.onAuthStateChange((_e, session) => cb(session?.user ?? null));
  return () => data.subscription.unsubscribe();
}
// Like onAuthChange but also passes the event name (needed for PASSWORD_RECOVERY).
export function onAuthEvent(cb) {
  if (!cloudEnabled) return () => {};
  const { data } = supabase.auth.onAuthStateChange((event, session) => cb(event, session?.user ?? null));
  return () => data.subscription.unsubscribe();
}

// ---- document mapping ----
function toDoc(state) {
  // NOTE: planImage (a rendered PDF page / uploaded raster) is intentionally
  // NOT sent to the cloud. It can be multiple MB as a base64 dataURL, which
  // bloats every row and can exceed request limits. It stays in localStorage
  // for the working session; rooms/markups/scale are the durable takeoff data.
  // Small uploaded images (< ~600KB) are kept so light plans still round-trip.
  const keepImage = typeof state.planImage === 'string' && state.planImage.length < 600_000;
  return {
    scale: state.scale, archScale: state.archScale,
    rooms: state.rooms, materials: state.materials, markups: state.markups,
    taxRate: state.taxRate, laborRatePerSf: state.laborRatePerSf,
    view: state.view, planImage: keepImage ? state.planImage : null,
  };
}
function headline(state) {
  const floorSf = state.rooms.reduce((s, r) => s + (state.scale ? polygonArea(r.points) : 0), 0);
  let total = 0;
  try { total = estimateProject(state).total; } catch (_) {}
  return { floorSf, total };
}

// ---- CRUD ----
export async function listProjects() {
  if (!cloudEnabled) return [];
  const { data, error } = await supabase
    .from('projects').select('id,name,floor_sf,total_cost,updated_at,archived')
    .eq('archived', false).order('updated_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function loadProject(id) {
  if (!cloudEnabled) return null;
  const { data, error } = await supabase.from('projects').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

export async function createProject(state) {
  if (!cloudEnabled) throw new Error('Cloud not configured');
  const user = await getUser();
  if (!user) throw new Error('Not signed in');
  const { floorSf, total } = headline(state);
  const { data, error } = await supabase.from('projects').insert({
    owner: user.id, name: state.name, unit_system: state.unitSystem,
    doc: toDoc(state), floor_sf: floorSf, total_cost: total,
  }).select('id').single();
  if (error) throw error;
  return data.id;
}

export async function saveProject(id, state) {
  if (!cloudEnabled || !id) return;
  const { floorSf, total } = headline(state);
  const { error } = await supabase.from('projects').update({
    name: state.name, unit_system: state.unitSystem,
    doc: toDoc(state), floor_sf: floorSf, total_cost: total,
  }).eq('id', id);
  if (error) throw error;
}

export async function deleteProject(id) {
  if (!cloudEnabled) return;
  const { error } = await supabase.from('projects').delete().eq('id', id);
  if (error) throw error;
}

// ---- tile library (shared across a user's projects; RLS-scoped per user) ----
export async function listTiles() {
  if (!cloudEnabled) return [];
  const { data, error } = await supabase
    .from('tile_library').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function addTile(tile) {
  if (!cloudEnabled) throw new Error('Cloud not configured');
  const user = await getUser();
  if (!user) throw new Error('Not signed in');
  const num = (v) => (Number.isFinite(+v) ? +v : null);
  const row = {
    owner: user.id,
    name: (tile.name || 'Tile').slice(0, 120),
    tw_in: num(tile.tw_in) ?? 12,
    th_in: num(tile.th_in) ?? 12,
    thickness_mm: num(tile.thickness_mm),
    material: tile.material || null,
    finish: tile.finish || null,
    sku: tile.sku || null,
    vendor: tile.vendor || null,
    price: num(tile.price),
    price_unit: tile.price_unit || 'sf',
    sf_per_box: num(tile.sf_per_box),
  };
  const { data, error } = await supabase.from('tile_library').insert(row).select('*').single();
  if (error) throw error;
  return data;
}

export async function deleteTile(id) {
  if (!cloudEnabled) return;
  const { error } = await supabase.from('tile_library').delete().eq('id', id);
  if (error) throw error;
}
