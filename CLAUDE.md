# TileTakeoff — read this first

Owner: Moshe Gluck (Lead Estimator, Artistic Tile Installation — tile & flooring, NY/NJ).
Terse; wants direct action, not confirmations. Don't invent requirements he didn't state.

## Branch
Trace is merged into **`main`** (live at https://tiletakeoff.vercel.app). Work on a new
branch from `main` and open a PR; Moshe has said to merge without asking.

## The idea (Moshe's own concept — keep to it)
Existing AI takeoff tools (Togal, Kreo, etc.) read the plan image and put measurements on it.
Lengths come out right, but **topology** is wrong: rooms don't close, areas get cut wrong,
the tracer walks the same wall twice, and wall LF in bathrooms with returns ("in and out")
is wrong — especially on messy PDFs.

TileTakeoff works the other way round:
1. **Trace, don't read.** Rebuild the walls as one connected model, like a snake that has to
   flow and come back to where it started. It may never go around the same area twice.
   If it tangles, that is a signal the geometry is wrong — not something to paper over.
2. **The sketch is the source of truth.** Every takeoff number (floor SF, wall LF, openings)
   comes from the reconstructed model, never from the PDF pixels. The model is drawn back
   over the plan so you can see it's right.
3. **Coherence = validation.** Every room must be a closed loop (planar graph, face tracing).
   Anything that doesn't close becomes a **located flag** for the human — short and specific,
   never a silent wrong number.
4. **Doors make sense in context.** A 10' opening between kitchen and living is fine; a 5'
   "door" into a single bathroom is flagged. Closets may be wide (bifold/double). Door widths
   come from the door schedule when there is one, otherwise from the swing arcs (a swing
   radius = leaf width — a free ruler that also cross-checks the scale).
5. **Both tracing styles are fine:** room-by-room loops or one continuous run.
6. **3D from the model.** Given ceiling height (and door height), the model becomes a real,
   **walkable, realistic** house you can design in — NOT a box/"square bubble". Finish picks
   in 3D become priced materials in the estimate.

## Where things are
- `src/engine/trace/` — the engine (pure JS, unit-tested)
  - `walls.js` pairs parallel face lines into wall bodies; merges doubled traces; rejects
    evenly spaced hatch / tile patterns (4+ equal spacings)
  - `graph.js` joins corners/tees, closes drafting gaps, drops detached scraps (fixtures),
    bridges doors/openings (swing arcs as evidence), builds the planar graph, traces faces
  - `analyze.js` rooms (offset to finished faces; floor to door centre by default), wall LF
    net of openings incl. dead-end partitions (2·L − Σhost t − attaches·t + free ends·t),
    holes, labels → names/types, door-in-context checks, scale check from door swings,
    sheet-border / title-block removal (by page extent), all flags
  - `index.js` `runTrace()` pipeline; `eraseFromBodies()` for the manual erase tool
  - `arcs.js` door-swing recognition from Bézier curves
  - `layers.js` CAD layer names → wall / opening / room label / ignore. On a layered sheet only
    wall + unnamed layers can be walls, door/window layers become doorway *hints*, and room
    names come from the room-label layer. Layers are read in `pdfVectors.js` (`readLayers`).
- `src/lib/pdfVectors.js` vector PDF → lines/curves/text in rendered-image px (pdf.js op list)
- `src/lib/rasterWalls.js` scanned plans: blob filter, auto-deskew, H/V stroke detection
- `src/lib/planEvidence.js`, `traceClient.js`, `traceWorker.js` read plan → feet → solve in a Worker
- `src/components/TracePanel.jsx` Trace tab (scale pickup, verdict, flags, rooms, fix tools)
- `src/components/canvasRender.js` `drawTrace()` overlay; `Canvas2D.jsx` tools `tr_wall`/`tr_erase`/`tr_region`
- `src/state/store.js` trace slice, `commitTrace()`, `applyFinish()` (3D picks → materials)
- `src/three/house3d.js` walkable house; `houseModel.js` model from store; `finishTextures.js` true-size textures
- `src/data/finishes.js` floor / wall-tile / paint presets
- `api/detect-plan.js` serverless Claude route; `mode: 'label'` = AI reads room NAMES only (never geometry).
  The default mode is **AI Detect** (`DetectModal.jsx`): room outlines read off the plan, reviewed by
  the user before they're added — a separate, opt-in tool, not the Trace pipeline. Model choice:
  `src/lib/planModels.js` (old `ANTHROPIC_MODEL` values are ignored).
- `src/engine/zones.js` floor design zones (border bands follow the walls, traced inlays); the
  field = room − holes − bands − inlays. Drawn in 2D (`drawZones`), 3D (`houseModel.zoneSurfaces`)
  and priced in `estimate.js`.
- `src/state/pages.js` each plan page keeps its own takeoff: the store holds the page on screen
  (rooms / markups / trace / scale) and parks the others in `pageData[page]`; `switchPage()` swaps.
  The estimate, exports and cloud save use `wholeProject()` (every page).
- `src/engine/takeoffRules.js` Artistic's takeoff rules (from Moshe's `marked-plan-takeoff-artistic`
  skill), used by the estimate, room cards, marked PDF and quantity list: floor = room − shower
  footprints − 10 SF a tub; walls = full perimeter × tiled height − 14 SF a standard door (2 LF × 7',
  8 SF at 4'), wide openings (> 4' / double door) at their width, − 10 SF a tub; windows never
  deducted (window cut EA); every quantity rounds UP. Each result carries its arithmetic as text.
  Per room: `fixtures` { tubs, showers [{w,d}], doors (untraced rooms) }, `finish.wallTileHeight`.
