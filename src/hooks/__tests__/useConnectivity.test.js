import { act, renderHook } from "@testing-library/react";

import { useConnectivity } from "../useConnectivity.js";

afterEach(() => {
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: true,
  });
});

test("tracks offline state and emits a sync retry when connectivity returns", () => {
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: false,
  });
  const { result } = renderHook(() => useConnectivity());

  expect(result.current.isOnline).toBe(false);
  expect(result.current.syncSignal).toBe(0);

  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: true,
  });
  act(() => window.dispatchEvent(new Event("online")));

  expect(result.current.isOnline).toBe(true);
  expect(result.current.syncSignal).toBe(1);
});
