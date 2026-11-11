// Cookedness ratings by date: saved locally first, unsynced until confirmed,
// and an unconfirmed local edit is not overwritten by the cloud copy.
import { act, renderHook, waitFor } from "@testing-library/react";
import { useDailyState } from "../useDailyState.js";
import { loadLS, saveLS, LS_DAILY_STATE_KEY, LS_DAILY_STATE_DIRTY_KEY } from "../../lib/storage.js";
import * as sync from "../../lib/sync.js";

jest.mock("../../lib/sync.js", () => ({
  pushDailyState: jest.fn(),
  deleteDailyState: jest.fn(),
  fetchAllDailyStates: jest.fn(),
}));

const user = { id: "user-1" };
beforeEach(() => {
  localStorage.clear();
  sync.pushDailyState.mockResolvedValue(true);
  sync.deleteDailyState.mockResolvedValue(true);
  sync.fetchAllDailyStates.mockResolvedValue([]);
});

test("a rating is saved locally, read back by date, and confirmed once pushed", async () => {
  const { result } = renderHook(() => useDailyState({ user: null }));
  act(() => result.current.saveCooked("2026-11-10", 6));
  expect(result.current.cookedOnDate("2026-11-10")).toBe(6);
  expect(loadLS(LS_DAILY_STATE_KEY)).toEqual({ "2026-11-10": 6 });
  expect(sync.pushDailyState).toHaveBeenCalledWith("2026-11-10", 6);
  await waitFor(() => expect(loadLS(LS_DAILY_STATE_DIRTY_KEY) || []).not.toContain("2026-11-10"));
});

test("clearing a rating removes it and deletes the cloud copy", () => {
  saveLS(LS_DAILY_STATE_KEY, { "2026-11-10": 6 });
  const { result } = renderHook(() => useDailyState({ user: null }));
  act(() => result.current.saveCooked("2026-11-10", null));
  expect(result.current.cookedOnDate("2026-11-10") ?? null).toBeNull();
  expect(loadLS(LS_DAILY_STATE_KEY)).toEqual({});
  expect(sync.deleteDailyState).toHaveBeenCalledWith("2026-11-10");
});

test("an unconfirmed local rating wins over the cloud copy; a clean date takes the cloud value", async () => {
  sync.pushDailyState.mockResolvedValue(false);            // offline edit
  saveLS(LS_DAILY_STATE_KEY, { "2026-11-09": 2 });
  sync.fetchAllDailyStates.mockResolvedValue([
    { date: "2026-11-09", cooked: 8 }, { date: "2026-11-10", cooked: 3 },
  ]);
  const { result, rerender } = renderHook(({ syncSignal }) => useDailyState({ user, syncSignal }),
    { initialProps: { syncSignal: 0 } });
  await waitFor(() => expect(result.current.cookedOnDate("2026-11-09")).toBe(8));   // clean → cloud wins

  act(() => result.current.saveCooked("2026-11-10", 9));   // local edit, push fails
  rerender({ syncSignal: 1 });
  await waitFor(() => expect(sync.fetchAllDailyStates).toHaveBeenCalledTimes(2));
  await act(async () => { await Promise.resolve(); });
  expect(result.current.cookedOnDate("2026-11-10")).toBe(9);
});
