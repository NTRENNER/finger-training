// Regression (Tom's bug, July 2026): the non-Tindeq weight-override box
// must persist across reps. ActiveSessionView unmounts on every rest
// phase, so a locally-held override reset to "" each rep and the next
// rep silently fell back to the prescribed weight. The override is now
// persisted in a module-scoped store keyed by sessionId.
import React from "react";
import { render, fireEvent, screen, cleanup } from "@testing-library/react";
import { ActiveSessionView } from "../ActiveSessionViews.js";

// Keep the render light: the live charts are irrelevant to this test.
jest.mock("../cards/RepCurveChart.jsx", () => ({ RepCurveChart: () => null }));
jest.mock("../cards/RecoveryChart.jsx", () => ({ RecoveryChart: () => null }));
jest.mock("../cards/LiveForceCard.jsx", () => ({
  BigTimer: () => null,
  ForceGauge: () => null,
}));

function fakeTindeq() {
  return {
    connected: false,
    force: 0, avgForce: 0, peak: 0,
    targetKgRef: { current: null },
    setAutoFailCallback: () => {},
    tare: async () => {}, startMeasuring: async () => {},
    stopMeasuring: async () => ({ avgForce: 0, peakForce: 0 }),
  };
}
const baseSession = (sessionId, hand = "L") => ({
  config: { grip: "Micro", hand: hand === "Both" ? "Both" : hand, repsPerSet: 5, targetTime: 45, restTime: 20 },
  currentRep: 0, sessionId, activeHand: hand === "Both" ? "L" : hand,
  refWeights: { L: 20, R: 20 }, sessionReps: [],
});
const props = (session) => ({
  session, onRepDone: () => {}, onAbort: () => {},
  tindeq: fakeTindeq(), autoStart: false, unit: "lbs", history: [],
});

afterEach(cleanup);

test("override persists across a remount within the same session", () => {
  const { unmount } = render(<ActiveSessionView {...props(baseSession("s1"))} />);
  const input = screen.getByPlaceholderText(/Override/i);
  fireEvent.change(input, { target: { value: "20" } });
  expect(input.value).toBe("20");
  unmount(); // mimic the rest-phase unmount between reps

  render(<ActiveSessionView {...props({ ...baseSession("s1"), currentRep: 1 })} />);
  expect(screen.getByPlaceholderText(/Override/i).value).toBe("20"); // persisted
});

test("L and R hold independent overrides within a session", () => {
  const sid = "both-1";
  const both = (activeHand) => ({
    config: { grip: "Micro", hand: "Both", repsPerSet: 5, targetTime: 45, restTime: 20 },
    currentRep: 0, sessionId: sid, activeHand,
    refWeights: { L: 20, R: 20 }, sessionReps: [],
  });

  // Left hand: set an override.
  let view = render(<ActiveSessionView {...props(both("L"))} />);
  fireEvent.change(screen.getByPlaceholderText(/Override/i), { target: { value: "20" } });
  view.unmount();

  // Switch to right hand — starts fresh (no L bleed-through).
  view = render(<ActiveSessionView {...props(both("R"))} />);
  expect(screen.getByPlaceholderText(/Override/i).value).toBe("");
  fireEvent.change(screen.getByPlaceholderText(/Override/i), { target: { value: "25" } });
  view.unmount();

  // Back to left — its own override is intact.
  render(<ActiveSessionView {...props(both("L"))} />);
  expect(screen.getByPlaceholderText(/Override/i).value).toBe("20");
});

test("override clears when a new session starts (different sessionId)", () => {
  render(<ActiveSessionView {...props({ ...baseSession("s2"), currentRep: 0 })} />);
  expect(screen.getByPlaceholderText(/Override/i).value).toBe(""); // fresh session
});
