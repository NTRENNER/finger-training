// ─────────────────────────────────────────────────────────────
// useActivities — climbing log + 1RM CRUD + cloud reconcile
// ─────────────────────────────────────────────────────────────
// Activities are the non-rep training events: climbing sessions
// (the bulk of the entries) and the legacy 1RM PR logs. They share
// a single LS array + Supabase table because the schema is shallow
// (id, date, type, plus type-specific fields) and the consumers
// already filter by `a.type === "climbing"` / `"oneRM"`.
//
// Extracted from App.js in late May 2026 (BACKLOG #154). Sister
// hook to useUserSettings: same local-first + cloud-reconcile-on-
// sign-in shape, narrower API (just add / delete / update + the
// state).
//
// SYNC MODEL (June 2026 — two complementary mechanisms):
//
// 1. DIRTY-KEY TRACKING (see storage.js): the reconcile used to be
//    "local wins on every id collision", which diverged across
//    devices — an edit made on Device B never landed on Device A,
//    because A's untouched stale copy beat the cloud's newer row on
//    every sign-in. Now add/update marks the id dirty until a cloud
//    push confirms; reconcile gives local priority ONLY for dirty
//    ids and takes the cloud row otherwise. A dirty id with no local
//    entry is a pending DELETE — reconcile drops the cloud copy and
//    retries the cloud delete.
//
// 2. TOMBSTONES: deletes were resurrecting deterministically — any
//    second device that still held the activity in LS saw it
//    "missing from cloud" on its next reconcile and re-pushed it.
//    Same design as useRepHistory's rep tombstones: a per-device LS
//    set for fast local filtering plus the synced activity_tombstones
//    table as the cross-device authority (written inside
//    deleteActivityCloud).
//
// Division of labor: dirty keys answer "whose EDIT wins" and make
// this device's unsynced deletes survive its own reconciles;
// tombstones make deletes durable across OTHER devices. Tombstones
// filter everything first; dirty keys arbitrate what remains.
//
// Hook contract: pass the current `user`. Returns { activities,
// addActivity, deleteActivity, updateActivity }. addActivity stamps
// a fresh uid onto the entry so callers don't have to know about
// id generation.

import { useState, useEffect, useCallback } from "react";
import {
  loadLS, saveLS,
  LS_ACTIVITY_DIRTY_KEY, loadDirtySet, markDirty, clearDirty,
} from "../lib/storage.js";
import { uid } from "../util.js";
import {
  pushActivity, deleteActivityCloud, fetchActivities,
  fetchActivityTombstoneIds, pushActivityTombstones,
} from "../lib/sync.js";

// Hook-internal LS keys. Used to live at the top of App.js.
const LS_ACTIVITY_KEY         = "ft_activity";          // [{ id, date, type, ... }]
const LS_ACTIVITY_DELETED_KEY = "ft_activity_deleted";  // [id, ...] per-device tombstones

// Confirm-or-keep-dirty helper: clear the dirty mark only if the LS
// entry at confirmation time still matches what we pushed (deep-equal
// via JSON — entries are small flat objects). If the user edited
// again while the push was in flight, the newer edit's own push owns
// the eventual clear; dropping the mark here would let a failed
// second push masquerade as synced. For deletes, pass null — the
// mark clears only if the entry is still absent locally.
function confirmPushed(id, pushedEntry) {
  const current = (loadLS(LS_ACTIVITY_KEY) || []).find(a => a?.id === id) || null;
  const same = pushedEntry == null
    ? current == null
    : current != null && JSON.stringify(current) === JSON.stringify(pushedEntry);
  if (same) clearDirty(LS_ACTIVITY_DIRTY_KEY, id);
}

