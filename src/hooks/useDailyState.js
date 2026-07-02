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
// SYNC MODEL (dirty-key tracking — see storage.js):
// The reconcile used to be "local wins on every collision", which
// diverged across devices: an edit made on Device B never landed on
// Device A because A's untouched stale copy beat it on every sign-in.
// Now each locally-edited date is marked dirty until a cloud push
// confirms; reconcile gives local priority ONLY for dirty dates and
// takes the cloud value otherwise. A dirty date with no local entry
// is a pending CLEAR — reconcile drops the cloud copy and retries
// the cloud delete instead of resurrecting the stale value.
//
// Why a separate hook rather than rolling this into useRepHistory:
// useRepHistory already owns rep state + sync. Daily_state is its
// own concern (date-keyed, not rep-keyed) and the LS shape is
// small enough that the extraction stays cheap. Same shape as
// useActivities / useUserSettings — clean per-domain hook + cloud
// reconcile.

import { useState, useEffect, useCallback } from "react";
import {
  loadLS, saveLS, LS_DAILY_STATE_KEY,
  LS_DAILY_STATE_DIRTY_KEY, loadDirtySet, markDirty, clearDirty,
} from "../lib/storage.js";
import {
  pushDailyState, deleteDailyState, fetchAllDailyStates,
} from "../lib/sync.js";

// Always returns a fresh object so React state updates trigger
// re-renders. Loading from LS returns the persisted snapshot.
function loadFromLS() {
  const raw = loadLS(LS_DAILY_STATE_KEY);
  return raw && typeof raw === "object" ? { ...raw } : {};
}

// One-time flag: set after the first reconcile that completed under
// the dirty-key sync model. Before it's set, clean local-only dates
// are treated as pre-upgrade offline writes and backfilled (the old
// code's behavior — never drop data on upgrade). After it's set,
// every local write is dirty-marked at save time, so a CLEAN local
// date the cloud doesn't have can only mean "cleared on another
// device" — reconcile drops it instead of resurrecting it via
// backfill. (User-namespaced like every other ft_* key — an account
// switch reads a different namespace, so no cross-user carryover.)
const LS_DAILY_STATE_SYNCED_ONCE_KEY = "ft_daily_state_synced_once";

// Confirm-or-keep-dirty helper: clear the dirty mark only if the
// LS value at confirmation time still matches what we pushed. If the
// user edited again while the push was in flight, the newer edit's
// own push (already fired) owns the eventual clear — dropping the
// mark here would let a failed second push masquerade as synced.
function confirmPushed(date, pushedCooked) {
  const current = loadFromLS()[date];
  const same = pushedCooked == null
    ? current == null
    : current != null && Number(current) === Number(pushedCooked);
  if (same) clearDirty(LS_DAILY_STATE_DIRTY_KEY, date);
}

export function useDailyState({ user }) {
  const [dailyState, setDailyState] = useState(() => loadFromLS());

  // Cloud reconcile on sign-in. Same shape as useActivities:
  //   - Pull every cloud row (bulk fetch)
  //   - Cloud wins except for dirty dates (unconfirmed local edits)
  //     and local-only dates (offline writes the cloud hasn't seen)
  //   - Dirty date with no local entry = pending clear → drop the
  //     cloud copy and retry the cloud delete
  //   - Backfill unsynced local entries to the cloud
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      const cloudRows = await fetchAllDailyStates();
      if (cancelled || !cloudRows) return;
      const local = loadFromLS();
      const dirty = loadDirtySet(LS_DAILY_STATE_DIRTY_KEY);
      const syncedOnce = !!loadLS(LS_DAILY_STATE_SYNCED_ONCE_KEY);
      const cloudDates = new Set(cloudRows.map(r => r.date));
      const merged = {};
      for (const r of cloudRows) {
        if (r.date && r.cooked != null) merged[r.date] = Number(r.cooked);
      }
      for (const [date, cooked] of Object.entries(local)) {
        // Local wins only when it's a known-unsynced edit (dirty) or
        // — on the FIRST reconcile under this sync model — a clean
        // local-only date (pre-upgrade offline write that never
        // backfilled). After that first pass, every local write is
        // dirty-marked at save time, so a clean cloud-absent date
        // means "cleared on another device" and stays dropped.
        // Everything else takes the cloud value, so edits from other
        // devices land.
        if (dirty.has(date) || (!syncedOnce && !cloudDates.has(date))) {
          merged[date] = Number(cooked);
        }
      }
      // Pending clears: dirty dates with no local entry. The user
      // cleared the day's cookedness but the cloud delete didn't
      // confirm — drop the resurrected cloud copy and retry.
      for (const date of dirty) {
        if (local[date] == null) {
          delete merged[date];
          if (cloudDates.has(date)) {
            deleteDailyState(date).then(ok => { if (ok) confirmPushed(date, null); });
          } else {
            // Nothing to delete server-side — the clear is settled.
            clearDirty(LS_DAILY_STATE_DIRTY_KEY, date);
          }
        }
      }
      saveLS(LS_DAILY_STATE_KEY, merged);
      setDailyState(merged);
      // Backfill: push every surviving local value the cloud doesn't
      // match (dirty edits + first-pass local-only entries). Fire-and-
      // forget; failures stay dirty (or re-merge on the next sign-in).
      for (const [date, cooked] of Object.entries(merged)) {
        if (local[date] == null) continue;            // came from cloud
        if (dirty.has(date) || !cloudDates.has(date)) {
          pushDailyState(date, cooked).then(ok => { if (ok) confirmPushed(date, cooked); });
        }
      }
      saveLS(LS_DAILY_STATE_SYNCED_ONCE_KEY, true);
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
  //
  // Both branches mark the date dirty BEFORE the cloud call and only
  // clear the mark when the push/delete confirms against an unchanged
  // local value — so an offline edit or clear survives sign-in
  // reconciles until the cloud actually has it.
  const saveCooked = useCallback((date, cooked) => {
    if (!date) return;
    markDirty(LS_DAILY_STATE_DIRTY_KEY, date);
    setDailyState(prev => {
      const next = { ...prev };
      if (cooked == null) delete next[date];
      else next[date] = Number(cooked);
      saveLS(LS_DAILY_STATE_KEY, next);
      return next;
    });
    if (cooked != null) {
      // The server trigger that updates β on rep insert doesn't
      // re-run for past reps when daily_state changes, so a
      // retroactive edit only flows into the curve fit via the
      // local freshMap rebuild — not into β. Acceptable trade-off
      // for MVP; the curve correction is the main vehicle of value.
      pushDailyState(date, cooked).then(ok => { if (ok) confirmPushed(date, cooked); });
    } else {
      // Cloud half of the clear. Before deleteDailyState existed the
      // cloud row survived a clear forever and the stale cooked value
      // resurrected on the next reconcile (and kept feeding the
      // server-side β trigger's date join).
      deleteDailyState(date).then(ok => { if (ok) confirmPushed(date, null); });
    }
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
