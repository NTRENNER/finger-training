import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WarmupView } from "../WarmupView.jsx";
import { useTindeq, TINDEQ_NOTIFY, CMD_START, CMD_STOP, CMD_BATTERY } from "../../lib/tindeq.js";
import { generateWarmupProtocol } from "../../model/warmup.js";

jest.mock("../../model/warmup.js", () => ({ generateWarmupProtocol: jest.fn() }));

const hang = (id, grip, targetLoadKg) => ({ id, grip, targetLoadKg, type: "hang", targetSec: 2, restAfterSec: 2,
  title: `Two-Handed ${grip}`, intensityLabel: id });
const protocol = { ok: true, bodyWeightLbs: 160, availablePeakGrips: ['Crusher', 'Micro'], steps: [
  hang("Easy hold", "Crusher", 20), hang("Moderate hold", "Crusher", 25),
  hang("Small edge", "Micro", 10), hang("Strength ramp", "Micro", 15),
  hang("Final strength ramp", "Micro", 18),
] };

beforeEach(() => {
  jest.useFakeTimers();
  localStorage.clear();
  generateWarmupProtocol.mockReturnValue(protocol);
});
afterEach(() => { jest.useRealTimers(); delete navigator.bluetooth; });

// Real sensor hook and real warm-up view. Only the physical BLE transport
// and generated durations are substituted so an entire sequence is fast.
async function setup({ peak = false, crusherPeak = false } = {}) {
  let listener, hook;
  let lastSampleMs = null;
  let streaming = false;
  const commands = [];
  const data = { addEventListener: (_, cb) => { listener = cb; }, removeEventListener: jest.fn(),
    startNotifications: async () => {}, stopNotifications: async () => {} };
  const control = { writeValue: async bytes => {
    commands.push(bytes[0]);
    if (bytes[0] === CMD_START[0]) streaming = true;
    if (bytes[0] === CMD_STOP[0]) streaming = false;
  } };
  const device = { addEventListener: jest.fn(), removeEventListener: jest.fn(), gatt: {
    connected: true, disconnect: jest.fn(), connect: async () => ({ getPrimaryService: async () => ({
      getCharacteristic: async id => id === TINDEQ_NOTIFY ? data : control,
    }) }),
  } };
  Object.defineProperty(navigator, "bluetooth", { configurable: true, value: { requestDevice: async () => device } });
  const onClose = jest.fn();
  const addReps = jest.fn();
  function Harness({ visible = true, tabVisible = true }) {
    hook = useTindeq();
    return visible && <WarmupView visible={tabVisible} history={[]} wLog={[]} bodyWeightKg={73} tindeq={hook} unit="kg" onClose={onClose} addReps={addReps} />;
  }
  const view = render(<Harness />);
  expect(screen.getByRole("switch", { name: "Micro Max Test" })).not.toBeChecked();
  expect(screen.getByRole("switch", { name: "Crusher Max Test" })).not.toBeChecked();
  if (crusherPeak) fireEvent.click(screen.getByRole("switch", { name: "Crusher Max Test" }));
  if (peak) fireEvent.click(screen.getByRole("switch", { name: "Micro Max Test" }));
  await act(async () => { await hook.connect(); });
  fireEvent.click(screen.getByRole("button", { name: "Start", exact: true }));
  await waitFor(() => expect(commands).toContain(CMD_START[0]));
  const send = kg => {
    if (!streaming) return;
    const sampleMs = lastSampleMs == null ? Date.now() : Math.max(Date.now(), lastSampleMs + 1);
    lastSampleMs = sampleMs;
    const value = new DataView(new ArrayBuffer(10));
    value.setUint8(0, 1); value.setUint8(1, 8);
    value.setFloat32(2, kg, true); value.setUint32(6, (sampleMs * 1000) >>> 0, true);
    act(() => listener({ target: { value } }));
  };
  const hold = (kg, ms) => {
    send(kg);
    for (let elapsed = 0; elapsed < ms; elapsed += 100) {
      act(() => jest.advanceTimersByTime(100)); send(kg);
    }
  };
  const rest = () => { hold(0, 2000); };
  return { ...view, leaveTab: () => view.rerender(<Harness tabVisible={false} />), returnTab: () => view.rerender(<Harness />), hideWarmup: () => view.rerender(<Harness visible={false} />), send, hold, rest, commands, onClose, addReps };
}

