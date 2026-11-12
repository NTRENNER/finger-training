-- Social snapshots only. No training/model tables or experiment rules change.
create function public.community_member() returns boolean
language sql stable security invoker set search_path = '' as $$
  select auth.uid() is not null and coalesce(auth.jwt()->>'is_anonymous', 'false') = 'false'
$$;
revoke all on function public.community_member() from public, anon;
grant execute on function public.community_member() to authenticated;

create table public.community_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (length(btrim(display_name)) between 2 and 32),
  sharing_enabled boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.community_profiles enable row level security;
create policy profiles_read on public.community_profiles for select to authenticated
  using (public.community_member() and (user_id = (select auth.uid()) or sharing_enabled));
create policy profiles_insert on public.community_profiles for insert to authenticated
  with check (public.community_member() and user_id = (select auth.uid()));
create policy profiles_update on public.community_profiles for update to authenticated
  using (public.community_member() and user_id = (select auth.uid()))
  with check (public.community_member() and user_id = (select auth.uid()));
revoke all on public.community_profiles from anon, authenticated;
grant select on public.community_profiles to authenticated;
grant insert (user_id, display_name, sharing_enabled), update (display_name, sharing_enabled)
  on public.community_profiles to authenticated;

create table public.community_achievements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.community_profiles(user_id) on delete cascade,
  achievement_key text not null check (length(achievement_key) between 1 and 250),
  grip text not null check (length(grip) between 1 and 80),
  metric text not null check (metric in ('balanced','max_strength','power','power_strength','strength','strength_endurance','endurance')),
  milestone_pct integer not null check (milestone_pct in (1,2,5,10,20,35,50,75,100)),
  improvement_pct double precision not null check (improvement_pct >= milestone_pct and improvement_pct < 10000),
  baseline_date date not null,
  prior_date date not null check (prior_date > baseline_date),
  achieved_date date not null check (achieved_date > prior_date),
  occurred_at timestamptz not null check (occurred_at <= now() + interval '5 minutes'),
  baseline_force_kg double precision not null check (baseline_force_kg > 0 and baseline_force_kg < 200),
  current_force_kg double precision not null check (current_force_kg > 0 and current_force_kg < 200),
  support_keys text[] not null check (cardinality(support_keys) between 1 and 6 and
    support_keys <@ array['max_strength','power','power_strength','strength','strength_endurance','endurance']),
  hidden boolean not null default false,
  withdrawn boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, achievement_key)
);
alter table public.community_achievements enable row level security;
create policy achievements_read on public.community_achievements for select to authenticated
  using (public.community_member() and (user_id = (select auth.uid()) or
    (not hidden and not withdrawn and exists (select 1 from public.community_profiles p where p.user_id = community_achievements.user_id and p.sharing_enabled))));
create policy achievements_insert on public.community_achievements for insert to authenticated
  with check (public.community_member() and user_id = (select auth.uid()) and
    exists (select 1 from public.community_profiles p where p.user_id = community_achievements.user_id and p.sharing_enabled
      and community_achievements.occurred_at >= p.created_at
      and community_achievements.achieved_date >= (p.created_at at time zone 'UTC')::date - 1));
create policy achievements_update on public.community_achievements for update to authenticated
  using (public.community_member() and user_id = (select auth.uid()))
  with check (public.community_member() and user_id = (select auth.uid()));
revoke all on public.community_achievements from anon, authenticated;
grant select, insert on public.community_achievements to authenticated;
grant update (improvement_pct, baseline_date, prior_date, achieved_date, occurred_at,
  baseline_force_kg, current_force_kg, support_keys, hidden, withdrawn) on public.community_achievements to authenticated;
create index community_feed_order on public.community_achievements (created_at desc, id desc) where not hidden and not withdrawn;

create table public.community_peaks (
  user_id uuid not null references public.community_profiles(user_id) on delete cascade,
  grip text not null check (length(grip) between 1 and 80),
  hand text not null check (hand in ('L','R')),
  peak_kg double precision not null check (peak_kg > 0 and peak_kg < 200),
  measured_date date not null check (measured_date <= current_date + 1),
  primary key (user_id, grip, hand)
);
alter table public.community_peaks enable row level security;
create policy peaks_read on public.community_peaks for select to authenticated
  using (public.community_member() and exists (select 1 from public.community_profiles p where p.user_id = community_peaks.user_id and p.sharing_enabled));
