import { supabase } from "../supabase.js";
import {
  pushBW, deleteBW, pushBWTombstones, removeBWTombstones,
  fetchBWLog, fetchBWTombstoneDates,
} from "../sync.js";
import {
  __setNsUidForTests, getStorageUserId, setLastUserRaw,
} from "../storage.js";

jest.mock("../supabase.js", () => ({
  supabase: { auth: { getUser: jest.fn() }, from: jest.fn() },
}));

let authenticatedId;
let queries;
let completeQuery;
const date = "2026-09-30";
const operations = [
  ["save", () => pushBW(date, 68.2), false],
  ["delete", () => deleteBW(date), false],
  ["tombstone", () => pushBWTombstones([date]), false],
  ["re-log", () => removeBWTombstones([date]), false],
  ["read weights", () => fetchBWLog(), null],
  ["read deletions", () => fetchBWTombstoneDates(), null],
];

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  __setNsUidForTests("account-a");
  setLastUserRaw("account-a");
  authenticatedId = "account-a";
  queries = [];
  completeQuery = () => ({ data: [{ date, kg: 68.2 }], error: null });
  supabase.auth.getUser.mockImplementation(async () => ({
    data: { user: authenticatedId ? { id: authenticatedId } : null },
  }));
  supabase.from.mockImplementation(table => {
    const query = { table, filters: [] };
    query.upsert = (rows, options) => { Object.assign(query, { action: "upsert", rows, options }); return query; };
    query.delete = () => { query.action = "delete"; return query; };
    query.select = columns => { Object.assign(query, { action: "select", columns }); return query; };
    query.eq = (key, value) => { query.filters.push([key, value]); return query; };
    query.in = (key, values) => { query.filters.push([key, values]); return query; };
    query.order = () => query;
    query.then = (resolve, reject) => Promise.resolve(completeQuery(query)).then(resolve, reject);
    queries.push(query);
    return query;
  });
});
afterEach(() => __setNsUidForTests(null));

test("the data owner stays frozen when the next signed-in account changes", () => {
  setLastUserRaw("account-b");
  expect(getStorageUserId()).toBe("account-a");
});

test.each(operations)("%s refuses another account's authentication", async (_name, run, failure) => {
  authenticatedId = "account-b"; // Even before the auth listener records the switch.
  expect(await run()).toBe(failure);
  expect(supabase.from).not.toHaveBeenCalled();
});

test.each(operations)("%s refuses work after sign-out", async (_name, run, failure) => {
  authenticatedId = null;
  expect(await run()).toBe(failure);
  expect(supabase.from).not.toHaveBeenCalled();
});

test.each(operations)("%s keeps anonymous work local until adoption and reload", async (_name, run, failure) => {
  __setNsUidForTests(null);
  expect(await run()).toBe(failure);
  expect(supabase.from).not.toHaveBeenCalled();
});

test.each(operations)("%s stops when account switching occurs during authentication", async (_name, run, failure) => {
  supabase.auth.getUser.mockImplementationOnce(async () => {
    setLastUserRaw("account-b");
    return { data: { user: { id: "account-a" } } };
  });
  expect(await run()).toBe(failure);
  expect(supabase.from).not.toHaveBeenCalled();
});

test("writes, reads, and deletes explicitly use the local data owner", async () => {
  expect(await pushBW(date, 68.2)).toBe(true);
  expect(queries[0]).toMatchObject({
    table: "body_weights", rows: { user_id: "account-a", date, kg: 68.2 },
    options: { onConflict: "user_id,date" },
  });
  expect(await fetchBWLog()).toEqual([{ date, kg: 68.2 }]);
  expect(await fetchBWTombstoneDates()).toEqual([date]);
  expect(await removeBWTombstones([date])).toBe(true);
  expect(await deleteBW(date)).toBe(true);
  for (const query of queries.filter(q => q.action !== "upsert")) {
    expect(query.filters).toContainEqual(["user_id", "account-a"]);
  }
  expect(queries.find(q => q.table === "bw_tombstones" && q.action === "upsert").rows)
    .toEqual([{ user_id: "account-a", date }]);
  expect(queries.at(-1)).toMatchObject({ table: "body_weights", action: "delete" });
  expect(queries.at(-1).filters).toContainEqual(["date", date]);
});

test.each(operations)("%s does not acknowledge or return data after an in-flight account change", async (_name, run, failure) => {
  completeQuery = () => {
    authenticatedId = "account-b";
    setLastUserRaw("account-b");
    return { data: [{ date, kg: 68.2 }], error: null };
  };
  expect(await run()).toBe(failure);
  expect(queries).toHaveLength(1); // In particular, no delete after a stale tombstone response.
  const owners = queries.flatMap(query => query.action === "upsert"
    ? (Array.isArray(query.rows) ? query.rows : [query.rows]).map(row => row.user_id)
    : query.filters.filter(([key]) => key === "user_id").map(([, value]) => value));
  expect(owners).not.toHaveLength(0);
  expect(owners.every(owner => owner === "account-a")).toBe(true);
});

test("a failed tombstone cannot proceed to deleting a weight", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  completeQuery = () => ({ error: { message: "offline" } });
  expect(await deleteBW(date)).toBe(false);
  expect(queries).toHaveLength(1);
  expect(queries[0]).toMatchObject({ table: "bw_tombstones", action: "upsert" });
  warn.mockRestore();
});

test("a rejected authentication request leaves work pending", async () => {
  supabase.auth.getUser.mockRejectedValueOnce(new Error("offline"));
  expect(await pushBW(date, 68.2)).toBe(false);
  expect(supabase.from).not.toHaveBeenCalled();
});
