import { useMemo } from "react";

import { useLSValue } from "./useLSValue.js";
import {
  LS_ACTIVITY_DIRTY_KEY,
  LS_BW_DIRTY_KEY,
  LS_DAILY_STATE_DIRTY_KEY,
  LS_USER_SETTINGS_PATCH_KEY,
  LS_WORKOUT_DELETED_KEY,
  LS_REP_SLOT_DELETE_QUEUE_KEY,
  LS_WORKOUT_LOG_KEY,
  LS_WORKOUT_SYNCED_KEY,
  loadLS,
} from "../lib/storage.js";
import { LS_QUEUE_KEY, LS_UPDATE_QUEUE_KEY } from "../lib/sync.js";

function listLength(value) {
  return Array.isArray(value) ? value.length : 0;
}

export function countPendingSyncChanges({
  repAdds,
  repUpdates,
  repSlotDeletes,
  activityDirty,
  bodyWeightDirty,
  dailyStateDirty,
  settingsPatch,
  workoutLog,
  workoutSynced,
  workoutDeleted,
}) {
  const synced = new Set(Array.isArray(workoutSynced) ? workoutSynced : []);
  const deleted = new Set(Array.isArray(workoutDeleted) ? workoutDeleted : []);
  const unsyncedWorkouts = (Array.isArray(workoutLog) ? workoutLog : [])
    .filter(session => !session?.id || (!synced.has(session.id) && !deleted.has(session.id)))
    .length;

  const settingsCount = settingsPatch && typeof settingsPatch === "object"
    ? Object.keys(settingsPatch).length
    : 0;

  return listLength(repAdds)
    + listLength(repUpdates)
    + listLength(repSlotDeletes)
    + listLength(activityDirty)
    + listLength(bodyWeightDirty)
    + listLength(dailyStateDirty)
    + settingsCount
    + unsyncedWorkouts;
}

// Same count, read straight from storage. For callers outside React's
// render cycle, such as the foreground-sync check in useConnectivity.
export function readPendingSyncCount() {
  return countPendingSyncChanges({
    repAdds: loadLS(LS_QUEUE_KEY),
    repUpdates: loadLS(LS_UPDATE_QUEUE_KEY),
    repSlotDeletes: loadLS(LS_REP_SLOT_DELETE_QUEUE_KEY),
    activityDirty: loadLS(LS_ACTIVITY_DIRTY_KEY),
    bodyWeightDirty: loadLS(LS_BW_DIRTY_KEY),
    dailyStateDirty: loadLS(LS_DAILY_STATE_DIRTY_KEY),
    settingsPatch: loadLS(LS_USER_SETTINGS_PATCH_KEY),
    workoutLog: loadLS(LS_WORKOUT_LOG_KEY),
    workoutSynced: loadLS(LS_WORKOUT_SYNCED_KEY),
    workoutDeleted: loadLS(LS_WORKOUT_DELETED_KEY),
  });
}

export function usePendingSyncCount() {
  const repAdds = useLSValue(LS_QUEUE_KEY);
  const repUpdates = useLSValue(LS_UPDATE_QUEUE_KEY);
  const repSlotDeletes = useLSValue(LS_REP_SLOT_DELETE_QUEUE_KEY);
  const activityDirty = useLSValue(LS_ACTIVITY_DIRTY_KEY);
  const bodyWeightDirty = useLSValue(LS_BW_DIRTY_KEY);
  const dailyStateDirty = useLSValue(LS_DAILY_STATE_DIRTY_KEY);
  const settingsPatch = useLSValue(LS_USER_SETTINGS_PATCH_KEY);
  const workoutLog = useLSValue(LS_WORKOUT_LOG_KEY);
  const workoutSynced = useLSValue(LS_WORKOUT_SYNCED_KEY);
  const workoutDeleted = useLSValue(LS_WORKOUT_DELETED_KEY);

  return useMemo(() => countPendingSyncChanges({
    repAdds,
    repUpdates,
    repSlotDeletes,
    activityDirty,
    bodyWeightDirty,
    dailyStateDirty,
    settingsPatch,
    workoutLog,
    workoutSynced,
    workoutDeleted,
  }), [
    repAdds,
    repUpdates,
    repSlotDeletes,
    activityDirty,
    bodyWeightDirty,
    dailyStateDirty,
    settingsPatch,
    workoutLog,
    workoutSynced,
    workoutDeleted,
  ]);
}
