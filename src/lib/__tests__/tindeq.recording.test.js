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





test('light attempts that never acquire target still end on confirmed release', async () => {
  const { packet, onEnd } = await setup(2.5);
  packet([[0, 2.01], [500, 2.01], [1000, 2.01], [1500, 2.01],
    [2000, 0], [2500, 0], [2999, 0]]);
  expect(onEnd).not.toHaveBeenCalled();
  packet([[3000, 0]]);
  expect(onEnd).toHaveBeenCalledTimes(1);
  expect(onEnd.mock.calls[0][0]).toMatchObject({ actualTime: 2, failureValid: false });
});



test('timed low-target warmups retain their existing start and release rules', async () => {
  const { packet, onStart, onEnd } = await setup(2.5, { endOnTargetDrop: false });
  packet([[0, 2.5], [500, 2.5]]);
  expect(onStart).not.toHaveBeenCalled();
  packet([[1000, 4], [1500, 4], [2000, 4], [2500, 4], [3000, 2.5], [3500, 2.5], [4000, 2.5]]);
  expect(onStart).toHaveBeenCalledTimes(1);
  expect(onEnd).toHaveBeenCalledTimes(1);
});




test('rest release watching is bounded and cannot stop a newer rep stream', async () => {
  const { hook, packet, commands } = await setup(25);
  packet([[0, 25], [500, 25], [1000, 20], [1500, 20], [2000, 20], [2500, 20], [3000, 20]]);
  act(() => { hook.result.current.endRepAndRequireRelease(); });
  await act(async () => { await hook.result.current.stopAutoDetect({ observeRelease: true }); });
  act(() => jest.advanceTimersByTime(9000));
  expect(commands.at(-1)).toBe(CMD_START[0]);
  const nextStart = jest.fn(), nextEnd = jest.fn();
  await act(async () => { await hook.result.current.startAutoDetect(nextStart, nextEnd); });
  // A held handle is still gated. Release is required, even after restart.
  packet([[4000, 25]]);
  expect(nextStart).not.toHaveBeenCalled();
  expect(hook.result.current.awaitingRelease).toBe(true);
  packet([[4500, 0]]);
  expect(hook.result.current.awaitingRelease).toBe(false);
  act(() => jest.advanceTimersByTime(2000));
  await act(async () => {});
  expect(commands.at(-1)).toBe(CMD_START[0]);
  packet([[5000, 25]]);
  expect(nextStart).toHaveBeenCalledTimes(1);
});

test('release watcher stops after ten seconds without inventing a release', async () => {
  const { hook, packet, commands, onStart, onEnd } = await setup(25);
  packet([[0, 25], [500, 25], [1000, 20], [1500, 20], [2000, 20], [2500, 20], [3000, 20]]);
  act(() => { hook.result.current.endRepAndRequireRelease(); });
  await act(async () => { await hook.result.current.stopAutoDetect({ observeRelease: true }); });
  act(() => jest.advanceTimersByTime(10000));
  await act(async () => {});
  expect(commands.at(-1)).toBe(CMD_STOP[0]);
  expect(hook.result.current.awaitingRelease).toBe(true);
  expect(onStart).toHaveBeenCalledTimes(1);
  expect(onEnd).not.toHaveBeenCalled();
});

test('a release sample before restart callbacks arm still clears the previous gate', async () => {
  const { hook, packet } = await setup(25);
  packet([[0, 25], [500, 25], [1000, 20], [1500, 20], [2000, 20], [2500, 20], [3000, 20]]);
  act(() => { hook.result.current.endRepAndRequireRelease(); });
  await act(async () => { await hook.result.current.stopAutoDetect(); });
  const nextStart = jest.fn();
  await act(async () => {
    const pending = hook.result.current.startAutoDetect(nextStart, jest.fn());
    packet([[3500, 0]]); // arrives while START is awaiting its GATT write
    await pending;
  });
  packet([[4000, 25]]);
  expect(nextStart).toHaveBeenCalledTimes(1);
});


test('a 1.5 second force adjustment recovers without ending the rep, then full release ends after 1 second', async () => {
  const { packet, onEnd } = await setup(7.6);
  packet([[0, 7.7], [500, 7.7], [1000, 6.8], [1500, 6.8], [2000, 6.8],
    [2499, 6.8], [2500, 7.7], [3000, 7.7], [3500, 7.7], [4000, 7.7]]);
  expect(onEnd).not.toHaveBeenCalled();
  packet([[4500, 0], [5000, 0], [5499, 0]]);
  expect(onEnd).not.toHaveBeenCalled();
  packet([[5500, 0]]);
  expect(onEnd).toHaveBeenCalledTimes(1);
  expect(onEnd.mock.calls[0][0]).toMatchObject({ actualTime: 4.5, failureValid: true });
});



