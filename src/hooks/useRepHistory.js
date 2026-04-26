// ─────────────────────────────────────────────────────────────
// useRepHistory — rep-log state + cloud reconcile + CRUD
// ─────────────────────────────────────────────────────────────
// Owns the canonical client-side rep array (persisted to
// localStorage under LS_HISTORY_KEY) plus everything that touches it:
//
//   * Cloud reconcile on sign-in: flush the offline retry queue,
//     fetch the remote `reps` table, then push any local-only
//     reps (sessions logged while signed out) before replacing
//     state with the merged set. Skips replacing when Supabase
//     returns no rows so a network hiccup or RLS-blocked JWT
//     can't silently wipe the local cache.
//   * `pendingCount` — how many reps are stuck in the offline
//     retry queue, surfaced by App.js as a "N pending" badge.
//   * `freshMap` / `threeExpPriors` — App-level memos that all
//     three callers (Setup card prescription, Analysis chart,
//     in-workout startSession) consume so the prescribed loads
//     stay byte-identical across views. Hoisted here because
//     they're derived from history and would otherwise live in
//     App.js right next to it.
//   * The four CRUD actions (addReps, updateRep, deleteRep,
//     updateSession, deleteSession) — each updates local state
//     immediately and then mirrors the change to Supabase if the
//     user is signed in. Failures are queued for the next sync.
//
// `replaceHistory` is exposed (not `setHistory`) for the manual
// cloud-pull path so callers can't accidentally clobber history
// without going through the same "only replace if remote returned
// rows" guard that the auth-driven reconcile uses.

import { useCallback, useEffect, useMemo, useState } from "react";

import { supabase } from "../lib/supabase.js";
import {
  loadLS, saveLS,
  LS_HISTORY_KEY, LS_REP_DELETED_KEY,
  LS_WORKOUT_LOG_KEY, LS_WORKOUT_SYNCED_KEY, LS_WORKOUT_DELETED_KEY,
} from "../lib/storage.js";
import {
  pushRep, fetchReps, enqueueReps, flushQueue,
  pushWorkoutSession, fetchWorkoutSessions,
  LS_QUEUE_KEY,
} from "../lib/sync.js";
import { PHYS_MODEL_DEFAULT } from "../model/fatigue.js";
import { buildFreshLoadMap, fitDoseK } from "../model/prescription.js";
import { buildThreeExpPriors } from "../model/threeExp.js";

// Rep-level identity: prefer Supabase's uuid; fall back to a
// composite key for reps that pre-date the cloud roundtrip
// (offline-only sessions, manually added rows, etc.).
const repMatchKey = (r) =>
  r.id ? `id:${r.id}` : `${r.session_id || r.date}|${r.set_num}|${r.rep_num}`;

// Append rep ids to the tombstone list (LS_REP_DELETED_KEY). The
// reconcile pass reads this list to avoid re-uploading deleted reps
// — see the comment on LS_REP_DELETED_KEY in src/lib/storage.js.
// Reps without an id (un-synced offline ones) can't be tombstoned;
// they have no cloud presence to defend against, so it's fine.
function addRepTombstones(ids) {
  const fresh = (ids || []).filter(Boolean);
  if (fresh.length === 0) return;
  const existing = new Set(loadLS(LS_REP_DELETED_KEY) || []);
  let changed = false;
  for (const id of fresh) {
    if (!existing.has(id)) { existing.add(id); changed = true; }
  }
  if (changed) saveLS(LS_REP_DELETED_KEY, [...existing]);
}

