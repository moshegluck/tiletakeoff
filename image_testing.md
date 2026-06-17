# Image Integration Testing Rules
- Use base64-encoded JPEG/PNG/WEBP images with real visual features (objects, edges, textures).
- Do not use blank/solid-color images or SVG/BMP/HEIC.
- Resize large images to reasonable bounds.
- For TileTakeoff AI: upload an architectural floor plan image (PNG/JPG) to a project, attach it to a takeoff, then call POST /api/takeoffs/{id}/ai-analyze. AI uses Gemini 3.1 Pro vision and returns JSON {regions, openings, recommended_waste_pct, summary}.
