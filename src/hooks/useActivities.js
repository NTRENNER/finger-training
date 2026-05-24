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
// state). No tombstone tracking yet — a deleted-on-phone climb can
// resurrect on next sign-in if the cloud delete didn't make it
// before the device went offline. Rare in practice; if it becomes
// a real pain point, mirror useRepHistory's LS_REP_DELETED_KEY
// pattern with an LS_ACTIVITY_DELETED_KEY.
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
} from "../lib/sync.js";

// Hook-internal LS key. Used to live at the top of App.js.
const LS_ACTIVITY_KEY = "ft_activity";  // [{ id, date, type, ... }]

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
      const cloud = await fetchActivities();
      if (cancelled || !cloud) return;
      const local = loadLS(LS_ACTIVITY_KEY) || [];
      const byId = new Map();
      for (const a of cloud) byId.set(a.id, a);
      // Local writes are most recent on this device — same convention
      // as the BW reconcile. If the user edited a climb on this device
      // between sign-ins, the local copy wins.
      for (const a of local) byId.set(a.id, a);
      const merged = [...byId.values()];
      saveLS(LS_ACTIVITY_KEY, merged);
      setActivities(merged);
      // Backfill any local-only entries to the cloud.
      const cloudIds = new Set(cloud.map(a => a.id));
      for (const a of local) {
        if (a?.id && !cloudIds.has(a.id)) pushActivity(a);
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
    // Cloud delete by id. If it fails, the next reconcile will resurrect
    // the entry from the cloud — that's acceptable for now (no tombstone
    // tracking yet for activities; rep deletes use LS_REP_DELETED_KEY,
    // and we can add the same pattern here if delete-resurrection
    // becomes a real problem).
    deleteActivityCloud(id);
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
