-- Apply before deploying the matching client.
--
-- Two independent changes that both come out of the September 2026
-- cookedness review; they ship together because they touch the same
-- feature and neither is useful alone.
--
-- 1. activities.attempts — how many times a climb was tried.
--
--    The log had one row per ascent and no way to say "eight burns on
--    this boulder, sent on the eighth". Recording that meant eight
--    rows, which nobody does, so projecting sessions — the single most
--    fatiguing kind — were under-represented by roughly their attempt
--    count. Session fatigue counted rows, so those days scored BELOW
--    a casual lap day. Nullable, and null means one: every row written
--    before today already meant exactly one attempt, which is what the
--    old row-counting formula assumed, so history keeps its meaning
--    without a backfill.
--
-- 2. Retire the fatigue β learner.
--
--    update_fatigue_beta_from_rep_trg ran on every rep insert and
--    stepped user_settings.settings.fatigue_model[grip].beta by SGD.
--    Its output stopped reaching prescribed loads in July 2026 after it
--    ran away, but the learner itself was left running on the theory
--    that the betas were a harmless diagnostic.
--
--    They were not. At the time of this migration the live values had
--    railed to BOTH clamp boundaries — 0.5 (the hard maximum, on two
--    grips, one with 62 observations) and 0.0034 (effectively the
--    minimum) — which is what an estimator does when its gradient
--    carries no signal. The quantity was never identifiable from this
--    data in the first place: the app scales the prescription BY the
--    cookedness before the pull, so the residual cannot separate "he
--    was tired" from "we already made it lighter".
--
--    Dropping the trigger also removes a SECURITY DEFINER function that
--    wrote to user_settings on every rep insert.
--
--    The stored betas go too. Leaving them would preserve a number that
--    looks meaningful, is not, and is one `COALESCE` away from being
--    believed again. reps.session_cooked and daily_state.cooked are
--    untouched — those are the user's own reports and keep their value.

BEGIN;

ALTER TABLE public.activities
  ADD COLUMN IF NOT EXISTS attempts integer;

ALTER TABLE public.activities
  DROP CONSTRAINT IF EXISTS activities_attempts_sane;
ALTER TABLE public.activities
  ADD CONSTRAINT activities_attempts_sane
  CHECK (attempts IS NULL OR (attempts >= 1 AND attempts <= 99));

COMMENT ON COLUMN public.activities.attempts IS
  'Times this climb was tried in the session. NULL = 1 (pre-September-2026 rows). ascent <> ''attempt'' means the last one stuck.';

DROP TRIGGER IF EXISTS update_fatigue_beta_from_rep_trg ON public.reps;
DROP FUNCTION IF EXISTS public.update_fatigue_beta_from_rep();

UPDATE public.user_settings
SET settings   = settings - 'fatigue_model',
    updated_at = now()
WHERE settings ? 'fatigue_model';

COMMIT;