- `src/lib/markedPdf.js` Export → Marked-up plan (PDF) in Moshe's markup language: floor-tiled rooms
  highlighted by type (yellow bath, green hall, purple living/kitchen, cyan laundry/mech, orange
  closet), red SF callouts, blue = walls fully tiled, magenta = partway, red bath dims / SH / TUB /
  ceiling note, window cuts, legend; summary page reads like the proposal (room header
  `NAME (9.25x5 sf5x2.75) 10' ceiling - fully tiled`, each line with its arithmetic).
- `src/lib/quantityList.js` Export → Tile Quantity List (Excel), Artistic's ordering sheet (maroon /
  lavender / purple bands, logo `public/artistic-logo.png`): page → room → surface, Count before
  waste (arithmetic as a cell note), Truman waste defaults, Total = ROUNDUP(Count × (1+Waste), 0),
  On Order blank, separate SF / LF total bands. Floor / wall totals equal the estimate's.
- `src/lib/aiReview.js` + `api/detect-plan.js` `mode: 'review'`: "Check the trace with AI" — Claude
  looks at the drawing with the traced model drawn on it (R/O tags) and returns located findings
  (missing / false wall, missed door, window taken as door…) shown as flags. Never geometry.
- `src/lib/supabasePublic.js` the live Supabase project; the API verifies each session with the
  project that issued its token, so a stale env var can't lock users out.
- `samples/sample-house.pdf` (vector) and `sample-house-scanned.pdf` (crooked scan); `npm run sample:pdf`

## Verified state
- `npm test` → 347 passing (engine, raster, design↔estimate, review regressions,
  `test/traceRealSheets.test.js` = cases from Moshe's real CAD sheet).
- Moshe's sheet (2 Patriot Dr, A-3 basement, 56 CAD layers): 25 floor rooms / 1,609 SF, audited
  room by room against the printed dims (gym 11'-0" x 10'-11", guest bedroom 14'-7" x 10'-11"
  match). 3 open-end flags (unexcavated footing lines + one foundation corner). Was 18 rooms / 393 SF.
- Wall LF rules: windows stay in wall LF (layer A-Glaz etc.); doors / openings come off; a stud
  wall furred 1–3" inside a foundation wall is one wall; leftover wall-layer faces 1–8" inside a
  room move its edge in; layer "0" never gives walls on a layered sheet; unexcavated / shaft
  rooms are out of the floor total. Flags that change a number are "check", with the amount.
  CLI: `npm run trace:pdf -- plan.pdf --page 3 --svg outdir` (overlay SVG for checking).
- Sample sheet: 7 rooms, 1,047.3 SF vector vs 1,046.5 SF from the crooked scan; scale read
  off the sheet and confirmed by 5/5 door swings; the planted 5' bath opening is flagged.
- 10k-line sheet traces in ~0.5 s (spatial indexes everywhere).
- Phone: right panel is a bottom drawer (tabs open it; loading a PDF opens Trace).
- pdf.js is imported from the **legacy** build on purpose (5.7 modern build breaks older browsers).

## Known gaps / next
- Scans: only horizontal/vertical walls; diagonal walls on scans get flagged.
- AI room naming (`Name rooms with AI`) runs on the same model chain as AI Detect; untested live.
- Supabase: deployed env vars point at a deleted project (edsywvqtlnoyqtsamryn). The build
  (`vite.config.js`) and `src/lib/supabase.js` swap in the live `tiletakeoff` project
  (qgvloanrqzuciuhpepjy); the API routes tokens by issuer. Clean fix = update
  VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in Vercel.
- A furring face covering ≥ 50% of a room edge moves the whole edge (no partial step).
- Windows are recognised from window layers only; on unlayered sheets a window gap reads as an opening.
- The AI check (`mode: 'review'`) is tested with a mocked model only; first live run pending.
- iPhone once read 0 texts off a sheet; op-list text is now a fallback and the read error is
  shown in the Trace panel. Root cause unconfirmed.
- Shower floor tile isn't a material pick yet (quantity list says SHOWER FLOOR TILE); customer and
  proposal # aren't stored (left blank on the quantity list).
- Next real step: more of Moshe's PDFs (other sheets of the Patriot set trace but untuned).

## Rules of the road
- Never make the takeoff come from pixels; geometry must go through the coherence engine.
- Never hide an incoherence: flag it at its location.
- Add a test for every bug fixed in the engine (see `test/trace.test.js` "review regressions").
- Branch from `main`, open a PR, and merge it once tests, lint, typecheck and build pass.
