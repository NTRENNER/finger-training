// Integration tests for the shared tendon store. The crux of the
// false-"logged" bug: a completion must NOT survive in the store if the
// cloud write failed. These assert the optimistic insert is rolled back
// on push failure (so the UI can show an error), kept on success, and
// that a failed delete restores the row.
import { render, act, waitFor } from "@testing-library/react";
import React from "react";
import { useTendon, __resetTendonStore } from "../useTendon.js";

// mock-prefixed so the jest.mock factory may close over them.
let mockPush, mockDelete, mockFetch;
jest.mock("../../lib/tendonSync.js", () => ({
  pushTendonSession:   (...a) => mockPush(...a),
  deleteTendonSession: (...a) => mockDelete(...a),
  fetchTendonSessions: (...a) => mockFetch(...a),
}));

// Render the hook and expose its latest value (single React instance).
function mountStore() {
  const ref = { current: null };
  function Probe() { ref.current = useTendon(); return null; }
  render(<Probe />);
  return ref;
}

beforeEach(() => {
  __resetTendonStore();
  mockPush   = jest.fn(async () => true);
  mockDelete = jest.fn(async () => true);
  mockFetch  = jest.fn(async () => []);   // start empty
});

test("push failure rolls the optimistic session back out of the store", async () => {
  mockPush = jest.fn(async () => false);
  const store = mountStore();
  await waitFor(() => expect(store.current.loaded).toBe(true));

  let res;
  await act(async () => {
    res = await store.current.logSession({ preset: "barr", sets: 5, totalWorkS: 150 });
  });

  expect(res.ok).toBe(false);
  // The failed session must NOT be present — otherwise the UI would
  // have falsely told the user it was logged.
  expect(store.current.sessions.find(s => s.id === res.rec.id)).toBeUndefined();
});

test("push success keeps the session, reports ok, with resolved params", async () => {
  let pushed;
  mockPush = jest.fn(async (r) => { pushed = r; return true; });
  mockFetch = jest.fn(async () => (pushed ? [pushed] : []));   // server echoes it back
  const store = mountStore();
  await waitFor(() => expect(store.current.loaded).toBe(true));

  let res;
  await act(async () => {
    res = await store.current.logSession({
      preset: "barr", sets: 5, totalWorkS: 150,
      workSec: 30, restSec: 45, effortPct: 40,
    });
  });

  expect(res.ok).toBe(true);
  expect(pushed).toMatchObject({ work_sec: 30, rest_sec: 45, effort_pct: 40 });
  await waitFor(() => expect(store.current.sessions.some(s => s.id === res.rec.id)).toBe(true));
});

test("delete failure restores the row and reports not-ok", async () => {
  mockFetch = jest.fn(async () => [{ id: "keep", date: "2026-07-15" }]);
  mockDelete = jest.fn(async () => false);
  const store = mountStore();
  await waitFor(() => expect(store.current.sessions.length).toBe(1));

  let res;
  await act(async () => { res = await store.current.removeSession("keep"); });

  expect(res.ok).toBe(false);
  await waitFor(() => expect(store.current.sessions.some(s => s.id === "keep")).toBe(true));
});
