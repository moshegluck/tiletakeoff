-- Plan files (the PDF / image a takeoff is drawn on), so a project opens with
-- its drawing on any device. Private bucket; each user reads and writes only
-- the files under their own folder: plans/<user id>/<project id>.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('plans', 'plans', false, 52428800,
        array['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'])
on conflict (id) do nothing;

drop policy if exists "plans_select_own" on storage.objects;
create policy "plans_select_own" on storage.objects for select to authenticated
  using (bucket_id = 'plans' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "plans_insert_own" on storage.objects;
create policy "plans_insert_own" on storage.objects for insert to authenticated
  with check (bucket_id = 'plans' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "plans_update_own" on storage.objects;
create policy "plans_update_own" on storage.objects for update to authenticated
  using (bucket_id = 'plans' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'plans' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "plans_delete_own" on storage.objects;
create policy "plans_delete_own" on storage.objects for delete to authenticated
  using (bucket_id = 'plans' and (storage.foldername(name))[1] = auth.uid()::text);
