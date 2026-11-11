import { act, renderHook } from "@testing-library/react";

import {
  FOREGROUND_SYNC_MIN_INTERVAL_MS,
  ONLINE_SYNC_DEBOUNCE_MS,
  useConnectivity,
} from "../useConnectivity.js";
import { saveLS } from "../../lib/storage.js";
import { LS_QUEUE_KEY } from "../../lib/sync.js";

const setVisibility = value => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
  act(() => document.dispatchEvent(new Event("visibilitychange")));
};
const comeBack = () => {
  setVisibility("hidden");
  setVisibility("visible");
  act(() => jest.advanceTimersByTime(ONLINE_SYNC_DEBOUNCE_MS));
};
beforeEach(() => localStorage.clear());

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
  act(() => jest.advanceTimersByTime(FOREGROUND_SYNC_MIN_INTERVAL_MS));
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  act(() => jest.advanceTimersByTime(ONLINE_SYNC_DEBOUNCE_MS));
  expect(result.current.syncSignal).toBe(1);
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  unmount();
  expect(jest.getTimerCount()).toBe(0);
});

// Regression: every return to the app triggered a full sync, which downloads
// the whole rep history (about 1.8 MB) each time.
test("returning to the app repeatedly does not sync each time", () => {
  jest.useFakeTimers();
  const { result } = renderHook(() => useConnectivity());

  comeBack();
  comeBack();
  comeBack();
  expect(result.current.syncSignal).toBe(0);

  act(() => jest.advanceTimersByTime(FOREGROUND_SYNC_MIN_INTERVAL_MS));
  comeBack();
  expect(result.current.syncSignal).toBe(1);
  comeBack();
  expect(result.current.syncSignal).toBe(1);
});

test("returning to the app syncs at once when changes are waiting to upload", () => {
  jest.useFakeTimers();
  const { result } = renderHook(() => useConnectivity());
  saveLS(LS_QUEUE_KEY, [{ id: "rep-1" }]);
  comeBack();
  expect(result.current.syncSignal).toBe(1);
});

test("returning to the app syncs at once after the device was offline", () => {
  jest.useFakeTimers();
  const { result } = renderHook(() => useConnectivity());
  act(() => window.dispatchEvent(new Event("offline")));
  expect(result.current.isOnline).toBe(false);
  comeBack();
  expect(result.current.isOnline).toBe(true);
  expect(result.current.syncSignal).toBe(1);
});

test('pending slot deletions bypass the foreground sync throttle', () => {
  const { LS_REP_SLOT_DELETE_QUEUE_KEY } = require('../../lib/storage.js');
  jest.useFakeTimers();
  const { result } = renderHook(() => useConnectivity());
  saveLS(LS_REP_SLOT_DELETE_QUEUE_KEY, [{ session_id: 's', set_num: 1, rep_num: 1, hand: 'L' }]);
  comeBack();
  expect(result.current.syncSignal).toBe(1);
});
