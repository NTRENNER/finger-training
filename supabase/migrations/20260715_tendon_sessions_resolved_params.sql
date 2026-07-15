-- ─────────────────────────────────────────────────────────────
-- tendon_sessions: store the RESOLVED protocol per session
-- ─────────────────────────────────────────────────────────────
-- Why: logSession previously stored only preset.key (e.g. "barr").
-- If the user customized Hold/Rest via the ⚙ editor, history showed
-- the preset name but not what they actually did. Persist the resolved
-- hold/rest/effort so the history log is faithful and queryable.
--
-- Nullable + additive; legacy rows keep NULL and readers fall back to
-- the preset defaults. Applied to the remote project via the Supabase
-- MCP (migration name: tendon_sessions_resolved_params); this file is
-- the repo record.

ALTER TABLE public.tendon_sessions
  ADD COLUMN IF NOT EXISTS work_sec   integer,
  ADD COLUMN IF NOT EXISTS rest_sec   integer,
  ADD COLUMN IF NOT EXISTS effort_pct integer;

COMMENT ON COLUMN public.tendon_sessions.work_sec   IS 'Resolved hold seconds per hang for the session as actually performed';
COMMENT ON COLUMN public.tendon_sessions.rest_sec   IS 'Resolved rest seconds between hangs as actually performed';
COMMENT ON COLUMN public.tendon_sessions.effort_pct IS 'Resolved effort cue (% of max) as actually performed';
