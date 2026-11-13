-- Add improvement summaries without guessing baselines for existing peaks.
-- Old clients remain compatible; rows without comparison evidence are unranked.
-- Gains are measured from the first max-effort day since joining.
alter table public.community_peaks
  add column baseline_peak_kg double precision,
  add column baseline_date date,
  add column improvement_peak_kg double precision,
  add column improvement_date date,
  add constraint community_peak_comparison_complete check (
    (baseline_peak_kg is null and baseline_date is null and improvement_peak_kg is null and improvement_date is null)
    or (baseline_peak_kg is not null and baseline_date is not null and improvement_peak_kg is not null and improvement_date is not null
      and baseline_peak_kg > 0 and baseline_peak_kg < 200
      and improvement_peak_kg > baseline_peak_kg and improvement_peak_kg <= peak_kg
      and improvement_peak_kg < 200 and baseline_date < improvement_date and improvement_date <= current_date + 1)
  );

create or replace function public.sync_community(p_achievements jsonb, p_peaks jsonb, p_progress jsonb default '[]'::jsonb) returns void
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
  insert into public.community_peaks (user_id, grip, hand, peak_kg, measured_date,
    baseline_peak_kg, baseline_date, improvement_peak_kg, improvement_date)
    select auth.uid(), x.grip, x.hand, x.peak_kg, x.measured_date,
      x.baseline_peak_kg, x.baseline_date, x.improvement_peak_kg, x.improvement_date
    from jsonb_to_recordset(p_peaks) as x(grip text, hand text, peak_kg double precision, measured_date date,
      baseline_peak_kg double precision, baseline_date date, improvement_peak_kg double precision, improvement_date date);
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

-- Percentage gain is computed here from the unrounded paired measurements.
-- Each hand keeps its own baseline; choose the most improved hand per member.
-- The baseline must fall on or after the member's join date (one day of
-- time-zone slack, as for achievements), whichever path wrote the row.
create function public.community_peak_improvement_ranking(p_grip text, p_hand text default null)
returns table (user_id uuid, display_name text, hand text, baseline_peak_kg double precision,
  peak_kg double precision, improvement_pct double precision, baseline_date date, measured_date date, place bigint)
language sql stable security invoker set search_path = '' as $$
  with gains as (
    select r.user_id, p.display_name, r.hand, r.baseline_peak_kg,
      r.improvement_peak_kg as peak_kg,
      (r.improvement_peak_kg / r.baseline_peak_kg - 1) * 100 as improvement_pct,
      r.baseline_date, r.improvement_date as measured_date
    from public.community_peaks r join public.community_profiles p on p.user_id = r.user_id
    where r.grip = p_grip and (p_hand is null or r.hand = p_hand) and p.sharing_enabled
      and r.baseline_peak_kg > 0 and r.improvement_peak_kg > r.baseline_peak_kg
      and r.baseline_date >= (p.created_at at time zone 'UTC')::date - 1
  ), best as (
    select distinct on (user_id) * from gains
    order by user_id, improvement_pct desc, measured_date, hand
  ) select *, rank() over (order by improvement_pct desc) from best
    order by improvement_pct desc, measured_date, user_id limit 100
$$;
revoke all on function public.community_peak_improvement_ranking(text,text) from public, anon;
grant execute on function public.community_peak_improvement_ranking(text,text) to authenticated;
