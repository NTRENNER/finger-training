import { act, renderHook } from "@testing-library/react";
import { useScreenWakeLock } from "../useScreenWakeLock.js";

let sentinels;
let visibility;
beforeEach(() => {
  sentinels = [];
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request: jest.fn(async () => {
    const sentinel = { released: false, release: jest.fn(async () => { sentinel.released = true; }) };
    sentinels.push(sentinel);
    return sentinel;
  }) } });
});
afterEach(() => { delete navigator.wakeLock; delete document.visibilityState; });

const flush = () => act(() => Promise.resolve());

test("holds the screen on only while active", async () => {
  const view = renderHook(({ active }) => useScreenWakeLock(active), { initialProps: { active: false } });
  await flush();
  expect(navigator.wakeLock.request).not.toHaveBeenCalled();
  view.rerender({ active: true });
  await flush();
  expect(navigator.wakeLock.request).toHaveBeenCalledWith("screen");
  view.rerender({ active: false });
  expect(sentinels[0].release).toHaveBeenCalled();
});

test("takes the lock back after the page was hidden", async () => {
  renderHook(() => useScreenWakeLock(true));
  await flush();
  sentinels[0].released = true; // the browser drops it when the page is hidden
  visibility = "hidden";
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(sentinels).toHaveLength(1);
  visibility = "visible";
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(sentinels).toHaveLength(2);
});

test("a refused or unsupported lock is silent", async () => {
  navigator.wakeLock.request.mockRejectedValueOnce(new Error("battery saver"));
  const { unmount } = renderHook(() => useScreenWakeLock(true));
  await flush();
  unmount();
  delete navigator.wakeLock;
  renderHook(() => useScreenWakeLock(true));
  await flush();
});
