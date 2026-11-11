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
  pushRep: jest.fn(async () => "ok"),
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
  sync.pushRep.mockResolvedValue("ok");
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

test.each(['rep', 'session'])('retries a failed slot tombstone after a successful %s row delete', async kind => {
  const a = rep('rep-a', 1), b = { ...rep('rep-b', 2), session_id: 's2' };
  saveLS(LS_HISTORY_KEY, [a, b]);
  sync.fetchReps.mockResolvedValue([a, b]);
  const { result, rerender } = renderHook(({ syncSignal }) => useRepHistory({ user, syncSignal }),
    { initialProps: { syncSignal: 0 } });
  await waitFor(() => expect(result.current.historySynced).toBe(true));
  sync.pushRepSlotTombstones.mockResolvedValue(false);
  await act(async () => {
    if (kind === 'rep') await result.current.deleteRep(a);
    else await result.current.deleteSession('s1');
  });
  sync.fetchReps.mockResolvedValue([b]);
  sync.fetchRepTombstoneIds.mockResolvedValue(['rep-a']);
  sync.pushRepSlotTombstones.mockClear();
  sync.pushRepSlotTombstones.mockResolvedValue(true);
  rerender({ syncSignal: 1 });
  await waitFor(() => expect(sync.pushRepSlotTombstones).toHaveBeenCalledWith([
    { session_id: 's1', set_num: 1, rep_num: 1, hand: 'L' },
  ]));
  await waitFor(() => expect(result.current.historySynced).toBe(true));
  sync.pushRepSlotTombstones.mockClear();
  rerender({ syncSignal: 2 });
  await waitFor(() => expect(result.current.historySynced).toBe(true));
  expect(sync.pushRepSlotTombstones).not.toHaveBeenCalled();
});

test('pending slot deletion survives remount and hides a stale rep with a fresh UUID', async () => {
  const a = rep('rep-a', 1), b = rep('rep-b', 2);
  saveLS(LS_HISTORY_KEY, [a, b]);
  sync.fetchReps.mockResolvedValue([a, b]);
  const view = renderHook(() => useRepHistory({ user }));
  await waitFor(() => expect(view.result.current.historySynced).toBe(true));
  sync.pushRepSlotTombstones.mockResolvedValue(false);
  await act(async () => { await view.result.current.deleteRep(a); });
  view.unmount();
  sync.fetchReps.mockResolvedValue([{ ...a, id: 'stale-copy-new-uuid' }, b]);
  // A push flush can already be running when this reconcile begins. Its
  // unprocessed stale copy must not bypass the history tombstone filter.
  sync.enqueueReps([{ ...a, id: 'queued-stale-copy' }]);
  sync.fetchRepTombstoneIds.mockResolvedValue(['rep-a']);
  sync.deleteRepsByIds.mockClear();
  const { result } = renderHook(() => useRepHistory({ user }));
  await waitFor(() => expect(result.current.historySynced).toBe(true));
  expect(result.current.history.map(r => r.id)).toEqual(['rep-b']);
  expect(sync.deleteRepsByIds).toHaveBeenCalledWith(['stale-copy-new-uuid']);
});

test('manual refresh shares tombstone filtering, delete retries and pending edit overlays', async () => {
  const a = rep('rep-a', 1), b = rep('rep-b', 2);
  saveLS(LS_HISTORY_KEY, [a, b]);
  sync.fetchReps.mockResolvedValue([a, b]);
  const { result } = renderHook(() => useRepHistory({ user }));
  await waitFor(() => expect(result.current.historySynced).toBe(true));
  saveLS(LS_REP_DELETED_KEY, ['rep-a']);
  sync.enqueueRepUpdate({ kind: 'rep', id: 'rep-b', updates: { actual_time_s: 55 } });
  let ok;
  await act(async () => { ok = await result.current.refreshHistory(); });
  expect(ok).toBe(true);
  expect(sync.deleteRepsByIds).toHaveBeenCalledWith(['rep-a']);
  expect(result.current.history).toEqual([expect.objectContaining({ id: 'rep-b', actual_time_s: 55 })]);
});

test('manual refresh clears the last rep when its deletion is confirmed', async () => {
  const a = rep('rep-a', 1);
  saveLS(LS_HISTORY_KEY, [a]); sync.fetchReps.mockResolvedValue([a]);
  const { result } = renderHook(() => useRepHistory({ user }));
  await waitFor(() => expect(result.current.historySynced).toBe(true));
  sync.fetchRepTombstoneIds.mockResolvedValue(['rep-a']);
  await act(async () => { await result.current.refreshHistory(); });
  expect(result.current.history).toEqual([]);
});

test('a rep saved while a refresh is in flight cannot be overwritten by its older snapshot', async () => {
  const a = rep('rep-a', 1), b = rep('rep-b', 2);
  saveLS(LS_HISTORY_KEY, [a]);
  sync.fetchReps.mockResolvedValue([a]);
  const { result } = renderHook(() => useRepHistory({ user }));
  await waitFor(() => expect(result.current.historySynced).toBe(true));
  saveLS(LS_REP_DELETED_KEY, ['older-deleted-rep']);
  let release;
  sync.pushRepTombstones.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  let refreshing;
  act(() => { refreshing = result.current.refreshHistory(); });
  await waitFor(() => expect(sync.pushRepTombstones).toHaveBeenCalledWith(['older-deleted-rep']));
  await act(async () => { result.current.addReps([b]); });
  let refreshed;
  await act(async () => { release(true); refreshed = await refreshing; });
  expect(refreshed).toBe(false);
  expect(result.current.history.map(r => r.id)).toEqual(['rep-b', 'rep-a']);
});

test('an older manual refresh cannot replace the latest completed refresh', async () => {
  const a = rep('rep-a', 1);
  saveLS(LS_HISTORY_KEY, [a]); sync.fetchReps.mockResolvedValue([a]);
  const { result } = renderHook(() => useRepHistory({ user }));
  await waitFor(() => expect(result.current.historySynced).toBe(true));
  let release;
  sync.fetchReps.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  let older;
  act(() => { older = result.current.refreshHistory(); });
  await waitFor(() => expect(sync.fetchReps).toHaveBeenCalledTimes(2));
  sync.fetchReps.mockResolvedValue([{ ...a, actual_time_s: 55 }]);
  await act(async () => { await result.current.refreshHistory(); });
  await act(async () => { release([a]); await older; });
  expect(result.current.history[0].actual_time_s).toBe(55);
});
