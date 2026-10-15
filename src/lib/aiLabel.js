// ============================================================
// aiLabel.js — ask the server route to READ room names off the plan
// for rooms the trace already measured (scans have no text layer).
// Geometry never comes from the model — only the names.
// ============================================================
import { supabase, cloudEnabled } from './supabase.js';

const MAX_W = 1800;

async function planToJpeg(src) {
  const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('Could not read plan image')); im.src = src; });
  const k = Math.min(1, MAX_W / img.naturalWidth);
  const cv = document.createElement('canvas');
  cv.width = Math.round(img.naturalWidth * k); cv.height = Math.round(img.naturalHeight * k);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.drawImage(img, 0, 0, cv.width, cv.height);
  const b64 = cv.toDataURL('image/jpeg', 0.85).split(',')[1];
  cv.width = cv.height = 0;
  return { b64, k };
}

/** @returns {Promise<Record<string,{name:string,type:string}>>} by trace room id */
export async function labelRoomsWithAI(state, rooms) {
  if (!state.planImage) throw new Error('No plan image loaded');
  const { b64, k } = await planToJpeg(state.planImage);
  const toImg = (ft) => (ft / state.scale) * k; // feet → model px → downscaled px
  const body = {
    mode: 'label', imageBase64: b64, mediaType: 'image/jpeg',
    rooms: rooms.map((r) => ({ id: r.id, x: toImg(r.center.x), y: toImg(r.center.y), areaSf: r.area })),
  };
  const headers = { 'content-type': 'application/json' };
  if (cloudEnabled && supabase) {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    if (token) headers.authorization = `Bearer ${token}`;
  }
  const res = await fetch('/api/detect-plan', { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error || `AI naming failed (${res.status})`);
  }
  const data = await res.json();
  const out = {};
  for (const r of data.rooms || []) out[r.id] = { name: r.name, type: r.type };
  return out;
}