export function useRepHistory({ user }) {
  const [history, setHistory] = useState(() => loadLS(LS_HISTORY_KEY) || []);
  useEffect(() => saveLS(LS_HISTORY_KEY, history), [history]);

  // Stable fingerprint for fatigue/prior memos so unrelated
  // history-array reference churn (cloud syncs that touch the
  // array without actually adding rows) doesn't re-fire the
  // O(N) fits below. Length + last-rep id + last-rep date is
  // enough to capture the dominant "new rep added" case; edits
  // to old reps will use the stale memo until the next session,
  // which is fine since the fits aren't sensitive to small
  // shifts in old data.
  const freshMapFp = useMemo(() => {
    const last = history[history.length - 1];
    return `${history.length}|${last?.id ?? ""}|${last?.date ?? ""}`;
  }, [history]);

  const freshMap = useMemo(() => {
    const k = fitDoseK(history) ?? PHYS_MODEL_DEFAULT.doseK;
    return buildFreshLoadMap(history, { doseK: k });
  }, [freshMapFp]); // eslint-disable-line react-hooks/exhaustive-deps

  const threeExpPriors = useMemo(
    () => buildThreeExpPriors(history),
    [freshMapFp] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Pending-sync queue size. App.js displays this as a badge so
  // the user can tell when offline reps are accumulating.
  const [pendingCount, setPendingCount] = useState(() => (loadLS(LS_QUEUE_KEY) || []).length);
  const refreshPending = useCallback(() => {
    setPendingCount((loadLS(LS_QUEUE_KEY) || []).length);
  }, []);

  // Cloud reconcile: runs when `user` flips from null → signed-in
  // (and on every subsequent user change). The cancelled flag
  // guards the multi-step async chain so tab-switch unmounts
  // don't apply stale results.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      const flushed = await flushQueue();
      if (!cancelled && flushed > 0) refreshPending();

      const remote = await fetchReps();
      if (cancelled) return;

      if (remote) {
        // Reconcile local-only reps (offline sessions) up to the cloud.
        // Tombstone filter: reps whose id is on LS_REP_DELETED_KEY were
        // explicitly deleted on this device — never re-upload them, even
        // if they're "missing" from cloud. Without this, deleting via
        // direct DB access (or any path that bypasses deleteRep's local
        // state update) leaves stale entries in localStorage that the
        // reconcile would helpfully resurrect.
        const localReps = loadLS(LS_HISTORY_KEY) || [];
        const keyFor = r => `${r.session_id || r.date}|${r.set_num}|${r.rep_num}|${r.hand}`;
        const remoteKeys = new Set(remote.map(keyFor));
        const tombstoned = new Set(loadLS(LS_REP_DELETED_KEY) || []);
        const toSync = localReps.filter(r =>
          !remoteKeys.has(keyFor(r)) &&
          !(r.id && tombstoned.has(r.id))
        );

        let pushedAny = false;
        for (const rep of toSync) {
          const ok = await pushRep(rep);
          if (ok) pushedAny = true;
          else enqueueReps([rep]);
        }
        if (cancelled) return;

        // If we pushed offline reps, refetch so state includes them with
        // proper server-assigned ids. Otherwise use the first fetch.
        const finalReps = pushedAny ? (await fetchReps()) : remote;
        if (cancelled) return;
        if (finalReps && finalReps.length > 0) setHistory(finalReps);
      }

      if (!cancelled) refreshPending();
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // ── Workout-session sync ────────────────────────────────────
  // Lives here (rather than in a separate hook) because it shares
  // the same auth-driven sync lifecycle as the rep reconcile. Same
  // pattern: on sign-in, fetch the cloud's workout_sessions, merge
  // anything new into LS_WORKOUT_LOG_KEY (skipping tombstoned ids),
  // and push any local-only sessions up.
  const markSynced = (id) => {
    if (!id) return;
    const s = new Set(loadLS(LS_WORKOUT_SYNCED_KEY) || []);
    s.add(id);
    saveLS(LS_WORKOUT_SYNCED_KEY, [...s]);
  };

  const handleWorkoutSessionSaved = useCallback(async (session) => {
    if (!user) return;
    const ok = await pushWorkoutSession(session);
    if (ok) markSynced(session.id);
  }, [user]);

  useEffect(() => {
    if (!user) return;
    fetchWorkoutSessions().then(async (remote) => {
      const local = loadLS(LS_WORKOUT_LOG_KEY) || [];

      // Mark all remote sessions as synced
      const remoteIds = new Set((remote || []).map(s => s.id).filter(Boolean));
      const synced = new Set(loadLS(LS_WORKOUT_SYNCED_KEY) || []);
      remoteIds.forEach(id => synced.add(id));

      // Merge any remote sessions not yet in local, skipping tombstoned deletions
      const localIds = new Set(local.map(s => s.id).filter(Boolean));
      const deletedIds = new Set(loadLS(LS_WORKOUT_DELETED_KEY) || []);
      const merged = [...local, ...(remote || []).filter(s => !localIds.has(s.id) && !deletedIds.has(s.id))];
      if (merged.length > local.length) saveLS(LS_WORKOUT_LOG_KEY, merged);

      // ── One-time migration: push local sessions missing from Supabase ──
      // Assign IDs to old sessions that never got one, then push all unsynced
      let changed = false;
      const genId = () => { try { return crypto.randomUUID(); } catch { return `ws_${Date.now()}_${Math.random().toString(36).slice(2,9)}`; } };
      const toMigrate = merged.map(s => {
        if (!s.id) { changed = true; return { ...s, id: genId() }; }
        return s;
      });
      if (changed) saveLS(LS_WORKOUT_LOG_KEY, toMigrate);

      for (const s of toMigrate) {
        if (!remoteIds.has(s.id) && !deletedIds.has(s.id)) {
          const ok = await pushWorkoutSession(s);
          if (ok) synced.add(s.id);
        }
      }

      saveLS(LS_WORKOUT_SYNCED_KEY, [...synced]);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // ── CRUD ────────────────────────────────────────────────────
  // Each mutation updates local state immediately, then mirrors
  // to Supabase if signed in. addReps queues failures for retry;
  // the others log warnings since failed deletes/updates are
  // recoverable on next reconcile.

  const addReps = useCallback((newReps) => {
    setHistory(h => {
      const existing = new Set(h.map(r => r.id));
      const fresh    = newReps.filter(r => !existing.has(r.id));
      return [...fresh, ...h];
    });
    if (user) {
      newReps.forEach(rep => {
        pushRep(rep).then(ok => {
          if (!ok) { enqueueReps([rep]); refreshPending(); }
        });
      });
    }
  }, [user, refreshPending]);

  const updateSession = useCallback(async (sessionKey, updates) => {
    // updates: { hand?, grip?, target_duration? }
    setHistory(h => h.map(r =>
      (r.session_id || r.date) === sessionKey ? { ...r, ...updates } : r
    ));
    if (user) {
      const { error } = await supabase.from("reps")
        .update(updates)
        .eq("session_id", sessionKey);
      if (error) console.warn("Supabase update:", error.message);
    }
  }, [user]);

  const deleteRep = useCallback(async (rep) => {
    const k = repMatchKey(rep);
    setHistory(h => h.filter(r => repMatchKey(r) !== k));
    // Tombstone the id so a future reconcile can't resurrect it from
    // a stale local cache or from another device's mirror.
    if (rep.id) addRepTombstones([rep.id]);
    if (user && rep.id) {
      const { error } = await supabase.from("reps").delete().eq("id", rep.id);
      if (error) console.warn("Supabase deleteRep:", error.message);
    }
  }, [user]);

  const updateRep = useCallback(async (rep, updates) => {
    const k = repMatchKey(rep);
    setHistory(h => h.map(r => repMatchKey(r) === k ? { ...r, ...updates } : r));
    if (user && rep.id) {
      const { error } = await supabase.from("reps").update(updates).eq("id", rep.id);
      if (error) console.warn("Supabase updateRep:", error.message);
    }
  }, [user]);

  const deleteSession = useCallback(async (sessionKey) => {
    setHistory(h => {
      // Tombstone the ids of every rep we're about to drop. Ids that
      // are missing (offline-only, never synced) can't be tombstoned
      // — they have no cloud presence to resurrect.
      const removed = h.filter(r => (r.session_id || r.date) === sessionKey);
      addRepTombstones(removed.map(r => r.id));
      return h.filter(r => (r.session_id || r.date) !== sessionKey);
    });
    if (user) {
      const { error } = await supabase.from("reps").delete()
        .or(`session_id.eq.${sessionKey},and(session_id.is.null,date.eq.${sessionKey})`);
      if (error) console.warn("Supabase delete:", error.message);
    }
  }, [user]);

  // Bulk replace — used by the manual cloud-pull path. Same
  // "only replace if you have rows" guard as the auth-driven
  // reconcile so a hiccup can't wipe state.
  const replaceHistory = useCallback((reps) => {
    if (reps && reps.length > 0) setHistory(reps);
  }, []);

  return {
    history,
    freshMap, freshMapFp, threeExpPriors,
    pendingCount, refreshPending,
    addReps, updateRep, deleteRep, updateSession, deleteSession,
    replaceHistory,
    handleWorkoutSessionSaved,
  };
}
