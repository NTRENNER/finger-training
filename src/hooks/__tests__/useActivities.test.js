// Offline-safe activity log: every change is saved locally first and stays
// marked as unsynced until the cloud confirms it.
import { act, renderHook, waitFor } from "@testing-library/react";
import { useActivities } from "../useActivities.js";
import { loadLS, saveLS, LS_ACTIVITY_DIRTY_KEY } from "../../lib/storage.js";
import * as sync from "../../lib/sync.js";

jest.mock("../../lib/sync.js", () => ({
  pushActivity: jest.fn(),
  deleteActivityCloud: jest.fn(),
  fetchActivities: jest.fn(),
  fetchActivityTombstoneIds: jest.fn(),
  pushActivityTombstones: jest.fn(),
}));

const climb = { date: "2026-11-10", type: "climbing", grade: "V4" };
const user = { id: "user-1" };

beforeEach(() => {
  localStorage.clear();
  sync.pushActivity.mockResolvedValue(true);
  sync.deleteActivityCloud.mockResolvedValue(true);
  sync.fetchActivities.mockResolvedValue([]);
  sync.fetchActivityTombstoneIds.mockResolvedValue([]);
  sync.pushActivityTombstones.mockResolvedValue(true);
});

test("an added activity is saved locally with an id and confirmed once pushed", async () => {
  const { result } = renderHook(() => useActivities({ user: null }));
  act(() => result.current.addActivity(climb));
  const [saved] = result.current.activities;
  expect(saved).toMatchObject(climb);
  expect(saved.id).toBeTruthy();
  expect(loadLS("ft_activity")).toEqual([saved]);
  await waitFor(() => expect(loadLS(LS_ACTIVITY_DIRTY_KEY) || []).not.toContain(saved.id));
});

test("an activity whose push fails stays marked as unsynced", async () => {
  sync.pushActivity.mockResolvedValue(false);
  const { result } = renderHook(() => useActivities({ user: null }));
  act(() => result.current.addActivity(climb));
  const id = result.current.activities[0].id;
  await act(async () => { await Promise.resolve(); });
  expect(loadLS(LS_ACTIVITY_DIRTY_KEY)).toContain(id);
  expect(result.current.activities).toHaveLength(1);
});

test("a deleted activity is tombstoned and not brought back by the next sync", async () => {
  const stored = { ...climb, id: "act-1" };
  saveLS("ft_activity", [stored]);
  sync.deleteActivityCloud.mockResolvedValue(false);      // offline delete
  const { result, rerender } = renderHook(({ syncSignal }) => useActivities({ user, syncSignal }),
    { initialProps: { syncSignal: 0 } });
  await waitFor(() => expect(sync.fetchActivities).toHaveBeenCalledTimes(1));

  await act(async () => { await Promise.resolve(); });   // the first sync backfills the local entry
  sync.pushActivity.mockClear();
  act(() => result.current.deleteActivity("act-1"));
  expect(result.current.activities).toEqual([]);
  expect(loadLS("ft_activity_deleted")).toContain("act-1");

  sync.fetchActivities.mockResolvedValue([stored]);       // the cloud row survived
  rerender({ syncSignal: 1 });
  await waitFor(() => expect(sync.fetchActivities).toHaveBeenCalledTimes(2));
  await act(async () => { await Promise.resolve(); });
  expect(result.current.activities).toEqual([]);
  expect(sync.pushActivity).not.toHaveBeenCalledWith(expect.objectContaining({ id: "act-1" }));
});
