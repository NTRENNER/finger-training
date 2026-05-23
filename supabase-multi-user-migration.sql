-- ─────────────────────────────────────────────────────────────
-- MULTI-USER ISOLATION MIGRATION
-- ─────────────────────────────────────────────────────────────
-- Goal: every public data table gets a `user_id` column tied to
-- auth.users(id), backfilled to your account, and RLS policies that
-- only allow each user to see/touch their own rows.
--
-- All changes wrapped in a single transaction. If anything fails,
-- the whole thing rolls back and the DB returns to its current
-- state — no half-migrated mess.
--
-- Nathan's user id used for backfill:
--   4f37565f-9ecc-4cf7-a6fa-9b2606a67a4a
-- All existing rows in the 8 affected tables get assigned to that
-- id. Your friends' tiny amount of data (if any) gets merged into
-- yours — acceptable per your call.

BEGIN;

-- Local helper: the UID we'll backfill to.
DO $$ BEGIN PERFORM set_config('migration.owner_uid',
  '4f37565f-9ecc-4cf7-a6fa-9b2606a67a4a', true); END $$;

-- ─────────────────────────────────────────────────────────────
-- 1. Add user_id columns + backfill + NOT NULL + FK + index
-- ─────────────────────────────────────────────────────────────
-- For each table:
--   a) ADD COLUMN user_id uuid (nullable so the backfill can happen)
--   b) UPDATE all existing rows to your UID
--   c) ALTER to NOT NULL once backfilled
--   d) Add FK to auth.users(id) so user deletion cascades
--   e) Set DEFAULT auth.uid() so future inserts auto-populate from
--      the current session (the client also passes it explicitly,
--      but the default is belt-and-suspenders)
--   f) Add an index on user_id for query speed

-- ── reps (321 rows) ──
ALTER TABLE public.reps
  ADD COLUMN user_id uuid;
UPDATE public.reps
  SET user_id = current_setting('migration.owner_uid')::uuid;
ALTER TABLE public.reps
  ALTER COLUMN user_id SET NOT NULL,
  ALTER COLUMN user_id SET DEFAULT auth.uid(),
  ADD CONSTRAINT reps_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
CREATE INDEX reps_user_id_idx ON public.reps(user_id);

-- ── activities (43 rows; climbing log) ──
ALTER TABLE public.activities
  ADD COLUMN user_id uuid;
UPDATE public.activities
  SET user_id = current_setting('migration.owner_uid')::uuid;
ALTER TABLE public.activities
  ALTER COLUMN user_id SET NOT NULL,
  ALTER COLUMN user_id SET DEFAULT auth.uid(),
  ADD CONSTRAINT activities_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
CREATE INDEX activities_user_id_idx ON public.activities(user_id);

-- ── workout_sessions (16 rows) ──
ALTER TABLE public.workout_sessions
  ADD COLUMN user_id uuid;
UPDATE public.workout_sessions
  SET user_id = current_setting('migration.owner_uid')::uuid;
ALTER TABLE public.workout_sessions
  ALTER COLUMN user_id SET NOT NULL,
  ALTER COLUMN user_id SET DEFAULT auth.uid(),
  ADD CONSTRAINT workout_sessions_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
CREATE INDEX workout_sessions_user_id_idx ON public.workout_sessions(user_id);

-- ── body_weights (7 rows) ──
ALTER TABLE public.body_weights
  ADD COLUMN user_id uuid;
UPDATE public.body_weights
  SET user_id = current_setting('migration.owner_uid')::uuid;
ALTER TABLE public.body_weights
  ALTER COLUMN user_id SET NOT NULL,
  ALTER COLUMN user_id SET DEFAULT auth.uid(),
  ADD CONSTRAINT body_weights_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
CREATE INDEX body_weights_user_id_idx ON public.body_weights(user_id);

-- ── rep_tombstones (20 rows) ──
ALTER TABLE public.rep_tombstones
  ADD COLUMN user_id uuid;
UPDATE public.rep_tombstones
  SET user_id = current_setting('migration.owner_uid')::uuid;
