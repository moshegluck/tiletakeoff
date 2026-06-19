# TileTakeoff — Product Requirements (Living Doc)

## Problem Statement
A full SaaS platform for tile-focused flooring and wall elevation takeoffs — drawing upload, measurement tools, tile layout libraries, AI-assisted quantity detection, 3D visualization, and professional exports. Positioned between MeasureSquare estimating and Bluebeam markup.

## Architecture
- Frontend: React 19 (CRA + craco), Tailwind, shadcn/ui, SWR, react-router. Fonts: Chivo + JetBrains Mono. "Control Room" CAD aesthetic (slate/orange).
- Backend: FastAPI (server.py, auth.py, models.py, calc.py, ai_service.py, storage.py). All routes under /api.
- DB: MongoDB (workspaces, users, user_sessions, projects, drawings, tiles, takeoffs).
- Storage: Emergent object storage (drawings).
- Integrations: Gemini 3.1 Pro vision (AI takeoff via EMERGENT_LLM_KEY); Resend (email, needs key); Emergent Google Auth + JWT.

## User Personas
- Tile contractors & estimators (primary) — heavy takeoff users.
- GCs, dealers/distributors, enterprise branches (secondary) — review/roles.

## Auth & RBAC
- JWT email/password + Emergent Google login (unified get_current_user). Bearer token in localStorage.
- Roles: admin (full), estimator (create/edit), viewer (read-only). New signup auto-creates workspace + 4 starter tiles.
- Admin seeded: admin@tiletakeoff.com / Admin123!

## Implemented (2026-06-17)
- Auth (both methods), multi-tenant workspaces, member invite + roles.
- Projects CRUD + project detail (drawings + takeoffs).
- Drawing upload (image/PDF) to object storage, authenticated file serving, scale calibration.
- Tile catalog CRUD (sizes, finish, pattern, grout, waste, pricing, box coverage, swatches).
- Takeoff Studio: Bluebeam-style canvas with tools (select, calibrate, area, wall, perimeter, linear, opening/deduct, count), SVG markup, zoom, live measurement values.
- Quantity engine (shoelace area × scale², waste factor → tiles/boxes/cost), per-surface + default tile assignment.
- AI takeoff assist (Gemini 3.1 Pro vision) — region/opening detection, recommended waste, confidence bars, review.
- 3D finish preview (floor/wall) with tile swatch/texture.
- Exports: PDF, Excel, CSV. Email report scaffold (needs RESEND_API_KEY).
- Landing page, dashboard, full design system.
- Tested: 21/21 backend, 100% frontend E2E.

## Pro Studio Upgrade (2026-06-18)
Major Bluebeam/MeasureSquare-grade rewrite of the Takeoff Studio:
- **Canvas engine**: transform-based pan (Space/middle-drag) + wheel zoom-to-cursor, fit-on-load only, debounced optimistic autosave (no jumping/flicker).
- **Markup**: drag-to-draw rectangle areas & cutouts, polygon rooms/walls, linear, perimeter, count, and text notes. Snap-to-corner + Shift ortho. Double-click/Enter/green-start-dot to finish; floating Finish/Undo/Cancel bar.
- **Control points**: select a shape to drag vertices, click green midpoints to ADD vertices, Alt-click to DELETE.
- **Per-shape styling (Style tab)**: line color, line width, fill color, fill opacity, label, deduction toggle, delete.
- **Layers tab**: visibility toggle, lock, rename, color dot, delete.
- **Tile-grid fill**: per-room tile + pattern (grid, brick, diagonal, herringbone, basketweave, chevron, checkerboard) rendered as SVG patterns clipped to each room at true calibration scale.
- **Cut/waste engine (calc.py)**: full tiles + edge cuts with cross-area leftover reuse, pattern-based waste, true waste %, boxes, cost. Toggle cut-reuse.
- **3D plan view**: builds from actual room polygons; Before (bare) / After (tiled) toggle showing the real tile finish in perspective.
- **AI on PDF**: server-side PyMuPDF rasterization → Gemini 3.1 Pro vision (works on PDF & image plans).
- Backend: Measurement model `extra="allow"` for rich fields; takeoff `cut_reuse`, per-measurement `pattern`/`tile_id`.

Known limitation: very small tiles (e.g. 3×6) on large areas render near-solid on the main canvas at fit-zoom (accurate to scale — zoom in to see grid); large-format & plank tiles show clearly. 3D view always shows tiles clearly (viz-scaled).

