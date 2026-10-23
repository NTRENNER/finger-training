import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { AutoRepSessionView, ActiveSessionView } from '../ActiveSessionViews.jsx';
import { ForceGauge } from '../cards/LiveForceCard.jsx';

jest.mock('../cards/RepCurveChart.jsx', () => ({ RepCurveChart: () => null }));
jest.mock('../cards/RecoveryChart.jsx', () => ({ RecoveryChart: () => null }));

const config = { grip: 'Micro', hand: 'L', repsPerSet: 4, targetTime: 40, restTime: 20 };
const session = { config, currentRep: 0, sessionId: 'targets', activeHand: 'L', refWeights: { L: 20 }, sessionReps: [] };

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('the force card pairs target time with target weight, and shows neither when absent', () => {
  const view = render(<ForceGauge force={18} avg={17} peak={20} targetKg={20} unit="kg" targetTime="40s" />);
  expect(screen.getByText('Target time')).toBeInTheDocument();
  expect(screen.getByText('40s')).toBeInTheDocument();
  expect(screen.getByText('Target weight')).toBeInTheDocument();
  view.unmount();
  render(<ForceGauge force={30} avg={28} peak={31} targetKg={null} unit="kg" emphasizePeak />);
  expect(screen.queryByText('Target time')).not.toBeInTheDocument();
  expect(screen.queryByText('Target weight')).not.toBeInTheDocument();
});

test('sensor reps show target time beside target weight, and keep both through a signal drop', () => {
  let start;
  const tindeq = { targetKgRef: {}, startAutoDetect: a => { start = a; }, stopAutoDetect: jest.fn(),
    connected: true, force: 18, avgForce: 17.5, peak: 20 };
  const view = render(<AutoRepSessionView session={session} onRepDone={jest.fn()} onAbort={jest.fn()} tindeq={tindeq} unit="kg" />);
  act(() => start());
  expect(screen.getByText('Target time')).toBeInTheDocument();
  expect(screen.getByText('40s')).toBeInTheDocument();
  expect(screen.getByText('Target weight')).toBeInTheDocument();
  expect(screen.getByText('Average weight')).toBeInTheDocument();
  view.rerender(<AutoRepSessionView session={session} onRepDone={jest.fn()} onAbort={jest.fn()}
    tindeq={{ ...tindeq, connected: false, reconnecting: true }} unit="kg" />);
  expect(screen.getByText('Target time')).toBeInTheDocument();
  expect(screen.getByText('Target weight')).toBeInTheDocument();
  expect(screen.queryByText('Average weight')).not.toBeInTheDocument();
});

test('manual reps show the target time in the target row instead of a small line under the clock', () => {
  const tindeq = { connected: false, targetKgRef: {}, setAutoFailCallback: jest.fn() };
  render(<ActiveSessionView session={session} onRepDone={jest.fn()} onAbort={jest.fn()} tindeq={tindeq} unit="kg" />);
  fireEvent.click(screen.getByRole('button', { name: /Start Rep/ }));
  for (let i = 0; i < 4; i++) act(() => jest.advanceTimersByTime(1000));
  expect(screen.getByText('Target time')).toBeInTheDocument();
  expect(screen.getByText('40s')).toBeInTheDocument();
  expect(screen.queryByText(/^target:/)).not.toBeInTheDocument();
});
