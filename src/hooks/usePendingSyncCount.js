import { useMemo } from "react";

import { useLSValue } from "./useLSValue.js";
import {
  LS_ACTIVITY_DIRTY_KEY,
  LS_BW_DIRTY_KEY,
  LS_DAILY_STATE_DIRTY_KEY,
  LS_USER_SETTINGS_PATCH_KEY,
  LS_WORKOUT_DELETED_KEY,
  LS_WORKOUT_LOG_KEY,
  LS_WORKOUT_SYNCED_KEY,
} from "../lib/storage.js";
import { LS_QUEUE_KEY, LS_UPDATE_QUEUE_KEY } from "../lib/sync.js";

function listLength(value) {
  return Array.isArray(value) ? value.length : 0;
}

export function countPendingSyncChanges({
  repAdds,
  repUpdates,
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
    + listLength(activityDirty)
    + listLength(bodyWeightDirty)
    + listLength(dailyStateDirty)
    + settingsCount
    + unsyncedWorkouts;
}

export function usePendingSyncCount() {
  const repAdds = useLSValue(LS_QUEUE_KEY);
  const repUpdates = useLSValue(LS_UPDATE_QUEUE_KEY);
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
    activityDirty,
    bodyWeightDirty,
    dailyStateDirty,
    settingsPatch,
    workoutLog,
    workoutSynced,
    workoutDeleted,
  ]);
}
