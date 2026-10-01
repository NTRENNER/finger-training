import { loadLS, __setNsUidForTests, setLastUserRaw } from "../storage.js";
import {
  enqueueUserSettingsPatch,
  flushUserSettingsPatch,
} from "../sync.js";
import { LS_USER_SETTINGS_PATCH_KEY } from "../storage.js";

const mockGetUser = jest.fn();
const mockRpc = jest.fn();

jest.mock("../supabase.js", () => ({
  supabase: {
    auth: { getUser: (...args) => mockGetUser(...args) },
    rpc: (...args) => mockRpc(...args),
  },
}));

beforeEach(() => {
  localStorage.clear();
  __setNsUidForTests("user-a");
  setLastUserRaw("user-a");
  mockGetUser.mockReset();
  mockRpc.mockReset();
  mockGetUser.mockResolvedValue({ data: { user: { id: "user-a" } } });
});

test("coalesces settings edits by top-level key", () => {
  expect(enqueueUserSettingsPatch({ climbing_focus: "bouldering" })).toBe(true);
  enqueueUserSettingsPatch({
    climbing_focus: "endurance",
    pyramid_project: { indoor: "V9" },
  });

  expect(loadLS(LS_USER_SETTINGS_PATCH_KEY)).toEqual({
    climbing_focus: "endurance",
    pyramid_project: { indoor: "V9" },
  });
});

test('reports failure when a settings patch cannot be persisted', () => {
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  const write = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Quota', 'QuotaExceededError');
  });
  expect(enqueueUserSettingsPatch({ volume_beta_plan_trial: { id: 'trial' } })).toBe(false);
  expect(loadLS(LS_USER_SETTINGS_PATCH_KEY)).toBeNull();
  expect(enqueueUserSettingsPatch(null)).toBe(false);
  write.mockRestore(); error.mockRestore();
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

afterEach(() => __setNsUidForTests(null));
