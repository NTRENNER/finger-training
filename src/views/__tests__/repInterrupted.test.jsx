import React from 'react';
import { act, render, fireEvent, screen } from '@testing-library/react';
import { AutoRepSessionView, ActiveSessionView, RestView, SessionSummaryView } from '../ActiveSessionViews.jsx';
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

test('beta sensor flow arms each domain load and does not finish at the reference time', () => {
  let start;
  const onRepDone = jest.fn();
  const tindeq = { targetKgRef: {}, startAutoDetect: a => { start = a; },
    stopAutoDetect: jest.fn(), connected: true, force: 25, avgForce: 25, peak: 26 };
  const beta = { ...session, config: { ...config, goal: 'power', targetTime: 30,
    mixedDomainPlan: { id: 'whole_curve_beta' } } };
  const view = render(<AutoRepSessionView session={beta} onRepDone={onRepDone} onAbort={() => {}} tindeq={tindeq} />);
  expect(tindeq.targetKgRef.current).toBe(20);
  act(() => start());
  act(() => jest.advanceTimersByTime(31000));
  expect(onRepDone).not.toHaveBeenCalled();
  expect(screen.queryByText(/Target reached/)).not.toBeInTheDocument();
  view.unmount();
  expect(tindeq.targetKgRef.current).toBeNull();
  render(<AutoRepSessionView session={{ ...beta, currentRep: 1, refWeights: { L: 15 },
    config: { ...beta.config, goal: 'power_strength', targetTime: 70 } }}
    onRepDone={onRepDone} onAbort={() => {}} tindeq={tindeq} />);
  expect(tindeq.targetKgRef.current).toBe(15);
  expect(screen.getByText(/Fatigued hold/)).toBeInTheDocument();
});
test('rest keeps technical measurement details collapsed', () => {
  render(<RestView lastRep={{actualTime: 30, avgForce: 17.5, failureValid: false, targetTime: 40}} restSeconds={20} repNum={1} repsPerSet={4} unit="kg" onRestDone={() => {}} />);
  expect(screen.getByText(/17.5 kg time-weighted average over 30.0s/)).not.toBeVisible();
  expect(screen.getByText('Interrupted')).toBeVisible();
  expect(screen.getByText(/Interrupted — activity only/)).not.toBeVisible();
});
test('final rep retains its interruption status in session summary', () => {
  render(<SessionSummaryView config={config} reps={[{rep_num: 1, set_num: 1, actual_time_s: 12, avg_force_kg: 18, failure_valid: false}]} onDone={() => {}} />);
  expect(screen.getByText('Interrupted')).toBeVisible();
  expect(screen.getByText(/Interrupted — activity only/)).not.toBeVisible();
});

test('an aborted partial set is not described as complete', () => {
  render(<SessionSummaryView config={{...config,repsPerSet:6}} reps={Array.from({length:3},(_,i)=>({
    rep_num:i+1,set_num:1,hand:'L',actual_time_s:40,avg_force_kg:20,failure_valid:true
  }))} onDone={() => {}} onAddSet={() => {}} />);
  expect(screen.getByRole('heading', {name:'Session Ended Early'})).toBeInTheDocument();
  expect(screen.queryByText('Recommended Set Complete')).not.toBeInTheDocument();
});
test('a fully recorded prescribed set is described as complete', () => {
  render(<SessionSummaryView config={config} reps={Array.from({length:4},(_,i)=>({
    rep_num:i+1,set_num:1,hand:'L',actual_time_s:40,avg_force_kg:20,failure_valid:true
  }))} onDone={() => {}} />);
  expect(screen.getByRole('heading', {name:'Recommended Set Complete'})).toBeInTheDocument();
});

test('regular short holds do not stop at five seconds or when force exceeds the selected load', () => {
  let start, finish;
  const onRepDone = jest.fn();
  const tindeq = { targetKgRef: {}, connected: true, force: 28, avgForce: 24, peak: 28,
    startAutoDetect: (a, b) => { start = a; finish = b; }, stopAutoDetect: jest.fn() };
  render(<AutoRepSessionView session={{ ...session, config: { ...config,
    goal: 'max_strength', targetTime: 5, repsPerSet: 3, restTime: 150 } }}
    onRepDone={onRepDone} onAbort={() => {}} tindeq={tindeq} />);
  act(() => start());
  act(() => jest.advanceTimersByTime(8000));
  expect(onRepDone).not.toHaveBeenCalled();
  act(() => finish({ actualTime: 8, avgForce: 24, peakForce: 28, failureValid: true, endReason: 'muscular_failure' }));
  expect(onRepDone).toHaveBeenCalledWith(expect.objectContaining({ actualTime: 8, avgForce: 24, peakForce: 28 }));
});

