# TileTakeoff

Professional flooring takeoff, estimating & 3D visualization. React + Vite, deploys to Vercel. AI floor-plan detection runs through a serverless route so the Anthropic key stays server-side. Project data persists in the browser (localStorage) — no database required for v1.

## Features

- **2D takeoff** — draw rectangle rooms, trace polygon rooms, calibrate scale with the ruler, pan/zoom, move/resize, plan-image underlay.
- **PDF takeoff** — load a plan PDF, render any page into the canvas, page-to-page navigation, then calibrate scale and measure directly on the drawing.
- **Markups (Bluebeam-style)** — Length, Area, Box, and Count measurement tools with per-markup unit cost, line cost, notes, and a measurement log that totals by type. Hotkeys M / A / B / C.
- **All measurement types** — feet-inches (fractions), decimal feet, inches, meters, cm, mm. Switch any time; everything re-renders.
- **Tile layouts** — straight grid, running brick (50% / 33%), herringbone, diagonal 45°, basketweave, with rotation. Full vs. cut tiles shaded on canvas.
- **Floor design (borders & inlays)** — the room outline is the walls; floor designs live inside it as zones with their own material. A **border band** is defined by distance-from-wall + width and is derived from the wall polygon (no tracing; follows L-shapes and re-flows when the room changes; stack bands for layered borders/listellos). An **inlay** (medallion, rug inset, feature panel) is traced (D) or boxed (I) on the plan's floor lines, snapping to room/inlay corners and walls, with its own pattern anchored to its corner or center. Zones are carved out of the field, so field + borders + inlays always add back up to the room. Border tile is counted the way it's installed — wall runs of strips, full courses plus one rip course.
- **Cut-redistribution engine** — sizes every cut piece via exact polygon clipping, tracks offcuts, and reuses them on other cuts (with chained reuse and grain-lock for planks). Two modes: practical first-fit and whole-job best-fit optimize. Reports real tiles ordered vs. naive waste %, with the tiles saved.
- **Installer cut sheet** — per-room summary, consolidated batch cut list, and a tile-by-tile cutting plan showing which offcut feeds which cut. Print-ready.
- **Tile library** — square, rectangle/subway, plank, mosaic, and metric sizes; grout-joint presets; pattern-based waste suggestions.
- **Estimate engine** — per material choose Waste% or Cut-reuse costing; full tiles + broken-for-cuts + safety margin → order qty (sf/tile/box), plus labor $/sf and tax.
- **3D walk-through** — a walkable house built from the rooms (or the traced wall model): floors and floor design zones tiled at true size, doors, ceiling height; orbit or walk.
- **AI detection (hybrid)** — runs on the plan that's already open (no re-upload): the part of the sheet on screen, or the whole page, re-rendered from the PDF at the model's full resolution. Claude (official Anthropic SDK, **structured outputs**, high-resolution vision) traces each room's outline in that image's pixels and reads printed room sizes; the app maps the pixels back onto the plan so rooms land exactly over the drawing — rectangles or L-shapes, walls squared up. You review them drawn over the plan, untick false positives, and add. Rooms already drawn are skipped; with no scale set, the scale is read from the printed room sizes and snapped to the standard preset (e.g. 1/4" = 1'-0").
- **Cloud (optional)** — Supabase auth + per-user projects with Row Level Security; auto-saves your work. Runs local-only (localStorage) if Supabase env vars are absent.
- **Export** — CSV, multi-sheet Excel (.xlsx), and re-importable JSON.

## Trace — takeoff from a reconstructed model (not from pixels)

Most AI takeoff tools read the plan image and measure what they see. They get
individual lengths right but lose the *topology* — rooms that don't close,
walls walked twice, linear footage that misses the in-and-out of a partition.
**Trace** works the other way round: it rebuilds the walls as one connected
model, insists that the model is coherent, and takes every number off that
model. The PDF is only the evidence.

1. **Read the plan.** Vector PDFs: every wall face, door swing and label is read
   straight out of the PDF (`src/lib/pdfVectors.js`). Scans: strokes are found
   in the image after auto-straightening (`src/lib/rasterWalls.js`). The scale
   note on the sheet (e.g. `1/4" = 1'-0"`) is picked up automatically.
