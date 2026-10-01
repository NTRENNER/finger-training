import React from 'react';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { BetweenSetRestView, SessionSummaryView } from '../ActiveSessionViews.js';
beforeEach(() => jest.useFakeTimers().setSystemTime(1000000));
afterEach(() => jest.useRealTimers());

test('same-hand rest counts elapsed work and zero waits for explicit readiness', () => {
  const ready = jest.fn();
  render(<BetweenSetRestView startedAtMs={900000} restSeconds={300} hand="R" source="device_release" onReady={ready} />);
  expect(screen.getByText('3:20')).toBeInTheDocument();
  expect(screen.getByText(/Right Hand/)).toBeInTheDocument();
  act(() => jest.advanceTimersByTime(200000));
  expect(screen.getByText('0:00')).toBeInTheDocument();
  expect(ready).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Start set 2' }));
  expect(ready).toHaveBeenCalledTimes(1);
});

test('early readiness and extended rest are voluntary; ending is available', () => {
  const ready = jest.fn(), finish = jest.fn();
  const view = render(<BetweenSetRestView startedAtMs={1000000} onReady={ready} onFinish={finish} />);
  expect(screen.getByText('5:00')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Rest another minute' }));
  expect(screen.getByText('6:00')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Start when ready' }));
  expect(ready).toHaveBeenCalledTimes(1);
  view.unmount();
  render(<BetweenSetRestView startedAtMs={1000000} onReady={ready} onFinish={finish} />);
  fireEvent.click(screen.getByRole('button', { name: 'Finish today' }));
  expect(finish).toHaveBeenCalledTimes(1);
});

test('another minute after a long elapsed rest starts a new minute', () => {
  render(<BetweenSetRestView startedAtMs={400000} onReady={() => {}} />);
  expect(screen.getByText('0:00')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Rest another minute' }));
  expect(screen.getByText('1:00')).toBeInTheDocument();
});

test('unknown release is visibly estimated and zero check blocks starting without auto-start', () => {
  const ready = jest.fn(), zero = jest.fn();
  const tindeq = { connected: true, releaseCheckRequired: true, zeroForNextRep: zero };
  const view = render(<BetweenSetRestView startedAtMs={1000000} source="estimated_transition" tindeq={tindeq} onReady={ready} />);
  expect(screen.getByText(/Rest is estimated/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Start when ready' })).toBeDisabled();
  act(() => jest.advanceTimersByTime(300000));
  fireEvent.click(screen.getByRole('button', { name: /Handle unloaded/ }));
  expect(zero).toHaveBeenCalledTimes(1);
  view.rerender(<BetweenSetRestView startedAtMs={1000000} source="estimated_transition" tindeq={{ ...tindeq, releaseCheckRequired: false }} onReady={ready} />);
  expect(ready).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Start set 2' }));
  expect(ready).toHaveBeenCalledTimes(1);
});

const config = { hand: 'L', grip: 'Micro', targetTime: 30, repsPerSet: 4, volumePlan: { id: 'volume_beta' } };
const rows = set => Array.from({ length: 4 }, (_, i) => ({ id: `${set}-${i}`, hand: 'L',
  set_num: set, rep_num: i + 1, actual_time_s: 10, target_duration: 30, prescribed_load_kg: 20, failure_valid: true }));
test('valid short holds offer only the planned second set', () => {
  const add = jest.fn();
  render(<SessionSummaryView config={config} reps={rows(1)} onAddSet={add} onDone={() => {}} />);
  expect(screen.getByText('Volume Beta: second set planned')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Continue to set 2' }));
  expect(add).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/Add another set/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Finish today' })).toBeInTheDocument();
});
test.each([[rows(1).slice(0, 3)], [rows(1).map((r, i) => i === 1 ? { ...r, failure_valid: false } : r)]])('incomplete or interrupted sets do not offer set two', reps => {
  render(<SessionSummaryView config={config} reps={reps} onAddSet={() => {}} onDone={() => {}} />);
  expect(screen.queryByRole('button', { name: 'Continue to set 2' })).not.toBeInTheDocument();
  expect(screen.queryByText(/Add another set/)).not.toBeInTheDocument();
});
test('the completed second set has no third-set action', () => {
  render(<SessionSummaryView config={config} reps={[...rows(1), ...rows(2)]} currentSet={2} onAddSet={() => {}} onDone={() => {}} />);
  expect(screen.getByText('Volume Beta Complete')).toBeInTheDocument();
  expect(screen.queryByText(/Continue to set|Add another set|Good set/)).not.toBeInTheDocument();
});
