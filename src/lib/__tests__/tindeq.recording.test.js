import { renderHook, act } from '@testing-library/react';
import { useTindeq, TINDEQ_NOTIFY } from '../tindeq.js';

async function setup(targetKg = null) {
  const listeners = {};
  const deviceListeners = {};
  const data = { addEventListener: (key, cb) => { listeners[key] = cb; }, removeEventListener: jest.fn(), startNotifications: async () => {}, stopNotifications: async () => {} };
  const control = { writeValue: async () => {} };
  const device = { addEventListener: (key, cb) => { deviceListeners[key] = cb; }, removeEventListener: jest.fn(), gatt: {
    connected: true, disconnect: jest.fn(), connect: async () => ({getPrimaryService: async () => ({ getCharacteristic: async id => id === TINDEQ_NOTIFY ? data : control })}),
  } };
  Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: { requestDevice: async () => device } });
  const hook = renderHook(() => useTindeq());
  await act(async () => { await hook.result.current.connect(); });
  hook.result.current.targetKgRef.current = targetKg;
  const onStart = jest.fn(), onEnd = jest.fn();
  await act(async () => { await hook.result.current.startAutoDetect(onStart, onEnd); });
  const packet = samples => {
    const value = new DataView(new ArrayBuffer(2 + samples.length * 8));
    value.setUint8(0, 1); value.setUint8(1, samples.length * 8);
    samples.forEach(([ms, kg], i) => { value.setFloat32(2 + i * 8, kg, true); value.setUint32(6 + i * 8, (ms * 1000) >>> 0, true); });
    act(() => listeners.characteristicvaluechanged({target: {value}}));
  };
  return { hook, packet, onStart, onEnd, deviceListeners };
}
beforeEach(() => jest.useFakeTimers());
afterEach(() => { jest.useRealTimers(); delete navigator.bluetooth; });
test('batched samples use device time, not packet arrival time, and save once', async () => {
  const { packet, onStart, onEnd } = await setup();
  for (let ms = 0; ms <= 3500; ms += 100) packet([[ms, ms < 1000 ? 30 : ms < 3000 ? 15 : 0]]);
  expect(onStart).toHaveBeenCalledTimes(1);
  expect(onEnd).toHaveBeenCalledTimes(1);
  expect(onEnd.mock.calls[0][0]).toMatchObject({actualTime: 3, avgForce: 20, failureValid: true});
});
test('multiple samples in one packet retain their individual time intervals', async () => {
  const { packet, onEnd } = await setup();
  packet([[0, 20], [500, 20], [1000, 20], [1500, 20], [2000, 0], [2500, 0]]);
  expect(onEnd.mock.calls[0][0]).toMatchObject({actualTime: 2, avgForce: 20});
});
test('silent equipment interruption saves only observed duration', async () => {
  const { packet, onEnd } = await setup();
  packet([[0, 20], [500, 20], [1000, 20]]);
  act(() => jest.advanceTimersByTime(2000));
  expect(onEnd).toHaveBeenCalledTimes(1);
  expect(onEnd.mock.calls[0][0]).toMatchObject({actualTime: 1, failureValid: false, endReason: 'equipment_interruption'});
});
test('disconnect preserves the active effort before reconnection', async () => {
  const { packet, onEnd, deviceListeners } = await setup();
  packet([[0, 20], [500, 20]]);
  act(() => { deviceListeners.gattserverdisconnected(); });
  expect(onEnd).toHaveBeenCalledTimes(1);
  expect(onEnd.mock.calls[0][0]).toMatchObject({actualTime: 0.5, failureValid: false});
});
test('explicit stop requires release before another rep can start', async () => {
  const { hook, packet, onStart } = await setup();
  packet([[0, 20], [500, 20]]);
  let stats;
  act(() => { stats = hook.result.current.endRepAndRequireRelease(); });
  expect(stats.actualTime).toBe(0.5);
  packet([[600, 20], [700, 20]]);
  expect(onStart).toHaveBeenCalledTimes(1);
  packet([[800, 0], [900, 20]]);
  expect(onStart).toHaveBeenCalledTimes(2);
});
test('a gap in device samples stops the effort before the missing interval', async () => {
  const { packet, onEnd } = await setup();
  packet([[0, 20], [500, 20]]);
  packet([[3000, 20]]);
  expect(onEnd.mock.calls[0][0]).toMatchObject({actualTime: 0.5, failureValid: false});
});
test('device timestamp rollover preserves duration', async () => {
  const { packet, onEnd } = await setup();
  const base = 4294900;
  packet([[base, 20], [base + 500, 20], [base + 1000, 20], [base + 1500, 20], [base + 2000, 0], [base + 2500, 0]]);
  expect(onEnd.mock.calls[0][0]).toMatchObject({actualTime: 2, avgForce: 20, failureValid: true});
});

test('sustained target loss ends once while still pulling and requires release', async () => {
  const { packet, onStart, onEnd } = await setup(25);
  for (let ms = 0; ms <= 6000; ms += 100) packet([[ms, ms < 3000 ? 25 : 15]]);
  expect(onEnd).toHaveBeenCalledTimes(1);
  const stats = onEnd.mock.calls[0][0];
  expect(stats.endReason).toBe('target_force_failure');
  expect(stats.failureValid).toBe(true);
  expect(stats.actualTime).toBeGreaterThanOrEqual(3);
  expect(stats.actualTime).toBeLessThan(3.4);
  expect(onStart).toHaveBeenCalledTimes(1);
  packet([[6100, 0], [6200, 25]]);
  expect(onStart).toHaveBeenCalledTimes(2);
});
test('a drop below target finishes a live rep', async () => {
  const { packet, onEnd } = await setup(25);
  for (let ms = 0; ms <= 4000; ms += 100) packet([[ms, ms >= 2000 && ms < 2200 ? 20 : 25]]);
  expect(onEnd).toHaveBeenCalledTimes(1);
  expect(onEnd.mock.calls[0][0].actualTime).toBe(2);
});
test('batched timestamps align rep start and end with wall time', async () => {
  const { packet, onEnd } = await setup();
  const arrival = Date.now();
  packet([[0, 20], [500, 20], [1000, 20], [1500, 20], [2000, 0], [2500, 0]]);
  expect(onEnd.mock.calls[0][0]).toMatchObject({startedAtMs: arrival - 2500, endedAtMs: arrival - 500});
});
