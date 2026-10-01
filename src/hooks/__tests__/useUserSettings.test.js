/* global globalThis */
import { act, renderHook, waitFor } from "@testing-library/react";

import { useUserSettings } from "../useUserSettings.js";
import { createVolumeExperiment } from '../../model/volumeExperiment.js';
import { LS_VOLUME_EXPERIMENTS_KEY, volumeExperimentPatch } from '../../lib/volumeExperimentStorage.js';
import {
  LS_BW_LOG_KEY,
  LS_BW_DIRTY_KEY,
  LS_PINNED_GRIP_BASELINES_KEY,
  LS_USER_SETTINGS_PATCH_KEY,
  loadLS,
  saveLS,
} from "../../lib/storage.js";
import {
  pushBW,
  removeBWTombstones,
  enqueueUserSettingsPatch,
  fetchBWLog,
  fetchBWTombstoneDates,
  fetchUserSettings,
  flushUserSettingsPatch,
} from "../../lib/sync.js";

jest.mock("../../lib/sync.js", () => ({
  pushBW: jest.fn().mockResolvedValue(true),
  deleteBW: jest.fn().mockResolvedValue(true),
  fetchBWLog: jest.fn(),
  fetchBWTombstoneDates: jest.fn(),
  removeBWTombstones: jest.fn().mockResolvedValue(true),
  fetchUserSettings: jest.fn(),
  enqueueUserSettingsPatch: jest.fn(patch => {
    const current = JSON.parse(globalThis.localStorage.getItem("ft_user_settings_patch") || "{}");
    globalThis.localStorage.setItem(
      "ft_user_settings_patch",
      JSON.stringify({ ...current, ...patch })
    );
    return true;
  }),
  flushUserSettingsPatch: jest.fn(),
}));

beforeEach(() => {
  jest.restoreAllMocks();
  localStorage.clear();
  jest.clearAllMocks();
  pushBW.mockResolvedValue(true);
  removeBWTombstones.mockResolvedValue(true);
  fetchBWLog.mockResolvedValue([]);
  fetchBWTombstoneDates.mockResolvedValue([]);
  enqueueUserSettingsPatch.mockImplementation(patch => saveLS(LS_USER_SETTINGS_PATCH_KEY,
    { ...(loadLS(LS_USER_SETTINGS_PATCH_KEY) || {}), ...patch }));
});

afterEach(() => jest.restoreAllMocks());

test('Volume plans restore from cloud while pending edits and separate experiments survive', async () => {
  const oldPlan = createVolumeExperiment({ grips: ['Micro'], startDate: '2026-07-01', id: 'previous' });
  const active = createVolumeExperiment({ grips: ['Micro', 'Crusher'], startDate: '2026-10-01', id: 'current' });
  const paused = { ...active, status: 'paused', updatedAt: '2026-10-02T08:00:00Z',
    reviews: { 1: { notes: 'Travel this week' } } };
  saveLS(LS_USER_SETTINGS_PATCH_KEY, { ...volumeExperimentPatch(paused, { statusOnly: true }),
    ...volumeExperimentPatch(paused, { reviewWeek: 1 }) });
  flushUserSettingsPatch.mockResolvedValue(false);
  fetchUserSettings.mockResolvedValue({ ...volumeExperimentPatch(oldPlan), ...volumeExperimentPatch(active) });
  const { result } = renderHook(() => useUserSettings({ user: { id: 'user-1' } }));
  await waitFor(() => expect(result.current.settingsSynced).toBe(true));
  expect(result.current.volumeExperiments).toEqual({ previous: oldPlan, current: paused });
  expect(loadLS(LS_VOLUME_EXPERIMENTS_KEY)).toEqual(result.current.volumeExperiments);
});

test('Volume lifecycle writes one experiment, preserves its frozen baseline and rejects malformed plans', () => {
  const oldPlan = createVolumeExperiment({ grips: ['Micro'], startDate: '2026-07-01', id: 'previous' });
  const active = createVolumeExperiment({ grips: ['Micro'], startDate: '2026-10-01', id: 'current' });
  saveLS(LS_VOLUME_EXPERIMENTS_KEY, { previous: oldPlan });
  const { result } = renderHook(() => useUserSettings({ user: null }));
  act(() => expect(result.current.saveVolumeExperiment(active)).toBe(true));
  const paused = { ...active, status: 'paused', updatedAt: '2026-10-02T08:00:00Z' };
  act(() => expect(result.current.saveVolumeExperiment(paused, { statusOnly: true })).toBe(true));
  expect(result.current.volumeExperiments.previous).toEqual(oldPlan);
  expect(result.current.volumeExperiments.current.baseline).toEqual(active.baseline);
  expect(enqueueUserSettingsPatch).toHaveBeenLastCalledWith({ volume_beta_status_current: {
    version: 1, experiment_id: 'current', status: 'paused', updatedAt: paused.updatedAt,
  } });
  act(() => expect(result.current.saveVolumeExperiment({ ...active, endDate: '2026-12-01' })).toBe(false));
  expect(result.current.volumeExperiments.current.status).toBe('paused');
});

