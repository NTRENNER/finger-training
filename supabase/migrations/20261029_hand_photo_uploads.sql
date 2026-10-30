-- Public upload of hand photos for HO device sizing (hands/index.html).
-- Private bucket: anyone with a valid code may upload; nobody but the owner
-- (dashboard / service role) can list, read, overwrite or delete.
-- Codes live in a table so they stay out of git and can be rotated:
--   insert into public.hand_upload_codes (code) values ('<random>');
--   update public.hand_upload_codes set active = false where code = '<old>';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('hand-photos', 'hand-photos', false, 31457280,
        array['image/heic', 'image/heif', 'image/jpeg', 'image/png'])
on conflict (id) do nothing;

create table if not exists public.hand_upload_codes (
  code text primary key check (code ~ '^[A-Za-z0-9]{8,40}$'),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.hand_upload_codes enable row level security;
-- no policies: the table is invisible to anon and signed-in users

create or replace function public.hand_upload_code_ok(candidate text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.hand_upload_codes c where c.code = candidate and c.active);
$$;
revoke all on function public.hand_upload_code_ok(text) from public;
grant execute on function public.hand_upload_code_ok(text) to anon, authenticated;

drop policy if exists "hand photos: upload with a valid code" on storage.objects;
create policy "hand photos: upload with a valid code"
on storage.objects for insert to anon, authenticated
with check (
  bucket_id = 'hand-photos'
  and public.hand_upload_code_ok((storage.foldername(name))[1])
);
