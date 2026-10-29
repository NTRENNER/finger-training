-- Phone push when someone finishes uploading hand photos (HO sizing).
-- The second photo of each upload ("apart_...") sends one ntfy.sh push to a
-- private topic. The topic lives in a locked table, not in git:
--   insert into public.hand_upload_settings (key, value) values ('ntfy_topic', '<random topic>');
-- Delete that row to stop notifications. A failed push never blocks an upload.

create extension if not exists pg_net with schema extensions;

create table if not exists public.hand_upload_settings (
  key text primary key,
  value text not null
);
alter table public.hand_upload_settings enable row level security;
-- no policies: invisible to anon and signed-in users

create or replace function public.notify_hand_photo_upload()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  topic text;
  folders text[];
  who text;
begin
  if new.bucket_id <> 'hand-photos' or new.name !~ '/apart_[^/]+$' then
    return new;
  end if;
  select s.value into topic from public.hand_upload_settings s where s.key = 'ntfy_topic';
  if topic is null then
    return new;
  end if;
  folders := storage.foldername(new.name);
  who := initcap(replace(regexp_replace(folders[array_length(folders, 1)], '^\d{4}-\d{2}-\d{2}_', ''), '-', ' '));
  perform net.http_post(
    url := 'https://ntfy.sh',
    body := jsonb_build_object(
      'topic', topic,
      'title', 'New hand photos',
      'message', who || case when new.name like 'u/%' then ' uploaded hand photos in the app.' else ' uploaded hand photos.' end
        || E'\nIn Terminal: cd ~/finger-training && npm run hand-photos',
      'tags', jsonb_build_array('raised_hand')
    )
  );
  return new;
exception when others then
  return new;
end;
$$;
revoke all on function public.notify_hand_photo_upload() from public, anon, authenticated;

drop trigger if exists notify_hand_photo_upload on storage.objects;
create trigger notify_hand_photo_upload
after insert on storage.objects
for each row execute function public.notify_hand_photo_upload();
