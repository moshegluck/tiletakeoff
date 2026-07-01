# TileTakeoff

Professional flooring takeoff, estimating & 3D visualization. React + Vite, deploys to Vercel. AI floor-plan detection runs through a serverless route so the Anthropic key stays server-side. Project data persists in the browser (localStorage) — no database required for v1.

## Features

- **2D takeoff** — draw rectangle rooms, trace polygon rooms, calibrate scale with the ruler, pan/zoom, move/resize, plan-image underlay.
- **PDF takeoff** — load a plan PDF, render any page into the canvas, page-to-page navigation, then calibrate scale and measure directly on the drawing.
- **Markups (Bluebeam-style)** — Length, Area, Box, and Count measurement tools with per-markup unit cost, line cost, notes, and a measurement log that totals by type. Hotkeys M / A / B / C.
- **All measurement types** — feet-inches (fractions), decimal feet, inches, meters, cm, mm. Switch any time; everything re-renders.
- **Tile layouts** — straight grid, running brick (50% / 33%), herringbone, diagonal 45°, basketweave, with rotation. Full vs. cut tiles shaded on canvas.
- **Cut-redistribution engine** — sizes every cut piece via exact polygon clipping, tracks offcuts, and reuses them on other cuts (with chained reuse and grain-lock for planks). Two modes: practical first-fit and whole-job best-fit optimize. Reports real tiles ordered vs. naive waste %, with the tiles saved.
- **Installer cut sheet** — per-room summary, consolidated batch cut list, and a tile-by-tile cutting plan showing which offcut feeds which cut. Print-ready.
- **Tile library** — square, rectangle/subway, plank, mosaic, and metric sizes; grout-joint presets; pattern-based waste suggestions.
- **Estimate engine** — per material choose Waste% or Cut-reuse costing; full tiles + broken-for-cuts + safety margin → order qty (sf/tile/box), plus labor $/sf and tax.
- **3D viewer** — extrudes rooms to walls and tiles the floors; orbit / zoom / pan.
- **AI detection (hybrid)** — upload a floor-plan image, Claude (via the official Anthropic SDK, using **structured outputs** for guaranteed-valid room data and high-resolution vision) proposes rooms as editable rectangles, you review/correct before committing.
- **Cloud (optional)** — Supabase auth + per-user projects with Row Level Security; auto-saves your work. Runs local-only (localStorage) if Supabase env vars are absent.
- **Export** — CSV, multi-sheet Excel (.xlsx), and re-importable JSON.

## Testing

The engine layer (geometry, units, layouts, cut redistribution, estimate,
markups, cut sheet) has a Vitest suite — 82 tests covering correctness and the
defensive/edge cases that cause silent financial errors (undefined tile sizes,
zero-area rooms, unassigned materials, degenerate polygons, the
never-exceed-naive invariant on the cut optimizer, and HTML-injection escaping
in the cut sheet).

```bash
npm test          # run once
npm run test:watch
```

These cover the pure engine — the code that produces order quantities and costs.
UI components are not yet covered.

## Cloud setup (Supabase)

1. Create a Supabase project.
2. Run the migration in `supabase/migrations/0001_init.sql` (SQL editor or `supabase db push`). It creates the `projects` and `tile_library` tables **with RLS enabled** — users only see their own rows.
3. Add front-end env vars (safe to expose; the anon key is protected by RLS):
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. Enable Email auth in Supabase → Authentication. Done — the Sign in / Projects buttons appear automatically.

Without these vars the app still works fully, saving locally in the browser.

## Local development

```bash
npm install
npm run dev          # http://localhost:5173
```

The AI Detect button calls `/api/detect-plan`, which only exists when running on
Vercel (or `vercel dev`). To test it locally:

```bash
npm i -g vercel
vercel dev
```

Set the key first (see below). Without it, the rest of the app works fully; only
AI detection is disabled.

## Deploy to Vercel

1. Push this repo to GitHub.
2. In Vercel: **New Project → import the repo**. Framework preset = Vite (auto-detected).
3. Add environment variable:
   - `ANTHROPIC_API_KEY` = your key
   - (optional) `ANTHROPIC_MODEL` = `claude-sonnet-5` (the default; any
     vision-capable Claude model works)
4. Deploy. The static site builds to `dist/`; `api/detect-plan.js` becomes a
   serverless function automatically.

The `/api/detect-plan` route is hardened: it caps image size, allow-lists the
media type, validates the model's JSON, and never leaks upstream error detail.
When the Supabase env vars are also present on the server it **requires a
signed-in session** and rate-limits per user, so the Anthropic key can't be
spent by anonymous callers; without Supabase it runs open with a per-IP rate
limit. (The in-memory rate limit is per warm instance — for multi-instance
production hardening, back it with Vercel KV / Upstash.)

## Architecture

```
src/
  engine/      units, geometry, layouts, estimate   (pure, framework-free)
  data/        tileCatalog                            (libraries)
  state/       store.js (Zustand + localStorage)
  components/  Canvas2D, Viewer3D, Panels, DetectModal
  three/       scene3d.js (lazy chunk)
  lib/         export.js, aiDetect.js
api/
  detect-plan.js  Vercel serverless route (key in env)
```

The engine layer has no React/DOM dependencies, so the math is unit-testable and
reusable (e.g. a future Supabase/multi-user backend can call it directly).

## Roadmap (not yet built)

- Pattern-accurate herringbone/pinwheel/versailles fragment geometry (current cut model treats angled fragments as bounding rectangles — conservative, and flagged in the estimate)
- Accent/border bands and feature strips per room edge
- Shared tile_library UI (schema is already in the migration)
- Markup ↔ Excel live link (Quantity-Link style)
- Seam diagrams for sheet goods
- Bluebeam-style markups list with per-item cost columns and legend
- PDF page rendering into the canvas (measure directly on plan PDFs)
- Pattern-accurate herringbone/pinwheel/versailles fragment geometry (current cut model treats angled fragments as bounding rectangles — conservative, and flagged in the estimate)
- Accent/border bands and feature strips per room edge
- Shared tile_library UI (schema is already in the migration)
