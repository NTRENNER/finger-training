// Integration test for timer completion. Drives the guided timer with
// fake timers and asserts onComplete fires exactly once with the right
// totals, and that the completion screen reflects the SAVE outcome —
// never claiming "Session logged" until the parent reports success, and
// offering a retry on failure.
import React from "react";
import { render, screen, act, cleanup } from "@testing-library/react";
import { TendonTimer } from "../TendonTimer.jsx";

// AudioContext isn't in jsdom; beep is guarded, but stub it anyway.
beforeAll(() => { window.AudioContext = undefined; window.webkitAudioContext = undefined; });
afterEach(cleanup);

// Single 1s hang so the whole session completes within one work
// interval (no intermediate rest→work re-render needed to reach done).
const preset = {
  key: "test", name: "Test",
  workSec: 1, restSec: 1, effortPct: 40,
  grips: [{ name: "Half-crimp", sets: 1 }],
};

test("fires onComplete once with totals and reflects the real save outcome", () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-07-15T12:00:00Z"));
  const onComplete = jest.fn();
  const view = render(
    <TendonTimer preset={preset} onComplete={onComplete} saveState="saving" onCancel={() => {}} onRetry={() => {}} />
  );

  act(() => { screen.getByText("▶ Start").click(); });

  // Cross the 1s hold deadline: move the clock forward, then let the
  // 200ms interval tick observe that time has elapsed.
  act(() => {
    jest.setSystemTime(new Date("2026-07-15T12:00:02Z"));
    jest.advanceTimersByTime(400);
  });

  expect(onComplete).toHaveBeenCalledTimes(1);
  expect(onComplete).toHaveBeenCalledWith({ sets: 1, totalWorkS: 1 });

  // While saving it must NOT claim the session is logged.
  expect(screen.queryByText("Session logged")).toBeNull();
  expect(screen.getByText("Saving…")).toBeInTheDocument();

  // Failure → retry offered, still not claimed as logged.
  view.rerender(<TendonTimer preset={preset} onComplete={onComplete} saveState="error" onCancel={() => {}} onRetry={() => {}} />);
  expect(screen.queryByText("Session logged")).toBeNull();
  expect(screen.getByText("↻ Retry")).toBeInTheDocument();

  // Success → now (and only now) it confirms.
  view.rerender(<TendonTimer preset={preset} onComplete={onComplete} saveState="ok" onCancel={() => {}} onRetry={() => {}} />);
  expect(screen.getByText("Session logged")).toBeInTheDocument();

  jest.useRealTimers();
});
