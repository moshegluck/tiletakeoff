-- Saved tiles carry how they're laid, so applying one from the library sets
-- the room's pattern, grout and colour, not just the size and price.
alter table public.tile_library
  add column if not exists kind        text    not null default 'floor',   -- floor | wall
  add column if not exists pattern     text    not null default 'grid',    -- engine/layouts.js PATTERNS ids
  add column if not exists angle_deg   numeric not null default 0,
  add column if not exists grout_in    numeric not null default 0.125,
  add column if not exists color       text,
  add column if not exists finish_style text,                            -- 3D texture style (wood, marble, …)
  add column if not exists waste_pct   numeric;
