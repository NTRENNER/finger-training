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
const baseSession = (sessionId) => ({
  config: { grip: "Micro", hand: "L", repsPerSet: 5, targetTime: 45, restTime: 20 },
  currentRep: 0, sessionId, activeHand: "L",
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

test("override clears when a new session starts (different sessionId)", () => {
  render(<ActiveSessionView {...props({ ...baseSession("s2"), currentRep: 0 })} />);
  expect(screen.getByPlaceholderText(/Override/i).value).toBe(""); // fresh session
});
