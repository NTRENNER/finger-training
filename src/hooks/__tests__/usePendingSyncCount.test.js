import { countPendingSyncChanges } from "../usePendingSyncCount.js";

test("counts pending work across every local-first data domain", () => {
  expect(countPendingSyncChanges({
    repAdds: [{ id: "rep-add" }],
    repUpdates: [{ id: "rep-edit" }],
    activityDirty: ["activity-1"],
    bodyWeightDirty: ["2026-07-27"],
    dailyStateDirty: ["2026-07-27"],
    settingsPatch: {
      climbing_focus: { discipline: "boulder" },
      pyramid_project: { indoor: "V9" },
    },
    workoutLog: [
      { id: "synced-workout" },
      { id: "pending-workout" },
      { name: "legacy pending workout" },
    ],
    workoutSynced: ["synced-workout"],
    workoutDeleted: [],
  })).toBe(9);
});

test("does not count synced or deleted workout sessions", () => {
  expect(countPendingSyncChanges({
    repAdds: null,
    repUpdates: null,
    activityDirty: null,
    bodyWeightDirty: null,
    dailyStateDirty: null,
    settingsPatch: null,
    workoutLog: [{ id: "synced" }, { id: "deleted" }],
    workoutSynced: ["synced"],
    workoutDeleted: ["deleted"],
  })).toBe(0);
});
