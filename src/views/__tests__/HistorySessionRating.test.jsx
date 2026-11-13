import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { HistoryView } from "../HistoryView.jsx";

jest.mock("../../lib/sync.js", () => ({ deleteBW: jest.fn() }));
// Session charts use ResizeObserver, which jsdom doesn't ship.
beforeAll(() => {
  global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});
afterAll(() => { delete global.ResizeObserver; });

// Replays 2026-11-12: a warm-up Peak Test while fresh (0/10), then a Micro
// session after climbing (9/10). Rating a session used to write the day
// rating, which every session that day showed, so both read the same value.
const peak = hand => ({
  id: `peak-${hand}`, date: "2026-11-12", grip: "Micro", hand, session_id: "warmup-peak",
  set_num: 1, rep_num: 1, target_duration: 5, actual_time_s: 3, peak_force_kg: 30, avg_force_kg: 28,
  session_cooked: null, force_recording: { session_protocol: { id: "peak_test", version: 2 } },
});
const micro = hand => ({
  id: `micro-${hand}`, date: "2026-11-12", grip: "Micro", hand, session_id: "micro-after-climb",
  set_num: 1, rep_num: 1, target_duration: 160, actual_time_s: 150, avg_force_kg: 16, weight_kg: 16,
  session_cooked: null, session_adjustment: { version: 1, reported_cooked: null, load_choice: "keep", applied_multiplier: 1 },
});
const reps = [peak("L"), peak("R"), micro("L"), micro("R")];
const values = () => screen.getAllByRole("slider", { name: "Session fatigue rating" }).map(s => s.value).sort();

test("rating one session leaves the other session that day unchanged", () => {
  const onSaveSessionCooked = jest.fn();
  const { rerender } = render(<HistoryView history={reps} cookedOnDate={() => 0} onSaveSessionCooked={onSaveSessionCooked} />);
  expect(values()).toEqual(["0", "0"]);

  const [slider] = screen.getAllByRole("slider", { name: "Session fatigue rating" });
  fireEvent.change(slider, { target: { value: "9" } });
  fireEvent.mouseUp(slider);
  expect(onSaveSessionCooked).toHaveBeenCalledTimes(1);
  const [rated, cooked] = onSaveSessionCooked.mock.calls[0];
  expect(["warmup-peak", "micro-after-climb"]).toContain(rated);
  expect(cooked).toBe(9);

  // The rating is stored on that session's reps only; the other keeps 0.
  rerender(<HistoryView history={reps.map(r => r.session_id === rated ? { ...r, session_cooked: 9 } : r)}
    cookedOnDate={() => 0} onSaveSessionCooked={onSaveSessionCooked} />);
  expect(values()).toEqual(["0", "9"]);
});