test('stale weekly review preserves a pause and another week already saved', () => {
  const active = createVolumeExperiment({ grips: ['Micro'], startDate: '2026-10-01', id: 'current' });
  const { result } = renderHook(() => useUserSettings({ user: null }));
  act(() => result.current.saveVolumeExperiment(active));
  act(() => result.current.saveVolumeExperiment({ ...active, status: 'paused' }, { statusOnly: true }));
  act(() => result.current.saveVolumeExperiment({ ...active, reviews: { 1: { notes: 'Week one' } } }, { reviewWeek: 1 }));
  act(() => result.current.saveVolumeExperiment({ ...active, reviews: { 2: { notes: 'Week two' } } }, { reviewWeek: 2 }));
  expect(result.current.volumeExperiments.current).toMatchObject({ status: 'paused',
    reviews: { 1: { notes: 'Week one' }, 2: { notes: 'Week two' } }, baseline: active.baseline });
  expect(enqueueUserSettingsPatch).toHaveBeenLastCalledWith({ volume_beta_review_current_2: {
    version: 1, experiment_id: 'current', week: 2, review: { notes: 'Week two' },
  } });
});

test('refuses activation if the durable settings queue cannot be saved', () => {
  const active = createVolumeExperiment({ grips: ['Micro'], startDate: '2026-10-01', id: 'current' });
  const { result } = renderHook(() => useUserSettings({ user: null }));
  enqueueUserSettingsPatch.mockReturnValueOnce(false);
  act(() => expect(result.current.saveVolumeExperiment(active)).toBe(false));
  expect(result.current.volumeExperiments).toEqual({});
  expect(loadLS(LS_VOLUME_EXPERIMENTS_KEY)).toBeNull();
  expect(loadLS(LS_USER_SETTINGS_PATCH_KEY)).toBeNull();
});

test('a failed secondary cache write recovers from the durable journal on offline remount', () => {
  const active = createVolumeExperiment({ grips: ['Micro'], startDate: '2026-10-01', id: 'current' });
  const originalSetItem = Storage.prototype.setItem;
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  const write = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
    if (key === LS_VOLUME_EXPERIMENTS_KEY) throw new DOMException('Quota', 'QuotaExceededError');
    return originalSetItem.call(this, key, value);
  });
  const view = renderHook(() => useUserSettings({ user: null }));
  act(() => expect(view.result.current.saveVolumeExperiment(active)).toBe(true));
  act(() => expect(view.result.current.saveVolumeExperiment({ ...active, status: 'paused' }, { statusOnly: true })).toBe(true));
  expect(loadLS(LS_VOLUME_EXPERIMENTS_KEY)).toBeNull();
  expect(loadLS(LS_USER_SETTINGS_PATCH_KEY)).toHaveProperty('volume_beta_plan_current');
  view.unmount();
  const utils = renderHook(() => useUserSettings({ user: null }));
  expect(utils.result.current.volumeExperiments.current).toMatchObject({ status: 'paused', baseline: active.baseline });
  write.mockRestore(); error.mockRestore();
});

test('existing plans cannot replace their frozen baseline through a full-plan save', () => {
  const active = createVolumeExperiment({ grips: ['Micro'], startDate: '2026-10-01', id: 'current' });
  const { result } = renderHook(() => useUserSettings({ user: null }));
  act(() => result.current.saveVolumeExperiment(active));
  act(() => expect(result.current.saveVolumeExperiment({ ...active, status: 'ended' })).toBe(false));
  expect(result.current.volumeExperiments.current.status).toBe('active');
});

test('invalid cloud Volume keys cannot replace a real experiment', async () => {
  const active = createVolumeExperiment({ grips: ['Micro'], startDate: '2026-10-01', id: 'current' });
  flushUserSettingsPatch.mockResolvedValue(true);
  fetchUserSettings.mockResolvedValue({ volume_beta_plan_wrong: active, volume_beta_plan_current: null });
  const { result } = renderHook(() => useUserSettings({ user: { id: 'user-1' } }));
  await waitFor(() => expect(result.current.settingsSynced).toBe(true));
  expect(result.current.volumeExperiments).toEqual({});
});

test("still fetches cloud settings when the queued patch flush fails", async () => {
  flushUserSettingsPatch.mockResolvedValue(false);
  fetchUserSettings.mockResolvedValue({ climbing_focus: "endurance" });
  const user = { id: "user-1" };

  const { result } = renderHook(() =>
    useUserSettings({ user })
  );

  await waitFor(() => expect(result.current.settingsSynced).toBe(true));
  expect(fetchUserSettings).toHaveBeenCalledTimes(1);
  expect(result.current.climbingFocus).toBe("endurance");
});

