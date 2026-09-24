import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WarmupView } from "../WarmupView.js";
import { useTindeq, TINDEQ_NOTIFY, CMD_START, CMD_STOP, CMD_BATTERY } from "../../lib/tindeq.js";
import { generateWarmupProtocol } from "../../model/warmup.js";

jest.mock("../../model/warmup.js", () => ({ generateWarmupProtocol: jest.fn() }));

const hang = (id, grip, targetLoadKg) => ({ id, grip, targetLoadKg, type: "hang", targetSec: 2, restAfterSec: 2,
  title: `Two-Handed ${grip}`, intensityLabel: id });
const protocol = { ok: true, bodyWeightLbs: 160, pullupSource: { sourceText: "test" }, steps: [
  hang("Easy hold", "Crusher", 20), hang("Moderate hold", "Crusher", 25),
  hang("Small edge", "Micro", 10), hang("Strength ramp", "Micro", 15),
  { id: "bork", grip: "Micro", type: "bork", title: "Micro primer", intensityLabel: "5 short pulls",
    reps: 5, holdSec: 2, restBetweenSec: 2, restAfterSec: 2, referenceMvcKg: 25 },
  { id: "pullup", type: "pullup", title: "Pullup Finisher", targetReps: 2, sets: 2, restAfterSec: 2 },
] };

beforeEach(() => {
  jest.useFakeTimers();
  localStorage.clear();
  generateWarmupProtocol.mockReturnValue(protocol);
});
afterEach(() => { jest.useRealTimers(); delete navigator.bluetooth; });

