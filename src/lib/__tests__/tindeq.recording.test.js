import { renderHook, act } from '@testing-library/react';
import { useTindeq, TINDEQ_NOTIFY, CMD_START, CMD_STOP } from '../tindeq.js';

async function setup(targetKg = null, options) {
  const listeners = {};
  const deviceListeners = {};
  const data = { addEventListener: (key, cb) => { listeners[key] = cb; }, removeEventListener: jest.fn(), startNotifications: async () => {}, stopNotifications: async () => {} };
  const commands = [];
  const control = { writeValue: async bytes => { commands.push(bytes[0]); } };
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
  return { hook, packet, onStart, onEnd, deviceListeners, commands };
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
    forceRecording:{failure_policy:{version:6,below_target_fraction:0.93,confirmation_ms:1000}}});
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
  act(() => { deviceListeners.gattserverdisconnected(); });
  let stats;
  await act(async()=>{stats=await hook.result.current.stopMeasuring();});
  expect(onFailure).toHaveBeenCalledTimes(1);
  expect(stats).toMatchObject({actualTime:1,failureValid:false,endReason:'equipment_interruption'});
});

test('light training starts below 4 kg and holds below 3 kg without false release', async () => {
  const { packet, onStart, onEnd } = await setup(2.5);
  packet([[0, 1], [500, 2], [1000, 2.5], [1500, 2.2], [2000, 2.2],
    [2500, 2.2], [3000, 2.2]]);
  expect(onStart).toHaveBeenCalledTimes(1);
  expect(onEnd).not.toHaveBeenCalled();
  packet([[3500, 1.9], [4000, 1.9], [4499, 1.9]]);
  expect(onEnd).not.toHaveBeenCalled();
  packet([[4500, 1.9]]);
  expect(onEnd).toHaveBeenCalledTimes(1);
  expect(onEnd.mock.calls[0][0]).toMatchObject({ actualTime: 2.5,
    endReason: 'target_force_failure', failureValid: true,
    forceRecording: { failure_policy: { version: 6, minimum_drop_kg: 0.45359237,
      maximum_drop_fraction: 0.20 } } });
});

test('light rep release gate retains its threshold when the next target increases', async () => {
  const { hook, packet, onStart, onEnd } = await setup(2.5);
  packet([[0, 2.5], [500, 2.5], [1000, 2.5], [1500, 1.9], [2000, 1.9], [2500, 1.9]]);
  expect(onEnd).toHaveBeenCalledTimes(1);
  hook.result.current.targetKgRef.current = 20;
  packet([[3000, 1.5], [3500, 20]]);
  expect(onStart).toHaveBeenCalledTimes(1);
  packet([[4000, 0], [4500, 20]]);
  expect(onStart).toHaveBeenCalledTimes(2);
});

test('light attempts that never acquire target still end on confirmed release', async () => {
  const { packet, onEnd } = await setup(2.5);
  packet([[0, 2.1], [500, 2.1], [1000, 2.1], [1500, 2.1],
    [2000, 0], [2500, 0], [2999, 0]]);
  expect(onEnd).not.toHaveBeenCalled();
  packet([[3000, 0]]);
  expect(onEnd).toHaveBeenCalledTimes(1);
  expect(onEnd.mock.calls[0][0]).toMatchObject({ actualTime: 2, failureValid: false });
});

test('manually started light sensor reps use the same tolerance and release rules', async () => {
  const { hook, packet } = await setup(2.5);
  const onFailure = jest.fn();
  await act(async () => {
    await hook.result.current.stopAutoDetect();
    hook.result.current.setAutoFailCallback(onFailure);
    await hook.result.current.startMeasuring();
  });
  packet([[0, 2.5], [500, 2.2], [1000, 2.2], [1500, 2.2], [2000, 2.2]]);
  expect(onFailure).not.toHaveBeenCalled();
  packet([[2500, 1.9], [3000, 1.9], [3500, 1.9]]);
  expect(onFailure).toHaveBeenCalledTimes(1);
  let stats;
  await act(async () => { stats = await hook.result.current.stopMeasuring(); });
  expect(stats).toMatchObject({ actualTime: 2.5, endReason: 'target_force_failure', failureValid: true });
});

