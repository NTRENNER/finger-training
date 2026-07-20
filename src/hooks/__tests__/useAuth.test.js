const mockReadRawLastUser = jest.fn();
const mockSetLastUserRaw = jest.fn();
const mockAdoptAnonDataForUser = jest.fn();

jest.mock("../../lib/storage.js", () => ({
  readRawLastUser: (...args) => mockReadRawLastUser(...args),
  setLastUserRaw: (...args) => mockSetLastUserRaw(...args),
  adoptAnonDataForUser: (...args) => mockAdoptAnonDataForUser(...args),
}));

jest.mock("../../lib/supabase.js", () => ({ supabase: { auth: {} } }));

import { guardUserSwitch } from "../useAuth.js";

beforeEach(() => {
  mockReadRawLastUser.mockReset();
  mockSetLastUserRaw.mockReset();
  mockAdoptAnonDataForUser.mockReset();
});

test("sign-out moves the next page to the anonymous namespace", () => {
  mockReadRawLastUser.mockReturnValue("user-a");
  expect(guardUserSwitch(null)).toBe(true);
  expect(mockSetLastUserRaw).toHaveBeenCalledWith(null);
});

test("an already-anonymous page does not reload-loop", () => {
  mockReadRawLastUser.mockReturnValue(null);
  expect(guardUserSwitch(null)).toBe(false);
  expect(mockSetLastUserRaw).not.toHaveBeenCalled();
});

test("same-user refresh is idempotent", () => {
  mockReadRawLastUser.mockReturnValue("user-a");
  expect(guardUserSwitch({ id: "user-a" })).toBe(false);
  expect(mockSetLastUserRaw).not.toHaveBeenCalled();
});

