// Tests for the rep-edit update queue (sync.js) and the localStorage
// quarantine path (storage.js) — both added June 2026 after the audit
// found (a) offline/failed edits being silently reverted by the next
// reconcile, and (b) corrupt LS blobs being overwritten with [] on
// first render.

import {
  enqueueRepUpdate, applyPendingUpdates, LS_UPDATE_QUEUE_KEY,
} from "../sync.js";
import { loadLS, saveLS } from "../storage.js";

beforeEach(() => localStorage.clear());

describe("enqueueRepUpdate + applyPendingUpdates", () => {
  const reps = [
    { id: "r1", session_id: "s1", date: "2026-06-01", actual_time_s: 30, avg_force_kg: 20 },
    { id: "r2", session_id: "s1", date: "2026-06-01", actual_time_s: 25, avg_force_kg: 19 },
    { id: "r3", session_id: "s2", date: "2026-06-02", actual_time_s: 40, avg_force_kg: 15 },
  ];

  test("no queue → reps pass through untouched (same reference)", () => {
    expect(applyPendingUpdates(reps)).toBe(reps);
  });

  test("rep-level patch applies to the matching id only", () => {
    enqueueRepUpdate({ kind: "rep", id: "r2", updates: { actual_time_s: 27.5 } });
    const out = applyPendingUpdates(reps);
    expect(out.find(r => r.id === "r2").actual_time_s).toBe(27.5);
    expect(out.find(r => r.id === "r1").actual_time_s).toBe(30);
    expect(out.find(r => r.id === "r3").actual_time_s).toBe(40);
  });

  test("session-level patch applies to every rep in the session", () => {
    enqueueRepUpdate({ kind: "session", sessionKey: "s1", updates: { grip: "Crusher" } });
    const out = applyPendingUpdates(reps);
    expect(out.filter(r => r.grip === "Crusher").map(r => r.id)).toEqual(["r1", "r2"]);
    expect(out.find(r => r.id === "r3").grip).toBeUndefined();
  });

  test("rep patch wins over session patch for the same field", () => {
    enqueueRepUpdate({ kind: "session", sessionKey: "s1", updates: { grip: "Crusher" } });
    enqueueRepUpdate({ kind: "rep", id: "r1", updates: { grip: "Micro" } });
    const out = applyPendingUpdates(reps);
    expect(out.find(r => r.id === "r1").grip).toBe("Micro");
    expect(out.find(r => r.id === "r2").grip).toBe("Crusher");
  });

  test("same-target edits merge key-by-key (later wins), one queue entry", () => {
    enqueueRepUpdate({ kind: "rep", id: "r1", updates: { actual_time_s: 31, avg_force_kg: 21 } });
    enqueueRepUpdate({ kind: "rep", id: "r1", updates: { actual_time_s: 32 } });
    const q = loadLS(LS_UPDATE_QUEUE_KEY);
    expect(q).toHaveLength(1);
    expect(q[0].updates).toEqual({ actual_time_s: 32, avg_force_kg: 21 });
  });

  test("entries without a target are ignored", () => {
    enqueueRepUpdate({ kind: "rep", updates: { actual_time_s: 1 } });
    enqueueRepUpdate({ kind: "session", updates: { grip: "x" } });
    enqueueRepUpdate(null);
    expect(loadLS(LS_UPDATE_QUEUE_KEY)).toBeNull();
  });
});

describe("loadLS corrupt-blob quarantine", () => {
  test("corrupt JSON is stashed under a sibling key, original removed", () => {
    localStorage.setItem("ft_test_blob", "{not json!!");
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    expect(loadLS("ft_test_blob")).toBeNull();
    errSpy.mockRestore();
    // Original removed so we don't re-quarantine on every read…
    expect(localStorage.getItem("ft_test_blob")).toBeNull();
    // …and the raw bytes survive under a timestamped quarantine key.
    const qKey = Object.keys(localStorage).find(k => k.startsWith("ft_test_blob__corrupt_"));
    expect(qKey).toBeDefined();
    expect(localStorage.getItem(qKey)).toBe("{not json!!");
  });

  test("valid JSON and missing keys behave as before", () => {
    expect(loadLS("ft_missing")).toBeNull();
    saveLS("ft_ok", { a: 1 });
    expect(loadLS("ft_ok")).toEqual({ a: 1 });
  });

  test("saveLS reports success", () => {
    expect(saveLS("ft_x", [1, 2, 3])).toBe(true);
  });

  // Guards the "blank screen" regression: saveLS returns a boolean, so
  // a concise-arrow effect `useEffect(() => saveLS(...), deps)` would
  // hand that boolean to React as the effect's cleanup. On the next
  // run React calls it — `true()` throws "is not a function" and
  // unmounts the whole app (blank screen on the first history change
  // after a cloud pull). This asserts the return is a non-callable
  // primitive so reviewers remember to use a block body, never a
  // concise arrow, when an effect calls saveLS.
  test("saveLS return value is not callable (must not be an effect cleanup)", () => {
    const r = saveLS("ft_y", { ok: 1 });
    expect(typeof r).toBe("boolean");
    expect(typeof r).not.toBe("function");
  });
});
