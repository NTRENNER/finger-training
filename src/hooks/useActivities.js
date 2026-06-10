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
// Tombstone tracking added June 2026: deletes were resurrecting
// deterministically — any second device that still held the
// activity in LS saw it "missing from cloud" on its next reconcile
// and re-pushed it. Same design as useRepHistory's rep tombstones:
// a per-device LS set for fast local filtering plus the synced
// activity_tombstones table as the cross-device authority (written
// inside deleteActivityCloud).
//
// Hook contract: pass the current `user`. Returns { activities,
// addActivity, deleteActivity, updateActivity }. addActivity stamps
// a fresh uid onto the entry so callers don't have to know about
// id generation.

import { useState, useEffect, useCallback } from "react";
import { loadLS, saveLS } from "../lib/storage.js";
import { uid } from "../util.js";
import {
  pushActivity, deleteActivityCloud, fetchActivities,
  fetchActivityTombstoneIds, pushActivityTombstones,
} from "../lib/sync.js";

// Hook-internal LS keys. Used to live at the top of App.js.
const LS_ACTIVITY_KEY         = "ft_activity";          // [{ id, date, type, ... }]
const LS_ACTIVITY_DELETED_KEY = "ft_activity_deleted";  // [id, ...] per-device tombstones

export function useActivities({ user }) {
  const [activities, setActivities] = useState(() => loadLS(LS_ACTIVITY_KEY) || []);

  // Cloud reconcile on sign-in. Same shape as the BW reconcile in
  // useUserSettings: fetch cloud, union by id (local wins on
  // collision since this device's recent edits are most current),
  // backfill any local-only entries up to the cloud.
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
      const byId = new Map();
      for (const a of cloud) {
        if (!deleted.has(a.id)) byId.set(a.id, a);
      }
      // Local writes are most recent on this device — same convention
      // as the BW reconcile. If the user edited a climb on this device
      // between sign-ins, the local copy wins.
      for (const a of local) {
        if (!deleted.has(a.id)) byId.set(a.id, a);
      }
      const merged = [...byId.values()];
      saveLS(LS_ACTIVITY_KEY, merged);
      setActivities(merged);
      // Backfill any local-only entries to the cloud — never a
      // tombstoned one (that's the delete-resurrection path).
      const cloudIds = new Set(cloud.map(a => a.id));
      for (const a of local) {
        if (a?.id && !cloudIds.has(a.id) && !deleted.has(a.id)) pushActivity(a);
      }
    })();
    return () => { cancelled = true; };
  }, [user]);

  const addActivity = useCallback((act) => {
    const stamped = { ...act, id: uid() };
    setActivities(prev => {
      const next = [...prev, stamped];
      saveLS(LS_ACTIVITY_KEY, next);
      return next;
    });
    // Best-effort cloud push (fire-and-forget). Failures are silent —
    // local write is durable and the next sign-in reconcile backfills
    // anything that didn't make it. Mirrors the saveBW pattern.
    pushActivity(stamped);
  }, []);

  const deleteActivity = useCallback((id) => {
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
    // too). Belt-and-braces direct tombstone push in case the helper
    // failed before reaching its tombstone write.
    deleteActivityCloud(id).then(ok => {
      if (!ok) pushActivityTombstones([id]).catch(() => {});
    });
  }, []);

  // Edit an existing activity. Same id → same Supabase row → upsert
  // replaces the cloud copy on conflict. Used by the History tab's
  // climb editor so you can fix a mis-typed grade or wrong date
  // without deleting + re-logging.
  const updateActivity = useCallback((id, updates) => {
    let updated = null;
    setActivities(prev => {
      const next = prev.map(a => {
        if (a.id !== id) return a;
        const merged = { ...a, ...updates, id: a.id };
        updated = merged;
        return merged;
      });
      saveLS(LS_ACTIVITY_KEY, next);
      return next;
    });
    if (updated) pushActivity(updated);
  }, []);

  return { activities, addActivity, deleteActivity, updateActivity };
}