test('Peak Test summary does not offer extra sets', () => {
  render(<SessionSummaryView config={{ ...config, peakTest: true, repsPerSet: 3 }}
    reps={[1,2,3].map(n => ({ rep_num: n, set_num: 1, hand: 'L', actual_time_s: 7, avg_force_kg: 20 }))}
    onDone={() => {}} onAddSet={() => {}} />);
  expect(screen.queryByRole('button', { name: /Add another set/ })).not.toBeInTheDocument();
});


test('a pending release gate explains why the next pull cannot start', () => {
  const tindeq = { targetKgRef: {}, connected: true, awaitingRelease: true,
    startAutoDetect: jest.fn(), stopAutoDetect: jest.fn() };
  render(<AutoRepSessionView session={session} onRepDone={jest.fn()} onAbort={jest.fn()} tindeq={tindeq} />);
  expect(screen.getByRole('status')).toHaveTextContent('Release the handle fully before your next pull');
  expect(screen.queryByText('Pull to begin rep 1')).not.toBeInTheDocument();
});

test('confirmed force loss freezes the displayed credit and asks for release before advancing', () => {
  let start;
  const onRepDone=jest.fn();
  const tindeq={targetKgRef:{},connected:true,force:15,avgForce:20,peak:25,
    startAutoDetect:a=>{start=a;},stopAutoDetect:jest.fn()};
  const view=render(<AutoRepSessionView session={session} onRepDone={onRepDone} onAbort={jest.fn()} tindeq={tindeq}/>);
  act(()=>start());
  view.rerender(<AutoRepSessionView session={session} onRepDone={onRepDone} onAbort={jest.fn()}
    tindeq={{...tindeq,forceLoss:{status:'complete',startTs:1000,endTs:11000}}}/>);
  expect(screen.getByText('Rep complete — release the handle')).toBeInTheDocument();
  expect(screen.getByText('10.0s')).toBeInTheDocument();
  act(()=>jest.advanceTimersByTime(5000));
  expect(screen.getByText('10.0s')).toBeInTheDocument();
  expect(onRepDone).not.toHaveBeenCalled();
});


test('live clock includes the ramp and freezes at the same end when loss confirms', () => {
  let start;
  const tindeq = { targetKgRef: {}, connected: true, force: 20, avgForce: 20, peak: 20,
    startAutoDetect: callback => { start = callback; }, stopAutoDetect: jest.fn() };
  const view = render(<AutoRepSessionView session={session} onRepDone={jest.fn()} onAbort={jest.fn()} tindeq={tindeq} />);
  act(() => start());
  view.rerender(<AutoRepSessionView session={session} onRepDone={jest.fn()} onAbort={jest.fn()}
    tindeq={{ ...tindeq, forceLoss: { status: 'holding', pullStartTs: 1000, startTs: null, observedTs: 2500 } }} />);
  expect(screen.getByText('1.5s')).toBeVisible();
  view.rerender(<AutoRepSessionView session={session} onRepDone={jest.fn()} onAbort={jest.fn()}
    tindeq={{ ...tindeq, forceLoss: { status: 'complete', pullStartTs: 1000, startTs: 4000, endTs: 31000 } }} />);
  expect(screen.getByText('30.0s')).toBeVisible();
});

test('rest shows pull time while keeping matched averaging duration in Details', () => {
  render(<RestView lastRep={{ actualTime: 27, avgForce: 20, targetTime: 30, failureValid: true,
    forceRecording: { pull_duration_s: 30 } }} restSeconds={20} repNum={1} repsPerSet={4} unit="kg" onRestDone={jest.fn()} />);
  expect(screen.getByText('30s')).toBeVisible();
  const detail = screen.getByText(/20.0 kg time-weighted average over 27.0s/);
  expect(detail).not.toBeVisible();
  fireEvent.click(screen.getByText('Details'));
  expect(detail).toBeVisible();
});