ALTER TABLE public.rep_tombstones
  ALTER COLUMN user_id SET NOT NULL,
  ALTER COLUMN user_id SET DEFAULT auth.uid(),
  ADD CONSTRAINT rep_tombstones_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
CREATE INDEX rep_tombstones_user_id_idx ON public.rep_tombstones(user_id);

-- ── daily_state (1 row; PK changes!) ──
-- The original PK is just `date`, which means two users couldn't
-- both have a row for the same day. Drop the PK, add user_id, then
-- recreate PK as (user_id, date).
ALTER TABLE public.daily_state
  ADD COLUMN user_id uuid;
UPDATE public.daily_state
  SET user_id = current_setting('migration.owner_uid')::uuid;
ALTER TABLE public.daily_state
  ALTER COLUMN user_id SET NOT NULL,
  ALTER COLUMN user_id SET DEFAULT auth.uid(),
  ADD CONSTRAINT daily_state_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  DROP CONSTRAINT daily_state_pkey,
  ADD CONSTRAINT daily_state_pkey PRIMARY KEY (user_id, date);

-- ── session_tombstones (5 rows; PK changes!) ──
-- session_id is the client-generated session uuid; safe to keep
-- but better to scope by user too.
ALTER TABLE public.session_tombstones
  ADD COLUMN user_id uuid;
UPDATE public.session_tombstones
  SET user_id = current_setting('migration.owner_uid')::uuid;
ALTER TABLE public.session_tombstones
  ALTER COLUMN user_id SET NOT NULL,
  ALTER COLUMN user_id SET DEFAULT auth.uid(),
  ADD CONSTRAINT session_tombstones_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  DROP CONSTRAINT session_tombstones_pkey,
  ADD CONSTRAINT session_tombstones_pkey PRIMARY KEY (user_id, session_id);

-- ── rep_slot_tombstones (21 rows; PK changes!) ──
ALTER TABLE public.rep_slot_tombstones
  ADD COLUMN user_id uuid;
UPDATE public.rep_slot_tombstones
  SET user_id = current_setting('migration.owner_uid')::uuid;
ALTER TABLE public.rep_slot_tombstones
  ALTER COLUMN user_id SET NOT NULL,
  ALTER COLUMN user_id SET DEFAULT auth.uid(),
  ADD CONSTRAINT rep_slot_tombstones_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  DROP CONSTRAINT rep_slot_tombstones_pkey,
  ADD CONSTRAINT rep_slot_tombstones_pkey
    PRIMARY KEY (user_id, session_id, set_num, rep_num, hand);

-- ─────────────────────────────────────────────────────────────
-- 2. Replace leaky RLS policies with proper user-scoped ones
-- ─────────────────────────────────────────────────────────────
-- The current "auth_all" policy allows any signed-in user to see
-- every row. Drop it on each table, then add 4 explicit policies
-- (SELECT / INSERT WITH CHECK / UPDATE / DELETE) all keyed on
-- auth.uid() = user_id.

