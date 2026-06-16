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
export function onAuthChange(cb) {
  if (!cloudEnabled) return () => {};
  const { data } = supabase.auth.onAuthStateChange((_e, session) => cb(session?.user ?? null));
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
