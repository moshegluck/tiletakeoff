// ============================================================
// aiDetect.js — client wrapper for the /api/detect-plan route.
// Posts one captured plan image (see planCapture.js) and returns the
// rooms the AI found, in that image's pixels. The UI maps them onto the
// plan and lets the user review before anything is added.
//
// When cloud (Supabase) is configured, the server requires a valid
// session, so we attach the access token. Without cloud the route runs
// open (IP rate-limited) and no token is needed.
// ============================================================

import { supabase, cloudEnabled } from './supabase.js';

/**
 * @param {{ base64: string, mediaType: string, width: number, height: number }} capture
 * @param {number} [feetPerPixel]  drawing scale for this image, if known
 * @returns {Promise<{ rooms: import('../engine/detectMap.js').Detection[], warning?: string }>}
 */
export async function detectRooms(capture, feetPerPixel) {
  const headers = { 'content-type': 'application/json' };
  if (cloudEnabled && supabase) {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    if (token) headers.authorization = `Bearer ${token}`;
  }
  let res;
  try {
    res = await fetch('/api/detect-plan', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        imageBase64: capture.base64, mediaType: capture.mediaType,
        imageWidth: capture.width, imageHeight: capture.height,
        feetPerPixel: feetPerPixel > 0 ? feetPerPixel : undefined,
      }),
    });
  } catch (_) {
    throw new Error('Could not reach the server. Check your connection and try again.');
  }
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    const err = new Error(e.error || (res.status === 504
      ? 'The AI took too long on this plan. Zoom in on part of it and try again.'
      : `Detection failed (${res.status}).`));
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return { rooms: Array.isArray(data.rooms) ? data.rooms : [], warning: data.warning };
}
