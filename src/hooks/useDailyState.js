// ─────────────────────────────────────────────────────────────
// useDailyState — per-date cookedness cache (0–10 scalar)
// ─────────────────────────────────────────────────────────────
// Daily "cookedness" is the user's pre-session subjective fatigue
// load (0 = fresh, 10 = wrecked). Captured at session start by the
// Setup tab's cookedness slider and pushed to Supabase's daily_state
// table for the server-side β-learner trigger to consume.
//
// This hook adds an OFFLINE cache + RETROACTIVE editing path:
//
//   1. On sign-in, bulk-fetch every daily_state row and mirror into
//      LS so the curve-fit pipeline (buildFreshLoadMap) can apply
//      per-rep capacity multipliers without round-tripping per date.
//   2. saveCooked(date, cooked) writes both LS and cloud. AnalysisView's
//      session-detail modal calls this when the user retroactively
//      tags a past day's cookedness — the local change is picked up
//      by the next history.map → freshMap rebuild (which triggers
//      curve-fit re-runs everywhere downstream).
//
// Why a separate hook rather than rolling this into useRepHistory:
// useRepHistory already owns rep state + sync. Daily_state is its
// own concern (date-keyed, not rep-keyed) and the LS shape is
// small enough that the extraction stays cheap. Same shape as
// useActivities / useUserSettings — clean per-domain hook + cloud
// reconcile.

import { useState, useEffect, useCallback } from "react";
import { loadLS, saveLS, LS_DAILY_STATE_KEY } from "../lib/storage.js";
import { pushDailyState, fetchAllDailyStates } from "../lib/sync.js";

// Always returns a fresh object so React state updates trigger
// re-renders. Loading from LS returns the persisted snapshot.
function loadFromLS() {
  const raw = loadLS(LS_DAILY_STATE_KEY);
  return raw && typeof raw === "object" ? { ...raw } : {};
}

export function useDailyState({ user }) {
  const [dailyState, setDailyState] = useState(() => loadFromLS());

  // Cloud reconcile on sign-in. Same shape as useActivities:
  //   - Pull every cloud row (bulk fetch)
  //   - Union by date — local writes win on collision (most recent
  //     edits sit on this device)
  //   - Backfill local-only entries to the cloud
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      const cloudRows = await fetchAllDailyStates();
      if (cancelled || !cloudRows) return;
      const local = loadFromLS();
      const merged = {};
      for (const r of cloudRows) {
        if (r.date && r.cooked != null) merged[r.date] = Number(r.cooked);
      }
      // Local wins on collision — preserves any retroactive edits the
      // user just made that haven't propagated to the cloud yet.
      for (const [date, cooked] of Object.entries(local)) {
        merged[date] = Number(cooked);
      }
      saveLS(LS_DAILY_STATE_KEY, merged);
      setDailyState(merged);
      // Backfill local-only entries the cloud didn't have. The push
      // is fire-and-forget; failures are silent (next sign-in
      // reconcile will retry naturally via the union above).
      const cloudDates = new Set(cloudRows.map(r => r.date));
      for (const [date, cooked] of Object.entries(local)) {
        if (!cloudDates.has(date)) pushDailyState(date, cooked);
      }
    })();
    return () => { cancelled = true; };
  }, [user]);

  // saveCooked writes LS immediately (so freshMap rebuilds see the
  // new value on the next render tick) and pushes to cloud in the
  // background. Null cooked = "clear" — drops the date entirely so
  // capacityMultiplier returns 1.0 and the rep treats itself as
  // fresh again. (Setting cooked = 0 has the same downstream effect
  // but leaves an explicit "I was fresh" record on the day; null
  // is "no opinion logged".)
  const saveCooked = useCallback((date, cooked) => {
    if (!date) return;
    setDailyState(prev => {
      const next = { ...prev };
      if (cooked == null) delete next[date];
      else next[date] = Number(cooked);
      saveLS(LS_DAILY_STATE_KEY, next);
      return next;
    });
    if (cooked != null) {
      // pushDailyState's signature is (date, cooked) — fire and
      // forget. The server trigger that updates β on rep insert
      // doesn't re-run for past reps when daily_state changes, so
      // a retroactive edit only flows into the curve fit via the
      // local freshMap rebuild — not into β. Acceptable trade-off
      // for MVP; the curve correction is the main vehicle of value.
      pushDailyState(date, cooked);
    }
    // No cloud delete path: pushDailyState only supports upsert.
    // Clearing locally is enough for the freshMap path; if the row
    // matters server-side later (β re-learning), we can add a
    // dedicated cloud delete endpoint.
  }, []);

  // Convenience getter — returns null when no entry exists (vs 0
  // which means "I was fresh, recorded explicitly").
  const cookedOnDate = useCallback((date) => {
    if (!date) return null;
    const v = dailyState[date];
    return v == null ? null : Number(v);
  }, [dailyState]);

  return { dailyState, cookedOnDate, saveCooked };
}