test("pending local values win while cloud map entries are preserved for retry", async () => {
  const localPins = {
    _v: 4,
    Prime: { date: "2026-07-28", amps: [1, 2, 3] },
  };
  saveLS("ft_climbing_focus", "bouldering");
  saveLS(LS_USER_SETTINGS_PATCH_KEY, {
    climbing_focus: "bouldering",
    pinned_grip_baselines: localPins,
  });
  flushUserSettingsPatch.mockResolvedValue(false);
  fetchUserSettings.mockResolvedValue({
    climbing_focus: "endurance",
    pinned_grip_baselines: {
      _v: 4,
      Crusher: { date: "2026-07-20", amps: [4, 5, 6] },
    },
  });
  const user = { id: "user-1" };

  const { result } = renderHook(() =>
    useUserSettings({ user })
  );

  await waitFor(() => expect(result.current.settingsSynced).toBe(true));
  expect(result.current.climbingFocus).toBe("bouldering");
  expect(result.current.pinnedGripBaselines).toMatchObject({
    _v: 4,
    Prime: localPins.Prime,
    Crusher: { date: "2026-07-20", amps: [4, 5, 6] },
  });
  expect(loadLS(LS_PINNED_GRIP_BASELINES_KEY)).toMatchObject({
    Prime: localPins.Prime,
    Crusher: { date: "2026-07-20", amps: [4, 5, 6] },
  });
  expect(enqueueUserSettingsPatch).toHaveBeenCalledWith({
    pinned_grip_baselines: expect.objectContaining({
      Prime: localPins.Prime,
      Crusher: { date: "2026-07-20", amps: [4, 5, 6] },
    }),
  });
});


test("backdated weight syncs its date without replacing current weight; corrections replace one row", async () => {
  saveLS(LS_BW_LOG_KEY, [{ date: "2026-01-15", kg: 70 }]);
  saveLS("ft_bw", 70);
  const { result } = renderHook(() => useUserSettings({ user: null }));
  act(() => result.current.saveBW(72.3, "2026-01-01"));
  expect(result.current.bodyWeight).toBe(70);
  expect(loadLS("ft_bw")).toBe(70);
  await waitFor(() => expect(pushBW).toHaveBeenCalledWith("2026-01-01", 72.3));
  expect(removeBWTombstones).toHaveBeenCalledWith(["2026-01-01"]);
  await waitFor(() => expect(loadLS(LS_BW_DIRTY_KEY) || []).not.toContain("2026-01-01"));
  act(() => result.current.saveBW(71.8, "2026-01-01"));
  await waitFor(() => expect(pushBW).toHaveBeenCalledWith("2026-01-01", 71.8));
  expect(loadLS(LS_BW_LOG_KEY)).toEqual([
    { date: "2026-01-01", kg: 71.8 }, { date: "2026-01-15", kg: 70 },
  ]);
  act(() => result.current.saveBW(69.8, "2026-01-15"));
  expect(result.current.bodyWeight).toBe(69.8);
  expect(loadLS("ft_bw")).toBe(69.8);
});

test("offline dated entry remains local and dirty for retry", async () => {
  pushBW.mockResolvedValueOnce(false);
  saveLS(LS_BW_LOG_KEY, []);
  const { result } = renderHook(() => useUserSettings({ user: null }));
  act(() => result.current.saveBW(72, "2026-01-01"));
  await waitFor(() => expect(pushBW).toHaveBeenCalledWith("2026-01-01", 72));
  expect(loadLS(LS_BW_LOG_KEY)).toEqual([{ date: "2026-01-01", kg: 72 }]);
  expect(loadLS(LS_BW_DIRTY_KEY)).toContain("2026-01-01");
});

test("invalid weights and dates cannot mutate weight history", () => {
  saveLS(LS_BW_LOG_KEY, []);
  const { result } = renderHook(() => useUserSettings({ user: null }));
  for (const [kg, date] of [[-1, "2026-01-01"], [Infinity, "2026-01-01"], [70, "2026-02-30"], [70, "2999-01-01"]]) {
    act(() => expect(result.current.saveBW(kg, date)).toBe(false));
  }
  expect(loadLS(LS_BW_LOG_KEY)).toEqual([]);
  expect(pushBW).not.toHaveBeenCalled();
});


test("failed un-tombstone keeps the weight dirty without attempting its upload", async () => {
  removeBWTombstones.mockResolvedValueOnce(false);
  const { result } = renderHook(() => useUserSettings({ user: null }));
  await act(async () => result.current.saveBW(68.2, "2026-01-01"));
  expect(removeBWTombstones).toHaveBeenCalledWith(["2026-01-01"]);
  expect(pushBW).not.toHaveBeenCalled();
  expect(loadLS(LS_BW_LOG_KEY)).toEqual([{ date: "2026-01-01", kg: 68.2 }]);
  expect(loadLS(LS_BW_DIRTY_KEY)).toContain("2026-01-01");
});

test("unavailable deletion history defers reconciliation instead of resurrecting a weight", async () => {
  saveLS(LS_BW_LOG_KEY, [{ date: "2026-01-01", kg: 68.2 }]);
  fetchBWTombstoneDates.mockResolvedValueOnce(null);
  const user = { id: "user-1" };
  renderHook(() => useUserSettings({ user }));
  await waitFor(() => expect(fetchBWLog).toHaveBeenCalled());
  expect(fetchBWLog).toHaveBeenCalled();
  expect(pushBW).not.toHaveBeenCalled();
  expect(loadLS(LS_BW_LOG_KEY)).toEqual([{ date: "2026-01-01", kg: 68.2 }]);
});
