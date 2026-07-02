// Tests for src/hooks/useLSValue.js — the React face of storage.js's
// reactive layer. The layer's own semantics (notify rules, snapshot
// stability, failed-write behavior, cross-tab events) are covered in
// src/lib/__tests__/storage.test.js; these tests pin the React
// integration: a mounted hook re-renders on saveLS, ignores writes to
// unrelated keys, serves referentially stable snapshots, and follows
// a key prop change.

import { renderHook, act } from "@testing-library/react";
import { useLSValue } from "../useLSValue.js";
import { saveLS, __setNsUidForTests } from "../../lib/storage.js";

beforeEach(() => {
  localStorage.clear();
  // Flushes the snapshot cache + subscriber sets so each test mounts
  // against a cold reactive layer (signed-out namespace).
  __setNsUidForTests(null);
});

describe("useLSValue", () => {
  test("returns null for an absent key", () => {
    const { result } = renderHook(() => useLSValue("ft_v3"));
    expect(result.current).toBeNull();
  });

  test("returns the current parsed value at mount", () => {
    saveLS("ft_v3", [{ id: 1 }]);
    const { result } = renderHook(() => useLSValue("ft_v3"));
    expect(result.current).toEqual([{ id: 1 }]);
  });

  test("re-renders with the new value when saveLS writes the key", () => {
    saveLS("ft_bw_log", [{ date: "2026-07-01", kg: 70 }]);
    const { result } = renderHook(() => useLSValue("ft_bw_log"));
    expect(result.current).toHaveLength(1);

    const next = [...result.current, { date: "2026-07-02", kg: 71 }];
    act(() => { saveLS("ft_bw_log", next); });

    expect(result.current).toBe(next); // the saved object IS the snapshot
  });

  test("does NOT re-render when an unrelated key is written, and the snapshot stays referentially stable", () => {
    saveLS("ft_v3", [1, 2]);
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useLSValue("ft_v3");
    });
    const mountRenders = renders;
    const snap = result.current;

    act(() => { saveLS("ft_bw_log", [{ date: "2026-07-02", kg: 71 }]); });
    act(() => { saveLS("ft_workout_log", [{ id: "w1" }]); });

    expect(renders).toBe(mountRenders);  // never woke up
    expect(result.current).toBe(snap);   // same reference, not a re-parse
  });

  test("unmount unsubscribes — later writes don't touch the dead hook", () => {
    let renders = 0;
    const { unmount } = renderHook(() => {
      renders += 1;
      return useLSValue("ft_v3");
    });
    const before = renders;
    unmount();
    act(() => { saveLS("ft_v3", [1]); });
    expect(renders).toBe(before);
  });

  test("follows a key prop change and resubscribes to the new key", () => {
    saveLS("ft_a_key", "A");
    saveLS("ft_b_key", "B");
    const { result, rerender } = renderHook(({ k }) => useLSValue(k), {
      initialProps: { k: "ft_a_key" },
    });
    expect(result.current).toBe("A");

    rerender({ k: "ft_b_key" });
    expect(result.current).toBe("B");

    // Old key's writes are no longer this hook's business…
    act(() => { saveLS("ft_a_key", "A2"); });
    expect(result.current).toBe("B");
    // …but the new key's are.
    act(() => { saveLS("ft_b_key", "B2"); });
    expect(result.current).toBe("B2");
  });

  test("two components subscribed to one key share the same snapshot reference", () => {
    saveLS("ft_v3", [{ id: 1 }]);
    const h1 = renderHook(() => useLSValue("ft_v3"));
    const h2 = renderHook(() => useLSValue("ft_v3"));
    expect(h1.result.current).toBe(h2.result.current);

    act(() => { saveLS("ft_v3", [{ id: 1 }, { id: 2 }]); });
    expect(h1.result.current).toBe(h2.result.current);
    expect(h1.result.current).toHaveLength(2);
  });
});