test("first timed hold, rest release, and the next pull use one uninterrupted sensor stream", async () => {
  const { hold, rest, commands } = await setup();
  expect(screen.getByRole("timer", { name: "Ready" })).toHaveTextContent("0");
  expect(screen.getByText("20.0 kg")).toBeInTheDocument();
  // Overshooting and dipping below target are both valid during a timed warm-up.
  hold(28, 1000); hold(12, 1000);
  expect(screen.getByRole("timer", { name: "Rest" })).toBeInTheDocument();
  expect(commands).toEqual([CMD_BATTERY[0], CMD_START[0]]);
  rest();
  expect(screen.getByText("Warm-up · Step 2 of 5")).toBeInTheDocument();
  expect(screen.getByText("25.0 kg")).toBeInTheDocument();
  expect(screen.getByRole("timer", { name: "Ready" })).toBeInTheDocument();
  // No extra zero sample after rest: release was already observed during rest.
  hold(30, 1000);
  expect(screen.getByRole("timer", { name: "Hold time" })).toHaveTextContent("1");
  expect(commands).toEqual([CMD_BATTERY[0], CMD_START[0]]);
});

test('a warm-up started without a sensor stays manual after reconnect and ignores stale force-loss state', () => {
  const startAutoDetect = jest.fn();
  const targetKgRef = { current: null };
  const baseTindeq = { connected: false, reconnecting: false, targetKgRef, startAutoDetect,
    stopAutoDetect: jest.fn(), forceLoss: { status: 'recovering', pendingEndTs: 0 } };
  const props = { visible: true, history: [], wLog: [], bodyWeightKg: 73, unit: 'kg',
    onClose: jest.fn(), addReps: jest.fn() };
  const view = render(<WarmupView {...props} tindeq={baseTindeq} />);
  fireEvent.click(screen.getByRole('button', { name: 'Start', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Start pull' }));
  act(() => jest.advanceTimersByTime(500));
  view.rerender(<WarmupView {...props} tindeq={{ ...baseTindeq, connected: true }} />);
  act(() => jest.advanceTimersByTime(1700));
  expect(screen.getByRole('timer', { name: 'Rest' })).toBeInTheDocument();
  expect(startAutoDetect).not.toHaveBeenCalled();
  expect(screen.queryByText('Connect the Tindeq to continue.')).not.toBeInTheDocument();
});

test('the warm-up reports active training only after it starts and clears it on exit', () => {
  const onTrainingStateChange = jest.fn();
  const props = { visible: true, history: [], wLog: [], bodyWeightKg: 73, unit: 'kg',
    onClose: jest.fn(), addReps: jest.fn(), onTrainingStateChange };
  const view = render(<WarmupView {...props} tindeq={{ connected: false }} />);
  expect(onTrainingStateChange).toHaveBeenLastCalledWith(false);
  fireEvent.click(screen.getByRole('button', { name: 'Start', exact: true }));
  expect(onTrainingStateChange).toHaveBeenLastCalledWith(true);
  view.unmount();
  expect(onTrainingStateChange).toHaveBeenLastCalledWith(false);
});

test("complete sequence retains stage layout and finishes after the second strength ramp", async () => {
  const { hold, rest, commands, addReps } = await setup();
  const completeStep = step => {
    expect(screen.getByText(`Warm-up · Step ${step} of 5`)).toBeInTheDocument();
    expect(screen.getByText("Target weight")).toBeInTheDocument();
    // A grip change deliberately re-arms release detection. Represent the
    // unloaded settling time that occurs while the athlete swaps equipment.
    hold(0, 1200);
    hold(30, 2000); rest();
  };
  completeStep(1); completeStep(2);
  expect(screen.getByText(/Swap the Tindeq to the/)).toBeInTheDocument();
  // The old Continue-click gate was removed; the swap banner is a
  // persistent note over hang-armed and clears when the next pull
  // starts. The pre-click "handling can't start a rep during swap"
  // invariant was tied to the click gate — accepted as a trade-off
  // for the frictionless swap flow. In real use, enterStep's
  // endRepAndRequireRelease still blocks brief handling spikes once
  // the user settles the swapped gripper.
  completeStep(3); completeStep(4);
  expect(screen.getByText("Warm-up · Step 5 of 5")).toBeInTheDocument();
  expect(screen.getByText("Final strength ramp")).toBeInTheDocument();
  expect(screen.getByText("18.0 kg")).toBeInTheDocument();
  hold(30, 2000);
  expect(screen.queryByText("Pullup Finisher")).not.toBeInTheDocument();
  expect(screen.queryByRole("timer", { name: "Rest" })).not.toBeInTheDocument();
  await waitFor(() => expect(commands).toEqual([CMD_BATTERY[0], CMD_START[0], CMD_STOP[0]]));
  expect(screen.getByText(/Warm-up complete/)).toBeInTheDocument();
  expect(addReps).not.toHaveBeenCalled();
});

test("recovery activity leads into Potentiation Pulls and completes the warm-up", () => {
  generateWarmupProtocol.mockReturnValue({ ...protocol, steps: [
    { ...hang("Primer hold", "Crusher", 20), restActivity: {
      id: "med-ball-slams",
      name: "Med-ball slams",
      dose: "3–5 crisp reps",
      cue: "Move explosively and stop while every rep is fast.",
    } },
    {
      id: "potentiation-crusher",
      type: "potentiation",
      grip: "Crusher",
      title: "Crusher Potentiation Pulls",
      targetLoadKg: 30,
      repsPerHand: 1,
      restBetweenSec: 20,
      restAfterSec: 0,
      intensityLabel: "Fast single-hand pulls",
    },
  ] });
  const addReps = jest.fn();
  render(<WarmupView visible history={[]} wLog={[]} bodyWeightKg={73}
    tindeq={{ connected: false }} unit="kg" onClose={jest.fn()} addReps={addReps} />);

  fireEvent.click(screen.getByRole("button", { name: "Start", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Start pull" }));
  act(() => jest.advanceTimersByTime(2200));
  expect(screen.getByText("Med-ball slams")).toBeInTheDocument();
  expect(screen.getByText("3–5 crisp reps")).toBeInTheDocument();
  // Finishing the movement needs no tap: the rest ends on its own and the
  // next step waits for the pull.
  expect(screen.queryByRole("button", { name: "Done" })).not.toBeInTheDocument();

  act(() => jest.advanceTimersByTime(2500));
  expect(screen.getByText("Crusher · Potentiation Pulls")).toBeInTheDocument();
  for (let pull = 0; pull < 2; pull += 1) {
    fireEvent.click(screen.getByRole("button", { name: "Start pull" }));
    fireEvent.click(screen.getByRole("button", { name: "Pull complete" }));
    if (pull === 0) fireEvent.click(screen.getByRole("button", { name: "Skip rest" }));
  }
  fireEvent.click(screen.getByRole("button", { name: "Finish warm-up" }));
  expect(screen.getByText(/Warm-up complete/)).toBeInTheDocument();
  expect(addReps).not.toHaveBeenCalled();
});

test("Continue early ends the rest before its timer runs out", () => {
  generateWarmupProtocol.mockReturnValue({ ...protocol, steps: [
    { ...hang("First hold", "Crusher", 20), restAfterSec: 90 },
    hang("Second hold", "Crusher", 25),
  ] });
  render(<WarmupView visible history={[]} wLog={[]} bodyWeightKg={73}
    tindeq={{ connected: false }} unit="kg" onClose={jest.fn()} addReps={jest.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Start", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Start pull" }));
  act(() => jest.advanceTimersByTime(2200));
  expect(screen.getByRole("timer", { name: "Rest" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Continue early" }));
  expect(screen.queryByRole("timer", { name: "Rest" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Start pull" })).toBeInTheDocument();
});

test("pulling during rest cannot shorten it or pre-start the next rep", async () => {
  const { hold, send } = await setup();
  hold(30, 2000); send(0); hold(30, 2000);
  expect(screen.getByRole("timer", { name: "Ready" })).toBeInTheDocument();
  hold(30, 500);
  expect(screen.getByRole("timer", { name: "Ready" })).toBeInTheDocument();
  hold(0, 1200); hold(30, 200);
  expect(screen.getByRole("timer", { name: "Hold time" })).toBeInTheDocument();
});

test("missing sensor samples pause the same rep rather than count a completed warm-up", async () => {
  const { hold } = await setup();
  hold(25, 100);
  act(() => jest.advanceTimersByTime(2000));
  expect(screen.getByText("Warm-up paused")).toBeInTheDocument();
  expect(screen.getByText("Warm-up · Step 1 of 5")).toBeInTheDocument();
  expect(screen.queryByRole("timer", { name: "Rest" })).not.toBeInTheDocument();
  hold(0, 1200);
  fireEvent.click(screen.getByRole("button", { name: "Retry rep" }));
  hold(25, 2000);
  expect(screen.getByRole("timer", { name: "Rest" })).toBeInTheDocument();
});

test("skipping an active hold still requires release and leaving warm-up stops the stream", async () => {
  const { hold, commands, hideWarmup } = await setup();
  hold(25, 500);
  fireEvent.click(screen.getByRole("button", { name: "Skip step" }));
  hold(25, 500);
  expect(screen.getByRole("timer", { name: "Ready" })).toBeInTheDocument();
  hold(0, 1200); hold(25, 2000);
  expect(screen.getByRole("timer", { name: "Rest" })).toBeInTheDocument();
  hideWarmup();
  await waitFor(() => expect(commands).toEqual([CMD_BATTERY[0], CMD_START[0], CMD_STOP[0]]));
});


test('optional Peak Test saves only its pulls, then completes warmup', async () => {
  generateWarmupProtocol.mockImplementation(({ peakTestGrips }) => ({ ...protocol, steps: [
    hang('Two handed', 'Micro', 10),
    ...(peakTestGrips.includes('Micro') ? [{ id: 'peak', type: 'peak_test', grip: 'Micro', title: 'Micro Peak Test', restAfterSec: 0 }]
      : [protocol.steps[4]]),
  ] }));
  const { hold, rest, addReps, commands } = await setup({ peak: true });
  hold(20, 2000); rest();
  await waitFor(() => expect(commands.filter(command => command === CMD_START[0])).toHaveLength(2));
  expect(screen.getByText('🤚 Left Hand')).toBeInTheDocument();
  expect(addReps).not.toHaveBeenCalled();
  for(let round=0;round<3;round++) {
    for(let h=0;h<2;h++) { hold(30,3100); hold(0,1200); }
    if(round<2) act(() => jest.advanceTimersByTime(61000));
  }
  expect(addReps).toHaveBeenCalledTimes(6);
  expect(addReps.mock.calls.flatMap(c=>c[0]).every(r=>r.force_recording.session_protocol.source==='warmup')).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'Finish warm-up'}));
  expect(screen.getByText(/Warm-up complete/)).toBeInTheDocument();
  expect(screen.queryByRole('timer',{name:'Rest'})).not.toBeInTheDocument();
});


test("tab navigation preserves warmup rest and cannot record hidden pulls", async () => {
  const h=await setup();
  h.hold(25,2000);h.send(0);
  expect(screen.getByRole("timer",{name:"Rest"})).toBeInTheDocument();
  await act(async()=>h.leaveTab());
  act(()=>jest.advanceTimersByTime(5000));
  await act(async()=>h.returnTab());
  expect(screen.getByText("Warm-up · Step 2 of 5")).toBeInTheDocument();
  h.hold(0,1200);h.hold(25,500);
  expect(screen.getByRole("timer",{name:"Hold time"})).toBeInTheDocument();
});

test('both selected max tests save separate grips and sessions with a swap between them', async () => {
  generateWarmupProtocol.mockImplementation(({ peakTestGrips }) => ({ ...protocol, steps: [
    hang('Two handed', 'Micro', 10),
    ...['Micro', 'Crusher'].filter(grip => peakTestGrips.includes(grip)).map(grip => ({
      id: `peak-${grip}`, type: 'peak_test', grip, title: `${grip} Peak Test`, restAfterSec: 0,
    })),
  ] }));
  const h = await setup({ peak: true, crusherPeak: true });
  h.hold(20, 2000); h.rest();
  await waitFor(() => expect(h.commands.filter(command => command === CMD_START[0])).toHaveLength(2));
  const finishTest = () => {
    for (let round = 0; round < 3; round++) {
      h.hold(30, 3100); h.hold(0, 1200);
      h.hold(32, 3100); h.hold(0, 1200);
      if (round < 2) act(() => jest.advanceTimersByTime(61000));
    }
  };
  finishTest();
  fireEvent.click(screen.getByRole('button', { name: 'Continue warm-up' }));
  expect(h.addReps).toHaveBeenCalledTimes(6);
  await waitFor(() => expect(h.commands.filter(command => command === CMD_START[0])).toHaveLength(3));
  expect(screen.getByText('Crusher · Peak Test')).toBeInTheDocument();
  expect(screen.getByText('Round 1 of 3')).toBeInTheDocument();
  finishTest();
  expect(h.addReps).toHaveBeenCalledTimes(12);
  const rows = h.addReps.mock.calls.flatMap(c => c[0]);
  expect(rows.map(r => r.grip)).toEqual([...Array(6).fill('Micro'), ...Array(6).fill('Crusher')]);
  expect(new Set(rows.map(r => r.session_id)).size).toBe(2);
  expect(rows.slice(0, 6).map(r => r.hand)).toEqual(rows.slice(6).map(r => r.hand));
  fireEvent.click(screen.getByRole('button', { name: 'Finish warm-up' }));
  expect(screen.getByText(/Warm-up complete/)).toBeInTheDocument();
});
