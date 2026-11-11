import React from 'react';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { AutoRepSessionView, ActiveSessionView } from '../ActiveSessionViews.jsx';
import { PeakTestView } from '../PeakTestView.jsx';

let mockScreenError = false;
jest.mock('../cards/LiveForceCard.jsx', () => ({
  BigTimer: ({ seconds }) => <span>{seconds}s elapsed</span>,
  ForceGauge: () => { if (mockScreenError) throw new Error('transient gauge error'); return null; },
}));
jest.mock('../cards/RepCurveChart.jsx', () => ({ RepCurveChart: () => null }));
jest.mock('../cards/RecoveryChart.jsx', () => ({ RecoveryChart: () => null }));
const session = { config: { grip: 'Micro', hand: 'L', repsPerSet: 4, targetTime: 40, restTime: 20 },
  currentRep: 0, activeHand: 'L', refWeights: { L: 20 }, sessionReps: [], sessionId: 'recovery' };
beforeEach(() => { mockScreenError = false; jest.useFakeTimers(); jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { jest.useRealTimers(); console.error.mockRestore(); });

function device() {
  const callbacks = {};
  const tindeq = { connected: true, targetKgRef: {}, force: 20, avgForce: 20, peak: 25,
    startAutoDetect: jest.fn((start, end) => { callbacks.start = start; callbacks.end = end; }),
    stopAutoDetect: jest.fn(), endRepAndRequireRelease: jest.fn(), setAutoFailCallback: jest.fn() };
  return { tindeq, callbacks };
}
const result = { actualTime: 12, avgForce: 23, peakForce: 25, failureValid: true };

test('redrawing an active automatic pull preserves its clock, target and single completion', () => {
  const { tindeq, callbacks } = device();
  const onRepDone = jest.fn();
  const draw = () => <AutoRepSessionView session={session} tindeq={tindeq} onRepDone={onRepDone} onAbort={() => {}} unit="kg" />;
  const view = render(draw());
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '23' } });
  act(() => callbacks.start());
  act(() => jest.advanceTimersByTime(10000));
  mockScreenError = true;
  view.rerender(draw());
  expect(screen.getByRole('alert')).toBeInTheDocument();
  expect(tindeq.stopAutoDetect).not.toHaveBeenCalled();
  mockScreenError = false;
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(screen.getByText('10.0s')).toBeInTheDocument();
  expect(tindeq.targetKgRef.current).toBe(23);
  expect(tindeq.startAutoDetect).toHaveBeenCalledTimes(1);
  act(() => { callbacks.end(result); callbacks.end(result); });
  expect(onRepDone).toHaveBeenCalledTimes(1);
  expect(onRepDone.mock.calls[0][0]).toMatchObject({ manualLoadKg: 23, actualTime: 12 });
});

test('a sensor completion during the error screen still saves exactly once', () => {
  const { tindeq, callbacks } = device();
  const onRepDone = jest.fn();
  const draw = () => <AutoRepSessionView session={session} tindeq={tindeq} onRepDone={onRepDone} onAbort={() => {}} />;
  const view = render(draw());
  act(() => callbacks.start());
  mockScreenError = true; view.rerender(draw());
  act(() => { callbacks.end(result); callbacks.end(result); });
  expect(onRepDone).toHaveBeenCalledTimes(1);
});

test('manual pull timing survives a screen error', () => {
  const { tindeq } = device(); tindeq.connected = false;
  const draw = () => <ActiveSessionView session={session} tindeq={tindeq} onRepDone={() => {}} onAbort={() => {}} />;
  const view = render(draw());
  fireEvent.click(screen.getByRole('button', { name: /Start Rep/ }));
  for (let i = 0; i < 4; i++) act(() => jest.advanceTimersByTime(1000));
  act(() => jest.advanceTimersByTime(10000));
  mockScreenError = true; view.rerender(draw());
  act(() => jest.advanceTimersByTime(2000));
  mockScreenError = false;
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(screen.getByText('13s elapsed')).toBeInTheDocument();
});

test('Peak Test redraw keeps the next hand, saved rows, rest and session UUID', () => {
  const { tindeq, callbacks } = device();
  const addReps = jest.fn();
  const draw = () => <PeakTestView grip="Micro" hand="Both" history={[]} tindeq={tindeq} addReps={addReps} onClose={() => {}} />;
  const view = render(draw());
  const pull = () => { act(() => callbacks.start()); act(() => jest.advanceTimersByTime(3000)); act(() => callbacks.end(result)); };
  pull();
  const left = addReps.mock.calls[0][0][0];
  mockScreenError = true; view.rerender(draw());
  mockScreenError = false; fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(screen.getByText('✋ Right Hand')).toBeInTheDocument();
  pull();
  const right = addReps.mock.calls[1][0][0];
  expect(right).toMatchObject({ hand: 'R', rep_num: 1, session_id: left.session_id });
  expect(screen.getByRole('timer', { name: 'Rest' })).toBeInTheDocument();
  expect(tindeq.startAutoDetect).toHaveBeenCalledTimes(1);
  expect(tindeq.stopAutoDetect).not.toHaveBeenCalled();
});
