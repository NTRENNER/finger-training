import React, { StrictMode } from 'react';
import { act, render, screen, fireEvent, cleanup } from '@testing-library/react';
import { AutoRepSessionView, ActiveSessionView } from '../ActiveSessionViews.jsx';
import { useSessionRunner } from '../../hooks/useSessionRunner.js';
import { useTindeq, TINDEQ_NOTIFY, CMD_START, CMD_STOP } from '../../lib/tindeq.js';
import { isCapacityEvidenceRep } from '../../model/forceRecording.js';
import { sustainedMaxKg } from '../../model/sustainedMax.js';

jest.mock('../../lib/sync.js', () => ({ pushDailyState: jest.fn() }));
jest.mock('../cards/RepCurveChart.jsx', () => ({ RepCurveChart: () => null }));
jest.mock('../cards/RecoveryChart.jsx', () => ({ RecoveryChart: () => null }));
jest.mock('../cards/LiveForceCard.jsx', () => ({ BigTimer: () => null, ForceGauge: () => null }));

const CONFIG = { grip: 'Micro', hand: 'L', targetTime: 30, restTime: 20, repsPerSet: 4, plannedLoadByHand: { L: 20 } };
const START = 100000;
let current, saved, packetListener, commands;
function Harness({ visible }) {
  const tindeq = useTindeq();
  const runner = useSessionRunner({ history: [], addReps: saved, tindeqConnected: tindeq.connected });
  current = { runner, tindeq };
  const { phase } = runner;
  return <><output data-testid="phase">{phase}</output>
    <div hidden={!visible}>{['rep_ready', 'rep_active'].includes(phase) && (tindeq.connected
      ? <AutoRepSessionView session={{ ...runner, config: runner.activeRepConfig }} tindeq={tindeq}
          onRepDone={runner.handleRepDone} onAbort={runner.handleAbort} visible={visible} />
      : <ActiveSessionView session={runner} tindeq={tindeq} onRepDone={runner.handleRepDone}
          onAbort={runner.handleAbort} visible={visible} autoStart={phase === 'rep_active'} />)}</div></>;
}
async function start({ device = true } = {}) {
  const data = { addEventListener: (key, callback) => { packetListener = callback; }, removeEventListener: jest.fn(), startNotifications: async () => {} };
  const control = { writeValue: async bytes => { commands.push(bytes[0]); } };
  const sensor = { addEventListener: jest.fn(), removeEventListener: jest.fn(), gatt: {
    connected: true, disconnect: jest.fn(), connect: async () => ({ getPrimaryService: async () => ({
      getCharacteristic: async id => id === TINDEQ_NOTIFY ? data : control,
    }) }),
  } };
  Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: { requestDevice: async () => sensor } });
  const view = render(<StrictMode><Harness visible /></StrictMode>);
  if (device) await act(async () => { await current.tindeq.connect(); });
  await act(async () => { current.runner.startSession(CONFIG); });
  if (!device) act(() => current.runner.chooseOffset(false));
  return { hide: () => view.rerender(<StrictMode><Harness visible={false} /></StrictMode>),
    show: () => view.rerender(<StrictMode><Harness visible /></StrictMode>) };
}
function feed(from, to, force) {
  for (let ms = from; ms <= to; ms += 100) {
    // Advance elapsed time, rather than repeatedly changing the wall clock.
    // setSystemTime shifts pending fake rAF deadlines independently of the
    // frame clock and can leave the UI one sample behind at assertion time.
    act(() => jest.advanceTimersByTime(START + ms - Date.now()));
    const value = new DataView(new ArrayBuffer(10));
    value.setUint8(0, 1); value.setUint8(1, 8);
    value.setFloat32(2, force(ms), true); value.setUint32(6, ms * 1000, true);
    const notify = packetListener;
    act(() => notify({ target: { value } }));
    act(() => jest.advanceTimersByTime(20));
  }
}
beforeEach(() => {
  jest.useFakeTimers().setSystemTime(START);
  // JSDOM's frame origin can depend on real process time. Keep UI coalescing
  // asynchronous, but schedule each frame on this test's controlled clock.
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => setTimeout(() => callback(performance.now()), 16));
  jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => clearTimeout(id));
  saved = jest.fn(); commands = [];
});
afterEach(() => { cleanup(); jest.restoreAllMocks(); jest.useRealTimers(); delete navigator.bluetooth; });

