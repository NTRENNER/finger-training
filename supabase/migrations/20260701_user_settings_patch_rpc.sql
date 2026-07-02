-- ─────────────────────────────────────────────────────────────
-- user_settings PATCH RPC — atomic server-side JSONB merge
-- ─────────────────────────────────────────────────────────────
-- Why: the client previously synced settings via fetch → spread →
-- upsert of the WHOLE settings object. Any write landing between the
-- fetch and the push was silently erased — including the
-- update_fatigue_beta_from_rep trigger's β updates (fires on every
-- rep-1 insert), and pins seeded concurrently on another device.
-- This is the same lost-update class as the June 2026 pinned-baseline
-- contamination incident.
--
-- Fix: clients now send ONLY the changed top-level key(s); the merge
-- happens atomically in one statement server-side (settings || patch).
-- SECURITY INVOKER: RLS on user_settings still applies; the insert
-- path is pinned to auth.uid() so a caller can only ever touch their
-- own row.

CREATE OR REPLACE FUNCTION public.update_user_settings_patch(patch jsonb)
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  INSERT INTO public.user_settings (user_id, settings, updated_at)
  VALUES (auth.uid(), patch, now())
  ON CONFLICT (user_id) DO UPDATE
    SET settings   = public.user_settings.settings || excluded.settings,
        updated_at = now();
$$;

REVOKE EXECUTE ON FUNCTION public.update_user_settings_patch(jsonb) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.update_user_settings_patch(jsonb) TO authenticated;
