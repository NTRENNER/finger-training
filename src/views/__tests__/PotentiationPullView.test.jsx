import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { PotentiationPullView } from "../PotentiationPullView.jsx";

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("manual potentiation groups each hand and completes four unsaved pulls", () => {
  const onClose = jest.fn();
  const onPullStart = jest.fn();
  const tindeq = { endRepAndRequireRelease: jest.fn() };
  render(<PotentiationPullView grip="Micro" targetLoadKg={10} repsPerHand={2} restSec={10}
    history={[]} tindeq={tindeq} unit="kg" manualMode swapRequired
    onPullStart={onPullStart} onClose={onClose} completionLabel="Finish warm-up" />);

  expect(screen.getByText("Pull 1 of 4 · 2 per hand")).toBeInTheDocument();
  expect(screen.getByText(/Swap the Tindeq to the/)).toBeInTheDocument();
  for (let pull = 1; pull <= 4; pull += 1) {
    fireEvent.click(screen.getByRole("button", { name: "Start pull" }));
    fireEvent.click(screen.getByRole("button", { name: "Pull complete" }));
    if (pull === 1 || pull === 3) fireEvent.click(screen.getByRole("button", { name: "Skip rest" }));
  }
  expect(onPullStart).toHaveBeenCalledTimes(4);
  expect(screen.getByText("Potentiation Pulls complete")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Finish warm-up" }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("a deliberately brief sensor pull advances despite the generic short-rep label", () => {
  let callbacks;
  const addReps = jest.fn();
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
  render(<PotentiationPullView grip="Crusher" targetLoadKg={30} repsPerHand={1} restSec={10}
    history={[]} tindeq={tindeq} unit="kg" addReps={addReps} onClose={jest.fn()} />);

  expect(targetKgRef.current).toBe(30);
  expect(tindeq.startAutoDetect).toHaveBeenCalledWith(expect.any(Function), expect.any(Function),
    { endOnTargetDrop: false, captureRapidForce: true });
  act(() => callbacks.start());
  act(() => callbacks.end({ actualTime: 0.8, peakForce: 31, failureValid: false, endReason: "interrupted",
    potentiationRfd: { version: 1, valid: true, rfd_200_kg_s: 120, peak_kg: 31 }, forceRecording: {} }));
  expect(screen.queryByRole("timer", { name: "Potentiation rest" })).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Switch to the right hand.');
  act(() => callbacks.start());
  act(() => callbacks.end({ actualTime: 0.7, peakForce: 32, failureValid: false, endReason: "interrupted",
    potentiationRfd: { version: 1, valid: true, rfd_200_kg_s: 125, peak_kg: 32 }, forceRecording: {} }));
  expect(screen.getByText("Potentiation Pulls complete")).toBeInTheDocument();
  expect(addReps).toHaveBeenCalledTimes(2);
  expect(addReps.mock.calls[0][0][0]).toMatchObject({ grip: "Crusher", failure_valid: false,
    force_recording: { capacity_eligible: false, session_protocol: { id: "warmup_potentiation" } } });
});

test('grouped sensor pulls retain short-rest deadlines, retry the same hand, and save the correct hand positions', () => {
  let callbacks;
  const addReps = jest.fn();
  const tindeq = { connected:true,targetKgRef:{current:null},
    startAutoDetect:jest.fn((start,end)=>{callbacks={start,end};}),stopAutoDetect:jest.fn(),endRepAndRequireRelease:jest.fn() };
  const valid = {actualTime:0.8,peakForce:31,forceRecording:{},potentiationRfd:{version:1,valid:true,rfd_200_kg_s:120,peak_kg:31}};
  render(<PotentiationPullView grip="Crusher" targetLoadKg={30} repsPerHand={2} restSec={10}
    tindeq={tindeq} addReps={addReps} onClose={jest.fn()} />);
  act(()=>callbacks.start()); act(()=>callbacks.end(valid));
  act(()=>callbacks.start()); // Early pulls during rest must not consume a slot.
  expect(addReps).toHaveBeenCalledTimes(1);
  expect(tindeq.endRepAndRequireRelease).toHaveBeenCalled();
  act(()=>jest.advanceTimersByTime(9900));
  expect(screen.getByRole('timer',{name:'Potentiation rest'})).toHaveTextContent('1s');
  act(()=>jest.advanceTimersByTime(100));
  act(()=>callbacks.start()); act(()=>callbacks.end({endReason:'equipment_interruption'}));
  expect(addReps).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button',{name:'Retry pull'}));
  act(()=>callbacks.start()); act(()=>callbacks.end(valid));
  expect(screen.queryByRole('timer',{name:'Potentiation rest'})).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Switch to the right hand.');
  act(()=>callbacks.start()); act(()=>callbacks.end(valid));
  act(()=>jest.advanceTimersByTime(10000));
  act(()=>callbacks.start()); act(()=>callbacks.end(valid));
  const rows = addReps.mock.calls.map(call=>call[0][0]);
  expect(rows.map(row=>row.hand)).toEqual(['L','L','R','R']);
  expect(rows.map(row=>row.force_recording.session_protocol.hand_position)).toEqual([1,2,1,2]);
  expect(rows.every(row=>row.force_recording.session_protocol.hand_sequence==='grouped')).toBe(true);
  expect(screen.getByText('Potentiation Pulls complete')).toBeInTheDocument();
});
