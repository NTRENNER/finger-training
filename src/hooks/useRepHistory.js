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
  pushRepTombstones, fetchRepTombstoneIds,
  pushRepSlotTombstones, fetchRepSlotTombstoneKeys,
  fetchSessionTombstoneIds,
  pushWorkoutSession, fetchWorkoutSessions,
  fetchWorkoutSessionTombstoneIds,
  enqueueRepUpdate, applyPendingUpdates, flushUpdateQueue,
  LS_QUEUE_KEY,
} from "../lib/sync.js";
import { PHYS_MODEL_DEFAULT } from "../model/fatigue.js";
import { computePersonalRecoveryTaus } from "../model/recoveryFit.js";
import { buildFreshLoadMap, fitDoseK } from "../model/prescription.js";
import { buildThreeExpPriors } from "../model/threeExp.js";

// Rep-level identity: prefer Supabase's uuid; fall back to a
// composite key for reps that pre-date the cloud roundtrip
// (offline-only sessions, manually added rows, etc.).
const repMatchKey = (r) =>
  r.id ? `id:${r.id}` : `${r.session_id || r.date}|${r.set_num}|${r.rep_num}`;

// Composite identity used by reconcile to dedup local-no-id reps
// against cloud rows. The reconcile dedup keys both sides off of
// THIS function (not repMatchKey) so a local rep without an id and
// a cloud rep WITH an id can still match when they describe the
// same workout slot. Without this, the May 2026 duplicate-storm
// bug fired every time auth re-initialized.
const compositeKey = (r) =>
  `${r.session_id || r.date}|${r.set_num}|${r.rep_num}|${r.hand}`;

// Client-side UUID. Browsers have crypto.randomUUID; we fall back to
// a timestamped random string for environments where it isn't
// available (very old Safari, some test envs). Reps need a stable id
// from creation time so cloud upsert(onConflict: "id") deduplicates.
const genRepId = () => {
  try { return crypto.randomUUID(); }
  catch { return `rep_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`; }
};

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

