// Tests for src/lib/storage.js: the pure helpers (pin key builder,
// legacy-pin migrator) plus the user-namespacing layer — key
// resolution, the legacy bare-key migration, anon-data adoption,
// namespace isolation, quarantine placement, and the repurposed
// clearUserScopedLS. jsdom supplies a real localStorage, so the
// namespace tests assert against raw physical keys directly.
//
// nsUid is frozen at module load in production; the __*ForTests seams
// exported by storage.js let these tests simulate signed-in /
// signed-out page loads within one module instance.

import {
  pyramidPinKey,
  migrateLegacyPyramidPins,
  loadLS,
  saveLS,
  subscribeLS,
  getLSSnapshot,
  readRawLastUser,
  setLastUserRaw,
  adoptAnonDataForUser,
  clearUserScopedLS,
  LS_LAST_USER_KEY,
  __setNsUidForTests,
  __runLegacyMigrationForTests,
} from "../storage.js";

describe("pyramidPinKey", () => {
  test("boulder + indoor + commercial → full composite key", () => {
    expect(pyramidPinKey("boulder", "indoor", "commercial")).toBe("boulder|indoor|commercial");
  });

  test("boulder + indoor + moonboard distinct from commercial", () => {
    expect(pyramidPinKey("boulder", "indoor", "moonboard")).toBe("boulder|indoor|moonboard");
  });

  test("boulder + outdoor forces wall to 'all' (wall doesn't apply outdoors)", () => {
    expect(pyramidPinKey("boulder", "outdoor", "commercial")).toBe("boulder|outdoor|all");
  });

  test("rope discipline forces wall to 'all' (wall doesn't apply to ropes)", () => {
    expect(pyramidPinKey("top_rope", "indoor", "commercial")).toBe("top_rope|indoor|all");
    expect(pyramidPinKey("lead",     "outdoor", "moonboard")).toBe("lead|outdoor|all");
  });

  test("'all venues' boulder keeps the wall slot", () => {
    expect(pyramidPinKey("boulder", "all", "commercial")).toBe("boulder|all|commercial");
  });

  test("falsy inputs fall back to defaults", () => {
    expect(pyramidPinKey()).toBe("boulder|all|all");
    expect(pyramidPinKey("boulder")).toBe("boulder|all|all");
    expect(pyramidPinKey("boulder", "indoor")).toBe("boulder|indoor|all");
  });
});

