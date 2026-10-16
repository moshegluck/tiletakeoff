// ============================================================
// cloud.js — project persistence against Supabase.
// The store remains the source of truth; this maps the store's
// document shape <-> the projects table. Auth helpers included.
// All functions no-op safely when cloud is disabled.
// ============================================================

import { supabase, cloudEnabled } from './supabase.js';
import { estimateProject } from '../engine/estimate.js';
import { polygonArea } from '../engine/geometry.js';
import { slimTrace } from '../state/slimTrace.js';

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
// Returns { user, session }. session is null when the project requires email
// confirmation: the account exists but can't sign in until the link is clicked.
export async function signUp(email, password) {
  if (!cloudEnabled) throw new Error('Cloud not configured');
  const { data, error } = await supabase.auth.signUp({
    email, password, options: { emailRedirectTo: window.location.origin },
  });
  if (error) throw error;
  return { user: data.user, session: data.session };
}
// Send the sign-up confirmation link again.
export async function resendConfirmation(email) {
  if (!cloudEnabled) throw new Error('Cloud not configured');
  const { error } = await supabase.auth.resend({
    type: 'signup', email, options: { emailRedirectTo: window.location.origin },
  });
  if (error) throw error;
}
// Plain-language message for a Supabase auth failure. Keeps `code` so the UI
// can offer the right next step (e.g. resend the confirmation email).
export function authErrorMessage(e) {
  const code = e?.code || '';
  const msg = String(e?.message || '');
  if (e?.name === 'AuthRetryableFetchError' || /failed to fetch|networkerror|load failed|network request failed/i.test(msg)) {
    return "Can't reach the account server. Check your internet connection; if it keeps happening, the app's Supabase settings (VITE_SUPABASE_URL) are pointing at a project that's down.";
  }
  if (code === 'email_not_confirmed' || /email not confirmed/i.test(msg)) return 'Your email isn’t confirmed yet. Open the confirmation link we emailed you (check spam), or send it again below.';
  if (code === 'invalid_credentials' || /invalid login credentials/i.test(msg)) return 'Wrong email or password. No account yet? Create one below.';
  if (code === 'user_already_exists' || code === 'email_exists' || /already registered/i.test(msg)) return 'An account with this email already exists. Sign in instead, or reset the password.';
  if (code === 'over_email_send_rate_limit' || /rate limit/i.test(msg)) return 'Too many emails were sent just now. Wait a few minutes and try again.';
  if (code === 'email_address_not_authorized') return 'The app’s email service can’t send to this address yet (Supabase’s built-in email only reaches your team’s addresses). Set up custom SMTP in Supabase, or turn off “Confirm email”.';
  if (code === 'signup_disabled') return 'New accounts are turned off for this app.';
  return msg || 'Something went wrong. Please try again.';
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
    trace: slimTrace(state.trace), layoutsV2: true, planFile: state.planFile || null,
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
  // its plan file goes with it
  const user = await getUser().catch(() => null);
  if (user) await supabase.storage.from(PLAN_BUCKET).remove([`${user.id}/${id}`]).catch(() => {});
}

// ---- plan files: the PDF / image a project is drawn on, one per project,
// in the private "plans" bucket under the user's own folder (RLS) ----
const PLAN_BUCKET = 'plans';

/**
 * Upload a project's plan file (replacing any earlier one).
 * @returns {Promise<{path:string,name:string,type:string,kind:string,page:number,size:number,at:number} | null>}
 *   what the project records about it, or null when not signed in
 */
export async function uploadPlanFile(projectId, blob, meta) {
  if (!cloudEnabled || !projectId || !blob) return null;
  const user = await getUser();
  if (!user) return null;
  const path = `${user.id}/${projectId}`;
  const type = meta.type || blob.type || (meta.kind === 'pdf' ? 'application/pdf' : 'image/png');
  // Send the bytes with an explicit type. A Blob goes up as a form part typed
  // by the browser, and a file read back from storage on an iPhone can come
  // back untyped — which the bucket rejects as not a PDF / image.
  const bytes = await blob.arrayBuffer();
  if (!bytes.byteLength) throw new Error('the plan file could not be read on this device');
  const { error } = await supabase.storage.from(PLAN_BUCKET).upload(path, bytes, { upsert: true, contentType: type, cacheControl: '3600' });
  if (error) throw error;
  return { path, name: meta.name || 'plan', type, kind: meta.kind, page: meta.page || 1, size: blob.size, at: Date.now() };
}

/** @returns {Promise<Blob>} */
export async function downloadPlanFile(path) {
  const { data, error } = await supabase.storage.from(PLAN_BUCKET).download(path);
  if (error) throw error;
  return data;
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
  const { data, error } = await supabase.from('tile_library').insert({ owner: user.id, ...tileRow(tile) }).select('*').single();
  if (error) throw error;
  return data;
}

export async function updateTile(id, tile) {
  if (!cloudEnabled) throw new Error('Cloud not configured');
  const { data, error } = await supabase.from('tile_library').update(tileRow(tile)).eq('id', id).select('*').single();
  if (error) throw error;
  return data;
}

// a library tile as a tile_library row (sizes in inches)
function tileRow(tile) {
  const num = (v) => (Number.isFinite(+v) && v !== '' && v != null ? +v : null);
  return {
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
    kind: tile.kind === 'wall' ? 'wall' : 'floor',
    pattern: tile.pattern || 'grid',
    angle_deg: num(tile.angle_deg) ?? 0,
    grout_in: num(tile.grout_in) ?? 0.125,
    color: tile.color || null,
    finish_style: tile.finish_style || null,
    waste_pct: num(tile.waste_pct),
  };
}

export async function deleteTile(id) {
  if (!cloudEnabled) return;
  const { error } = await supabase.from('tile_library').delete().eq('id', id);
  if (error) throw error;
}