export function useRepHistory({ user, fatigueModel = null, dailyState = null }) {
  const [history, setHistory] = useState(() => loadLS(LS_HISTORY_KEY) || []);
  // NOTE: block body, not a concise arrow. saveLS now returns a
  // boolean (so callers can detect quota failures), and a concise
  // `() => saveLS(...)` would make that boolean the effect's return
  // value — React then treats it as the cleanup fn and calls `true()`
  // on the next run, throwing "is not a function" and unmounting the
  // whole tree (blank screen on the first history change after a
  // cloud pull). The braces discard the return value.
  useEffect(() => { saveLS(LS_HISTORY_KEY, history); }, [history]);

  // Content-aware fingerprint for fatigue/prior memos. Cloud-sync
  // poll churn (history array reference changes without content
  // changes) is filtered by the outer useMemo's reference compare
  // — we only pay the O(N) string-build when history actually
  // re-references. Downstream memos then key off the fingerprint
  // string, so they ONLY recompute when content meaningfully
  // changed (a new rep, an edit to an old rep, or a delete).
  //
  // Previous version used `history.length | last.id | last.date`,
  // which missed edits to old reps entirely. Fixing a typo on a
  // historical avg_force_kg or weight_kg silently left freshMap /
  // threeExpPriors stale until the next session — and for outlier
  // reps near curve hinge points, that staleness measurably
  // shifted CF / W' / amps. Worth the per-update O(N) cost to get
  // the right answer.
  //
  // Fields included: those that feed the fit functions
  // (target_duration, actual_time_s, avg_force_kg, peak_force_kg,
  // prescribed_load_kg, manual_load_kg, weight_kg [legacy], failed,
  // rep_num, rest_s) plus filter/identity fields (id, date, hand,
  // grip). set_num is not consumed by the fit code paths so it's
  // omitted to keep the string smaller.
  //
  // prescribed_load_kg + manual_load_kg added late May 2026 with the
  // weight_kg schema split — editing either now invalidates the fit
  // memos correctly. weight_kg stays in the fingerprint so any legacy
  // edit that still touches it (shouldn't happen post-split, but
  // belts and braces) also triggers re-fit.
  const freshMapFp = useMemo(() => {
    return history.map(r => [
      r.id,
      r.date,
      r.hand,
      r.grip,
      r.target_duration,
      r.actual_time_s,
      r.avg_force_kg,
      r.peak_force_kg,
      r.prescribed_load_kg,
      r.manual_load_kg,
      r.weight_kg,
      r.failed ? 1 : 0,
      r.rep_num,
      r.rest_s,
      // Per-session cookedness override — when this changes (the
      // user edited the session's override slider) the freshMap
      // needs to rebuild so the new override flows into the curve fit.
      r.session_cooked,
    ].join(":")).join("|");
  }, [history]);

  // Per-grip personal recovery taus (fast + medium; slow stays at
  // population — see recoveryFit.js header for the identifiability
  // rationale). Fit on within-set decay sequences with Bayesian
  // shrinkage toward the population prior. Engine-only personalization:
  // feeds buildFreshLoadMap, which feeds the F-D curve fit, which
  // feeds prescription. No user-facing surface.
  const personalRecoveryTaus = useMemo(
    () => computePersonalRecoveryTaus(history),
    [freshMapFp] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Stable fingerprint for dailyState so freshMap only rebuilds when
  // a date's cooked value actually changes (vs every render that
  // happens to recreate the dailyState object reference).
  const dailyStateFp = useMemo(() => {
    if (!dailyState) return "";
    return Object.entries(dailyState)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([d, c]) => `${d}:${c}`).join("|");
  }, [dailyState]);

  const freshMap = useMemo(() => {
    const k = fitDoseK(history) ?? PHYS_MODEL_DEFAULT.doseK;
    return buildFreshLoadMap(history, {
      doseK: k,
      personalTausByGrip: personalRecoveryTaus,
      // Cookedness compensation: divides each rep's load by
      // capacityMultiplier(model, grip, cookedOnDate) so a cooked
      // session looks like its fresh-equivalent to the curve fit.
      // Retroactive edits via AnalysisView's session-detail modal
      // flow into here within one render cycle.
      cookedByDate: dailyState,
      fatigueModel: fatigueModel,
    });
  }, [freshMapFp, personalRecoveryTaus, dailyStateFp, fatigueModel]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Fast tombstone scrub. Fires alongside the full reconcile (below)
  // but only does the cheap part: fetch synced tombstones, strip any
  // local-history reps whose ids match. This lets the chart update
  // within ~1 round trip instead of waiting for the full
  // flushQueue + fetchReps + push-missing + refetch chain.
  //
  // Catches the May 2026 scenario where a server-side delete (or a
  // delete on another device) left this device's LS holding ids
  // that no longer exist in cloud — without this, those reps stay
  // on the chart until the next manual pull or full reconcile
  // setHistory(finalReps) ran. With this, opening the app on a
  // device with the new bundle is sufficient to scrub local.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      // Fetch all three tombstone tables in parallel and filter local
      // history on the union. Slot keys catch fresh-UUID resurrection;
      // session ids catch the case where bad legacy sessions keep
      // re-pushing reps into slots we never tombstoned (extra rep_nums,
      // hand=B variants, etc.) — the entire session is killable at once.
      const [cloudIds, cloudSlots, cloudSessions] = await Promise.all([
        fetchRepTombstoneIds(),
        fetchRepSlotTombstoneKeys(),
        fetchSessionTombstoneIds(),
      ]);
      if (cancelled) return;
      const idSet      = new Set(cloudIds      || []);
      const slotSet    = new Set(cloudSlots    || []);
      const sessionSet = new Set(cloudSessions || []);
      if (idSet.size === 0 && slotSet.size === 0 && sessionSet.size === 0) return;
      // Merge cloud id-tombstones into local LS so subsequent
      // operations see the union without re-fetching.
      if (idSet.size > 0) {
        const localTombs = new Set(loadLS(LS_REP_DELETED_KEY) || []);
        let lsChanged = false;
        for (const id of idSet) {
          if (!localTombs.has(id)) { localTombs.add(id); lsChanged = true; }
        }
        if (lsChanged) saveLS(LS_REP_DELETED_KEY, [...localTombs]);
      }
      // Drop tombstoned reps from history state by id OR slot OR
      // session. Session matches let us nuke an entire bad legacy
      // session in one shot.
      setHistory(h => {
        const filtered = h.filter(r =>
          !(r.id && idSet.has(r.id)) &&
          !slotSet.has(compositeKey(r)) &&
          !(r.session_id && sessionSet.has(r.session_id))
        );
        return filtered.length === h.length ? h : filtered;
      });
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // True once the full reconcile below has landed (or immediately
  // when signed out — local is the authority then). Consumed by
  // useGripFits' auto-pin gate via App: until the cloud's reps are
  // merged in, `history` can be a partial local cache, and a baseline
  // auto-pinned from it freezes the wrong window permanently (pins
  // never overwrite). Stays false while signed in if the rep fetch
  // errors — pinning waits for a reconcile that actually saw the cloud.
  const [historySynced, setHistorySynced] = useState(false);
  useEffect(() => {
    if (!user) setHistorySynced(true);
  }, [user]);

  // Cloud reconcile: runs when `user` flips from null → signed-in
  // (and on every subsequent user change). The cancelled flag
  // guards the multi-step async chain so tab-switch unmounts
  // don't apply stale results.
  useEffect(() => {
    if (!user) return;
    setHistorySynced(false);
    let cancelled = false;
    (async () => {
      const flushed = await flushQueue();
      if (!cancelled && flushed > 0) refreshPending();
      // Retry pending EDITS before fetching, so an edit made offline
      // lands in cloud and the fetch below returns the edited row
      // (instead of the stale one that applyPendingUpdates would
      // then have to patch over).
      await flushUpdateQueue();
      if (cancelled) return;

      const remote = await fetchReps();
      if (cancelled) return;

      // Fetch all three tombstone tables. The set together blocks
      // any flavor of resurrection:
      //   id      — same-UUID re-push from same client
      //   slot    — fresh-UUID re-push from old client (strips id)
      //   session — re-push into a previously-tombstoned session_id,
      //             even if the (set, rep, hand) slot wasn't explicitly
      //             tombstoned at cleanup time
      const [cloudTombstones, cloudSlotKeys, cloudSessionIds] = await Promise.all([
        fetchRepTombstoneIds(),
        fetchRepSlotTombstoneKeys(),
        fetchSessionTombstoneIds(),
      ]);
      if (cancelled) return;
      const slotTombSet    = new Set(cloudSlotKeys    || []);
      const sessionTombSet = new Set(cloudSessionIds  || []);

      if (remote) {
        // Reconcile local-only reps (offline sessions) up to the cloud.
        // Tombstone filter: reps whose id is in EITHER the local
        // LS_REP_DELETED_KEY OR the synced cloud rep_tombstones table
        // were explicitly deleted somewhere — never re-upload them,
        // even if they're "missing" from cloud. Without the cloud
        // tombstones the per-device LS would let a delete on Device A
        // get undone on Device B's next reconcile (May 2026
        // resurrection bug).
        const localReps = loadLS(LS_HISTORY_KEY) || [];
        // Dedup against cloud on BOTH id (when available) AND the
        // workout-slot composite key. The composite check is the
        // critical one: a local rep with no id (legacy offline
        // session, manually-added row) would otherwise NEVER match
        // any cloud row by id, because the previous keyFor preferred
        // id when present — so every cloud row keyed as `id:UUID`,
        // local-no-id reps keyed as composites, and the two sets
        // never collided. That mismatch was the duplicate-storm
        // bug: local reps got re-pushed as fresh rows on every
        // auth-flip → sign-in reconcile → repeat.
        // (Same fix mirrored in App.js's pullFromCloud.)
        const remoteIds = new Set(remote.map(r => r.id).filter(Boolean));
        const remoteCompositeKeys = new Set(remote.map(compositeKey));
        // Union local + cloud tombstones. cloudTombstones is null when
        // the fetch errored — in that case fall back to local-only
        // (safer than silently re-pushing).
        const tombstoned = new Set([
          ...(loadLS(LS_REP_DELETED_KEY) || []),
          ...(cloudTombstones || []),
        ]);
        // Mirror cloud tombstones into local LS so the per-device fast
        // path stays in sync between reconciles (and so subsequent
        // CRUD operations have the union without re-fetching).
        if (cloudTombstones && cloudTombstones.length > 0) {
          saveLS(LS_REP_DELETED_KEY, [...tombstoned]);
        }
        const toSync = localReps.filter(r =>
          !(r.id && remoteIds.has(r.id)) &&
          !remoteCompositeKeys.has(compositeKey(r)) &&
          !(r.id && tombstoned.has(r.id)) &&
          !slotTombSet.has(compositeKey(r)) &&
          !(r.session_id && sessionTombSet.has(r.session_id))
        );

        let pushedAny = false;
        const tombstonedIds = new Set();
        for (const rep of toSync) {
          const result = await pushRep(rep);
          if (result === "ok") pushedAny = true;
          else if (result === "error") enqueueReps([rep]);
          else if (result === "tombstoned") tombstonedIds.add(rep.id);
        }
        if (cancelled) return;

        // If we pushed offline reps, refetch so state includes them with
        // proper server-assigned ids. Otherwise use the first fetch.
        const cloudRepsRaw = pushedAny ? (await fetchReps()) : remote;
        if (cancelled) return;
        if (!cloudRepsRaw) return;

        // Filter the FETCHED rows through the tombstone sets too. A
        // rep whose cloud delete failed (offline at delete time) but
        // whose tombstone push succeeded is still present in cloud —
        // without this filter the reconcile re-added it to local
        // history even though it's permanently dead (the trigger
        // blocks re-inserts, not selects). Then overlay any pending
        // local edits so a not-yet-synced edit isn't reverted by the
        // wholesale setHistory below — the exact "fix a typo, lose it
        // on next sign-in" failure the update queue exists for.
        const cloudReps = applyPendingUpdates(cloudRepsRaw.filter(r =>
          !(r.id && tombstoned.has(r.id)) &&
          !slotTombSet.has(compositeKey(r)) &&
          !(r.session_id && sessionTombSet.has(r.session_id))
        ));

        // MERGE, don't replace. Verify every toSync rep actually landed
        // in cloud after the push round. Any that didn't are either:
        //   (a) push-failed and already in the retry queue (network blip,
        //       RLS error, etc.), or
        //   (b) tombstone-rejected by the server trigger (rare race —
        //       this device queued the rep before the tombstone synced).
        // Preserve (a) so the user doesn't lose real data. Drop (b) by
        // filtering out tombstonedIds — those reps are permanently dead
        // on the server and re-queuing would loop forever.
        const cloudIdSet = new Set(cloudReps.map(r => r.id).filter(Boolean));
        const cloudSlotSet = new Set(cloudReps.map(compositeKey));
        const preserved = toSync.filter(r =>
          !(r.id && cloudIdSet.has(r.id)) &&
          !cloudSlotSet.has(compositeKey(r)) &&
          !(r.id && tombstonedIds.has(r.id))
        );
        if (preserved.length > 0) enqueueReps(preserved);

        // Surface anything still in the retry queue that isn't already
        // in cloud or in `preserved`. The retry queue (LS_QUEUE_KEY) is
        // a separate stash from LS_HISTORY_KEY — if a prior reconcile
        // wiped history while pushes were failing, the reps survived
        // in the queue but became invisible to the History UI. Stitch
        // them back so the user sees what they actually entered, even
        // when it still can't sync. Recovery path for the May 19 2026
        // missing-finger-workout case.
        const queue = loadLS(LS_QUEUE_KEY) || [];
        const preservedIdSet = new Set(preserved.map(r => r.id).filter(Boolean));
        const preservedSlotSet = new Set(preserved.map(compositeKey));
        const fromQueue = queue.filter(r =>
          !(r.id && cloudIdSet.has(r.id)) &&
          !cloudSlotSet.has(compositeKey(r)) &&
          !(r.id && preservedIdSet.has(r.id)) &&
          !preservedSlotSet.has(compositeKey(r))
        );

        const finalReps = [...cloudReps, ...preserved, ...fromQueue];
        if (finalReps.length > 0) setHistory(finalReps);
        // Reconcile landed with a real cloud snapshot — history now
        // includes the cloud's reps. Safe for auto-pin writes.
        setHistorySynced(true);
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

  // Push any local workout sessions whose id isn't marked synced.
  // Sister-helper to flushQueue for reps — workout sessions don't have
  // their own persistent retry queue (unlike reps), so we piggyback on
  // every save attempt to retry stragglers. Returns the number of
  // sessions successfully pushed during this call (mostly diagnostic).
  const flushUnsyncedWorkoutSessions = useCallback(async () => {
    if (!user) return 0;
    const local = loadLS(LS_WORKOUT_LOG_KEY) || [];
    const synced = new Set(loadLS(LS_WORKOUT_SYNCED_KEY) || []);
    const deleted = new Set(loadLS(LS_WORKOUT_DELETED_KEY) || []);
    let pushed = 0;
    let touched = false;
    for (const s of local) {
      if (!s?.id) continue;
      if (synced.has(s.id)) continue;
      if (deleted.has(s.id)) continue;
      const ok = await pushWorkoutSession(s);
      if (ok) { synced.add(s.id); pushed++; touched = true; }
    }
    if (touched) saveLS(LS_WORKOUT_SYNCED_KEY, [...synced]);
    return pushed;
  }, [user]);

  // Push the just-saved session, then opportunistically retry any older
  // unsynced ones. Before this retry, a single failed push (network
  // blip, transient auth, etc.) would orphan the session in localStorage
  // until the next sign-in event re-ran the reconcile useEffect — long
  // enough that the rotation pointer would drift between devices.
  // Reps don't have this problem because their failed pushes hit
  // enqueueReps/flushQueue. Workout sessions piggyback on saves instead.
  const handleWorkoutSessionSaved = useCallback(async (session) => {
    if (!user) return;
    const ok = await pushWorkoutSession(session);
    if (ok) markSynced(session.id);
    await flushUnsyncedWorkoutSessions();
  }, [user, flushUnsyncedWorkoutSessions]);

  // Retry on tab refocus + network online. Both are cheap "we might
  // have just come back from being unreachable" signals — exactly when
  // a queued push deserves another shot. The reconcile useEffect below
  // already covers the sign-in path.
  //
  // Both handlers are named (not anonymous arrows) so the cleanup
  // can pass the same reference to removeEventListener. An earlier
  // version used an inline arrow on visibilitychange and silently
  // accumulated a new listener on every user transition.
  useEffect(() => {
    if (!user) return;
    const retry = () => { flushUnsyncedWorkoutSessions(); };
    const onVisible = () => {
      if (document.visibilityState === "visible") retry();
    };
    window.addEventListener("online", retry);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", retry);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [user, flushUnsyncedWorkoutSessions]);

  useEffect(() => {
    if (!user) return;
    fetchWorkoutSessions().then(async (remote) => {
      const local = loadLS(LS_WORKOUT_LOG_KEY) || [];

      // Mark all remote sessions as synced
      const remoteIds = new Set((remote || []).map(s => s.id).filter(Boolean));
      const synced = new Set(loadLS(LS_WORKOUT_SYNCED_KEY) || []);
      remoteIds.forEach(id => synced.add(id));

      // Union the per-device tombstone set with the SYNCED
      // workout_session_tombstones table. The per-device set only
      // protects the device the delete happened on; every other
      // device saw the session "missing from cloud" and re-pushed it
      // below — the deterministic delete-resurrection bug that
      // rep_tombstones fixed for reps. Mirror the cloud set into LS
      // so subsequent saves/flushes see the union without refetching.
      // (null = fetch error → fall back to local-only, same
      // convention as the rep tombstone fetches.)
      const cloudDeleted = await fetchWorkoutSessionTombstoneIds();
      const deletedIds = new Set([
        ...(loadLS(LS_WORKOUT_DELETED_KEY) || []),
        ...(cloudDeleted || []),
      ]);
      if (cloudDeleted && cloudDeleted.length > 0) {
        saveLS(LS_WORKOUT_DELETED_KEY, [...deletedIds]);
      }

      // Merge any remote sessions not yet in local, skipping tombstoned
      // deletions. Also SCRUB tombstoned sessions already sitting in
      // local (deleted on another device) — without this they linger
      // in this device's log forever.
      const localIds = new Set(local.map(s => s.id).filter(Boolean));
      const localScrubbed = local.filter(s => !(s.id && deletedIds.has(s.id)));
      const merged = [...localScrubbed, ...(remote || []).filter(s => !localIds.has(s.id) && !deletedIds.has(s.id))];
      if (merged.length !== local.length) saveLS(LS_WORKOUT_LOG_KEY, merged);

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
    // Stamp a client-generated UUID on any rep that doesn't already
    // carry one. The id is what makes pushRep idempotent (upsert
    // on conflict). Without this, every retry / reconcile / tab-
    // focus event re-pushed the rep as a fresh row — the May 2026
    // duplicate-storm bug. We stamp BEFORE both state update and
    // push so the cloud row and the local row share the same id
    // from the first moment.
    const stamped = (newReps || []).map(r => r.id ? r : { ...r, id: genRepId() });
    setHistory(h => {
      const existing = new Set(h.map(r => r.id));
      const fresh    = stamped.filter(r => !existing.has(r.id));
      return [...fresh, ...h];
    });
    if (user) {
      stamped.forEach(rep => {
        pushRep(rep).then(result => {
          if (result === "error") { enqueueReps([rep]); refreshPending(); }
          // result === "ok" → nothing to do
          // result === "tombstoned" → rep matched a server tombstone (rare
          //   race: addReps called for a rep whose id was tombstoned on
          //   another device). Don't enqueue (would loop forever). Local
          //   state still has it but it'll vanish on the next reconcile.
        });
      });
    }
  }, [user, refreshPending]);

  const updateSession = useCallback(async (sessionKey, updates) => {
    // updates: { hand?, grip?, target_duration? }
    setHistory(h => h.map(r =>
      (r.session_id || r.date) === sessionKey ? { ...r, ...updates } : r
    ));
    // WRITE-AHEAD queue — see updateRep for the full rationale. The
    // entry lands in LS before any network IO, so an app close mid-
    // flight can't lose the edit; flushUpdateQueue removes it only on
    // confirmed success.
    enqueueRepUpdate({ kind: "session", sessionKey, updates });
    if (user) await flushUpdateQueue();
  }, [user]);

  // Per-session cookedness override (null clears). Updates every rep
  // in the session via updateSession's bulk path. Stays separate
  // from updateSession because consumers that don't care about
  // cookedness shouldn't have to construct an `{ session_cooked }`
  // object — and because the LS write also needs to refresh the
  // freshMap (handled implicitly by setHistory triggering the memo).
  const updateSessionCooked = useCallback(async (sessionKey, cooked) => {
    const v = cooked == null ? null : Number(cooked);
    await updateSession(sessionKey, { session_cooked: v });
  }, [updateSession]);

  const deleteRep = useCallback(async (rep) => {
    const k = repMatchKey(rep);
    setHistory(h => h.filter(r => repMatchKey(r) !== k));
    // Tombstone the id so a future reconcile can't resurrect it from
    // a stale local cache or from another device's mirror. Both
    // surfaces (local LS + cloud rep_tombstones table) get the id
    // so deletes propagate across devices.
    if (rep.id) addRepTombstones([rep.id]);
    if (user) {
      if (rep.id) {
        const { error } = await supabase.from("reps").delete().eq("id", rep.id);
        if (error) console.warn("Supabase deleteRep:", error.message);
        pushRepTombstones([rep.id]).catch(() => {});
      }
      // Slot tombstone catches the case where an old-bundle browser
      // re-pushes the same workout-slot with a fresh UUID (the id
      // tombstone wouldn't match because the UUID is new). Server-
      // side trigger then refuses the insert at the DB level.
      if (rep.session_id != null && rep.set_num != null
          && rep.rep_num != null && rep.hand) {
        pushRepSlotTombstones([{
          session_id: rep.session_id,
          set_num:    rep.set_num,
          rep_num:    rep.rep_num,
          hand:       rep.hand,
        }]).catch(() => {});
      }
    }
  }, [user]);

  const updateRep = useCallback(async (rep, updates) => {
    const k = repMatchKey(rep);
    setHistory(h => h.map(r => repMatchKey(r) === k ? { ...r, ...updates } : r));
    // WRITE-AHEAD queue (June 2026): enqueue BEFORE the network
    // attempt, not only after a failure. The old shape (await update →
    // enqueue on error) had a silent loss mode on phones: close the
    // app while the write is in flight and neither the success nor
    // the error path ever runs — the edit isn't queued, and the next
    // reconcile reverts it to the cloud copy (this is how manually
    // R-labeled reps "changed back" to L on 2026-06-12).
    // flushUpdateQueue pushes the entry and removes it only when
    // Supabase confirms; until then applyPendingUpdates keeps the
    // local view correct across reconciles, and signed-out edits just
    // sit in the queue for the next sign-in.
    if (rep.id) {
      enqueueRepUpdate({ kind: "rep", id: rep.id, updates });
      if (user) await flushUpdateQueue();
    }
  }, [user]);

  const deleteSession = useCallback(async (sessionKey) => {
    // Capture removed reps outside setHistory so we can push their
    // ids AND workout-slot tuples to the cloud tombstone tables.
    // (setHistory's updater is called inside React's commit phase;
    // we don't want to do network work from there.)
    const removedReps = (history || [])
      .filter(r => (r.session_id || r.date) === sessionKey);
    const removedIds = removedReps.map(r => r.id).filter(Boolean);
    const removedSlots = removedReps
      .filter(r => r.session_id != null && r.set_num != null
                   && r.rep_num != null && r.hand)
      .map(r => ({
        session_id: r.session_id,
        set_num:    r.set_num,
        rep_num:    r.rep_num,
        hand:       r.hand,
      }));
    setHistory(h => {
      addRepTombstones(removedIds);
      return h.filter(r => (r.session_id || r.date) !== sessionKey);
    });
    if (user) {
      const { error } = await supabase.from("reps").delete()
        .or(`session_id.eq.${sessionKey},and(session_id.is.null,date.eq.${sessionKey})`);
      if (error) console.warn("Supabase delete:", error.message);
      // Both tombstone tables: id table catches same-UUID re-pushes,
      // slot table catches fresh-UUID resurrection. Fire-and-forget.
      if (removedIds.length > 0)   pushRepTombstones(removedIds).catch(() => {});
      if (removedSlots.length > 0) pushRepSlotTombstones(removedSlots).catch(() => {});
    }
  }, [user, history]);

  // Bulk replace — used by the manual cloud-pull path. Same
  // "only replace if you have rows" guard as the auth-driven
  // reconcile so a hiccup can't wipe state.
  const replaceHistory = useCallback((reps) => {
    if (reps && reps.length > 0) setHistory(reps);
  }, []);

  return {
    history,
    historySynced,
    freshMap, freshMapFp, threeExpPriors,
    pendingCount, refreshPending,
    addReps, updateRep, deleteRep, updateSession, updateSessionCooked, deleteSession,
    replaceHistory,
    handleWorkoutSessionSaved,
  };
}