// Real sensor hook and real warm-up view. Only the physical BLE transport
// and generated durations are substituted so an entire sequence is fast.
async function setup({ peak = false } = {}) {
  let listener, hook;
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
  expect(screen.getByRole("checkbox", { name: "Include Peak Test today" })).not.toBeChecked();
  if (peak) fireEvent.click(screen.getByRole("checkbox", { name: "Include Peak Test today" }));
  await act(async () => { await hook.connect(); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start", exact: true })); });
  const send = kg => {
    if (!streaming) return;
    const value = new DataView(new ArrayBuffer(10));
    value.setUint8(0, 1); value.setUint8(1, 8);
    value.setFloat32(2, kg, true); value.setUint32(6, (Date.now() * 1000) >>> 0, true);
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
  expect(screen.getByText("Warm-up · Step 2 of 6")).toBeInTheDocument();
  expect(screen.getByText("25.0 kg")).toBeInTheDocument();
  expect(screen.getByRole("timer", { name: "Ready" })).toBeInTheDocument();
  // No extra zero sample after rest: release was already observed during rest.
  hold(30, 1000);
  expect(screen.getByRole("timer", { name: "Hold time" })).toHaveTextContent("1");
  expect(commands).toEqual([CMD_BATTERY[0], CMD_START[0]]);
});

test("complete sequence retains stage layout, shows every primer rep, then both pullup sets", async () => {
  const { hold, rest, commands } = await setup();
  for (let step = 1; step <= 4; step++) {
    expect(screen.getByText(`Warm-up · Step ${step} of 6`)).toBeInTheDocument();
    expect(screen.getByText("Target weight")).toBeInTheDocument();
    hold(30, 2000); rest();
    if (step === 2) {
      expect(screen.getByText("Swap to Micro")).toBeInTheDocument();
      // Moving equipment during the swap must not start a rep.
      hold(15, 200); hold(0, 100);
      expect(screen.queryByRole("timer")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    }
  }
  for (let rep = 1; rep <= 5; rep++) {
    expect(screen.getByText(`Micro · Rep ${rep} of 5`)).toBeInTheDocument();
    expect(screen.queryByText("Target weight")).not.toBeInTheDocument();
    hold(30, 2000);
    expect(screen.getByRole("timer", { name: "Rest" })).toBeInTheDocument();
    if (rep < 5) {
      expect(screen.getByText(`Rep ${rep + 1} of 5 · 2s maximum effort`)).toBeInTheDocument();
      expect(screen.queryByText("Pullup Finisher")).not.toBeInTheDocument();
    } else expect(screen.getByText("Pullup Finisher")).toBeInTheDocument();
    rest();
  }
  await waitFor(() => expect(commands).toEqual([CMD_BATTERY[0], CMD_START[0], CMD_STOP[0]]));
  expect(screen.getByText("Set 1 of 2")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "+1 rep" }));
  fireEvent.click(screen.getByRole("button", { name: "Set done" }));
  expect(screen.getByText("Set 2 of 2 · 2 pullups")).toBeInTheDocument();
  act(() => jest.advanceTimersByTime(2000));
  expect(screen.getByText("Set 2 of 2")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Done", exact: true }));
  expect(screen.getByText(/Warm-up complete/)).toBeInTheDocument();
});

test("pulling during rest cannot shorten it or pre-start the next rep", async () => {
  const { hold, send } = await setup();
  hold(30, 2000); send(0); hold(30, 2000);
  expect(screen.getByRole("timer", { name: "Ready" })).toBeInTheDocument();
  hold(30, 500);
  expect(screen.getByRole("timer", { name: "Ready" })).toBeInTheDocument();
  send(0); hold(30, 200);
  expect(screen.getByRole("timer", { name: "Hold time" })).toBeInTheDocument();
});

test("missing sensor samples pause the same rep rather than count a completed warm-up", async () => {
  const { hold, send } = await setup();
  hold(25, 100);
  act(() => jest.advanceTimersByTime(2000));
  expect(screen.getByText("Warm-up paused")).toBeInTheDocument();
  expect(screen.getByText("Warm-up · Step 1 of 6")).toBeInTheDocument();
  expect(screen.queryByRole("timer", { name: "Rest" })).not.toBeInTheDocument();
  send(0);
  fireEvent.click(screen.getByRole("button", { name: "Retry rep" }));
  hold(25, 2000);
  expect(screen.getByRole("timer", { name: "Rest" })).toBeInTheDocument();
});

test("skipping an active hold still requires release and leaving warm-up stops the stream", async () => {
  const { hold, send, commands, hideWarmup } = await setup();
  hold(25, 500);
  fireEvent.click(screen.getByRole("button", { name: "Skip step" }));
  hold(25, 500);
  expect(screen.getByRole("timer", { name: "Ready" })).toBeInTheDocument();
  send(0); hold(25, 2000);
  expect(screen.getByRole("timer", { name: "Rest" })).toBeInTheDocument();
  hideWarmup();
  await waitFor(() => expect(commands).toEqual([CMD_BATTERY[0], CMD_START[0], CMD_STOP[0]]));
});


test('optional Peak Test replaces the maximal block, saves only its pulls, then returns to warmup', async () => {
  generateWarmupProtocol.mockImplementation(({ includePeakTest }) => ({ ...protocol, steps: [
    hang('Two handed', 'Micro', 10),
    ...(includePeakTest ? [{ id: 'peak', type: 'peak_test', grip: 'Micro', title: 'Micro Peak Test', restAfterSec: 0 }]
      : [protocol.steps[4]]),
    protocol.steps[5],
  ] }));
  const { hold, send, rest, addReps } = await setup({ peak: true });
  hold(20, 2000); rest();
  await act(async () => {}); // allow the shared sensor queue to switch views
  expect(screen.getByText('🤚 Left Hand')).toBeInTheDocument();
  expect(addReps).not.toHaveBeenCalled();
  for(let round=0;round<3;round++) {
    for(let h=0;h<2;h++) { hold(30,3100); send(0); }
    if(round<2) act(() => jest.advanceTimersByTime(61000));
  }
  expect(addReps).toHaveBeenCalledTimes(6);
  expect(addReps.mock.calls.flatMap(c=>c[0]).every(r=>r.force_recording.session_protocol.source==='warmup')).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'Continue warm-up'}));
  expect(screen.getByText('Pullup Finisher')).toBeInTheDocument();
  expect(screen.queryByRole('timer',{name:'Rest'})).not.toBeInTheDocument();
});


test("tab navigation preserves warmup rest and cannot record hidden pulls", async () => {
  const h=await setup();
  h.hold(25,2000);h.send(0);
  expect(screen.getByRole("timer",{name:"Rest"})).toBeInTheDocument();
  await act(async()=>h.leaveTab());
  act(()=>jest.advanceTimersByTime(5000));
  await act(async()=>h.returnTab());
  expect(screen.getByText("Warm-up · Step 2 of 6")).toBeInTheDocument();
  h.send(0);h.hold(25,500);
  expect(screen.getByRole("timer",{name:"Hold time"})).toBeInTheDocument();
});
