import { renderHook } from "@testing-library/react";
import { useLeaveWarning } from "../useLeaveWarning.js";

const leave = () => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

test("asks before leaving only while a session is running", () => {
  const { rerender, unmount } = renderHook(({ active }) => useLeaveWarning(active), {
    initialProps: { active: false },
  });
  expect(leave()).toBe(false);
  rerender({ active: true });
  expect(leave()).toBe(true);
  rerender({ active: false });
  expect(leave()).toBe(false);
  rerender({ active: true });
  unmount();
  expect(leave()).toBe(false);
});