create policy peaks_insert on public.community_peaks for insert to authenticated
  with check (public.community_member() and user_id = (select auth.uid()) and exists (select 1 from public.community_profiles p where p.user_id = community_peaks.user_id and p.sharing_enabled));
create policy peaks_delete on public.community_peaks for delete to authenticated
  using (public.community_member() and user_id = (select auth.uid()));
revoke all on public.community_peaks from anon, authenticated;
grant select, insert, delete on public.community_peaks to authenticated;
create index community_peak_order on public.community_peaks (grip, hand, peak_kg desc);

create table public.community_progress (
  user_id uuid not null references public.community_profiles(user_id) on delete cascade,
  grip text not null check (length(grip) between 1 and 80),
  metric text not null check (metric in ('balanced','max_strength','power','power_strength','strength','strength_endurance','endurance')),
  baseline_date date not null,
  prior_date date not null check (prior_date > baseline_date),
  measured_date date not null check (measured_date > prior_date and measured_date <= current_date + 1),
  baseline_force_kg double precision not null check (baseline_force_kg > 0 and baseline_force_kg < 200),
  current_force_kg double precision not null check (current_force_kg > 0 and current_force_kg < 200),
  group_force_kg double precision not null check (group_force_kg > 0 and group_force_kg < 200),
  baseline_band integer generated always as ((floor((group_force_kg + 1e-9) / 10) * 10)::integer) stored,
  improvement_pct double precision not null check (improvement_pct >= milestone_pct and improvement_pct < 10000),
  milestone_pct integer not null check (milestone_pct in (1,2,5,10,20,35,50,75,100)),
  support_keys text[] not null check (cardinality(support_keys) between 1 and 6
    and support_keys <@ array['max_strength','power','power_strength','strength','strength_endurance','endurance']),
  primary key (user_id, grip, metric)
);
alter table public.community_progress enable row level security;
create policy progress_read on public.community_progress for select to authenticated
  using (public.community_member() and exists (select 1 from public.community_profiles p where p.user_id = community_progress.user_id and p.sharing_enabled));
create policy progress_insert on public.community_progress for insert to authenticated
  with check (public.community_member() and user_id = (select auth.uid()) and exists (select 1 from public.community_profiles p where p.user_id = community_progress.user_id and p.sharing_enabled));
create policy progress_delete on public.community_progress for delete to authenticated
  using (public.community_member() and user_id = (select auth.uid()));
revoke all on public.community_progress from anon, authenticated;
grant select, insert, delete on public.community_progress to authenticated;
create index community_progress_order on public.community_progress (grip, baseline_band, metric, improvement_pct desc);