test('End Session preserves the active sensor effort and independent sustained maximum exactly once', async () => {
  await start();
  expect(saved).not.toHaveBeenCalled(); // StrictMode replay is not an interrupted attempt.
  feed(0, 4000, ms => ms < 1000 ? 4 : 20);
  fireEvent.click(screen.getByRole('button', { name: 'End Session' }));
  expect(saved).toHaveBeenCalledTimes(1);
  const rep = saved.mock.calls[0][0][0];
  expect(rep).toMatchObject({ failure_valid: false, end_reason: 'interrupted', actual_time_s: 3,
    force_recording: { capacity_eligible: false, activity: { duration_s: 4 },
      session_prescription: { version: 1, reps_per_set: 4, target_duration_s: 30, rest_s: 20, load_kg: 20, base_load_kg: 20, hand_mode: 'L' } } });
  expect(isCapacityEvidenceRep(rep)).toBe(false);
  expect(sustainedMaxKg(rep)).toBeCloseTo(20);
  expect(current.runner.phase).toBe('done');
  feed(4100, 5500, () => 0);
  expect(saved).toHaveBeenCalledTimes(1);
});

test('tab navigation saves an interrupted pull and stops the hidden recorder without a duplicate', async () => {
  const view = await start();
  feed(0, 3000, () => 20);
  await act(async () => view.hide());
  expect(saved).toHaveBeenCalledTimes(1);
  expect(saved.mock.calls[0][0][0]).toMatchObject({ failure_valid: false, end_reason: 'interrupted', actual_time_s: 3 });
  expect(sustainedMaxKg(saved.mock.calls[0][0][0])).toBeCloseTo(20);
  expect(current.runner.phase).toBe('resting');
  feed(3100, 5000, () => 20);
  await act(async () => view.hide());
  expect(saved).toHaveBeenCalledTimes(1);
  expect(commands).toContain(CMD_STOP[0]);
});

test('a hidden training tab cannot arm the next pull after rest completes', async () => {
  const view = await start();
  feed(0, 3000, () => 20);
  await act(async () => view.hide());
  expect(saved).toHaveBeenCalledTimes(1);
  await act(async () => current.runner.handleRestDone());
  const startsBefore = commands.filter(command => command === CMD_START[0]).length;
  // Another tab may own this same sensor (e.g. a climb warmup).
  current.tindeq.targetKgRef.current = 9;
  feed(3100, 5000, () => 0);
  feed(5100, 8500, () => 20);
  expect(current.tindeq.targetKgRef.current).toBe(9);
  expect(saved).toHaveBeenCalledTimes(1);
  expect(commands.filter(command => command === CMD_START[0])).toHaveLength(startsBefore);
  await act(async () => view.show());
  expect(commands.filter(command => command === CMD_START[0])).toHaveLength(startsBefore + 1);
  expect(screen.getByText('Pull to begin rep 2')).toBeInTheDocument();
  expect(current.tindeq.targetKgRef.current).toBe(20);
});

test('navigating before a pull and ending a session before a pull do not invent activity', async () => {
  const view = await start();
  await act(async () => view.hide());
  expect(saved).not.toHaveBeenCalled();
  await act(async () => view.show());
  fireEvent.click(screen.getByRole('button', { name: 'End Session' }));
  expect(saved).not.toHaveBeenCalled();
  expect(current.runner.phase).toBe('idle');
});

test('an unsuccessful acquisition can be explicitly finished above the release threshold', async () => {
  await start();
  feed(0, 4000, () => 17);
  feed(4100, 8000, () => .8);
  expect(saved).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Finish attempt — target not reached' }));
  expect(saved).toHaveBeenCalledTimes(1);
  const rep = saved.mock.calls[0][0][0];
  expect(rep).toMatchObject({ failure_valid: false, end_reason: 'target_not_reached', force_recording: { capacity_eligible: false } });
  expect(isCapacityEvidenceRep(rep)).toBe(false);
  expect(current.tindeq.releaseCheckRequired).toBe(true);
  expect(current.runner.phase).toBe('resting');
});

