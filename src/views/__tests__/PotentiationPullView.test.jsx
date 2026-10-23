import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { PotentiationPullView } from "../PotentiationPullView.jsx";

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("manual potentiation alternates four unsaved pulls and completes", () => {
  const onClose = jest.fn();
  const onPullStart = jest.fn();
  const tindeq = { endRepAndRequireRelease: jest.fn() };
  render(<PotentiationPullView grip="Micro" targetLoadKg={10} repsPerHand={2} restSec={20}
    history={[]} tindeq={tindeq} unit="kg" manualMode swapRequired
    onPullStart={onPullStart} onClose={onClose} completionLabel="Finish warm-up" />);

  expect(screen.getByText("Pull 1 of 4 · 2 per hand")).toBeInTheDocument();
  expect(screen.getByText(/Swap the Tindeq to the/)).toBeInTheDocument();
  for (let pull = 1; pull <= 4; pull += 1) {
    fireEvent.click(screen.getByRole("button", { name: "Start pull" }));
    fireEvent.click(screen.getByRole("button", { name: "Pull complete" }));
    if (pull < 4) fireEvent.click(screen.getByRole("button", { name: "Skip rest" }));
  }
  expect(onPullStart).toHaveBeenCalledTimes(4);
  expect(screen.getByText("Potentiation Pulls complete")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Finish warm-up" }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("a deliberately brief sensor pull advances despite the generic short-rep label", () => {
  let callbacks;
  const targetKgRef = { current: null };
  const tindeq = {
    connected: true,
    force: 0,
    peak: 0,
    avgForce: 0,
    targetKgRef,
    startAutoDetect: jest.fn((start, end) => { callbacks = { start, end }; }),
    stopAutoDetect: jest.fn(),
    endRepAndRequireRelease: jest.fn(),
  };
  render(<PotentiationPullView grip="Crusher" targetLoadKg={30} repsPerHand={1} restSec={20}
    history={[]} tindeq={tindeq} unit="kg" onClose={jest.fn()} />);

  expect(targetKgRef.current).toBe(30);
  act(() => callbacks.start());
  act(() => callbacks.end({ peakForce: 31, failureValid: false, endReason: "interrupted" }));
  expect(screen.getByRole("timer", { name: "Potentiation rest" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Skip rest" }));
  act(() => callbacks.start());
  act(() => callbacks.end({ peakForce: 32, failureValid: false, endReason: "interrupted" }));
  expect(screen.getByText("Potentiation Pulls complete")).toBeInTheDocument();
});