DROP POLICY IF EXISTS auth_all ON public.reps;
CREATE POLICY reps_select  ON public.reps FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY reps_insert  ON public.reps FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY reps_update  ON public.reps FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY reps_delete  ON public.reps FOR DELETE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS auth_all ON public.activities;
CREATE POLICY activities_select ON public.activities FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY activities_insert ON public.activities FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY activities_update ON public.activities FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY activities_delete ON public.activities FOR DELETE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS auth_all ON public.workout_sessions;
CREATE POLICY workout_sessions_select ON public.workout_sessions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY workout_sessions_insert ON public.workout_sessions FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY workout_sessions_update ON public.workout_sessions FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY workout_sessions_delete ON public.workout_sessions FOR DELETE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS auth_all ON public.body_weights;
CREATE POLICY body_weights_select ON public.body_weights FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY body_weights_insert ON public.body_weights FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY body_weights_update ON public.body_weights FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY body_weights_delete ON public.body_weights FOR DELETE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS auth_all ON public.daily_state;
CREATE POLICY daily_state_select ON public.daily_state FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY daily_state_insert ON public.daily_state FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY daily_state_update ON public.daily_state FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY daily_state_delete ON public.daily_state FOR DELETE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS auth_all ON public.rep_tombstones;
CREATE POLICY rep_tombstones_select ON public.rep_tombstones FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY rep_tombstones_insert ON public.rep_tombstones FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY rep_tombstones_delete ON public.rep_tombstones FOR DELETE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS auth_all ON public.session_tombstones;
CREATE POLICY session_tombstones_select ON public.session_tombstones FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY session_tombstones_insert ON public.session_tombstones FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY session_tombstones_delete ON public.session_tombstones FOR DELETE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS auth_all ON public.rep_slot_tombstones;
CREATE POLICY rep_slot_tombstones_select ON public.rep_slot_tombstones FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY rep_slot_tombstones_insert ON public.rep_slot_tombstones FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY rep_slot_tombstones_delete ON public.rep_slot_tombstones FOR DELETE USING (auth.uid() = user_id);

-- (sessions and user_settings already have proper user-scoped
-- policies — no changes needed there.)

-- ─────────────────────────────────────────────────────────────
-- 3. Fix the fatigue-learning trigger for multi-user
-- ─────────────────────────────────────────────────────────────
-- The current trigger says `-- single-user app: take the only row`
-- and updates whichever user_settings row it finds. With multiple
-- users, that would update the wrong row on every rep insert.
-- Fix: look up settings by NEW.user_id (now that reps carries it).

CREATE OR REPLACE FUNCTION public.update_fatigue_beta_from_rep()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cooked        smallint;
  v_settings      jsonb;
  v_fatigue_model jsonb;
  v_grip_block    jsonb;
  v_eta           numeric;
  v_lambda        numeric;
  v_beta_old      numeric;
  v_beta_prior    numeric;
  v_beta_new      numeric;
  v_e             numeric;
  v_n_obs         integer;
  v_beta_max      CONSTANT numeric := 0.5;
  v_beta_min      CONSTANT numeric := 0.0;
  v_default_beta  CONSTANT numeric := 0.05;
  v_default_eta   CONSTANT numeric := 0.02;
  v_default_lambda CONSTANT numeric := 0.01;
BEGIN
  IF NEW.set_num IS DISTINCT FROM 1
     OR NEW.rep_num IS DISTINCT FROM 1
     OR NEW.actual_time_s IS NULL OR NEW.actual_time_s <= 0
     OR NEW.target_duration IS NULL OR NEW.target_duration <= 0
     OR NEW.grip IS NULL
     OR NEW.date IS NULL
     OR NEW.user_id IS NULL
  THEN
    RETURN NEW;
  END IF;

  -- Scope cookedness lookup to the rep's user (daily_state is now
  -- per-user too).
  SELECT cooked INTO v_cooked
  FROM public.daily_state
  WHERE date = NEW.date AND user_id = NEW.user_id;
  IF v_cooked IS NULL THEN
    RETURN NEW;
  END IF;

  -- Scope settings lookup to the rep's user.
  SELECT settings INTO v_settings
  FROM public.user_settings
  WHERE user_id = NEW.user_id;
  IF v_settings IS NULL THEN
    RETURN NEW;
  END IF;

  v_fatigue_model := COALESCE(v_settings->'fatigue_model', '{}'::jsonb);
  v_eta    := COALESCE(NULLIF(v_fatigue_model->>'eta', '')::numeric, v_default_eta);
  v_lambda := COALESCE(NULLIF(v_fatigue_model->>'lambda', '')::numeric, v_default_lambda);

  v_grip_block := COALESCE(
    v_fatigue_model->NEW.grip,
    jsonb_build_object('beta', v_default_beta, 'beta_prior', v_default_beta, 'n_obs', 0)
  );
  v_beta_old   := COALESCE(NULLIF(v_grip_block->>'beta', '')::numeric, v_default_beta);
  v_beta_prior := COALESCE(NULLIF(v_grip_block->>'beta_prior', '')::numeric, v_default_beta);
  v_n_obs      := COALESCE(NULLIF(v_grip_block->>'n_obs', '')::integer, 0);

  v_e := ln(NEW.actual_time_s::numeric / NEW.target_duration::numeric);
  v_beta_new := v_beta_old - v_eta * v_e * v_cooked - v_lambda * (v_beta_old - v_beta_prior);
  v_beta_new := GREATEST(v_beta_min, LEAST(v_beta_max, v_beta_new));

  v_grip_block := v_grip_block || jsonb_build_object(
    'beta',        v_beta_new,
    'beta_prior',  v_beta_prior,
    'n_obs',       v_n_obs + 1,
    'last_update', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );

  v_fatigue_model := v_fatigue_model || jsonb_build_object(NEW.grip, v_grip_block);
  v_fatigue_model := jsonb_set(v_fatigue_model, '{eta}',    to_jsonb(v_eta));
  v_fatigue_model := jsonb_set(v_fatigue_model, '{lambda}', to_jsonb(v_lambda));

  UPDATE public.user_settings
  SET settings   = jsonb_set(settings, '{fatigue_model}', v_fatigue_model),
      updated_at = now()
  WHERE user_id  = NEW.user_id;

  RETURN NEW;

EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'update_fatigue_beta_from_rep failed for rep id=%: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$function$;

-- ─────────────────────────────────────────────────────────────
-- 4. Harden the other two trigger functions
-- ─────────────────────────────────────────────────────────────
-- Pin search_path on both (Supabase advisor warning) to prevent
-- search-path injection attacks on SECURITY-DEFINER-adjacent code.

ALTER FUNCTION public.daily_state_set_updated_at()    SET search_path = public;
ALTER FUNCTION public.reject_tombstoned_rep_insert()  SET search_path = public;

-- ─────────────────────────────────────────────────────────────
-- 5. Lock down the fatigue trigger function's RPC exposure
-- ─────────────────────────────────────────────────────────────
-- The function is only meant to fire as an AFTER INSERT trigger on
-- reps, but Supabase auto-exposes every public function as an RPC.
-- Revoke EXECUTE from anon and authenticated so it can't be called
-- directly via /rest/v1/rpc/.

REVOKE EXECUTE ON FUNCTION public.update_fatigue_beta_from_rep() FROM anon;
REVOKE EXECUTE ON FUNCTION public.update_fatigue_beta_from_rep() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.update_fatigue_beta_from_rep() FROM public;

-- ─────────────────────────────────────────────────────────────
-- 6. Verify state before commit
-- ─────────────────────────────────────────────────────────────
-- Sanity check: every public table has user_id and proper policies.
-- If any of these fail, the transaction rolls back.

DO $$
DECLARE
  v_tables text[] := ARRAY[
    'reps','activities','workout_sessions','body_weights',
    'daily_state','rep_tombstones','session_tombstones','rep_slot_tombstones'
  ];
  v_table text;
  v_count integer;
BEGIN
  FOREACH v_table IN ARRAY v_tables LOOP
    -- user_id column exists, NOT NULL
    SELECT count(*) INTO v_count
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name=v_table
      AND column_name='user_id' AND is_nullable='NO';
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'sanity: table % missing NOT NULL user_id', v_table;
    END IF;

    -- old auth_all policy is gone
    SELECT count(*) INTO v_count
    FROM pg_policies
    WHERE schemaname='public' AND tablename=v_table AND policyname='auth_all';
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'sanity: table % still has auth_all policy', v_table;
    END IF;

    -- at least one user-scoped policy exists
    SELECT count(*) INTO v_count
    FROM pg_policies
    WHERE schemaname='public' AND tablename=v_table
      AND qual LIKE '%auth.uid() = user_id%';
    IF v_count = 0 THEN
      RAISE EXCEPTION 'sanity: table % missing user-scoped policy', v_table;
    END IF;
  END LOOP;
END $$;

COMMIT;
