// ============================================================
// /api/detect-plan.js — Vercel serverless function.
// Receives a base64 floor-plan image/PDF page + a known scale,
// asks Claude (vision) to return rooms as polygons in feet.
// The ANTHROPIC_API_KEY lives in an env var and never reaches
// the browser. Two-pass design: pass 1 extracts rooms + dims,
// the client lets the user correct, then re-runs if needed.
// ============================================================

export const config = { maxDuration: 60 };

const SYSTEM = `You are a flooring takeoff assistant analyzing an architectural floor plan image.
Extract EVERY enclosed room/space you can identify. Do not filter by room type and do not
decide what gets tiled — the contractor makes scope decisions. For each room return its
rectangular footprint (or bounding box if irregular) with real-world dimensions in FEET.

Rules:
- Read dimension strings and scale bars when present; otherwise estimate from the given pixelsPerFoot.
- Return decimal feet (e.g. 12.5), not feet-inches strings.
- Coordinates: top-left origin, +x right, +y down, in FEET from the plan's top-left.
- If unsure of a label, use a generic name (e.g. "Room A").

Respond with ONLY valid JSON, no markdown, in this exact shape:
{"rooms":[{"name":"Kitchen","x":0,"y":0,"w":12.5,"h":10,"confidence":0.0-1.0}]}`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'Server missing ANTHROPIC_API_KEY' });

  try {
    const { imageBase64, mediaType = 'image/png', pixelsPerFoot } = req.body || {};
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });

    const userText = pixelsPerFoot
      ? `The plan is rendered at approximately ${pixelsPerFoot} pixels per foot. Extract all rooms.`
      : `No scale provided. Use visible dimension strings or a scale bar to infer real feet. Extract all rooms.`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: SYSTEM,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
            { type: 'text', text: userText },
          ],
        }],
      }),
    });

    if (!r.ok) {
      const detail = await r.text();
      return res.status(502).json({ error: 'Anthropic API error', detail });
    }
    const data = await r.json();
    const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    const clean = text.replace(/```json|```/g, '').trim();

    let parsed;
    try { parsed = JSON.parse(clean); }
    catch { return res.status(200).json({ rooms: [], raw: clean, warning: 'Model returned non-JSON' }); }

    return res.status(200).json({ rooms: parsed.rooms || [] });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
}
