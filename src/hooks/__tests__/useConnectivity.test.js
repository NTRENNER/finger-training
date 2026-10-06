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

test('refreshes on return to the app and cancels the retry when unmounted', () => {
  jest.useFakeTimers();
  const { result, unmount } = renderHook(() => useConnectivity());
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  act(() => jest.advanceTimersByTime(ONLINE_SYNC_DEBOUNCE_MS));
  expect(result.current.syncSignal).toBe(0);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  act(() => jest.advanceTimersByTime(ONLINE_SYNC_DEBOUNCE_MS));
  expect(result.current.syncSignal).toBe(1);
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  unmount();
  expect(jest.getTimerCount()).toBe(0);
});