describe("migrateLegacyPyramidPins", () => {
  test("converts legacy discipline-keyed pins to composite keys", () => {
    const legacy = { boulder: "V6", lead: "5.13a" };
    expect(migrateLegacyPyramidPins(legacy)).toEqual({
      "boulder|all|all": "V6",
      "lead|all|all":    "5.13a",
    });
  });

  test("passes through already-migrated composite keys", () => {
    const current = {
      "boulder|indoor|commercial": "V7",
      "boulder|outdoor|all":       "V6",
    };
    expect(migrateLegacyPyramidPins(current)).toEqual(current);
  });

  test("mixed legacy + composite is normalized", () => {
    const mixed = {
      "boulder":                   "V5", // legacy
      "boulder|indoor|moonboard":  "V4", // already migrated
    };
    expect(migrateLegacyPyramidPins(mixed)).toEqual({
      "boulder|all|all":           "V5",
      "boulder|indoor|moonboard":  "V4",
    });
  });

  test("drops falsy values and bad keys", () => {
    const bad = { boulder: "V6", "": "junk", "lead|all|all": null };
    expect(migrateLegacyPyramidPins(bad)).toEqual({ "boulder|all|all": "V6" });
  });

  test("returns {} for empty / null / non-object", () => {
    expect(migrateLegacyPyramidPins(null)).toEqual({});
    expect(migrateLegacyPyramidPins(undefined)).toEqual({});
    expect(migrateLegacyPyramidPins("string")).toEqual({});
    expect(migrateLegacyPyramidPins({})).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────
// USER NAMESPACING
// ─────────────────────────────────────────────────────────────

describe("user namespacing", () => {
  beforeEach(() => {
    localStorage.clear();
    __setNsUidForTests(null); // default: signed-out page
  });

  describe("key resolution via loadLS/saveLS", () => {
    test("signed out: user-scoped keys read/write BARE physical keys", () => {
      expect(saveLS("ft_v3", [{ id: 1 }])).toBe(true);
      expect(localStorage.getItem("ft_v3")).toBe(JSON.stringify([{ id: 1 }]));
      expect(loadLS("ft_v3")).toEqual([{ id: 1 }]);
      // No stray namespaced copy.
      expect(Object.keys(localStorage).some(k => k.startsWith("u:"))).toBe(false);
    });

    test("signed in: user-scoped keys read/write u:<uid>:<key>", () => {
      __setNsUidForTests("alice");
      expect(saveLS("ft_v3", ["rep"])).toBe(true);
      expect(localStorage.getItem("u:alice:ft_v3")).toBe(JSON.stringify(["rep"]));
      expect(localStorage.getItem("ft_v3")).toBeNull();
      expect(loadLS("ft_v3")).toEqual(["rep"]);
    });

    test("unit_pref is user-scoped despite lacking the ft_ prefix", () => {
      __setNsUidForTests("alice");
      saveLS("unit_pref", "kg");
      expect(localStorage.getItem("u:alice:unit_pref")).toBe(JSON.stringify("kg"));
      expect(localStorage.getItem("unit_pref")).toBeNull();
    });

    test("ft_last_user is device-scoped: bare even when signed in", () => {
      __setNsUidForTests("alice");
      saveLS(LS_LAST_USER_KEY, "alice");
      expect(localStorage.getItem("ft_last_user")).toBe(JSON.stringify("alice"));
      expect(localStorage.getItem("u:alice:ft_last_user")).toBeNull();
    });
  });

  describe("legacy migration (hole (a): pre-guard devices)", () => {
    test("moves bare user-scoped keys into the last-recorded user's namespace", () => {
      localStorage.setItem("ft_last_user", JSON.stringify("alice"));
      localStorage.setItem("ft_v3", "[1,2]");
      localStorage.setItem("ft_bw_log", "[]");
      localStorage.setItem("unit_pref", '"kg"');

      __runLegacyMigrationForTests();

      expect(localStorage.getItem("u:alice:ft_v3")).toBe("[1,2]");
      expect(localStorage.getItem("u:alice:ft_bw_log")).toBe("[]");
      expect(localStorage.getItem("u:alice:unit_pref")).toBe('"kg"');
      // MOVED, not copied — bare originals are gone.
      expect(localStorage.getItem("ft_v3")).toBeNull();
      expect(localStorage.getItem("ft_bw_log")).toBeNull();
      expect(localStorage.getItem("unit_pref")).toBeNull();
      // ft_last_user itself stays bare (device-scoped).
      expect(localStorage.getItem("ft_last_user")).toBe(JSON.stringify("alice"));
    });

    test("quarantine siblings migrate with the user", () => {
      localStorage.setItem("ft_last_user", JSON.stringify("alice"));
      localStorage.setItem("ft_v3__corrupt_1719900000000", "{oops");

      __runLegacyMigrationForTests();

      expect(localStorage.getItem("u:alice:ft_v3__corrupt_1719900000000")).toBe("{oops");
      expect(localStorage.getItem("ft_v3__corrupt_1719900000000")).toBeNull();
    });

    test("conflict: existing namespaced copy wins (newer by construction); bare is dropped", () => {
      localStorage.setItem("ft_last_user", JSON.stringify("alice"));
      localStorage.setItem("u:alice:ft_v3", '["namespaced-newer"]');
      localStorage.setItem("ft_v3", '["bare-stale"]');

      __runLegacyMigrationForTests();

      expect(localStorage.getItem("u:alice:ft_v3")).toBe('["namespaced-newer"]');
      expect(localStorage.getItem("ft_v3")).toBeNull();
    });

    test("no ft_last_user recorded → no migration (bare keys stay anonymous)", () => {
      localStorage.setItem("ft_v3", "[1]");

      __runLegacyMigrationForTests();

      expect(localStorage.getItem("ft_v3")).toBe("[1]");
      expect(Object.keys(localStorage).some(k => k.startsWith("u:"))).toBe(false);
    });
  });

  describe("setLastUserRaw (hole (b): pre-reload write window)", () => {
    test("records the uid, readable by readRawLastUser", () => {
      setLastUserRaw("bob");
      expect(localStorage.getItem("ft_last_user")).toBe(JSON.stringify("bob"));
      expect(readRawLastUser()).toBe("bob");
    });

    test("readRawLastUser tolerates corrupt JSON → null", () => {
      localStorage.setItem("ft_last_user", "not-json{");
      expect(readRawLastUser()).toBeNull();
    });

    test("does NOT redirect the current page's writes to the new user", () => {
      // Page loaded as alice; bob signs in; reload hasn't happened yet.
      __setNsUidForTests("alice");
      setLastUserRaw("bob");

      // An in-flight persistence effect fires: it must still land in
      // ALICE's namespace — this is the structural fix for hole (b).
      saveLS("ft_v3", ["alice-in-memory-data"]);
      expect(localStorage.getItem("u:alice:ft_v3")).toBe(JSON.stringify(["alice-in-memory-data"]));
      expect(localStorage.getItem("u:bob:ft_v3")).toBeNull();
      // Reads too: the page keeps seeing alice's world until reload.
      expect(loadLS("ft_v3")).toEqual(["alice-in-memory-data"]);
    });
  });

  describe("adoptAnonDataForUser (first sign-in)", () => {
    test("moves anonymous (bare) training data into the new user's namespace", () => {
      // Signed-out training session wrote bare keys.
      saveLS("ft_v3", [{ rep: 1 }]);
      saveLS("unit_pref", "lbs");

      adoptAnonDataForUser("alice");

      expect(localStorage.getItem("u:alice:ft_v3")).toBe(JSON.stringify([{ rep: 1 }]));
      expect(localStorage.getItem("u:alice:unit_pref")).toBe(JSON.stringify("lbs"));
      expect(localStorage.getItem("ft_v3")).toBeNull();
      expect(localStorage.getItem("unit_pref")).toBeNull();
    });

    test("existing namespaced copy wins over anon data on conflict", () => {
      localStorage.setItem("u:alice:ft_v3", '["alices-own"]');
      localStorage.setItem("ft_v3", '["anon"]');

      adoptAnonDataForUser("alice");

      expect(localStorage.getItem("u:alice:ft_v3")).toBe('["alices-own"]');
      expect(localStorage.getItem("ft_v3")).toBeNull();
    });
  });

  describe("namespace isolation", () => {
    test("two users on one device never see each other's data", () => {
      __setNsUidForTests("alice");
      saveLS("ft_v3", ["alice-reps"]);
      saveLS("unit_pref", "kg");

      // Simulate the post-switch reload: page now loads as bob.
      __setNsUidForTests("bob");
      expect(loadLS("ft_v3")).toBeNull();
      expect(loadLS("unit_pref")).toBeNull();
      saveLS("ft_v3", ["bob-reps"]);

      // And back: alice's data is untouched — no wipe ever happened.
      __setNsUidForTests("alice");
      expect(loadLS("ft_v3")).toEqual(["alice-reps"]);
      expect(loadLS("unit_pref")).toBe("kg");

      __setNsUidForTests("bob");
      expect(loadLS("ft_v3")).toEqual(["bob-reps"]);
    });
  });

  describe("corrupt-JSON quarantine under namespacing", () => {
    test("quarantine key is a sibling of the RESOLVED key", () => {
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      try {
        __setNsUidForTests("alice");
        localStorage.setItem("u:alice:ft_daily_state", "{definitely not json");

        expect(loadLS("ft_daily_state")).toBeNull();

        // Original removed; raw bytes stashed under a timestamped
        // sibling INSIDE alice's namespace.
        expect(localStorage.getItem("u:alice:ft_daily_state")).toBeNull();
        const qKeys = Object.keys(localStorage)
          .filter(k => /^u:alice:ft_daily_state__corrupt_\d+$/.test(k));
        expect(qKeys).toHaveLength(1);
        expect(localStorage.getItem(qKeys[0])).toBe("{definitely not json");
      } finally {
        errSpy.mockRestore();
      }
    });
  });

  describe("clearUserScopedLS (repurposed: current namespace only)", () => {
    test("signed in: clears only the current user's namespace", () => {
      localStorage.setItem("u:alice:ft_v3", "[1]");
      localStorage.setItem("u:alice:unit_pref", '"kg"');
      localStorage.setItem("u:bob:ft_v3", "[2]");
      localStorage.setItem("ft_v3", "[3]"); // anonymous namespace
      localStorage.setItem("ft_last_user", JSON.stringify("alice"));

      __setNsUidForTests("alice");
      clearUserScopedLS();

      expect(localStorage.getItem("u:alice:ft_v3")).toBeNull();
      expect(localStorage.getItem("u:alice:unit_pref")).toBeNull();
      // Everyone else untouched: bob, anon, and the device-scoped marker.
      expect(localStorage.getItem("u:bob:ft_v3")).toBe("[2]");
      expect(localStorage.getItem("ft_v3")).toBe("[3]");
      expect(localStorage.getItem("ft_last_user")).toBe(JSON.stringify("alice"));
    });

    test("signed out: clears only bare user-scoped keys, keeps ft_last_user + namespaces", () => {
      localStorage.setItem("ft_v3", "[3]");
      localStorage.setItem("unit_pref", '"lbs"');
      localStorage.setItem("u:alice:ft_v3", "[1]");
      localStorage.setItem("ft_last_user", JSON.stringify("alice"));

      clearUserScopedLS(); // nsUid is null

      expect(localStorage.getItem("ft_v3")).toBeNull();
      expect(localStorage.getItem("unit_pref")).toBeNull();
      expect(localStorage.getItem("u:alice:ft_v3")).toBe("[1]");
      expect(localStorage.getItem("ft_last_user")).toBe(JSON.stringify("alice"));
    });
  });
});

// ─────────────────────────────────────────────────────────────
// SUBSCRIPTIONS + SNAPSHOT CACHE (reactive layer)
// ─────────────────────────────────────────────────────────────

describe("LS subscriptions + snapshot cache", () => {
  beforeEach(() => {
    localStorage.clear();
    // Also flushes the snapshot cache + wakes stale subscribers, so
    // each test starts with a cold reactive layer.
    __setNsUidForTests(null);
  });

  describe("subscribeLS / saveLS notification", () => {
    test("saveLS notifies subscribers of THAT key only", () => {
      const onV3 = jest.fn();
      const onBw = jest.fn();
      subscribeLS("ft_v3", onV3);
      subscribeLS("ft_bw_log", onBw);

      saveLS("ft_v3", [{ id: 1 }]);

      expect(onV3).toHaveBeenCalledTimes(1);
      expect(onBw).not.toHaveBeenCalled();
    });

    test("unsubscribe stops notifications", () => {
      const cb = jest.fn();
      const unsub = subscribeLS("ft_v3", cb);
      saveLS("ft_v3", [1]);
      unsub();
      saveLS("ft_v3", [1, 2]);
      expect(cb).toHaveBeenCalledTimes(1);
    });

    test("multiple subscribers on one key all fire; one throwing doesn't starve the rest", () => {
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      try {
        const bad = jest.fn(() => { throw new Error("boom"); });
        const good = jest.fn();
        subscribeLS("ft_v3", bad);
        subscribeLS("ft_v3", good);
        saveLS("ft_v3", [1]);
        expect(bad).toHaveBeenCalledTimes(1);
        expect(good).toHaveBeenCalledTimes(1);
      } finally {
        errSpy.mockRestore();
      }
    });

    test("keys are LOGICAL: same subscription fires whether signed in or out", () => {
      __setNsUidForTests("alice");
      const cb = jest.fn();
      subscribeLS("ft_v3", cb);
      saveLS("ft_v3", ["rep"]); // physically u:alice:ft_v3
      expect(cb).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem("u:alice:ft_v3")).toBe(JSON.stringify(["rep"]));
    });
  });

  describe("getLSSnapshot stability", () => {
    test("returns the same reference across calls until the key is written", () => {
      saveLS("ft_v3", [{ id: 1 }]);
      const a = getLSSnapshot("ft_v3");
      const b = getLSSnapshot("ft_v3");
      expect(a).toBe(b); // referential, not just deep, equality

      saveLS("ft_v3", [{ id: 1 }, { id: 2 }]);
      const c = getLSSnapshot("ft_v3");
      expect(c).not.toBe(a);
      expect(getLSSnapshot("ft_v3")).toBe(c);
    });

    test("saveLS caches the exact value written — snapshot IS the saved object", () => {
      const v = [{ id: 7 }];
      saveLS("ft_v3", v);
      expect(getLSSnapshot("ft_v3")).toBe(v);
    });

    test("absent key snapshots as a stable null", () => {
      expect(getLSSnapshot("ft_v3")).toBeNull();
      expect(getLSSnapshot("ft_v3")).toBeNull();
    });

    test("writes to an unrelated key leave the snapshot reference alone", () => {
      saveLS("ft_v3", [1]);
      const a = getLSSnapshot("ft_v3");
      saveLS("ft_bw_log", [{ date: "2026-07-01", kg: 70 }]);
      expect(getLSSnapshot("ft_v3")).toBe(a);
    });

    test("cache-miss read goes through loadLS (namespace-resolved)", () => {
      __setNsUidForTests("alice");
      localStorage.setItem("u:alice:ft_v3", JSON.stringify(["alice-rep"]));
      expect(getLSSnapshot("ft_v3")).toEqual(["alice-rep"]);
    });

    test("plain loadLS stays uncached: raw external rewrite is visible to loadLS while the snapshot holds", () => {
      saveLS("ft_v3", [1]);
      const snap = getLSSnapshot("ft_v3");
      // Simulate an external raw write that bypasses saveLS (DevTools).
      localStorage.setItem("ft_v3", JSON.stringify([1, 2, 3]));
      expect(loadLS("ft_v3")).toEqual([1, 2, 3]);   // one-off readers see disk
      expect(getLSSnapshot("ft_v3")).toBe(snap);    // snapshot stable until notified
    });
  });

  describe("failed writes", () => {
    test("failed saveLS returns false, does NOT notify, and leaves the snapshot alone", () => {
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      const setSpy = jest.spyOn(Storage.prototype, "setItem");
      try {
        saveLS("ft_v3", [1]);
        const before = getLSSnapshot("ft_v3");
        const cb = jest.fn();
        subscribeLS("ft_v3", cb);

        setSpy.mockImplementation(() => { throw new DOMException("quota", "QuotaExceededError"); });
        expect(saveLS("ft_v3", [1, 2])).toBe(false);

        expect(cb).not.toHaveBeenCalled();
        expect(getLSSnapshot("ft_v3")).toBe(before); // still the persisted value
      } finally {
        setSpy.mockRestore();
        errSpy.mockRestore();
      }
    });
  });

  describe("corrupt-JSON quarantine coherence", () => {
    test("quarantining via loadLS nulls the snapshot and notifies subscribers", () => {
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      try {
        saveLS("ft_daily_state", { "2026-07-01": 3 });
        expect(getLSSnapshot("ft_daily_state")).toEqual({ "2026-07-01": 3 });
        const cb = jest.fn();
        subscribeLS("ft_daily_state", cb);

        // Corrupt the bytes behind the cache's back, then hit the
        // quarantine path with a one-off read.
        localStorage.setItem("ft_daily_state", "{not json");
        expect(loadLS("ft_daily_state")).toBeNull();

        expect(cb).toHaveBeenCalledTimes(1);
        expect(getLSSnapshot("ft_daily_state")).toBeNull();
      } finally {
        errSpy.mockRestore();
      }
    });
  });

  describe("cross-tab 'storage' events", () => {
    const fireStorage = (key, newValue) => {
      window.dispatchEvent(new StorageEvent("storage", {
        key, newValue, storageArea: window.localStorage,
      }));
    };

    test("another tab writing OUR resolved key invalidates the snapshot and notifies", () => {
      __setNsUidForTests("alice");
      saveLS("ft_v3", ["old"]);
      const before = getLSSnapshot("ft_v3");
      const cb = jest.fn();
      subscribeLS("ft_v3", cb);

      // The other tab wrote through its own saveLS: physical key is
      // namespaced. Simulate the raw effect + the event.
      localStorage.setItem("u:alice:ft_v3", JSON.stringify(["new"]));
      fireStorage("u:alice:ft_v3", JSON.stringify(["new"]));

      expect(cb).toHaveBeenCalledTimes(1);
      const after = getLSSnapshot("ft_v3");
      expect(after).not.toBe(before);
      expect(after).toEqual(["new"]);
    });

    test("another user's namespace doesn't leak into ours", () => {
      __setNsUidForTests("alice");
      saveLS("ft_v3", ["alice"]);
      const snap = getLSSnapshot("ft_v3");
      const cb = jest.fn();
      subscribeLS("ft_v3", cb);

      fireStorage("u:bob:ft_v3", JSON.stringify(["bob"]));

      expect(cb).not.toHaveBeenCalled();
      expect(getLSSnapshot("ft_v3")).toBe(snap);
    });

    test("signed out: bare keys map to themselves, u:* keys are ignored", () => {
      const cb = jest.fn();
      subscribeLS("ft_bw_log", cb);

      localStorage.setItem("ft_bw_log", JSON.stringify([{ date: "2026-07-02", kg: 71 }]));
      fireStorage("ft_bw_log", localStorage.getItem("ft_bw_log"));
      expect(cb).toHaveBeenCalledTimes(1);

      fireStorage("u:alice:ft_bw_log", "[]");
      expect(cb).toHaveBeenCalledTimes(1); // unchanged
    });

    test("cross-tab clear() (key === null) flushes everything", () => {
      saveLS("ft_v3", [1]);
      getLSSnapshot("ft_v3");
      const cb = jest.fn();
      subscribeLS("ft_v3", cb);

      localStorage.clear();
      window.dispatchEvent(new StorageEvent("storage", {
        key: null, storageArea: window.localStorage,
      }));

      expect(cb).toHaveBeenCalledTimes(1);
      expect(getLSSnapshot("ft_v3")).toBeNull();
    });
  });

  describe("clearUserScopedLS flushes the reactive layer", () => {
    test("subscribers re-read to null after a namespace wipe", () => {
      saveLS("ft_v3", [1]);
      expect(getLSSnapshot("ft_v3")).toEqual([1]);
      const cb = jest.fn();
      subscribeLS("ft_v3", cb);

      clearUserScopedLS();

      expect(cb).toHaveBeenCalledTimes(1);
      expect(getLSSnapshot("ft_v3")).toBeNull();
    });
  });
});
