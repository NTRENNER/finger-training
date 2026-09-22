import { renderHook, act } from '@testing-library/react';
import { useTindeq, TINDEQ_NOTIFY } from '../tindeq.js';

async function setup(targetKg = null, options) {
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
  await act(async () => { await hook.result.current.startAutoDetect(onStart, onEnd, options); });
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
  for (let ms = 0; ms <= 4000; ms += 100) packet([[ms, ms < 1000 ? 30 : ms < 3000 ? 15 : 0]]);
  expect(onStart).toHaveBeenCalledTimes(1);
  expect(onEnd).toHaveBeenCalledTimes(1);
  expect(onEnd.mock.calls[0][0]).toMatchObject({actualTime: 3, avgForce: 20, failureValid: true});
});
test('multiple samples in one packet retain their individual time intervals', async () => {
  const { packet, onEnd } = await setup();
  packet([[0, 20], [500, 20], [1000, 20], [1500, 20], [2000, 0], [2500, 0], [3000, 0]]);
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
test('a sub-second release dip does not end the rep', async () => {
  const { packet, onEnd } = await setup();
  packet([[0, 20], [500, 20], [1000, 0], [1500, 0], [1600, 20]]);
  expect(onEnd).not.toHaveBeenCalled();
  packet([[2000, 0], [3000, 0]]);
  expect(onEnd).toHaveBeenCalledTimes(1);
  expect(onEnd.mock.calls[0][0]).toMatchObject({actualTime: 2, failureValid: true});
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
  packet([[base, 20], [base + 500, 20], [base + 1000, 20], [base + 1500, 20], [base + 2000, 0], [base + 2500, 0], [base + 3000, 0]]);
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
test('a brief dip below target does not finish a live rep', async () => {
  const { packet, onEnd } = await setup(25);
  for (let ms = 0; ms <= 4000; ms += 100) packet([[ms, ms >= 2000 && ms < 2200 ? 20 : 25]]);
  expect(onEnd).not.toHaveBeenCalled();
});
test('batched timestamps align rep start and end with wall time', async () => {
  const { packet, onEnd } = await setup();
  const arrival = Date.now();
  packet([[0, 20], [500, 20], [1000, 20], [1500, 20], [2000, 0], [2500, 0], [3000, 0]]);
  expect(onEnd.mock.calls[0][0]).toMatchObject({startedAtMs: arrival - 3000, endedAtMs: arrival - 1000});
});


test('timed warmups tolerate target crossings until the timer ends the rep', async () => {
  const { hook, packet, onStart, onEnd } = await setup(25, { endOnTargetDrop: false });
  for (let ms = 0; ms <= 10000; ms += 100) {
    packet([[ms, ms < 1000 ? 20 : ms % 300 === 0 ? 24 : 27]]);
  }
  expect(onStart).toHaveBeenCalledTimes(1);
  expect(onEnd).not.toHaveBeenCalled();
  act(() => { hook.result.current.endRepAndRequireRelease(); });
  packet([[10100, 26], [10200, 26]]);
  expect(onStart).toHaveBeenCalledTimes(1);
  packet([[10300, 0], [10400, 26]]);
  expect(onStart).toHaveBeenCalledTimes(2);
});

test('timed warmups still end on an actual early release', async () => {
  const { packet, onEnd } = await setup(25, { endOnTargetDrop: false });
  for (let ms = 0; ms <= 4000; ms += 100) packet([[ms, ms < 3000 ? 26 : 0]]);
  expect(onEnd).toHaveBeenCalledTimes(1);
  expect(onEnd.mock.calls[0][0].actualTime).toBe(3);
});

test('training restores target-drop detection after leaving a timed warmup', async () => {
  const { hook, packet, onStart, onEnd } = await setup(25, { endOnTargetDrop: false });
  await act(async () => {
    await hook.result.current.stopAutoDetect();
    await hook.result.current.startAutoDetect(onStart, onEnd);
  });
  packet([[0, 26], [500, 26], [1000, 22], [1500, 22], [2000, 22]]);
  expect(onEnd).toHaveBeenCalledTimes(1);
  expect(onEnd.mock.calls[0][0].endReason).toBe('target_force_failure');
});


test('live reps use the tolerance and confirm with sensor time in delayed batches', async () => {
  const { packet, onEnd } = await setup(25);
  packet([[0, 27], [500, 24], [1000, 24], [1500, 24], [2000, 22], [2500, 22]]);
  expect(onEnd).not.toHaveBeenCalled();
  packet([[3000, 22]]);
  expect(onEnd).toHaveBeenCalledTimes(1);
  expect(onEnd.mock.calls[0][0]).toMatchObject({actualTime:2, avgForce:24.75,
    forceRecording:{failure_policy:{version:5,below_target_fraction:0.93,confirmation_ms:1000}}});
});


test('sensor recording pairs post-acquisition force and duration and preserves ramp activity', async () => {
  const {packet,onEnd}=await setup(30);
  packet([[0,4],[400,17],[800,30]]);
  for(let ms=1300;ms<=7300;ms+=500) packet([[ms,30]]);
  packet([[7800,0],[8300,0],[8400,0],[8800,0]]);
  expect(onEnd).toHaveBeenCalledTimes(1);
  expect(onEnd.mock.calls[0][0]).toMatchObject({actualTime:7,avgForce:30,
    forceRecording:{basis:'target_acquired',acquisition_s:0.8,activity:{duration_s:7.8}}});
});
test('manually started sensor measurements remain interrupted after a disconnect', async () => {
  const {hook,packet,deviceListeners}=await setup(25);
  const onFailure=jest.fn();
  await act(async()=>{
    await hook.result.current.stopAutoDetect();
    hook.result.current.setAutoFailCallback(onFailure);
    await hook.result.current.startMeasuring();
  });
  packet([[0,25],[500,25],[1000,25]]);
  act(()=>deviceListeners.gattserverdisconnected());
  let stats;
  await act(async()=>{stats=await hook.result.current.stopMeasuring();});
  expect(onFailure).toHaveBeenCalledTimes(1);
  expect(stats).toMatchObject({actualTime:1,failureValid:false,endReason:'equipment_interruption'});
});
