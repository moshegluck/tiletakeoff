// ============================================================
// aiDetect.js — client wrapper for the /api/detect-plan route.
// Converts a File (image) to base64 and posts it. The result is
// a list of room rectangles in feet that the UI lets the user
// review and edit before committing (hybrid detection).
// ============================================================

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const result = r.result;
      const base64 = String(result).split(',')[1];
      resolve({ base64, mediaType: file.type || 'image/png' });
    };
    r.onerror = () => reject(new Error('Read failed'));
    r.readAsDataURL(file);
  });
}

export async function detectRooms(file, pixelsPerFoot) {
  const { base64, mediaType } = await fileToBase64(file);
  const res = await fetch('/api/detect-plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ imageBase64: base64, mediaType, pixelsPerFoot }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error || `Detection failed (${res.status})`);
  }
  const data = await res.json();
  return data.rooms || [];
}
