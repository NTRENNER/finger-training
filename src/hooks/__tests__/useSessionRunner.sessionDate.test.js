// Regression (Nathan's 2026-07-12 Crusher session, July 2026): a session
// that crosses local midnight must keep every rep on the day it STARTED.
// Reps used to be stamped with today() at each completion, so a late-night
// session split across two History days when the clock rolled over.
import { renderHook, act } from "@testing-library/react";
import * as util from "../../util.js";
import { useSessionRunner } from "../useSessionRunner.js";

function setup() {
  const addReps = jest.fn();
  const hook = renderHook(() => useSessionRunner({
    history: [], freshMap: null, threeExpPriors: null,
    addReps, fatigueModel: null, tindeqConnected: false,
    onSessionStart: () => {},
  }));
  return { hook, addReps };
}
const cfg = { grip: "Crusher", targetTime: 90, repsPerSet: 5, restTime: 20, hand: "L" };

afterEach(() => jest.restoreAllMocks());

test("all reps keep the session's start date even when the clock rolls to the next day", () => {
  // today() returns the start day when the session begins, then the NEXT
  // day for the reps completed after midnight.
  const todaySpy = jest.spyOn(util, "today");
  todaySpy.mockReturnValue("2026-07-12"); // start-of-session value

  const { hook, addReps } = setup();
  act(() => hook.result.current.startSession(cfg));

  // Clock rolls past midnight before the reps land.
  todaySpy.mockReturnValue("2026-07-13");

  for (let i = 0; i < 3; i++) {
    act(() => hook.result.current.handleRepDone({
      actualTime: 30, avgForce: 31, peakForce: 33, failed: false,
    }));
    // Advance past the rest phase so the duplicate-rep lock re-arms for
    // the next rep (mirrors the real rep -> rest -> rep flow).
    act(() => hook.result.current.handleRestDone());
  }

  const dates = addReps.mock.calls.map(c => c[0][0].date);
  expect(dates).toEqual(["2026-07-12", "2026-07-12", "2026-07-12"]);
});