test('timed low-target warmups retain their existing start and release rules', async () => {
  const { packet, onStart, onEnd } = await setup(2.5, { endOnTargetDrop: false });
  packet([[0, 2.5], [500, 2.5]]);
  expect(onStart).not.toHaveBeenCalled();
  packet([[1000, 4], [1500, 4], [2000, 4], [2500, 4], [3000, 2.5], [3500, 2.5], [4000, 2.5]]);
  expect(onStart).toHaveBeenCalledTimes(1);
  expect(onEnd).toHaveBeenCalledTimes(1);
});


test('release during rest re-arms the next rep before it pulls, then stops the idle stream', async () => {
  const { hook, packet, onStart, onEnd, commands } = await setup(25);
  packet([[0, 25], [500, 25], [1000, 25], [1500, 20], [2000, 20], [2500, 20]]);
  expect(onEnd).toHaveBeenCalledTimes(1);
  await act(async () => { await hook.result.current.stopAutoDetect({ observeRelease: true }); });
  expect(commands.at(-1)).toBe(CMD_START[0]);
  packet([[3000, 0]]);
  await act(async () => {});
  expect(commands.at(-1)).toBe(CMD_STOP[0]);
  expect(onStart).toHaveBeenCalledTimes(1);
  const nextStart = jest.fn(), nextEnd = jest.fn();
  await act(async () => { await hook.result.current.startAutoDetect(nextStart, nextEnd); });
  // No extra zero sample after rest. The physical release was already observed.
  packet([[23000, 25], [23500, 25], [24000, 25], [24500, 25],
    [25000, 0], [25500, 0], [26000, 0]]);
  expect(nextStart).toHaveBeenCalledTimes(1);
  expect(nextEnd).toHaveBeenCalledTimes(1);
  expect(nextEnd.mock.calls[0][0]).toMatchObject({ actualTime: 2, failureValid: true });
});

test('rest release watching is bounded and cannot stop a newer rep stream', async () => {
  const { hook, packet, commands } = await setup(25);
  packet([[0, 25], [500, 25], [1000, 20], [1500, 20], [2000, 20]]);
  await act(async () => { await hook.result.current.stopAutoDetect({ observeRelease: true }); });
  act(() => jest.advanceTimersByTime(9000));
  expect(commands.at(-1)).toBe(CMD_START[0]);
  const nextStart = jest.fn(), nextEnd = jest.fn();
  await act(async () => { await hook.result.current.startAutoDetect(nextStart, nextEnd); });
  // A held handle is still gated. Release is required, even after restart.
  packet([[3000, 25]]);
  expect(nextStart).not.toHaveBeenCalled();
  expect(hook.result.current.awaitingRelease).toBe(true);
  packet([[3500, 0]]);
  expect(hook.result.current.awaitingRelease).toBe(false);
  act(() => jest.advanceTimersByTime(2000));
  await act(async () => {});
  expect(commands.at(-1)).toBe(CMD_START[0]);
  packet([[4000, 25]]);
  expect(nextStart).toHaveBeenCalledTimes(1);
});

test('release watcher stops after ten seconds without inventing a release', async () => {
  const { hook, packet, commands, onStart, onEnd } = await setup(25);
  packet([[0, 25], [500, 25], [1000, 20], [1500, 20], [2000, 20]]);
  await act(async () => { await hook.result.current.stopAutoDetect({ observeRelease: true }); });
  act(() => jest.advanceTimersByTime(10000));
  await act(async () => {});
  expect(commands.at(-1)).toBe(CMD_STOP[0]);
  expect(hook.result.current.awaitingRelease).toBe(true);
  expect(onStart).toHaveBeenCalledTimes(1);
  expect(onEnd).toHaveBeenCalledTimes(1);
});

test('a release sample before restart callbacks arm still clears the previous gate', async () => {
  const { hook, packet } = await setup(25);
  packet([[0, 25], [500, 25], [1000, 20], [1500, 20], [2000, 20]]);
  await act(async () => { await hook.result.current.stopAutoDetect(); });
  const nextStart = jest.fn();
  await act(async () => {
    const pending = hook.result.current.startAutoDetect(nextStart, jest.fn());
    packet([[2500, 0]]); // arrives while START is awaiting its GATT write
    await pending;
  });
  packet([[3000, 25]]);
  expect(nextStart).toHaveBeenCalledTimes(1);
});