export function useActivities({ user }) {
  const [activities, setActivities] = useState(() => loadLS(LS_ACTIVITY_KEY) || []);

  // Cloud reconcile on sign-in. Same shape as the BW reconcile in
  // useUserSettings: fetch cloud, union by id, backfill unsynced
  // local entries up to the cloud. Local wins ONLY for dirty ids
  // (unconfirmed local edits) and local-only ids (offline adds /
  // pre-dirty-era entries) — cloud wins everywhere else so edits
  // from other devices actually land here.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      // Tombstones first: union the per-device set with the synced
      // activity_tombstones table, mirror the union into LS, and
      // filter EVERYTHING below through it — the cloud rows (a delete
      // whose row-delete failed but tombstone landed), the local rows
      // (deleted on another device), and the backfill push list (the
      // resurrection vector). null = tombstone fetch error → fall
      // back to the per-device set, same convention as reps.
      const [cloud, cloudTombs] = await Promise.all([
        fetchActivities(),
        fetchActivityTombstoneIds(),
      ]);
      if (cancelled || !cloud) return;
      const deleted = new Set([
        ...(loadLS(LS_ACTIVITY_DELETED_KEY) || []),
        ...(cloudTombs || []),
      ]);
      if (cloudTombs && cloudTombs.length > 0) {
        saveLS(LS_ACTIVITY_DELETED_KEY, [...deleted]);
      }
      const local = loadLS(LS_ACTIVITY_KEY) || [];
      const dirty = loadDirtySet(LS_ACTIVITY_DIRTY_KEY);
      const cloudIds = new Set(cloud.map(a => a.id));
      const localIds = new Set(local.map(a => a?.id).filter(Boolean));
      const byId = new Map();
      // Tombstoned ids never enter the merge, from either side.
      for (const a of cloud) {
        if (!deleted.has(a.id)) byId.set(a.id, a);
      }
      for (const a of local) {
        if (!a?.id) continue;
        if (deleted.has(a.id)) {
          // Deleted (here or on another device) — drop, and retire any
          // stale dirty mark so it doesn't read as a pending edit.
          clearDirty(LS_ACTIVITY_DIRTY_KEY, a.id);
          continue;
        }
        // Dirty = this device has an edit the cloud hasn't confirmed.
        // Local-only = the cloud has never seen it (offline add, or an
        // entry from before dirty tracking existed) — keep + backfill.
        if (dirty.has(a.id) || !cloudIds.has(a.id)) byId.set(a.id, a);
      }
      // Pending deletes: dirty ids with no local entry. The user
      // deleted on this device but the cloud delete didn't confirm —
      // drop the resurrected cloud copy and retry the delete.
      for (const id of dirty) {
        if (localIds.has(id)) continue;
        byId.delete(id);
        if (cloudIds.has(id) && !deleted.has(id)) {
          deleteActivityCloud(id).then(ok => { if (ok) confirmPushed(id, null); });
        } else {
          clearDirty(LS_ACTIVITY_DIRTY_KEY, id);  // already gone / tombstoned
        }
      }
      const merged = [...byId.values()];
      saveLS(LS_ACTIVITY_KEY, merged);
      setActivities(merged);
      // Backfill unsynced local entries (dirty edits + local-only
      // adds). Never a tombstoned one — byId excludes them above, so
      // the byId.has gate doubles as the resurrection filter. Fire-
      // and-forget; failures stay dirty and retry on the next
      // sign-in reconcile.
      for (const a of local) {
        if (!a?.id || !byId.has(a.id)) continue;
        if (dirty.has(a.id) || !cloudIds.has(a.id)) {
          pushActivity(a).then(ok => { if (ok) confirmPushed(a.id, a); });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [user]);

  const addActivity = useCallback((act) => {
    const stamped = { ...act, id: uid() };
    markDirty(LS_ACTIVITY_DIRTY_KEY, stamped.id);
    setActivities(prev => {
      const next = [...prev, stamped];
      saveLS(LS_ACTIVITY_KEY, next);
      return next;
    });
    // Best-effort cloud push. Failures are silent — the local write
    // is durable, the id stays dirty, and the next sign-in reconcile
    // retries the backfill. Mirrors the saveBW pattern.
    pushActivity(stamped).then(ok => { if (ok) confirmPushed(stamped.id, stamped); });
  }, []);

  const deleteActivity = useCallback((id) => {
    markDirty(LS_ACTIVITY_DIRTY_KEY, id);
    setActivities(prev => {
      const next = prev.filter(a => a.id !== id);
      saveLS(LS_ACTIVITY_KEY, next);
      return next;
    });
    // Per-device tombstone so this device's reconcile never re-adds
    // or re-pushes the entry, even if the cloud calls below fail.
    const deleted = new Set(loadLS(LS_ACTIVITY_DELETED_KEY) || []);
    if (!deleted.has(id)) {
      deleted.add(id);
      saveLS(LS_ACTIVITY_DELETED_KEY, [...deleted]);
    }
    // Cloud delete (deleteActivityCloud writes the synced tombstone
    // before deleting the row, so other devices stop resurrecting it
    // too). On success, retire the dirty mark; on failure, push the
    // tombstone directly as a belt-and-braces fallback — the id also
    // stays dirty with no local entry, which the reconcile reads as a
    // pending delete and retries.
    deleteActivityCloud(id).then(ok => {
      if (ok) confirmPushed(id, null);
      else pushActivityTombstones([id]).catch(() => {});
    });
  }, []);

  // Edit an existing activity. Same id → same Supabase row → upsert
  // replaces the cloud copy on conflict. Used by the History tab's
  // climb editor so you can fix a mis-typed grade or wrong date
  // without deleting + re-logging.
  const updateActivity = useCallback((id, updates) => {
    // Compute the merged entry from LS (the durable source the state
    // mirrors) rather than capturing it inside the setState updater —
    // updater-invocation timing is a React internal, and the cloud
    // push + dirty bookkeeping below need the value deterministically.
    const current = loadLS(LS_ACTIVITY_KEY) || [];
    const target = current.find(a => a?.id === id);
    if (!target) return;  // nothing to edit, nothing to sync
    const mergedEntry = { ...target, ...updates, id };
    markDirty(LS_ACTIVITY_DIRTY_KEY, id);
    const next = current.map(a => (a?.id === id ? mergedEntry : a));
    saveLS(LS_ACTIVITY_KEY, next);
    setActivities(next);
    pushActivity(mergedEntry).then(ok => { if (ok) confirmPushed(id, mergedEntry); });
  }, []);

  return { activities, addActivity, deleteActivity, updateActivity };
}
