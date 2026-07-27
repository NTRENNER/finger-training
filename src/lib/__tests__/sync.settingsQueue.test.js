const mockGetUser = jest.fn();
const mockRpc = jest.fn();

jest.mock("../supabase.js", () => ({
  supabase: {
    auth: { getUser: (...args) => mockGetUser(...args) },
    rpc: (...args) => mockRpc(...args),
  },
}));

import { loadLS } from "../storage.js";
import {
  enqueueUserSettingsPatch,
  flushUserSettingsPatch,
} from "../sync.js";
import { LS_USER_SETTINGS_PATCH_KEY } from "../storage.js";

beforeEach(() => {
  localStorage.clear();
  mockGetUser.mockReset();
  mockRpc.mockReset();
  mockGetUser.mockResolvedValue({ data: { user: { id: "user-a" } } });
});

test("coalesces settings edits by top-level key", () => {
  enqueueUserSettingsPatch({ climbing_focus: "bouldering" });
  enqueueUserSettingsPatch({
    climbing_focus: "endurance",
    pyramid_project: { indoor: "V9" },
  });

  expect(loadLS(LS_USER_SETTINGS_PATCH_KEY)).toEqual({
    climbing_focus: "endurance",
    pyramid_project: { indoor: "V9" },
  });
});

test("keeps a failed settings patch queued", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  mockRpc.mockResolvedValue({ error: { message: "offline" } });
  enqueueUserSettingsPatch({ climbing_focus: "endurance" });

  await expect(flushUserSettingsPatch()).resolves.toBe(false);
  expect(loadLS(LS_USER_SETTINGS_PATCH_KEY)).toEqual({
    climbing_focus: "endurance",
  });
  warn.mockRestore();
});

test("drains a newer edit queued while a push is in flight", async () => {
  let finishFirstPush;
  mockRpc
    .mockReturnValueOnce(new Promise(resolve => { finishFirstPush = resolve; }))
    .mockResolvedValue({ error: null });

  enqueueUserSettingsPatch({ climbing_focus: "bouldering" });
  const flushing = flushUserSettingsPatch();
  await Promise.resolve();
  await Promise.resolve();

  enqueueUserSettingsPatch({ climbing_focus: "endurance" });
  finishFirstPush({ error: null });

  await expect(flushing).resolves.toBe(true);
  expect(mockRpc).toHaveBeenCalledTimes(2);
  expect(mockRpc).toHaveBeenNthCalledWith(2, "update_user_settings_patch", {
    patch: { climbing_focus: "endurance" },
  });
  expect(loadLS(LS_USER_SETTINGS_PATCH_KEY)).toEqual({});
});
