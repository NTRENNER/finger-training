import React from "react";
import { render, screen } from "@testing-library/react";
import { WorkoutHistoryView } from "../WorkoutHistoryView.jsx";
import { saveLS, LS_WORKOUT_LOG_KEY } from "../../lib/storage.js";

beforeEach(() => localStorage.clear());

test("with no logged workouts it says so and shows no session", () => {
  render(<WorkoutHistoryView unit="lbs" />);
  expect(screen.getByText(/No workout sessions yet/)).toBeInTheDocument();
});

test("a logged workout is listed with its date in the app's date format", () => {
  const year = new Date().getFullYear();
  saveLS(LS_WORKOUT_LOG_KEY, [{
    id: "w1", date: `${year}-11-10`, workout: "A", completedAt: `${year}-11-10T18:00:00Z`,
    exercises: { pull_ups: { sets: [{ reps: "5", weight: "20", done: true }] } },
  }]);
  render(<WorkoutHistoryView unit="lbs" defaultWorkouts={{}} />);
  expect(screen.queryByText(/No workout sessions yet/)).not.toBeInTheDocument();
  expect(screen.getByText(/Nov 10/)).toBeInTheDocument();
});
