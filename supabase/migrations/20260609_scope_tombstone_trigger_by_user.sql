-- Applied to the live DB on 2026-06-09 via MCP (migration name:
-- scope_tombstone_reject_trigger_by_user). Recorded here so the repo
-- matches production.
--
-- Context: reject_tombstoned_rep_insert's three tombstone lookups were
-- global. After the multi-user migration, any user's tombstone for a
-- colliding rep id / slot tuple / 8-char session id would permanently
-- block another user's insert. All lookups now scope by NEW.user_id.
--
-- Also verified live on 2026-06-09 (no action needed, recorded for the
-- avoidance of doubt — the committed multi-user migration predates them):
--   reps:         UNIQUE (user_id, session_id, set_num, rep_num, hand)  [reps_user_workout_slot_unique]
--   body_weights: UNIQUE (user_id, date)                                [body_weights_user_date_unique]
--   RLS enabled (relrowsecurity=true) on all 9 app tables.

CREATE OR REPLACE FUNCTION public.reject_tombstoned_rep_insert()
RETURNS trigger AS $$
BEGIN
  IF NEW.id IS NOT NULL AND EXISTS (
    SELECT 1 FROM rep_tombstones
    WHERE id = NEW.id AND user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'TOMBSTONE_REJECTION: rep id % is tombstoned', NEW.id
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.session_id IS NOT NULL AND NEW.set_num IS NOT NULL
     AND NEW.rep_num IS NOT NULL AND NEW.hand IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM rep_slot_tombstones
       WHERE user_id    = NEW.user_id
         AND session_id = NEW.session_id
         AND set_num    = NEW.set_num
         AND rep_num    = NEW.rep_num
         AND hand       = NEW.hand
     ) THEN
    RAISE EXCEPTION 'TOMBSTONE_REJECTION: slot (%, %, %, %) is tombstoned',
      NEW.session_id, NEW.set_num, NEW.rep_num, NEW.hand
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.session_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM session_tombstones
    WHERE session_id = NEW.session_id AND user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'TOMBSTONE_REJECTION: session % is tombstoned', NEW.session_id
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;