2. **Find the walls.** Parallel face lines a wall-thickness apart become wall
   bodies; doubled traces merge; evenly spaced hatch / tile patterns are ignored
   (`src/engine/trace/walls.js`).
3. **Connect them.** Corners and tees are closed, drafting gaps repaired, and
   doors / openings bridged — using door swings as rulers (`graph.js`).
4. **Close every room.** The walls become a planar graph; every room must be a
   closed loop (face tracing). A wall that dead-ends inside a room is counted in
   *and* out. Anything that doesn't close becomes a **located flag** — never a
   silent number (`analyze.js`).
5. **Check it makes sense.** Door widths are checked against what the room is
   (a 5' "door" into a bath is flagged; an 8' cased opening between kitchen and
   living is fine), against the door schedule, and the scale is cross-checked
   against standard door sizes.
6. **Fix and re-solve.** Add or erase a wall on the plan; the whole model
   re-solves so rooms, SF and LF stay consistent. Then **Send rooms to takeoff**.

Floor SF is measured to finished wall faces (to the door centre by default);
wall LF is net of openings and includes both faces of dead-end partitions.

### 3D walk-through
The traced model builds a walkable house: true wall thickness, door headers and
hung doors, ceiling height, tiled floors at true tile size. Click any floor or
wall to choose a finish — every pick becomes a priced material in the estimate.

### Try it
`samples/sample-house.pdf` (vector) and `samples/sample-house-scanned.pdf`
(crooked scan) are included. Load one with **PDF**, click **Trace**, accept the
sheet scale, **Trace plan**. Regenerate with `npm run sample:pdf`.

## Testing

The engine layer (geometry, units, layouts, floor-design zones, the Trace
engine, cut redistribution, estimate, markups, cut sheet, AI-detection mapping)
plus the `/api/detect-plan` route (with a mocked SDK) have a Vitest suite —
193 tests covering correctness and the
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
   - (optional) `ANTHROPIC_MODEL` — defaults to `claude-opus-5-5`, the most
     accurate on technical drawings. Leave it unset unless you need another
     model: it must read plans at full resolution (Opus 4.7+, or
     Opus/Sonnet/Fable 5+). An older model is ignored (with a warning in the
     function logs), and if the API rejects the configured model the request
     falls back to the default. Detection uses high effort and allows the
     function up to 300 s (`vercel.json`); a full sheet usually takes 20–60 s.
4. Deploy. The static site builds to `dist/`; `api/detect-plan.js` becomes a
   serverless function automatically.

The `/api/detect-plan` route is hardened: it caps image size, allow-lists the
media type, validates the model's JSON, and never leaks upstream error detail.
When the Supabase env vars are also present on the server it **requires a
signed-in session** and rate-limits per user, so the Anthropic key can't be
spent by anonymous callers; without Supabase it runs open with a per-IP rate
limit. The rate limiter uses **Upstash Redis / Vercel KV** for durable,
cross-instance limiting when `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`
(or `KV_REST_API_URL` + `KV_REST_API_TOKEN`) are set, and falls back to an
in-memory window (per warm instance) otherwise.

## Architecture

```
src/
  engine/      units, geometry, layouts, zones, estimate   (pure, framework-free)
  engine/trace/ wall reconstruction, planar graph, rooms/flags (Trace)
  data/        tileCatalog, finishes                  (libraries)
  state/       store.js (Zustand + localStorage)
  components/  Canvas2D, Viewer3D, Panels, TracePanel, DetectModal
  three/       house3d.js, houseModel.js, finishTextures.js (lazy chunk)
  lib/         export, pdf, planLoad, planCapture, aiDetect, aiLabel,
               pdfVectors, rasterWalls, planEvidence, planModels
api/
  detect-plan.js  Vercel serverless route (key in env)
```

The engine layer has no React/DOM dependencies, so the math is unit-testable and
reusable (e.g. a future Supabase/multi-user backend can call it directly).

## Roadmap (not yet built)

- Pattern-accurate herringbone/pinwheel/versailles fragment geometry (current cut model treats angled fragments as bounding rectangles — conservative, and flagged in the estimate)
- Per-wall border control (skip a band along cabinets/thresholds) and inlay frames
- Shared tile_library UI (schema is already in the migration)
- Markup ↔ Excel live link (Quantity-Link style)
- Seam diagrams for sheet goods
- Bluebeam-style markups list with per-item cost columns and legend
