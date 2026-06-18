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

## Known gaps / Notes
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
