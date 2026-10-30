-- Signed-in app users upload hand photos from Settings into their own
-- folder, u/<auth uid>/, without a link code. Still insert-only.
drop policy if exists "hand photos: signed-in upload to own folder" on storage.objects;
create policy "hand photos: signed-in upload to own folder"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'hand-photos'
  and (storage.foldername(name))[1] = 'u'
  and (storage.foldername(name))[2] = (select auth.uid())::text
);