test('device hold clock includes the ramp, includes recovered dips, and matches the saved hold', async () => {
  await start();
  feed(0, 1900, () => 4);
  expect(screen.getByText('1.9s')).toBeInTheDocument();
  feed(2000, 4900, () => 20);
  expect(screen.getByText('4.9s')).toBeInTheDocument();
  feed(5000, 5900, () => 16);
  expect(screen.getByText('5.2s')).toBeInTheDocument();
  expect(screen.getByText(/Checking force dip/)).toBeInTheDocument();
  feed(6000, 7000, () => 20);
  expect(screen.getByText('7.0s')).toBeInTheDocument();
  expect(screen.queryByText(/Checking force dip/)).not.toBeInTheDocument();
  expect(saved).not.toHaveBeenCalled();
  feed(7100, 9900, () => 20);
  feed(10000, 11100, () => 0);
  expect(saved).toHaveBeenCalledTimes(1);
  expect(saved.mock.calls[0][0][0]).toMatchObject({ actual_time_s: 8, failure_valid: true,
    force_recording: { acquisition_s: 2, pull_duration_s: 10, activity: { duration_s: 10 } } });
});

test('a pending dip holds the credited clock at the same cutoff saved after early release', async () => {
  await start();
  feed(0, 4900, () => 20);
  feed(5000, 6000, () => 16);
  expect(current.tindeq.forceLoss.status).toBe('recovering');
  expect(screen.getByText('5.2s')).toBeInTheDocument();
  feed(6100, 6900, () => 16);
  expect(screen.getByText('5.2s')).toBeInTheDocument();
  expect(saved).not.toHaveBeenCalled();
  // Release before the four-second loss confirmation. There is no clock rollback.
  feed(7000, 8100, () => 0);
  expect(saved).toHaveBeenCalledTimes(1);
  expect(saved.mock.calls[0][0][0]).toMatchObject({ actual_time_s: 5.2,
    force_recording: { activity: { duration_s: 7 } } });
});

test.each(['end', 'navigate'])('a manual active pull is saved when leaving by %s', async action => {
  const view = await start({ device: false });
  fireEvent.click(screen.getByRole('button', { name: /Start Rep/ }));
  for (let i = 0; i < 3; i++) await act(async () => jest.advanceTimersByTime(1000));
  act(() => jest.advanceTimersByTime(5000));
  if (action === 'end') fireEvent.click(screen.getByRole('button', { name: 'End Session' }));
  else await act(async () => view.hide());
  expect(saved).toHaveBeenCalledTimes(1);
  expect(saved.mock.calls[0][0][0]).toMatchObject({ failure_valid: false, end_reason: 'interrupted', actual_time_s: 5 });
  expect(current.runner.phase).toBe(action === 'end' ? 'done' : 'resting');
});


test('a chosen lower target controls the real sensor detector and preserves the original prescription', async () => {
  await start();
  fireEvent.click(screen.getByText('Adjust target weight'));
  fireEvent.change(screen.getByRole('spinbutton', {name:'Target weight (lbs)'}), {target:{value:'22.0462'}});
  expect(current.tindeq.targetKgRef.current).toBeCloseTo(10, 4);
  // The ramp remains on the clock, with averages starting at the chosen target.
  feed(0, 1900, () => 4);
  feed(2000, 26000, () => 10.1);
  expect(saved).not.toHaveBeenCalled(); // no false original-target failure/backstop
  expect(screen.queryByText('Adjust target weight')).not.toBeInTheDocument();
  feed(26100, 27300, () => 0);
  const rep = saved.mock.calls[0][0][0];
  expect(saved).toHaveBeenCalledTimes(1);
  expect(rep).toMatchObject({ prescribed_load_kg:20, manual_load_kg:10, failure_valid:true });
  expect(rep.force_recording.target_kg).toBeCloseTo(10,4);
  expect(rep.avg_force_kg).toBeCloseTo(10.1,1);
  expect(rep.force_recording.pull_duration_s).toBeGreaterThan(26);
  expect(rep.end_reason).not.toBe('equipment_interruption');
  await act(async () => current.runner.handleRestDone());
  expect(current.tindeq.targetKgRef.current).toBe(20); // chosen target belongs to this hold
});
