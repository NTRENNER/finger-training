// Regression: a rep deleted while offline must be deleted from the cloud
// once the connection returns. The cloud delete and both tombstone pushes
// were attempted once and never retried, so the row stayed in the cloud and
// other devices kept showing it; only this device's local tombstone list
// hid it.
import { renderHook, act, waitFor } from "@testing-library/react";
import { useRepHistory } from "../useRepHistory.js";
import { saveLS, loadLS, LS_HISTORY_KEY, LS_REP_DELETED_KEY } from "../../lib/storage.js";
import * as sync from "../../lib/sync.js";
import { syncWorkoutSessions } from "../../lib/workoutSync.js";

const mockDeleteResult = { error: null };
jest.mock("../../lib/supabase.js", () => {
  const chain = () => {
    const c = {
      eq: () => c, or: () => c, in: () => c, select: () => c,
      then: (resolve) => resolve({ data: [], ...mockDeleteResult }),
    };
    return c;
  };
  return { supabase: { from: () => ({ delete: chain, select: chain, update: chain, insert: chain, upsert: chain }) } };
});
jest.mock("../../lib/workoutSync.js", () => ({
  markWorkoutPending: jest.fn(),
  syncWorkoutSessions: jest.fn(async () => {}),
}));
jest.mock("../../lib/sync.js", () => ({
  ...jest.requireActual("../../lib/sync.js"),
  fetchReps: jest.fn(),
  flushQueue: jest.fn(async () => 0),
  flushUpdateQueue: jest.fn(async () => 0),
  fetchRepTombstoneIds: jest.fn(async () => []),
  fetchRepSlotTombstoneKeys: jest.fn(async () => []),
  fetchSessionTombstoneIds: jest.fn(async () => []),
  pushRepTombstones: jest.fn(async () => true),
  pushRepSlotTombstones: jest.fn(async () => true),
  deleteRepsByIds: jest.fn(async () => true),
}));

const rep = (id, rep_num) => ({
  id, session_id: "s1", date: "2026-11-10", grip: "Crusher", hand: "L",
  set_num: 1, rep_num, target_duration: 45, actual_time_s: 40,
  avg_force_kg: 20, weight_kg: 20,
});
const user = { id: "user-1" };

// Mock implementations are reset between tests, so set them here.
function online() {
  mockDeleteResult.error = null;
  syncWorkoutSessions.mockResolvedValue();
  sync.flushQueue.mockResolvedValue(0);
  sync.flushUpdateQueue.mockResolvedValue(0);
  sync.fetchRepTombstoneIds.mockResolvedValue([]);
  sync.fetchRepSlotTombstoneKeys.mockResolvedValue([]);
  sync.fetchSessionTombstoneIds.mockResolvedValue([]);
  sync.pushRepTombstones.mockResolvedValue(true);
  sync.pushRepSlotTombstones.mockResolvedValue(true);
  sync.deleteRepsByIds.mockResolvedValue(true);
}

beforeEach(() => {
  localStorage.clear();
  jest.clearAllMocks();
  online();
});

test("a rep deleted offline is removed from the cloud on the next sync", async () => {
  const a = rep("rep-a", 1);
  const b = rep("rep-b", 2);
  saveLS(LS_HISTORY_KEY, [a, b]);
  sync.fetchReps.mockResolvedValue([a, b]);

  const { result, rerender } = renderHook(
    ({ syncSignal }) => useRepHistory({ user, syncSignal }),
    { initialProps: { syncSignal: 0 } },
  );
  await waitFor(() => expect(result.current.historySynced).toBe(true));
  expect(result.current.history).toHaveLength(2);

  // Offline: the cloud delete and both tombstone pushes fail.
  mockDeleteResult.error = { message: "Failed to fetch" };
  sync.pushRepTombstones.mockResolvedValue(false);
  sync.pushRepSlotTombstones.mockResolvedValue(false);
  await act(async () => { await result.current.deleteRep(a); });
  expect(result.current.history.map(r => r.id)).toEqual(["rep-b"]);
  expect(loadLS(LS_REP_DELETED_KEY)).toContain("rep-a");
  expect(sync.deleteRepsByIds).not.toHaveBeenCalled();

  // Back online. The cloud still holds the row and has no tombstone for it.
  jest.clearAllMocks();
  online();
  sync.fetchReps.mockResolvedValue([a, b]);
  rerender({ syncSignal: 1 });

  await waitFor(() => expect(sync.deleteRepsByIds).toHaveBeenCalledWith(["rep-a"]));
  expect(sync.pushRepTombstones).toHaveBeenCalledWith(["rep-a"]);
  expect(sync.pushRepSlotTombstones).toHaveBeenCalledWith([
    { session_id: "s1", set_num: 1, rep_num: 1, hand: "L" },
  ]);
  await waitFor(() => expect(result.current.historySynced).toBe(true));
  expect(result.current.history.map(r => r.id)).toEqual(["rep-b"]);
});

test("nothing is deleted from the cloud when no deleted rep is still there", async () => {
  const b = rep("rep-b", 2);
  saveLS(LS_HISTORY_KEY, [b]);
  saveLS(LS_REP_DELETED_KEY, ["rep-a"]);
  sync.fetchReps.mockResolvedValue([b]);
  sync.fetchRepTombstoneIds.mockResolvedValue(["rep-a"]);

  const { result } = renderHook(() => useRepHistory({ user, syncSignal: 0 }));
  await waitFor(() => expect(result.current.historySynced).toBe(true));

  expect(sync.deleteRepsByIds).not.toHaveBeenCalled();
  expect(sync.pushRepTombstones).not.toHaveBeenCalled();
  expect(result.current.history.map(r => r.id)).toEqual(["rep-b"]);
});
