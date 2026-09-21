import { renderHook, act } from "@testing-library/react";
import { useTindeq, TINDEQ_NOTIFY, CMD_BATTERY, CMD_START } from "../tindeq.js";

beforeEach(() => jest.useFakeTimers());
afterEach(() => { jest.useRealTimers(); delete navigator.bluetooth; });

async function setup({ rejectBattery = false, warningOnSubscribe = false } = {}) {
  let notify, disconnect;
  const writes = [];
  const emit = bytes => {
    const data = bytes instanceof DataView ? bytes : new DataView(Uint8Array.from(bytes).buffer);
    act(() => notify({ target: { value: data } }));
  };
  const data = {
    addEventListener: (_, cb) => { notify = cb; }, removeEventListener: jest.fn(),
    startNotifications: async () => { if (warningOnSubscribe) emit([4, 0]); }, stopNotifications: async () => {},
  };
  const control = { writeValue: async bytes => {
    writes.push(bytes[0]);
    if (rejectBattery && bytes[0] === CMD_BATTERY[0]) throw new Error("Unsupported");
  } };
  const device = { addEventListener: (_, cb) => { disconnect = cb; }, removeEventListener: jest.fn(), gatt: {
    connected: true, disconnect: jest.fn(), connect: async () => ({ getPrimaryService: async () => ({
      getCharacteristic: async id => id === TINDEQ_NOTIFY ? data : control,
    }) }),
  } };
  Object.defineProperty(navigator, "bluetooth", { configurable: true, value: { requestDevice: async () => device } });
  const hook = renderHook(() => useTindeq());
  await act(async () => { await hook.result.current.connect(); });
  const battery = mv => {
    const data = new DataView(new ArrayBuffer(6));
    data.setUint8(0, 0); data.setUint8(1, 4); data.setUint32(2, mv, true); emit(data);
  };
  const packet = samples => {
    const data = new DataView(new ArrayBuffer(2 + samples.length * 8));
    data.setUint8(0, 1); data.setUint8(1, samples.length * 8);
    samples.forEach(([ms, kg], i) => { data.setFloat32(2 + 8 * i, kg, true); data.setUint32(6 + 8 * i, ms * 1000, true); });
    emit(data);
  };
  return { hook, writes, emit, battery, packet, disconnect: () => act(() => { disconnect(); }) };
}

test("reads millivolts once on connect and accepts no unsolicited command responses", async () => {
  const { hook, writes, battery } = await setup();
  expect(writes).toEqual([CMD_BATTERY[0]]);
  expect(hook.result.current.battery.status).toBe("checking");
  battery(3012);
  expect(hook.result.current.battery).toMatchObject({ status: "available", voltage_mv: 3012,
    voltage_read_at_ms: Date.now(), low_battery_warning: false });
  battery(1000);
  expect(hook.result.current.battery.voltage_mv).toBe(3012);
});

test("a device warning is retained even if voltage arrives afterward", async () => {
  const { hook, battery } = await setup({ warningOnSubscribe: true });
  battery(2800);
  expect(hook.result.current.battery).toMatchObject({ voltage_mv: 2800, low_battery_warning: true,
    low_battery_warning_at_ms: Date.now() });
});

test.each([[0, 4, 100], [0, 2, 100, 0, 0, 0], [0, 4, 255, 255, 255, 255], [0, 4, 0, 0, 0, 0]])(
  "malformed battery reply %j stays unavailable after timeout", async (...bytes) => {
    const { hook, emit } = await setup();
    emit(bytes);
    act(() => jest.advanceTimersByTime(2100));
    expect(hook.result.current.connected).toBe(true);
    expect(hook.result.current.battery).toMatchObject({ status: "unavailable", voltage_mv: null });
  }
);

test("unsupported battery command does not prevent connecting or starting a rep", async () => {
  const { hook, writes, packet } = await setup({ rejectBattery: true });
  expect(hook.result.current.connected).toBe(true);
  expect(hook.result.current.battery.status).toBe("unavailable");
  const start = jest.fn();
  await act(async () => hook.result.current.startAutoDetect(start, jest.fn()));
  packet([[0, 20]]);
  expect(start).toHaveBeenCalledTimes(1);
  expect(writes).toEqual([CMD_BATTERY[0], CMD_START[0]]);
});

test("a low battery warning does not end a valid rep or add any measurement commands", async () => {
  const { hook, writes, packet, emit, battery } = await setup();
  battery(2800);
  const end = jest.fn();
  await act(async () => hook.result.current.startAutoDetect(jest.fn(), end));
  packet([[0, 20], [500, 20], [1000, 20]]);
  emit([4, 0]);
  expect(end).not.toHaveBeenCalled();
  packet([[1500, 20], [2000, 0], [2500, 0]]);
  expect(end).toHaveBeenCalledTimes(1);
  expect(end.mock.calls[0][0]).toMatchObject({ actualTime: 2, avgForce: 20, failureValid: true,
    forceRecording: { battery: { voltage_mv: 2800, low_battery_warning: true } } });
  expect(writes).toEqual([CMD_BATTERY[0], CMD_START[0]]);
});

test("battery warnings cannot keep a silent force stream alive", async () => {
  const { hook, packet, emit } = await setup();
  const end = jest.fn();
  await act(async () => hook.result.current.startAutoDetect(jest.fn(), end));
  packet([[0, 20], [500, 20]]);
  for (let i = 0; i < 4; i++) {
    act(() => jest.advanceTimersByTime(500)); emit([4, 0]);
  }
  expect(end).toHaveBeenCalledTimes(1);
  expect(end.mock.calls[0][0]).toMatchObject({ actualTime: 0.5, failureValid: false,
    endReason: "equipment_interruption", forceRecording: { battery: { low_battery_warning: true } } });
});

test("disconnect snapshots are immutable and reconnect requests a fresh reading", async () => {
  const { hook, writes, packet, emit, battery, disconnect } = await setup();
  battery(2750); emit([4, 0]);
  const end = jest.fn();
  await act(async () => hook.result.current.startAutoDetect(jest.fn(), end));
  packet([[0, 20], [500, 20]]);
  disconnect();
  const saved = end.mock.calls[0][0];
  expect(saved).toMatchObject({ endReason: "equipment_interruption", failureValid: false,
    forceRecording: { battery: { voltage_mv: 2750, low_battery_warning: true } } });
  await act(async () => { jest.advanceTimersByTime(1500); });
  battery(3050);
  expect(hook.result.current.battery).toMatchObject({ voltage_mv: 3050, low_battery_warning: false });
  expect(saved.forceRecording.battery.voltage_mv).toBe(2750);
  expect(saved.forceRecording.battery.low_battery_warning).toBe(true);
  expect(writes.filter(c => c === CMD_BATTERY[0])).toHaveLength(2);
});

test("manual measurements retain battery context on equipment interruption", async () => {
  const { hook, battery, packet, disconnect } = await setup();
  battery(2990);
  await act(async () => hook.result.current.startMeasuring());
  packet([[0, 20], [500, 20]]);
  disconnect();
  let stats;
  await act(async () => { stats = await hook.result.current.stopMeasuring(); });
  expect(stats).toMatchObject({ failureValid: false, endReason: "equipment_interruption",
    forceRecording: { battery: { voltage_mv: 2990 } } });
});

test("battery timeout is cleaned up on unmount", async () => {
  const { hook, writes } = await setup();
  hook.unmount();
  act(() => jest.advanceTimersByTime(3000));
  expect(writes).toEqual([CMD_BATTERY[0]]);
});