create table public.community_celebrations (
  achievement_id uuid not null references public.community_achievements(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  primary key (achievement_id, user_id)
);
alter table public.community_celebrations enable row level security;
create policy celebrations_read on public.community_celebrations for select to authenticated
  using (public.community_member() and exists (select 1 from public.community_achievements a join public.community_profiles p on p.user_id = a.user_id
    where a.id = achievement_id and not a.hidden and not a.withdrawn and p.sharing_enabled));
create policy celebrations_insert on public.community_celebrations for insert to authenticated
  with check (public.community_member() and user_id = (select auth.uid()) and exists (
    select 1 from public.community_achievements a join public.community_profiles p on p.user_id = a.user_id
    where a.id = achievement_id and not a.hidden and not a.withdrawn and p.sharing_enabled));
create policy celebrations_delete on public.community_celebrations for delete to authenticated
  using (public.community_member() and user_id = (select auth.uid()));
revoke all on public.community_celebrations from anon, authenticated;
grant select, insert, delete on public.community_celebrations to authenticated;

-- Serialize a member's publications, including multiple devices. Opt-out's
-- profile update takes the same row lock. Hidden cards stay hidden on retries.
create function public.sync_community(p_achievements jsonb, p_peaks jsonb, p_progress jsonb default '[]'::jsonb) returns void
language plpgsql security invoker set search_path = '' as $$
declare enrolled timestamptz; enabled boolean;
begin
  if not public.community_member() then raise exception 'Member required'; end if;
  select p.created_at, p.sharing_enabled into enrolled, enabled from public.community_profiles p
    where p.user_id = auth.uid() for update;
  if not coalesce(enabled, false) then return; end if;
  if jsonb_typeof(p_achievements) <> 'array' or jsonb_typeof(p_peaks) <> 'array' or jsonb_typeof(p_progress) <> 'array'
     or p_achievements is null or p_peaks is null or p_progress is null then raise exception 'Snapshots required'; end if;
  update public.community_achievements a set withdrawn = true where a.user_id = auth.uid()
    and not exists (select 1 from jsonb_array_elements(p_achievements) j where j->>'achievement_key' = a.achievement_key);
  insert into public.community_achievements (user_id, achievement_key, grip, metric, milestone_pct,
    improvement_pct, baseline_date, prior_date, achieved_date, occurred_at, baseline_force_kg, current_force_kg, support_keys)
  select auth.uid(), x.achievement_key, x.grip, x.metric, x.milestone_pct,
    x.improvement_pct, x.baseline_date, x.prior_date, x.achieved_date, x.occurred_at, x.baseline_force_kg, x.current_force_kg, x.support_keys
    from jsonb_to_recordset(p_achievements) as x(achievement_key text, grip text, metric text, milestone_pct integer,
      improvement_pct double precision, baseline_date date, prior_date date, achieved_date date, occurred_at timestamptz,
      baseline_force_kg double precision, current_force_kg double precision, support_keys text[])
    where x.occurred_at >= enrolled and x.achieved_date >= (enrolled at time zone 'UTC')::date - 1
  on conflict (user_id, achievement_key) do update set
    improvement_pct = excluded.improvement_pct, baseline_date = excluded.baseline_date,
    prior_date = excluded.prior_date, achieved_date = excluded.achieved_date, occurred_at = excluded.occurred_at,
    baseline_force_kg = excluded.baseline_force_kg, current_force_kg = excluded.current_force_kg,
    support_keys = excluded.support_keys, withdrawn = false;
  delete from public.community_peaks where user_id = auth.uid();
  insert into public.community_peaks (user_id, grip, hand, peak_kg, measured_date)
    select auth.uid(), x.grip, x.hand, x.peak_kg, x.measured_date
    from jsonb_to_recordset(p_peaks) as x(grip text, hand text, peak_kg double precision, measured_date date);
  delete from public.community_progress where user_id = auth.uid();
  insert into public.community_progress (user_id, grip, metric, baseline_date,
    prior_date, measured_date, baseline_force_kg, current_force_kg, group_force_kg, improvement_pct, milestone_pct, support_keys)
    select auth.uid(), x.grip, x.metric, x.baseline_date,
      x.prior_date, x.measured_date, x.baseline_force_kg, x.current_force_kg, x.group_force_kg, x.improvement_pct, x.milestone_pct, x.support_keys
    from jsonb_to_recordset(p_progress) as x(grip text, metric text,
      baseline_date date, prior_date date, measured_date date, baseline_force_kg double precision,
      current_force_kg double precision, group_force_kg double precision, improvement_pct double precision,
      milestone_pct integer, support_keys text[]);
end $$;
revoke all on function public.sync_community(jsonb,jsonb,jsonb) from public, anon;
grant execute on function public.sync_community(jsonb,jsonb,jsonb) to authenticated;

create function public.community_feed(p_grip text default null, p_before timestamptz default null,
  p_before_id uuid default null) returns table (id uuid, user_id uuid, display_name text, grip text,
    metric text, milestone_pct integer, improvement_pct double precision, baseline_date date,
    achieved_date date, baseline_force_kg double precision, current_force_kg double precision,
    support_keys text[], created_at timestamptz, celebrations bigint, celebrated boolean)
language sql stable security invoker set search_path = '' as $$
  select a.id, a.user_id, p.display_name, a.grip, a.metric, a.milestone_pct, a.improvement_pct,
    a.baseline_date, a.achieved_date, a.baseline_force_kg, a.current_force_kg, a.support_keys, a.created_at,
    (select count(*) from public.community_celebrations c where c.achievement_id = a.id),
    exists (select 1 from public.community_celebrations c where c.achievement_id = a.id and c.user_id = auth.uid())
  from public.community_achievements a join public.community_profiles p on p.user_id = a.user_id
  where p.sharing_enabled and not a.hidden and not a.withdrawn
    and (p_grip is null or a.grip = p_grip)
    and (p_before is null or (a.created_at, a.id) < (p_before, p_before_id))
  order by a.created_at desc, a.id desc limit 30
$$;
revoke all on function public.community_feed(text,timestamptz,uuid) from public, anon;
grant execute on function public.community_feed(text,timestamptz,uuid) to authenticated;

-- One entry per member. Both hands selects that member's best hand, not two
-- entries. Exact ties share rank; dates/UUIDs only stabilize display ordering.
create function public.community_ranking(p_grip text, p_hand text default null)
returns table (user_id uuid, display_name text, hand text, peak_kg double precision, measured_date date, place bigint)
language sql stable security invoker set search_path = '' as $$
  with best as (
    select distinct on (r.user_id) r.user_id, p.display_name, r.hand, r.peak_kg, r.measured_date
    from public.community_peaks r join public.community_profiles p on p.user_id = r.user_id
    where r.grip = p_grip and (p_hand is null or r.hand = p_hand) and p.sharing_enabled
    order by r.user_id, r.peak_kg desc, r.measured_date, r.hand
  ) select *, rank() over (order by peak_kg desc) from best order by peak_kg desc, measured_date, user_id limit 100
$$;
revoke all on function public.community_ranking(text,text) from public, anon;
grant execute on function public.community_ranking(text,text) to authenticated;

-- A cohort is a starting balanced-force band AND an identical duration basis.
-- These are navigation groups, not fitness classifications. No population data
-- or private training rows are read to form them.
create function public.community_improvement_groups(p_grip text)
returns table (baseline_band integer, support_keys text[], members bigint)
language sql stable security invoker set search_path = '' as $$
  select r.baseline_band, r.support_keys, count(distinct r.user_id)
  from public.community_progress r join public.community_profiles p on p.user_id = r.user_id
  where p.sharing_enabled and r.grip = p_grip
  group by r.baseline_band, r.support_keys order by r.baseline_band, r.support_keys
$$;
revoke all on function public.community_improvement_groups(text) from public, anon;
grant execute on function public.community_improvement_groups(text) to authenticated;

create function public.community_improvement_ranking(p_grip text, p_baseline_band integer, p_support_keys text[])
returns table (user_id uuid, display_name text, metric text, baseline_force_kg double precision,
  current_force_kg double precision, improvement_pct double precision, milestone_pct integer,
  baseline_date date, measured_date date, place bigint)
language sql stable security invoker set search_path = '' as $$
  with ranked as (
    select r.user_id, p.display_name, r.metric, r.baseline_force_kg, r.current_force_kg,
      r.improvement_pct, r.milestone_pct, r.baseline_date, r.measured_date,
      rank() over (partition by r.metric order by r.improvement_pct desc) as place,
      row_number() over (partition by r.metric order by r.improvement_pct desc, r.user_id) as position
    from public.community_progress r join public.community_profiles p on p.user_id = r.user_id
    where p.sharing_enabled and r.grip = p_grip
      and r.baseline_band = p_baseline_band and r.support_keys = p_support_keys
  ) select user_id, display_name, metric, baseline_force_kg, current_force_kg, improvement_pct,
    milestone_pct, baseline_date, measured_date, place from ranked where position <= 100
    order by metric, place, user_id
$$;
revoke all on function public.community_improvement_ranking(text,integer,text[]) from public, anon;
grant execute on function public.community_improvement_ranking(text,integer,text[]) to authenticated;

-- Publish an empty invalidation, never a profile, training row or score.
-- An opt-out must invalidate other clients even though their RLS permission to
-- read that member disappears. A private broadcast avoids leaking OLD records.
create schema if not exists community_private;
revoke all on schema community_private from public, anon, authenticated;
create function community_private.notify_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then return null; end if;
  perform realtime.send('{}'::jsonb, 'changed', 'community', true);
  return null;
end $$;
revoke all on function community_private.notify_change() from public, anon, authenticated;
create trigger community_profile_changed after insert or update or delete on public.community_profiles
  for each statement execute function community_private.notify_change();
create trigger community_progress_changed after insert or delete on public.community_progress
  for each statement execute function community_private.notify_change();
create trigger community_peaks_changed after insert or delete on public.community_peaks
  for each statement execute function community_private.notify_change();
create trigger community_achievement_changed after insert or update or delete on public.community_achievements
  for each statement execute function community_private.notify_change();
create trigger community_celebration_changed after insert or delete on public.community_celebrations
  for each statement execute function community_private.notify_change();
create policy community_broadcast_read on realtime.messages for select to authenticated
  using (realtime.topic() = 'community' and public.community_member());
-- Restrict only this topic, even if the project has broader existing policies.
create policy community_broadcast_member_only on realtime.messages as restrictive for select to authenticated
  using (coalesce(realtime.topic(), '') <> 'community' or public.community_member());
create policy community_broadcast_server_only on realtime.messages as restrictive for insert to authenticated
  with check (coalesce(realtime.topic(), '') <> 'community');
