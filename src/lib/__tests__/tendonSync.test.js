// Integration tests for the tendon cloud-sync layer. These pin the
// contract the UI relies on: every function returns a boolean/data
// outcome WITHOUT throwing, so the card can honestly confirm "logged"
// vs offer a retry, and the history list can surface a failed delete.
import { pushTendonSession, fetchTendonSessions, deleteTendonSession } from "../tendonSync.js";

// Configurable supabase mock (vars are mock-prefixed so jest allows the
// factory to close over them). Each test sets the knobs below.
let mockUser;            // { id } | null
let mockGetUserThrows;   // boolean
let mockUpsertResult;    // { error }
let mockSelectResult;    // { data, error }
let mockDeleteResult;    // { error }
let mockLastUpsertPayload;

jest.mock("../supabase.js", () => ({
  supabase: {
    auth: {
      getUser: async () => {
        if (mockGetUserThrows) throw new Error("network");
        return { data: { user: mockUser } };
      },
    },
    from: () => ({
      upsert: async (payload) => { mockLastUpsertPayload = payload; return mockUpsertResult; },
      select: () => ({ order: async () => mockSelectResult }),
      delete: () => ({ eq: async () => mockDeleteResult }),
    }),
  },
}));

beforeEach(() => {
  mockUser = { id: "user-1" };
  mockGetUserThrows = false;
  mockUpsertResult = { error: null };
  mockSelectResult = { data: [], error: null };
  mockDeleteResult = { error: null };
  mockLastUpsertPayload = undefined;
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const rec = () => ({
  id: "t1", date: "2026-07-15", preset: "barr",
  sets: 5, total_work_s: 150, work_sec: 30, rest_sec: 45, effort_pct: 40,
});

describe("pushTendonSession", () => {
  test("unauthenticated completion → false, no throw, no write", async () => {
    mockUser = null;
    await expect(pushTendonSession(rec())).resolves.toBe(false);
    expect(mockLastUpsertPayload).toBeUndefined();
  });

  test("Supabase error → false (retryable), no throw", async () => {
    mockUpsertResult = { error: { message: "row level security" } };
    await expect(pushTendonSession(rec())).resolves.toBe(false);
  });

  test("auth call throwing is swallowed → false", async () => {
    mockGetUserThrows = true;
    await expect(pushTendonSession(rec())).resolves.toBe(false);
  });

  test("success → true and persists resolved protocol params", async () => {
    await expect(pushTendonSession(rec())).resolves.toBe(true);
    expect(mockLastUpsertPayload).toMatchObject({
      id: "t1", user_id: "user-1",
      work_sec: 30, rest_sec: 45, effort_pct: 40,
    });
  });
});

describe("deleteTendonSession", () => {
  test("Supabase error → false (surfaced to user)", async () => {
    mockDeleteResult = { error: { message: "conflict" } };
    await expect(deleteTendonSession("t1")).resolves.toBe(false);
  });
  test("success → true", async () => {
    await expect(deleteTendonSession("t1")).resolves.toBe(true);
  });
});

describe("fetchTendonSessions", () => {
  test("error → null (caller keeps prior state)", async () => {
    mockSelectResult = { data: null, error: { message: "boom" } };
    await expect(fetchTendonSessions()).resolves.toBeNull();
  });
  test("success → rows", async () => {
    mockSelectResult = { data: [{ id: "t1" }], error: null };
    await expect(fetchTendonSessions()).resolves.toEqual([{ id: "t1" }]);
  });
});
