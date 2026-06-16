-- ============================================================
-- TileTakeoff schema — projects belong to an authenticated user.
-- Row Level Security from day one: a user can only see/edit own rows.
-- A project stores its full document (rooms, materials, view, scale)
-- as JSONB so the engine stays the source of truth and the schema
-- doesn't fight every UI change. Indexed columns are the queryable
-- metadata (name, updated_at, owner).
-- ============================================================

create extension if not exists "pgcrypto";

create table if not exists public.projects (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null references auth.users(id) on delete cascade,
  name        text not null default 'Untitled Takeoff',
  unit_system text not null default 'imperial_ft_in',
  -- full editable document; engine reads/writes this shape
  doc         jsonb not null default '{}'::jsonb,
  -- denormalized headline numbers for list views / dashboards
  floor_sf    numeric default 0,
  total_cost  numeric default 0,
  thumbnail   text,                     -- optional dataURL/preview
  archived    boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists projects_owner_idx     on public.projects(owner);
create index if not exists projects_updated_idx   on public.projects(owner, updated_at desc);

-- keep updated_at fresh
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists projects_touch on public.projects;
create trigger projects_touch before update on public.projects
  for each row execute function public.touch_updated_at();

-- ---- Row Level Security ----
alter table public.projects enable row level security;

drop policy if exists "own_select" on public.projects;
create policy "own_select" on public.projects
  for select using (auth.uid() = owner);

drop policy if exists "own_insert" on public.projects;
create policy "own_insert" on public.projects
  for insert with check (auth.uid() = owner);

drop policy if exists "own_update" on public.projects;
create policy "own_update" on public.projects
  for update using (auth.uid() = owner) with check (auth.uid() = owner);

drop policy if exists "own_delete" on public.projects;
create policy "own_delete" on public.projects
  for delete using (auth.uid() = owner);

-- ============================================================
-- Reusable libraries (tile catalog, labor rates) shared per user.
-- Lets you build the "massive library" without bloating each project.
-- ============================================================
create table if not exists public.tile_library (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid not null references auth.users(id) on delete cascade,
  name       text not null,
  tw_in      numeric not null,
  th_in      numeric not null,
  thickness_mm numeric,
  material   text,            -- porcelain / ceramic / stone / LVT ...
  finish     text,
  sku        text,
  vendor     text,
  price      numeric,
  price_unit text default 'sf',
  sf_per_box numeric,
  created_at timestamptz not null default now()
);
create index if not exists tile_library_owner_idx on public.tile_library(owner);
alter table public.tile_library enable row level security;

drop policy if exists "lib_all" on public.tile_library;
create policy "lib_all" on public.tile_library
  using (auth.uid() = owner) with check (auth.uid() = owner);
