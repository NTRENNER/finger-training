-- Apply before deploying the next client. Keep planned rest_s unchanged.
BEGIN;
ALTER TABLE public.reps ADD COLUMN IF NOT EXISTS rep_timing jsonb;
ALTER TABLE public.reps ADD COLUMN IF NOT EXISTS load_provenance text;
DO $migration$
DECLARE
  definition text;
  guarded_definition text;
BEGIN
  SELECT pg_get_functiondef('public.update_fatigue_beta_from_rep()'::regprocedure) INTO definition;
  IF position('NEW.force_recording' in definition) = 0 THEN
    guarded_definition := regexp_replace(definition, '(?in)^[ \t]*BEGIN[ \t]*$',
      E'BEGIN\n  IF NEW.force_recording->>''capacity_eligible'' = ''false''\n     OR NEW.load_provenance IN (''nominal_setting'', ''prescription_only'') THEN\n    RETURN NEW;\n  END IF;');
    IF guarded_definition = definition THEN
      RAISE EXCEPTION 'Could not locate fatigue learner entry point';
    END IF;
    EXECUTE guarded_definition;
  END IF;
END;
$migration$;
COMMIT;
