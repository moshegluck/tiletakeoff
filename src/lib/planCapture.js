// ============================================================
// planCapture.js — cut the image the AI reads out of the plan that is
// already loaded: the region on screen, or the whole page.
//
// PDFs are re-rendered from the vector page at the highest resolution the
// model reads (2576 px long edge, ~3.75 MP), so a zoomed-in region is much
// sharper than the on-screen underlay. Image plans are cropped from the
// original pixels. Either way the result carries an ImageMap that turns
// detection pixels back into underlay px (see engine/detectMap.js).
// ============================================================

const MAX_EDGE = 2576;
const MAX_PIX = 3_750_000;
// Keep the request well under Vercel's 4.5 MB body limit.
const MAX_B64 = 3_600_000;

/**
 * @param {object} state  store snapshot: pdfDoc, pdfPage, planDpi, planImage, planWidth, planHeight
 * @param {?{x:number,y:number,w:number,h:number}} region  underlay px; null = whole page
 */
export async function capturePlan(state, region) {
  const r = region || { x: 0, y: 0, w: state.planWidth, h: state.planHeight };
  if (!(r.w > 0 && r.h > 0)) throw new Error('No plan loaded.');
  if (state.pdfDoc && state.planDpi > 0) return capturePdf(state, r);
  if (state.planImage) return captureImage(state.planImage, r);
  throw new Error('No plan loaded.');
}

async function capturePdf(state, r) {
  const page = await state.pdfDoc.getPage(state.pdfPage || 1);
  const rs = state.planDpi / 72;              // underlay px per PDF point
  const pts = { x: r.x / rs, y: r.y / rs, w: r.w / rs, h: r.h / rs };
  const k = Math.min(MAX_EDGE / Math.max(pts.w, pts.h), Math.sqrt(MAX_PIX / (pts.w * pts.h)), 12);
  const W = Math.max(16, Math.floor(pts.w * k)), H = Math.max(16, Math.floor(pts.h * k));
  // same orientation as the underlay (renderPage), shifted so the region
  // starts at the canvas origin
  const viewport = page.getViewport({ scale: k, offsetX: -pts.x * k, offsetY: -pts.y * k });
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Could not prepare the plan image.');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  await page.render({ canvasContext: ctx, viewport }).promise;
  // image px → PDF pt → underlay px, exactly (independent of W/H rounding)
  return encode(canvas, { ox: r.x, oy: r.y, rx: rs / k, ry: rs / k });
}

async function captureImage(url, r) {
  const img = await loadImage(url);
  // modest upscaling of a small crop helps the model place walls precisely
  const k = Math.min(2, MAX_EDGE / Math.max(r.w, r.h), Math.sqrt(MAX_PIX / (r.w * r.h)));
  const W = Math.max(16, Math.round(r.w * k)), H = Math.max(16, Math.round(r.h * k));
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Could not prepare the plan image.');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, W, H);
  return encode(canvas, { ox: r.x, oy: r.y, rx: r.w / W, ry: r.h / H });
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read the plan image.'));
    img.src = url;
  });
}

// PNG keeps thin lines and small print crisp; fall back to JPEG when a busy
// sheet makes the PNG too big to send.
async function encode(canvas, map) {
  let blob = null;
  for (const [type, q] of [['image/png'], ['image/jpeg', 0.92], ['image/jpeg', 0.8], ['image/jpeg', 0.65]]) {
    blob = await toBlob(canvas, type, q);
    if (blob && blob.size * 4 / 3 <= MAX_B64) break;
  }
  if (!blob) throw new Error('Could not encode the plan image.');
  const base64 = await blobToBase64(blob);
  const out = {
    blob, base64, mediaType: blob.type || 'image/png',
    width: canvas.width, height: canvas.height, map,
    url: URL.createObjectURL(blob),
  };
  canvas.width = canvas.height = 0; // free the backing store
  return out;
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    if (canvas.toBlob) canvas.toBlob((b) => resolve(b), type, quality);
    else resolve(null);
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const rd = new FileReader();
    rd.onload = () => resolve(String(rd.result).split(',')[1]);
    rd.onerror = () => reject(new Error('Could not read the plan image.'));
    rd.readAsDataURL(blob);
  });
}