function feed(packet, from, to, force) {
  for (let ms = from; ms <= to; ms += 100) packet([[ms, force(ms)]]);
}
test('confirmed loss freezes hold time, records weaker work until release, and then advances once', async () => {
  const {hook,packet,onEnd,onStart}=await setup(25);
  feed(packet,0,9000,ms=>ms<3000?25:20);
  expect(hook.result.current.forceLoss.status).toBe('complete');
  expect(onEnd).not.toHaveBeenCalled();
  feed(packet,9100,10100,()=>0);
  expect(onEnd).toHaveBeenCalledTimes(1);
  const stats=onEnd.mock.calls[0][0];
  expect(stats.actualTime).toBeGreaterThanOrEqual(3);
  expect(stats.actualTime).toBeLessThan(3.4);
  expect(stats).toMatchObject({failureValid:true,endReason:'target_force_failure',
    forceRecording:{failure_policy:{version:8},recording_stop_reason:'release',
      capacity_end_reason:'sustained_force_loss',activity:{duration_s:9.1}}});
  feed(packet,10200,11000,()=>25);
  expect(onStart).toHaveBeenCalledTimes(2);
  expect(onEnd).toHaveBeenCalledTimes(1);
});
test.each([2.5,25])('a two-second adjustment at target %s survives; zero release ends after one second', async target => {
  const {packet,onEnd,hook}=await setup(target);
  feed(packet,0,9000,ms=>ms>=3000&&ms<5000?target*.7:target*.98);
  expect(onEnd).not.toHaveBeenCalled();
  expect(hook.result.current.forceLoss.status).toBe('holding');
  feed(packet,9100,10000,()=>0);
  expect(onEnd).not.toHaveBeenCalled();
  packet([[10100,0]]);
  expect(onEnd).toHaveBeenCalledTimes(1);
  expect(onEnd.mock.calls[0][0]).toMatchObject({actualTime:9.1,failureValid:true,
    forceRecording:{capacity_end_reason:'release',failure_policy:{version:8}}});
});
test('repeated short good pulses do not erase an ongoing loss in the live detector', async () => {
  const {packet,hook,onEnd}=await setup(20);
  feed(packet,0,10000,ms=>ms<3000?20:ms%1000===0?18.7:18);
  expect(hook.result.current.forceLoss.status).toBe('complete');
  feed(packet,10100,11100,()=>0);
  expect(onEnd.mock.calls[0][0].actualTime).toBeLessThan(3.5);
});
test('manually started sensor reps use the same loss and release decisions', async () => {
  const {hook,packet}=await setup(2.5);
  const onFailure=jest.fn();
  await act(async()=>{await hook.result.current.stopAutoDetect();
    hook.result.current.setAutoFailCallback(onFailure);await hook.result.current.startMeasuring();});
  feed(packet,0,9000,ms=>ms<3000?2.4:1.8);
  expect(hook.result.current.forceLoss.status).toBe('complete');
  expect(onFailure).not.toHaveBeenCalled();
  feed(packet,9100,10100,()=>0);
  expect(onFailure).toHaveBeenCalledTimes(1);
  let stats;await act(async()=>{stats=await hook.result.current.stopMeasuring();});
  expect(stats.actualTime).toBeLessThan(3.4);
  expect(stats.forceRecording.activity.duration_s).toBe(9.1);
});
test('disconnect while awaiting release retains observed work but cannot prove a failure endpoint', async () => {
  const {hook,packet,onEnd,deviceListeners}=await setup(25);
  feed(packet,0,9000,ms=>ms<3000?25:20);
  expect(hook.result.current.forceLoss.status).toBe('complete');
  await act(async()=>{deviceListeners.gattserverdisconnected();});
  expect(onEnd).toHaveBeenCalledTimes(1);
  expect(onEnd.mock.calls[0][0]).toMatchObject({failureValid:false,endReason:'equipment_interruption'});
});
test('short attempts notify the view instead of leaving its timer running', async () => {
  const {packet,onEnd}=await setup(25);
  feed(packet,0,1500,ms=>ms<500?25:0);
  expect(onEnd).toHaveBeenCalledTimes(1);
  expect(onEnd.mock.calls[0][0]).toMatchObject({actualTime:.5,failureValid:false,endReason:'interrupted'});
});
test('training restores the new detector after a timed warmup', async () => {
  const {hook,packet,onStart,onEnd}=await setup(25,{endOnTargetDrop:false});
  await act(async()=>{await hook.result.current.stopAutoDetect();await hook.result.current.startAutoDetect(onStart,onEnd);});
  feed(packet,0,9000,ms=>ms<3000?25:20);
  expect(hook.result.current.forceLoss.status).toBe('complete');
  feed(packet,9100,10100,()=>0);
  expect(onEnd.mock.calls[0][0].endReason).toBe('target_force_failure');
});

