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