## Advanced Features (2026-06-18b)
- **Move + multi-select**: Select tool drags whole shapes; Shift-click for multi-select; Delete removes all selected.
- **AI → editable polygons**: Gemini now returns normalized room outlines; "Add all rooms" / per-region "+ Add to plan" drops them onto the canvas as editable area measurements (verified: 5 rooms).
- **Per-tile cut sheet in PDF**: export now includes a cut-sheet table (full / cut / reused / boxes / true waste %) + per-room breakdown.
- **WebGL 3D walkthrough**: Three.js + @react-three/fiber + drei OrbitControls — extrudes the actual room polygons into a floor+walls scene with tile texture and an adjustable wall-height slider (2.5D Plan ⇄ 3D Walkthrough toggle). Lazy-loaded.

## Calc engine fix + Custom tile sizing (2026-06-19)
- **FIXED critical waste/count bug**: the old engine added every perimeter edge-cut as a *whole extra tile*, so large-format tiles (e.g. 24×48 = 8 sqft) on a 201 sf room reported ~82% waste / 46 tiles. Rewrote `tile_quantities()` to an area-based model: `installed = ceil(net/tile_area)`, `order = ceil(installed × (1+waste))`, where `waste = max(pattern_rule, manufacturer_floor)` reduced ~3% when cut-reuse is on (floor 5%). Calacatta 24×48 now: 28 tiles / 11.2% waste. Full/Cut split is an informational cut sheet that sums to installed tiles.
- **Custom tile dimensions per room (PRIMARY input)**: Tile tab → Per-Room Layout now has Width × Height (inches) number inputs. Library tile is optional (supplies color/finish/price). `_eff_dims()` + `effectiveTile()` (geometry.js) flow custom dims through canvas tile-fill, 3D, and calc. `compute_summary()` groups by tile+size+pattern so different sizes form separate lines; per-tid deductions distribute to the largest room of that tile.
- **Mosaic pattern**: added to PATTERNS, SVG TilePattern (small chips), and Room3D texture. Calculated/sold by the sheet (`_mosaic_quantities`, 12×12 = 1 sqft sheet). Breakdown relabels Full→Sheets for mosaic.
- Tests: /app/backend/tests/test_calc.py (8 passing). Frontend E2E verified (waste sanity, custom dims, mosaic, panel scroll all pass).

## In-app subscription management (2026-06-19f)
- Billing now tracks a **30-day plan period** (`current_period_end`) set on each successful payment; `ws_plan` lazily downgrades to Free when a canceled period lapses.
- **Self-serve management**: `/billing/cancel` (cancel at period end) + `/billing/reactivate`; Billing page shows "Active · renews <date>" / "Cancels on <date>" with Cancel / Reactivate buttons. Verified (iteration_6, 6/6 pass).
- NOTE: true Stripe auto-charging recurring + hosted Customer Portal require the user's REAL Stripe secret key + recurring Price IDs (the Emergent-managed `sk_test_emergent` sandbox only supports one-time Checkout). This in-app model is the working equivalent until a live key is added.

## Plan feature-gating + live email (2026-06-19e)

- **Stripe plans now enforce real limits** server-side (`PLAN_LIMITS`): Free = 1 project, no AI/exports/email/audit, 1 seat; Pro = unlimited projects + AI + exports + email; Team = + audit log + 10 seats. Gated routes return **HTTP 402** with an upgrade message; frontend axios interceptor shows an "View plans" toast. Verified: free blocks 2nd project/AI/export/email/audit, team allows all.
- `/billing/me` returns `limits` + live `usage` (projects, members); Billing page shows per-plan feature checklist + current usage.
- **Email is LIVE** with the user's Resend key — sends HTML + PDF attachment (test mode: deliverable only to the Resend account email until a domain is verified).
- Test workspace ("TileTakeoff HQ") set to `team` so existing demo flows keep working.

## "Finish all" — Waves 1-7 (2026-06-19d)

Delivered the full PRD gap list:
- **Per-page PDF calibration** — each page stores its own scale (`drawings.calibrations.{n}`); `calc.py` resolves scale per measurement page. Status badge shows `p{n}` + not-calibrated per page.
- **On-canvas A/W/H overlay** — `ShapeRender` renders room name + A=sf, W/H=feet-inches, P=ft, toggled by Layers "Show" prefs, matching plan annotations.
- **Email report (Resend)** — completed with PDF attachment; needs a real `RESEND_API_KEY` (currently empty → 503).
- **AI approve/reject** — per-region Accept/Reject/Restore with persisted status; AI service now also returns **symbols/fixtures** + **OCR text_annotations** + recommended waste.
- **Catalog upgrade** — CSV import captures SKU / manufacturer / distributor; shown on catalog cards.
- **Revision history** — snapshot/list/restore takeoff versions (`takeoff_revisions`), History dialog in studio.
- **Mobile companion (PWA)** — `/m` route + manifest.json; touch-first project→takeoff→summary→PDF flow.
- **SaaS hardening** — `audit_logs` + `/audit` page (admin), and **Stripe billing** (`/billing`, plans free/pro/team, test-mode checkout + status polling + webhook, `payment_transactions`, workspace `plan`).
- Canvas: scroll-zoom + middle-mouse pan hardened.
- Tests: 11 calc pytests + testing-agent iteration_5 (12/12 new backend cases, new UI pages all pass).