test('a confirmed loss with attachment offset saves once, preserves capacity, and requires zeroing', async () => {
 const {hook,packet,onEnd,onStart}=await setup(20);
 feed(packet,0,21000,ms=>ms<3000?20:.8);
 expect(onEnd).not.toHaveBeenCalled();
 feed(packet,21100,24000,()=>.8);
 expect(onEnd).toHaveBeenCalledTimes(1);
 const stats=onEnd.mock.calls[0][0];
 expect(stats).toMatchObject({failureValid:true,forceRecording:{capacity_eligible:true,
   recording_stop_reason:'release_not_observed',recovery_eligible:false,release_uncertain:true,
   activity:{ended_at_ms:null,endpoint_quality:'release_not_observed'}}});
 expect(stats.actualTime).toBeGreaterThanOrEqual(3);
 expect(stats.actualTime).toBeLessThan(3.4);
 expect(stats.forceRecording.activity.observed_until_at_ms).toEqual(expect.any(Number));
 expect(hook.result.current.releaseCheckRequired).toBe(true);
 feed(packet,24100,26000,()=>20);
 expect(onStart).toHaveBeenCalledTimes(1);
 expect(onEnd).toHaveBeenCalledTimes(1);
 await act(async()=>{await expect(hook.result.current.startMeasuring()).rejects.toThrow('Release and zero');});
});

test('a physical release before the backstop keeps its measured endpoint',async()=>{
 const {hook,packet,onEnd}=await setup(20);
 feed(packet,0,20000,ms=>ms<3000?20:.8);
 feed(packet,20100,21200,()=>0);
 expect(onEnd).toHaveBeenCalledTimes(1);
 expect(onEnd.mock.calls[0][0].forceRecording.recording_stop_reason).toBe('release');
 expect(hook.result.current.releaseCheckRequired).toBe(false);
});

test('zeroing is explicit, blocked during a pull, and needs fresh stable unloaded readings',async()=>{
 const {hook,packet,commands,onStart}=await setup(20);
 const {CMD_TARE}=require('../tindeq.js');
 expect(commands).not.toContain(CMD_TARE[0]);
 feed(packet,0,1000,()=>20);
 await act(async()=>{expect(await hook.result.current.zeroForNextRep()).toBe(false);});
 expect(commands).not.toContain(CMD_TARE[0]);
 feed(packet,1100,24000,ms=>ms<3000?20:.8);
 await act(async()=>{expect(await hook.result.current.zeroForNextRep()).toBe(true);});
 expect(commands).toContain(CMD_TARE[0]);
 feed(packet,24100,24500,()=>0);
 expect(hook.result.current.releaseCheckRequired).toBe(true);
 packet([[24600,0]]);
 expect(hook.result.current.releaseCheckRequired).toBe(false);
 expect(hook.result.current.zeroing).toBe(false);
 packet([[24700,20]]);
 expect(onStart).toHaveBeenCalledTimes(2);
});

test('unsuccessful zero verification remains blocked and can be retried',async()=>{
 const {hook,packet,onStart}=await setup(20);
 await act(async()=>{await hook.result.current.zeroForNextRep();});
 feed(packet,0,1000,()=>.8);
 act(()=>jest.advanceTimersByTime(5000));
 expect(hook.result.current.zeroing).toBe(false);
 expect(hook.result.current.releaseCheckRequired).toBe(true);
 expect(hook.result.current.bleError).toContain('Zero not confirmed');
 packet([[1100,20]]);
 expect(onStart).not.toHaveBeenCalled();
 await act(async()=>{await hook.result.current.zeroForNextRep();});
 feed(packet,1200,1800,()=>0);
 expect(hook.result.current.releaseCheckRequired).toBe(false);
 expect(hook.result.current.bleError).toBeNull();
});

test('manual sensor mode has the same bounded release backstop',async()=>{
 const {hook,packet}=await setup(20);
 await act(async()=>{await hook.result.current.stopAutoDetect();await hook.result.current.startMeasuring();});
 const ended=jest.fn();
 act(()=>hook.result.current.setAutoFailCallback(ended));
 feed(packet,0,24000,ms=>ms<3000?20:.8);
 expect(ended).toHaveBeenCalledTimes(1);
 let stats;await act(async()=>{stats=await hook.result.current.stopMeasuring();});
 expect(stats).toMatchObject({failureValid:true,forceRecording:{capacity_eligible:true,recording_stop_reason:'release_not_observed'}});
 expect(hook.result.current.releaseCheckRequired).toBe(true);
});

test('the backstop never invents failure without acquisition or during timed warmups',async()=>{
 const first=await setup(20);
 feed(first.packet,0,30000,()=>10);
 expect(first.onEnd).not.toHaveBeenCalled();
 first.hook.unmount();
 const warmup=await setup(20,{endOnTargetDrop:false});
 feed(warmup.packet,0,30000,ms=>ms<3000?20:5);
 expect(warmup.onEnd).not.toHaveBeenCalled();
});

test('a disconnect during zero verification cannot clear the release gate',async()=>{
 const {hook,packet,deviceListeners}=await setup(20);
 await act(async()=>{await hook.result.current.zeroForNextRep();});
 feed(packet,0,300,()=>0);
 act(()=>{deviceListeners.gattserverdisconnected();});
 expect(hook.result.current.zeroing).toBe(false);
 expect(hook.result.current.releaseCheckRequired).toBe(true);
 await act(async()=>{jest.advanceTimersByTime(1500);});
 feed(packet,400,1500,()=>0);
 expect(hook.result.current.releaseCheckRequired).toBe(true);
});
