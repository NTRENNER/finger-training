import { renderHook, waitFor } from "@testing-library/react";

import { useUserSettings } from "../useUserSettings.js";
import {
  LS_PINNED_GRIP_BASELINES_KEY,
  LS_USER_SETTINGS_PATCH_KEY,
  loadLS,
  saveLS,
} from "../../lib/storage.js";
import {
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
  }),
  flushUserSettingsPatch: jest.fn(),
}));

beforeEach(() => {
  localStorage.clear();
  jest.clearAllMocks();
  fetchBWLog.mockResolvedValue([]);
  fetchBWTombstoneDates.mockResolvedValue([]);
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