## Wave-prior history below

## Exports + AI page + waste override + CSV import + metrics + pan/zoom (2026-06-19c)

- **Per-room metrics by preference (NEW)**: Layers tab has a "Show" bar (Area / W×L / Perimeter / Wall sf) persisted to `localStorage(tt_metric_prefs)`. Each room shows A=<sf>, W×L=<feet-inches>, Perim=<ft> — matches plan-style A/W/H annotations (e.g. "A=157 sf  W×L=11'-9\" × 13'-4\"  Perim=50.2 ft"). Helpers `bbox()` + `fmtFtIn()` in geometry.js.
- **Per-room waste % override**: input in Tile tab (`room-waste-<id>`); `tile_quantities(..., waste_override)` replaces the auto allowance (accepts 15 or 0.15).
- **Catalog CSV import**: `POST /api/tiles/import` (flexible headers, name/width/height/finish/pattern/price/etc.) + Import CSV / Template buttons on Catalog page.
- **Multi-page AI**: `ai-analyze?page=N` rasterizes the active PDF page; frontend `runAI` passes current page.
- **Exports**: PDF/Excel/CSV `<a>` links now force-download (download attr); all verified 200 with correct content-types.
- **Canvas pan/zoom**: scroll-wheel zoom (existing) + middle-mouse-button hold-drag pan made robust (pointer capture + native mousedown preventDefault to kill browser autoscroll).
- **Fixed**: Catalog.js unterminated-JSX crash (stray `<div>` balance).
- Tests: 10 passing in test_calc.py. Full E2E iteration_4.json — all 7 asks pass, no bugs.


- **Wall-elevation mode**: a linear/wall run can be given a height (Style tab → Wall Elevation → Height ft). The backend (`calc.py` LINEAR branch) converts it to a tiled surface area = length × height, joins it into the tile group, and it appears in Per-Room Layout for tile/size/pattern assignment. Verified: 32.6 ft × 8 ft = 261.13 sf added to net area. Door/window openings deduct via cutout rectangles.
- **Multi-page PDF**: `pdf.js` now exposes `loadPdf`/`renderPdfPage`; the studio shows a page navigator (Page X / N) for multi-page PDFs. Markup is tagged with `page` and the canvas (fill, shapes, control points, hit-test, snapping) is filtered to the current page. Layers list shows a `pX` badge and clicking jumps to that page. (AI still rasterizes page 1 — multi-page AI is a future enhancement.)
- **Panel-scroll fix**: scrollable `TabsContent` panels were missing `min-h-0`, so they couldn't shrink and clipped content. Added `min-h-0` to all scrollable tab panels.
- Tests: 9 passing in test_calc.py (added wall-elevation). Frontend E2E: all 6 asks pass (iteration_3.json).



- Email sending requires a real RESEND_API_KEY (currently returns 503).
- PDF plans now render in the Takeoff Studio canvas (client-side via pdf.js, page 1) so calibration + markup work on PDFs.
- AI analysis still requires an IMAGE drawing (PNG/JPG); PDF AI uses page-1 raster is a future enhancement (currently 400 on PDF).
- Catalog Add Tile includes a 68-size standard tile library (quick-pick presets).

## Backlog (Prioritized)
### P1
- PDF-to-image rasterization for PDF plan markup + AI on PDFs.
- AI suggestion → auto-create traced polygons on canvas (currently advisory only).
- Catalog/pricing CSV import (manufacturer SKUs / distributor price lists).
### P2
- Revision history for measurements; multi-sheet linking.
- Comments / approvals / version comparison collaboration.
- Mobile companion app (field review, offline asset caching).
- Audit logs, usage tracking, billing hooks (Stripe), admin controls.
- Real Three.js/R3F 3D room walkthrough.

## Next Tasks
- Wire RESEND_API_KEY when user provides it to enable live email sharing.
- Add PDF rasterization to unlock AI + markup on PDF plans.
- Catalog import pipeline.
