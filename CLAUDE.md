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
    evenly spaced hatch / tile patterns (4+ equal spacings). Pen-aware: on a sheet drawn with pen
    weights two hairlines (< 0.4 × the wall pen) never pair; a light line in an annotation colour
    (`chromatic`, read in `pdfVectors.js`) is never a face; a merged run carries the pen most of it is
    drawn with, but a pair is judged by the pen along the stretch it uses (`penOn`): a face running
    on past its heavy pen as a hairline (into a vanity) is a hairline there; a lighter stretch between
    heavier ones is still the wall; dashed runs (4+ even pieces) are `dashed` — never a wall, except as the hidden outer
    face of a thick wall. Thick masonry 16"–36" when the faces run on 8'+ (or its piers between
    window bays add up), both in a wall pen, nothing inside. Bodies overlapping in thickness (nested,
    or sharing most of the thinner one — layer lines paired across each other) over most of both
    lengths are one wall at any length (`mergeLayers`; a door's 6" jamb drawn on two layers); a copy of
    part of a longer wall lying within its band is dropped (the wall stays as drawn, not widened; a
    pilaster standing out of it stays). A short hatch
    run (4–5 lines) must be drawn in one pen (a door leaf, two wall faces and a washer box 6" apart
    are not a pattern). Window bays: thick piers that pair with one unbroken face line, ≤ 12' apart,
    are one wall across the bay (the plan cuts at window height; below the sill it's solid, so the
    floor stops at the inner face). On a sheet with pen weights a brick wall may share its face line
    with a wall built against it (both faces in a wall pen); they merge into one. `dropCasework`: a strip
    faced by a hairline lying face to face along a wall (toilet tank, vanity, counter) is not wall.
  - `graph.js` `bridgeOpenings` also reads the window symbol on unlayered sheets: 2+ lines across the
    gap inside the wall's thickness → a window (closes the room, stays in wall LF).
  - `graph.js` joins corners/tees, closes drafting gaps, drops detached scraps (fixtures),
    bridges doors/openings (swing arcs as evidence), builds the planar graph, traces faces.
    Joins: an end touching only a scrap shorter than half its thickness still finds its corner; a
    tee met just past the other wall's end extends that wall; collinear pieces that each turn into a
    different crossing wall (an offset cross) run through — up to a thick wall's thickness between the
    crossing walls' faces when they come from opposite sides; an end on a wall right by that wall's end snaps to it.
    A corner whose own wall carries on behind a scrap is still a plain L (a closet door bridges from it).
    An inferred opening (no swing, no door drawing) never crosses one already placed; a door the
    sheet draws stands (Patriot's bifold closet front). A swing matches a door when it hinges at one
    jamb and, when its leaf says where it closes (`closed`), closes on that doorway's line; it also
    matches when its `closed` end lands across most of the gap (short jamb returns). A ray may land on
    a wall end it misses by ≤ max(0.3', t) only with a swing and only when clearly nearer than any
    wall it meets; that end becomes the door's jamb.
  - `analyze.js` rooms (offset to finished faces; floor to door centre by default), wall LF
    net of openings incl. dead-end partitions (2·L − Σhost t − attaches·t + free ends·t),
    holes, labels → names/types, door-in-context checks, scale check from door swings, room edges snap
    to the heavy face line within 1½" (`faceSnap`; a gypsum line drawn a hair inside isn't the face),
    sheet-border / title-block removal (by page extent), all flags
  - `index.js` `runTrace()` pipeline; `eraseFromBodies()` for the manual erase tool
  - `arcs.js` door-swing recognition from Bézier curves, and from swings a CAD export flattened into
    chains of straight pieces (`arcsFromPolylines`); `readLeaves` reads each swing's drawn leaf
    (the edge closest to the radius: open end → `closed` = the other end) and keeps part-open (25–55°)
    swings only with their leaf. `leafLines`: the leaf's lines (hinge → open end, radius long, drawn
    lighter than the sheet's wall pen) are never wall faces; `runTrace` also cuts every body along a door's closed leaf (hinge → `closed`):
    a threshold or leaf drawn across a doorway is no wall.
  - `sheetScale.js` which scale the floor plan is drawn at: every scale note read text by text (a
    view's number bubble is no part of it; "SCALE:" + its value as two texts; AutoCAD SHX's flattened
    stacked fractions, `SCALE:  "=1'-0"14"=1'-0"` = 1/4"), and the note printed with the plan's title
    ("BASEMENT PLAN", not "SEE … PLAN" / details / sections) wins over the sheet's commonest note (its
    details'). `dimScale.js` then measures the sheet against its own dimension strings: each one's value
    / its span between the extension lines crossing its dimension line on either side of the text
    (texts carry `rot`: 0 across, 90 up the sheet); with ≥ 5 votes and ≥ 40% agreeing, the dimensions
    confirm the note (`dims`) or overrule it (`how: 'dimensions'`, `note` = what it said; a plot at no
    standard scale gets id null, label `1" = 5.53' (measured)`). Herzka: 1/4" confirmed by 61–81
    dimensions a floor. `planEvidence.detectSheetScale` does both.
    Room names (`analyze.js` `isLabel`): framing / beam callouts (LVL, HEADER, W18x71, 2x10 @ 16" O.C.),
    construction notes (… ABOVE, TO BE, SEE), door tags (3'0" X 6'8"), stair notes (UP 22R), window /
    equipment codes and CAD attribute dumps never name a room.
  - `survey.js` `describeSheet()`: what the trace read off the sheet, in words (building type, phase
    legend, pens, annotation / dashed / hatch set aside, wall thicknesses, doors, plan check, reading
    used) — shown in the Trace panel. `runTrace` traces the sheet as drawn, then tries other readings
    when a rule could be wrong for this drawing (`READINGS`: every pen can be a wall; no masonry) and
    keeps the one that agrees best with the sheet's own evidence (`readingScore`: printed areas,
    named rooms, merged / unplaced names, open ends).
  - Plan check (`analyze.js` `printedAreas` / `checkPrintedAreas`): room tags that print an area
    ("580 SF") are the answer key — each traced room holding one is `areaCheck: 'match'` (within
    `AREA_TOL` 3% / 2 SF, compared at the wall faces: `room.areaFaces`, since a tag stops at the wall
    line across a doorway while the tile floor runs to the door's centre) or an `area_check` flag at
    the tag with both numbers (several tags in one room = rooms merged).
    `res.verify` = { tags, matched, off, unplaced }.
- `scripts/bench.mjs manifest.json [--json out] [--baseline base]` — the accuracy benchmark: per sheet,
  answers (printed tags and/or hand-audited rooms) right within 1%, within 3%, merged, missing, and
  SILENT (wrong beyond 3% with no flag — must stay 0). `samples/bench.json` = the sample sheet's
  answer key worked by hand. Client PDFs stay outside the repo; their manifest points at them.
  **Marked plans** (`"marked": true`): an estimator's Bluebeam takeoff on the architect's PDF is the
  answer key — `scripts/markedKeys.mjs` reads each measured polygon (/Subj = the takeoff item, "Half
  Tiled Bathroom", "Vanity Floor", "Shower Floor", "Floor Deduction"…; /Contents "A = 41 sf"; /IC the
  finish colour; /Measure the calibration), polylines (fully tiled wall LF) and counts.
  `benchScore.mjs` `scoreMarked` joins marked areas and traced rooms that overlap (> half of either)
  into regions; a region is right when traced floor = marked floor within max(1 SF, 1%).
  `--key-scale` uses the estimator's calibration (tells a wrong scale from wrong geometry).
  The trace never reads annotations as drawing (`pdfVectors.js`: annotationMode DISABLE); AutoCAD's
  invisible "AutoCAD SHX Text" annotations are read as the sheet's words (room names, dims).
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
- `src/lib/quantityList.js` Export → Tile Quantity List (Excel), to the current standard of Moshe's
  `artistic-quantity-sheet` skill (its `build_quantity_list.py` is the reference): logo at B1, title
  centred in C1:E3, job band (Project · Proposal #, Customer · site address, date), page → room
  (proposal-style header) → surface. Nothing below the title is merged (AutoFilter on row 8).
  Item = size + type (`24X48 FLOOR TILE`, `3X12 SUBWAY`), never "large / rectified / plank"; no pick
  → `NA`. Current waste table (48X48 in a bath 35%, bath 25%, large format 22%, 24X24/12X24 20%,
  mosaic / subway / shower floors / patterned 15%, borders 10%, default 10%). Count before waste
  (arithmetic as a cell note), Total = ROUNDUP(Count × (1+Waste), 1), one SUMIF total over SF rows.
  Floor + border rows and Wall rows equal the estimate's floor / wall SF.
  Job info lives in `state.job` { proposal, customer, address } (Estimate panel; saved everywhere).
- `src/lib/proposal.js` Export → Proposal (Excel): the priced Artistic proposal (Description | SF/LF/PC |
  Item | Rate | Total, Total = qty × rate formulas, Subtotal / Sales Tax 0.00% / TOTAL), rate card of
  #41765 (`ARTISTIC_RATES`: rectified 12X24/24X24 $7.75, large (a side ≥ 30") $8.75, + $2 x-large from
  48X48, shower floor $185 / $385 from 17 SF, niche $145 (1 per tub / shower unless set), seat $250,
  window cut $145 (W x H on the room), *OPTIONAL* miter $65/LF = 6.25 a niche + window perimeters,
  *OPTIONAL* Ram Board at 0.00 with its price in the text, *FOR OFFICE USE* mud-job calc, footer).
  A line with no tile picked or a size off the rate card gets no rate and a flag — never a guess.
- Wall split (`takeoffRules.js` `wallParts`): a second wall tile in a room with a shower / tub covers the
  wet run (W + 2·D a shower, 10 LF a tub) × height (`finish.wetWallMaterialId`, else the second picked;
  "Shower walls in" on the room card); the rest of the walls carries the doors and the tub's 10 SF.
  The estimate, quantity list, marked PDF and proposal all use it (no double count).
- `src/lib/aiReview.js` + `api/detect-plan.js` `mode: 'review'`: "Check the trace with AI" — Claude
  looks at the drawing with the traced model drawn on it (R/O tags) and returns located findings
  (missing / false wall, missed door, window taken as door…) shown as flags. Never geometry.
- `src/lib/supabasePublic.js` the live Supabase project; the API verifies each session with the
  project that issued its token, so a stale env var can't lock users out.
- `samples/sample-house.pdf` (vector) and `sample-house-scanned.pdf` (crooked scan); `npm run sample:pdf`

## Verified state
- `npm test` → 412 passing (engine, raster, design↔estimate, review regressions,
  `test/traceRealSheets.test.js` = cases from Moshe's real CAD sheet).
- Moshe's sheet (2 Patriot Dr, A-3 basement, 56 CAD layers): 25 floor rooms / 1,609 SF (the bench
  keeps this audited trace as its answer key: 25/25), audited
  room by room against the printed dims (gym 11'-0" x 10'-11", guest bedroom 14'-7" x 10'-11"
  match). 3 open-end flags (unexcavated footing lines + one foundation corner). Was 18 rooms / 393 SF.
- Wall LF rules: windows stay in wall LF (layer A-Glaz etc.); doors / openings come off; a stud
  wall furred 1–3" inside a foundation wall is one wall; leftover wall-layer faces 1–8" inside a
  room move its edge in; layer "0" never gives walls on a layered sheet; unexcavated / shaft
  rooms are out of the floor total. Flags that change a number are "check", with the amount.
  CLI: `npm run trace:pdf -- plan.pdf --page 3 --svg outdir` (overlay SVG for checking).
- Mill 2 (NJ251 Open Square Way, Holyoke — 41-page set; A101 basement = page 16, 1/8", 34k lines,
  no layers, swings as straight pieces, 28" brick with window bays, hidden outer faces, blue dims):
  bench (1% / 3%, at faces): 50 / 50 of 55 printed rooms, 0 silent, errors 9 (was 17 / 36 with 1
  silent, then 41 / 45, 48 / 48). All three sheets: 82 / 87 (94.3%). Plan check (old 6% rule) 39 of 55 printed rooms agree (was 4, then 23: bedrooms, bathrooms, offices, every UNIT
  living room, COWORKS 584/580, MEETING 725/720, STORAGE 986/982, TURBINE, DOG WASH, JAN. STORAGE,
  FITNESS, PODCAST, WOMENS, STAIR B; METER + ELECTRIC as zones 186 + 281 = 469), 11 flagged off,
  errors 19 (was ~250). White fill-only edges (wipeouts / text masks, 3,900 on this sheet) are not
  drawing. Patriot and the sample sheet trace as before. `test/traceMill.test.js` = its cases.
  Plan check: several tags in one traced space that add up to it, in sight of each other (no traced
  edge between them), are zones of one open space (`printedParts`, info flag `area_zones`).
  The second-pass alcove rule needs a mouth ≥ ½·√area (a stair hall behind a slot is a room); it
  also joins a named room whose only way in is a smaller unnamed space with one door, open to it with
  nothing drawn across (a bath's vanity area split off by the tub-end stub). A partition dead-ending in
  a room is notched into its outline (`notchSpur`): its footprint is off the floor.
  Diagnostics used: render the sheet + trace overlay for a crop and read it (see `scripts/trace-pdf.mjs
  --svg`); every fix above came from one wrong room on this sheet.
- Moshe's marked jobs (Oct 2026; PDFs outside the repo): 454 Saddle River Rd (synagogue, AutoCAD,
  3 floor plans), Herzka residence (Bluebeam over AutoCAD, 3 plans, pages rotated 270°), Promenade at
  Middletown (memory care finish plan, 1/8"). Baseline: 24 / 190 marked regions right (12.6%), 54
  within 3%, 34 silent with the estimator's scale; 7 / 144 with the scale the trace reads (it takes a
  detail's scale on 5 of 7 plans). Failure classes: wrong / missing scale; structural callouts read
  as room names; big rooms traced as fragments; open rooms merged; small baths / WCs 5–15% off.
  Now (sheetScale.js + label filters): the plan's scale is right on 9 of the 10 benchmark sheets and
  the trace scores 25 / 190 with its own scale. The tenth, Saddle A-103 (second floor), says 1/4" but
  is plotted at 5.53 ft/in (its 28'-11" dimension measures 752.6 px between ticks = Moshe's own
  calibration); its dimension text is drawn as strokes with no text layer, so only reading the
  dimension strings (OCR) can catch it — dimScale.js does it wherever dimensions are text.
- Sample sheet: 7 rooms, 1,045.4 SF vector (bench 7/7; the bath's pony wall is off its floor);
  1,046.5 SF from the crooked scan before that change; scale read
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
- Mill 2 still open: LOUNGE (1623) + LOUNGE/GAMING (1457) + MECH + ELEVATOR are one face (the two
  lounges share a ~12' gap with nothing drawn; MECH / ELEVATOR leak through gaps in the brick); the
  310 SF annex north of the brick has no room; CORRIDOR 576/713 (the architect's corridor runs on
  past its end door into the 22' hall between COWORKS and the offices, which the trace gives to the
  lounge). Next: a plan-check repair pass (try closing a gap / dropping an
  inferred opening where tags disagree, keep it only if more printed areas agree), an envelope rule,
  and an AI reading pass (building type, legend, outside / in scope) — the AI may name and classify,
  never supply geometry. No Anthropic key in this container: AI modes are mock-tested.
- Sliding doors drawn as parallel panels in a gap can read as a window on unlayered sheets.
- The AI check (`mode: 'review'`) is tested with a mocked model only; first live run pending.
- iPhone once read 0 texts off a sheet; op-list text is now a fallback and the read error is
  shown in the Trace panel. Root cause unconfirmed.
- Shower floor tile isn't a material pick yet (quantity list says NA; the proposal prices it EA);
  accent / feature walls (tub BW, 30% waste), pattern labor lines (checkerboard) and tiled base aren't
  modelled. Three+ wall tiles in one room each price the whole wall (flagged).
- Next real step: more of Moshe's PDFs (other sheets of the Patriot set trace but untuned).

## Rules of the road
- Never make the takeoff come from pixels; geometry must go through the coherence engine.
- Never hide an incoherence: flag it at its location.
- Add a test for every bug fixed in the engine (see `test/trace.test.js` "review regressions").
- Branch from `main`, open a PR, and merge it once tests, lint, typecheck and build pass.
