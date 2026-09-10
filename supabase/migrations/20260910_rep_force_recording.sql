-- Apply before deploying the client. Nullable fields preserve legacy semantics.
BEGIN;
ALTER TABLE public.reps ADD COLUMN IF NOT EXISTS failure_valid boolean;
ALTER TABLE public.reps ADD COLUMN IF NOT EXISTS end_reason text;
ALTER TABLE public.reps ADD COLUMN IF NOT EXISTS force_recording jsonb;

-- Preserve the currently deployed learner rather than replacing it with an
-- older copy. Only add the interruption guard at its function entry point.
DO $migration$
DECLARE
  definition text;
  guarded_definition text;
BEGIN
  SELECT pg_get_functiondef('public.update_fatigue_beta_from_rep()'::regprocedure)
    INTO definition;
  IF position('NEW.failure_valid IS FALSE' in definition) = 0 THEN
    guarded_definition := regexp_replace(
      definition, '(?in)^[ \t]*BEGIN[ \t]*$',
      E'BEGIN\n  IF NEW.failure_valid IS FALSE THEN\n    RETURN NEW;\n  END IF;'
    );
    IF guarded_definition = definition THEN
      RAISE EXCEPTION 'Could not locate fatigue learner entry point; migration rolled back';
    END IF;
    EXECUTE guarded_definition;
  END IF;
END;
$migration$;
COMMIT;
