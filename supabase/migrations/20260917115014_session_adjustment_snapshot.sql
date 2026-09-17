alter table public.reps add column if not exists session_adjustment jsonb;
comment on column public.reps.session_adjustment is
  'Versioned snapshot of reported_cooked and applied_multiplier at session start. Null on legacy rows; never infer from later daily_state.';
