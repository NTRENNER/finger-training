import { act, renderHook } from "@testing-library/react";

import {
  ONLINE_SYNC_DEBOUNCE_MS,
  useConnectivity,
} from "../useConnectivity.js";

afterEach(() => {
  jest.useRealTimers();
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: true,
  });
});

test("tracks offline state and emits a sync retry when connectivity returns", () => {
  jest.useFakeTimers();
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
  act(() => {
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("online"));
  });

  expect(result.current.isOnline).toBe(true);
  expect(result.current.syncSignal).toBe(0);

  act(() => jest.advanceTimersByTime(ONLINE_SYNC_DEBOUNCE_MS));
  expect(result.current.syncSignal).toBe(1);
});
