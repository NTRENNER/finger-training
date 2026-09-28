import React from 'react';
import { act, render, renderHook, screen, fireEvent, waitFor } from '@testing-library/react';
import { useTindeq, TINDEQ_NOTIFY, CMD_START, CMD_STOP, CMD_TARE } from '../tindeq.js';
import { AutoRepSessionView } from '../../views/ActiveSessionViews.js';
jest.mock('../../views/cards/RepCurveChart.jsx', () => ({ RepCurveChart: () => null }));
jest.mock('../../views/cards/RecoveryChart.jsx', () => ({ RecoveryChart: () => null }));
jest.mock('../../views/cards/LiveForceCard.jsx', () => ({ BigTimer: () => null, ForceGauge: () => null }));

const session = { config: { grip: 'Micro', hand: 'L', repsPerSet: 5, targetTime: 45 },
  currentRep: 0, sessionId: 'gatt-test', activeHand: 'L', refWeights: { L: 20 }, sessionReps: [] };

// Unlike an immediately resolved mock, this adapter rejects overlapping work
// exactly as Chrome does while its previous GATT operation is in flight.
async function setup() {
  let busy = false, collisions = 0, notify;
  const writes = [];
  let rejectNext = null;
  const operation = async fn => {
    if (busy) { collisions++; throw new Error('GATT operation already in progress.'); }
    busy = true;
    try { await new Promise(resolve => setTimeout(resolve, 5)); return fn(); }
    finally { busy = false; }
  };
  const data = { addEventListener: (_, cb) => { notify = cb; }, removeEventListener: jest.fn(),
    startNotifications: () => operation(() => {}), stopNotifications: async () => {} };
  const control = { writeValue: bytes => operation(() => {
    writes.push(bytes[0]);
    if (rejectNext === bytes[0]) { rejectNext = null; throw new Error('Device unavailable'); }
  }) };
  const device = { addEventListener: jest.fn(), removeEventListener: jest.fn(), gatt: {
    connected: true, disconnect: jest.fn(), connect: () => operation(() => ({
      getPrimaryService: () => operation(() => ({
        getCharacteristic: id => operation(() => id === TINDEQ_NOTIFY ? data : control),
      })),
    })),
  } };
  Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: { requestDevice: async () => device } });
  const hook = renderHook(() => useTindeq());
  await act(async () => hook.result.current.connect());
  writes.length = 0;
  return { hook, writes, collisions: () => collisions, fail: cmd => { rejectNext = cmd[0]; },
    packet: samples => {
      const value = new DataView(new ArrayBuffer(2 + samples.length * 8));
      value.setUint8(0, 1); value.setUint8(1, samples.length * 8);
      samples.forEach(([ms, kg], i) => {
        value.setFloat32(2 + i * 8, kg, true);
        value.setUint32(6 + i * 8, ms * 1000, true);
      });
      act(() => notify({ target: { value } }));
    },
    pull: () => {
      const value = new DataView(new ArrayBuffer(10));
      value.setUint8(0, 1); value.setUint8(1, 8);
      value.setFloat32(2, 20, true); value.setUint32(6, 1000000, true);
      act(() => notify({ target: { value } }));
    },
  };
}
afterEach(() => { delete navigator.bluetooth; });

test('start, cleanup stop, and restart are serialized and leave the latest rep armed', async () => {
  const { hook, writes, collisions, pull } = await setup();
  const first = jest.fn(), latest = jest.fn();
  await act(async () => {
    await Promise.all([
      hook.result.current.startAutoDetect(first, jest.fn()),
      hook.result.current.stopAutoDetect(),
      hook.result.current.startAutoDetect(latest, jest.fn()),
    ]);
  });
  expect(collisions()).toBe(0);
  expect(writes).toEqual([CMD_START[0], CMD_STOP[0], CMD_START[0]]);
  pull();
  expect(first).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledTimes(1);
});

test('tare waits behind an in-flight start and a rejected command does not poison the queue', async () => {
  const { hook, writes, collisions, fail } = await setup();
  fail(CMD_START);
  await act(async () => {
    const results = await Promise.allSettled([
      hook.result.current.startAutoDetect(jest.fn(), jest.fn()),
      hook.result.current.tare(),
      hook.result.current.startAutoDetect(jest.fn(), jest.fn()),
    ]);
    expect(results.map(result => result.status)).toEqual(['rejected', 'fulfilled', 'fulfilled']);
  });
  expect(collisions()).toBe(0);
  expect(writes).toEqual([CMD_START[0], CMD_TARE[0], CMD_START[0]]);
});

