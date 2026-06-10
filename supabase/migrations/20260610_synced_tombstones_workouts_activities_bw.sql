-- Applied to the live DB on 2026-06-10 via MCP (migration name:
-- synced_tombstones_for_workouts_activities_bw). Recorded here so the
-- repo matches production.
--
-- Synced tombstones for the three domains that only had per-device
-- delete markers (workout sessions) or none at all (activities, body
-- weights). Without these, any second device that still holds a
-- deleted item in its local cache re-pushes it on its next reconcile
-- ("delete resurrection") — the same failure mode rep_tombstones was
-- built to stop for reps.
--
-- Client consumers:
--   workout_session_tombstones — sync.deleteWorkoutSession writes;
--     useRepHistory's workout reconcile unions into LS_WORKOUT_DELETED_KEY.
--   activity_tombstones — sync.deleteActivityCloud writes;
--     useActivities' reconcile filters merge + backfill.
--   bw_tombstones — sync.deleteBW writes; useUserSettings' BW
--     reconcile filters merge + backfill.

CREATE TABLE IF NOT EXISTS public.workout_session_tombstones (
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, session_id)
);
ALTER TABLE public.workout_session_tombstones ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS own_rows_select ON public.workout_session_tombstones;
DROP POLICY IF EXISTS own_rows_write  ON public.workout_session_tombstones;
CREATE POLICY own_rows_select ON public.workout_session_tombstones
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY own_rows_write ON public.workout_session_tombstones
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.activity_tombstones (
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  activity_id text NOT NULL,
  deleted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, activity_id)
);
ALTER TABLE public.activity_tombstones ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS own_rows_select ON public.activity_tombstones;
DROP POLICY IF EXISTS own_rows_write  ON public.activity_tombstones;
CREATE POLICY own_rows_select ON public.activity_tombstones
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY own_rows_write ON public.activity_tombstones
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.bw_tombstones (
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date       text NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, date)
);
ALTER TABLE public.bw_tombstones ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS own_rows_select ON public.bw_tombstones;
DROP POLICY IF EXISTS own_rows_write  ON public.bw_tombstones;
CREATE POLICY own_rows_select ON public.bw_tombstones
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY own_rows_write ON public.bw_tombstones
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
