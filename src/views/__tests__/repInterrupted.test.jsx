import React from 'react';
import { act, render, fireEvent, screen } from '@testing-library/react';
import { AutoRepSessionView, ActiveSessionView, RestView, SessionSummaryView } from '../ActiveSessionViews.js';
jest.mock('../cards/RepCurveChart.jsx', () => ({ RepCurveChart: () => null }));
jest.mock('../cards/RecoveryChart.jsx', () => ({ RecoveryChart: () => null }));
jest.mock('../cards/LiveForceCard.jsx', () => ({ BigTimer: () => null, ForceGauge: () => null }));
const config = { grip: 'Micro', hand: 'L', repsPerSet: 4, targetTime: 40, restTime: 20 };
const session = { config, currentRep: 0, sessionId: 'interruption', activeHand: 'L', refWeights: {L: 20}, sessionReps: [] };
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());
test('one interrupt action saves the auto rep once with explicit invalidity', () => {
  let start, end;
  const onRepDone = jest.fn();
  const tindeq = { targetKgRef: {}, startAutoDetect: (a, b) => { start = a; end = b; }, stopAutoDetect: jest.fn(),
    endRepAndRequireRelease: () => ({actualTime: 12, avgForce: 18, peakForce: 22}), connected: true };
  render(<AutoRepSessionView session={session} onRepDone={onRepDone} onAbort={() => {}} tindeq={tindeq} />);
  expect(screen.getByText(/Target time guides/)).toBeInTheDocument();
  act(() => start());
  fireEvent.click(screen.getByRole('button', {name: 'Rep interrupted'}));
  expect(onRepDone).toHaveBeenCalledWith(expect.objectContaining({actualTime: 12, avgForce: 18, failureValid: false, endReason: 'interrupted'}));
  act(() => end({actualTime: 12, avgForce: 18}));
  expect(onRepDone).toHaveBeenCalledTimes(1);
});
test('manual interruption does not reuse stale sensor averages', () => {
  const onRepDone = jest.fn();
  const tindeq = { connected: false, avgForce: 99, peak: 100, targetKgRef: {}, setAutoFailCallback: jest.fn() };
  render(<ActiveSessionView session={session} onRepDone={onRepDone} onAbort={() => {}} tindeq={tindeq} />);
  fireEvent.click(screen.getByRole('button', {name: /Start Rep/}));
  for (let i = 0; i < 4; i++) act(() => jest.advanceTimersByTime(1000));
  fireEvent.click(screen.getByRole('button', {name: 'Rep interrupted'}));
  expect(onRepDone).toHaveBeenCalledWith(expect.objectContaining({avgForce: null, peakForce: null, failureValid: false}));
});
test('rest explains force, time, and validity', () => {
  render(<RestView lastRep={{actualTime: 30, avgForce: 17.5, failureValid: false, targetTime: 40}} restSeconds={20} repNum={1} repsPerSet={4} unit="kg" onRestDone={() => {}} />);
  expect(screen.getByText(/17.5 kg time-weighted average over 30.0s/)).toBeInTheDocument();
  expect(screen.getByText(/activity saved; excluded from failure learning/)).toBeInTheDocument();
});
test('final rep retains its interruption status in session summary', () => {
  render(<SessionSummaryView config={config} reps={[{rep_num: 1, set_num: 1, actual_time_s: 12, avg_force_kg: 18, failure_valid: false}]} onDone={() => {}} />);
  expect(screen.getByText(/Interrupted · excluded from failure learning/)).toBeInTheDocument();
});