test('the actual workout screen survives StrictMode effect replay with a slow Bluetooth device', async () => {
  const { hook, writes, collisions, pull } = await setup();
  const onRepDone = jest.fn();
  const view = render(<React.StrictMode><AutoRepSessionView session={session} tindeq={hook.result.current}
    onRepDone={onRepDone} onAbort={() => {}} /></React.StrictMode>);
  await waitFor(() => expect(writes).toEqual([CMD_START[0], CMD_STOP[0], CMD_START[0]]));
  expect(collisions()).toBe(0);
  pull();
  expect(screen.getByRole('button', { name: 'Rep interrupted' })).toBeInTheDocument();
  expect(onRepDone).not.toHaveBeenCalled();
  view.unmount();
  await waitFor(() => expect(writes).toHaveLength(4));
});

test('a real start failure offers retry without logging a rep, even if cleanup stop also fails', async () => {
  const { hook, writes, fail, pull } = await setup();
  fail(CMD_START);
  const onRepDone = jest.fn();
  const view = render(<AutoRepSessionView session={session} tindeq={hook.result.current}
    onRepDone={onRepDone} onAbort={() => {}} />);
  const retry = await screen.findByRole('button', { name: 'Retry Tindeq' });
  pull();
  expect(screen.queryByRole('button', { name: 'Rep interrupted' })).not.toBeInTheDocument();
  expect(onRepDone).not.toHaveBeenCalled();
  fail(CMD_STOP);
  fireEvent.click(retry);
  await waitFor(() => expect(writes).toEqual([CMD_START[0], CMD_STOP[0], CMD_START[0]]));
  expect(screen.queryByRole('button', { name: 'Retry Tindeq' })).not.toBeInTheDocument();
  expect(onRepDone).not.toHaveBeenCalled();
  view.unmount();
  await waitFor(() => expect(writes).toHaveLength(4));
});


test('unmount cancels queued commands instead of writing to a retired connection', async () => {
  const { hook, writes } = await setup();
  await act(async () => {
    const pending = hook.result.current.startAutoDetect(jest.fn(), jest.fn());
    const stopped = hook.result.current.stopAutoDetect();
    hook.unmount();
    const results = await Promise.allSettled([pending, stopped]);
    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
  });
  expect(writes).toEqual([]);
});


test('second workout rep shows its timer and completes after release during the rest handoff', async () => {
  const { hook, writes, packet, collisions } = await setup();
  const done = jest.fn();
  function Workout() {
    const [rep, setRep] = React.useState(0);
    const [resting, setResting] = React.useState(false);
    if (resting) return <button onClick={() => setResting(false)}>Finish rest</button>;
    return <AutoRepSessionView key={rep} session={{ ...session, currentRep: rep }}
      tindeq={hook.result.current} onAbort={() => {}}
      onRepDone={stats => { done(stats); setRep(n => n + 1); setResting(true); }} />;
  }
  const view = render(<Workout />);
  await waitFor(() => expect(writes).toEqual([CMD_START[0]]));
  packet([[0, 20], [500, 20], [1000, 20], [1500, 20], [2000, 18], [2500, 18], [3000, 18], [3500, 18], [4000, 18]]);
  for (let ms=4500;ms<=7500;ms+=500) packet([[ms,18]]);
  // Sustained force loss has ended the credited hold, but rest cannot begin
  // while the athlete is still pulling. Capture physical release first.
  expect(done).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', {name:'Finish rest'})).not.toBeInTheDocument();
  packet([[8000,0],[8500,0],[9000,0]]);
  expect(done).toHaveBeenCalledTimes(1);
  expect(done.mock.calls[0][0].actualTime).toBeLessThan(3);
  expect(done.mock.calls[0][0].forceRecording.activity.duration_s).toBe(8);
  await waitFor(() => expect(writes).toEqual([CMD_START[0], CMD_STOP[0]]));
  fireEvent.click(screen.getByRole('button', { name: 'Finish rest' }));
  await waitFor(() => expect(writes).toEqual([CMD_START[0], CMD_STOP[0], CMD_START[0]]));
  expect(screen.getByText('Pull to begin rep 2')).toBeInTheDocument();
  packet([[23000, 20], [23500, 20], [24000, 20], [24500, 20]]);
  // This harness owns the device hook outside Workout; mirror App's updated props.
  view.rerender(<Workout />);
  expect(screen.getByText('0s')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Rep interrupted' })).toBeInTheDocument();
  packet([[25000, 0], [25500, 0], [26000, 0]]);
  expect(done).toHaveBeenCalledTimes(2);
  expect(done.mock.calls[1][0]).toMatchObject({ actualTime: 2, failureValid: true });
  expect(screen.getByRole('button', { name: 'Finish rest' })).toBeInTheDocument();
  expect(collisions()).toBe(0);
  view.unmount();
});
