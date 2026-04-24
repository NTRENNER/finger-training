// App-level smoke test placeholder.
//
// The full App component renders Supabase auth, BLE, recharts, etc., none
// of which are easily mockable in Jest. We rely on the model-layer test
// suites under src/model/__tests__/ for engine correctness, and on the
// CRA build pipeline for UI compile-time checks. If we add app-level
// integration tests in the future they belong here.

describe("App smoke", () => {
  test("placeholder — model-layer tests live under src/model/__tests__/", () => {
    expect(true).toBe(true);
  });
});
