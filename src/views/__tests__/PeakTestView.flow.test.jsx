import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { PeakTestView } from '../PeakTestView.jsx';
import { useTindeq, TINDEQ_NOTIFY, CMD_START, CMD_STOP } from '../../lib/tindeq.js';
import { isValidPeakMeasurement } from '../../model/peakTest.js';
import { freshFitReps } from '../../model/load.js';
beforeEach(() => { jest.useFakeTimers().setSystemTime(new Date(2026, 8, 24, 12)); localStorage.clear(); });
afterEach(() => { jest.useRealTimers(); delete navigator.bluetooth; });
async function setup(history = []) {
  let listener, hook, onDisconnect;
  let streaming = false;
  const commands = [];
  const data = { addEventListener: (_, cb) => { listener = cb; }, removeEventListener: jest.fn(),
    startNotifications: async () => {}, stopNotifications: async () => {} };
  const control = { writeValue: async bytes => {
    commands.push(bytes[0]);
    if (bytes[0] === CMD_START[0]) streaming = true;
    if (bytes[0] === CMD_STOP[0]) streaming = false;
  } };
  const device = { addEventListener: (name, cb) => { if(name === 'gattserverdisconnected') onDisconnect = cb; }, removeEventListener: jest.fn(), gatt: {
    connected: true, disconnect: jest.fn(), connect: async () => ({ getPrimaryService: async () => ({
      getCharacteristic: async id => id === TINDEQ_NOTIFY ? data : control,
    }) }),
  } };
  Object.defineProperty(navigator, "bluetooth", { configurable: true, value: { requestDevice: async () => device } });
  const onClose = jest.fn();
  const addReps = jest.fn();
  function Harness({ visible = true, tabVisible = true }) {
    hook = useTindeq();
    return visible && <PeakTestView visible={tabVisible} grip="Micro" history={history} tindeq={hook} unit="kg" addReps={addReps} onClose={onClose} />;
  }
  const view = render(<Harness />);
  await act(async () => { await hook.connect(); });

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
  const arm = () => {};
  // A full pull: force rise + a natural release+settle long enough
  // for the hook's AUTO_RELEASE_CONFIRM_MS (1s) release detection to
  // fire. The 3s auto-cutoff was removed, so pulls now end only on
  // release.
  const pull = (kg, ms) => { arm(); hold(kg, ms); hold(0, 1200); };
  // Used by the disconnect-mid-attempt test which needs phase=active
  // when the disconnect fires. The regular `pull` ends with a release.
  const pullNoRelease = (kg, ms) => { arm(); hold(kg, ms); };
  return { ...view, leaveTab: () => view.rerender(<Harness tabVisible={false} />), returnTab: () => view.rerender(<Harness />), hideWarmup: () => view.rerender(<Harness visible={false} />), send, hold, pull, pullNoRelease, arm, rest, commands, onClose, addReps, disconnect: () => act(() => { onDisconnect(); }) };
}

test.each(['L', 'R'])('six real sensor pulls alternate from %s, with exactly two rests and no countdown start', async first => {
  const history = first === 'R' ? [{ date: '2026-09-20', hand: 'L', actual_time_s: 30 }] : [];
  const { hold, send, arm, addReps, commands } = await setup(history);
  const order = first === 'L' ? ['L','R'] : ['R','L'];
  function checkRestBetweenRounds(round) {
      expect(screen.getByRole('timer', { name: 'Rest' })).toBeInTheDocument();
      // Handling equipment during rest cannot record another pull.
      hold(10, 100); send(0);
      act(() => jest.advanceTimersByTime(61000));
      expect(screen.queryByRole('timer', { name: 'Rest' })).not.toBeInTheDocument();
      expect(screen.getByText('Pull to begin')).toBeInTheDocument();
      act(() => jest.advanceTimersByTime(10000));
      expect(addReps).toHaveBeenCalledTimes((round + 1) * 2);
  }
  for (let round = 0; round < 3; round++) {
    for (const h of order) {
      expect(screen.getByText(h === 'L' ? '🤚 Left Hand' : '✋ Right Hand')).toBeInTheDocument();
      // The 3s auto-cutoff was removed; a natural release ends the
      // pull. hold(0, 1200) is the release+settle (AUTO_RELEASE_CONFIRM_MS
      // = 1s). The old "continued force cannot start the next hand"
      // sub-check was predicated on auto-complete immediately followed
      // by continued force, which no longer happens — pulls are always
      // user-released.
      arm(); hold(h === 'L' ? 25 : 30, 3100); hold(0, 1200);
      expect(addReps).toHaveBeenCalledTimes(round * 2 + order.indexOf(h) + 1);
    }
    if (round < 2) checkRestBetweenRounds(round);
  }
  expect(screen.getByText('Peak Test complete')).toBeInTheDocument();
  expect(screen.queryByRole('timer')).not.toBeInTheDocument();
  const rows = addReps.mock.calls.flatMap(c => c[0]);
  expect(rows.map(r => r.hand)).toEqual([...order,...order,...order]);
  expect(rows.every(isValidPeakMeasurement)).toBe(true);
  expect(rows.every(r => r.force_recording.hand_order.first_hand === first)).toBe(true);
  expect(rows.filter(r => r.rep_num > 1).every(r => r.rep_timing.rest_before_s >= 60)).toBe(true);
  expect(freshFitReps(rows)).toEqual([]);
  expect(commands.filter(c => c === CMD_START[0])).toHaveLength(1);
});

test('Retry rep discards the active attempt and keeps the slot', async () => {
  const { pullNoRelease, hold, send, addReps } = await setup();
  pullNoRelease(30, 1200);
  fireEvent.click(screen.getByRole('button', { name: 'Retry rep' }));
  // No row recorded — the attempt was discarded.
  expect(addReps).not.toHaveBeenCalled();
  // Slot unchanged: still showing round 1 and the first hand's cue.
  expect(screen.getByText('Round 1 of 3')).toBeInTheDocument();
  // Re-attempt the same slot: release+settle (so the hook clears
  // its awaiting-release guard), then a real pull completes a rep.
  send(0); hold(0, 1500);
  hold(50, 3100); hold(0, 1200);
  expect(addReps).toHaveBeenCalledTimes(1);
  const r = addReps.mock.calls[0][0][0];
  expect(r.rep_num).toBe(1); // first slot — the retry didn't consume it
});


test('dropped link retains elapsed activity but cannot contribute a peak', async () => {
  const { pullNoRelease, disconnect, addReps } = await setup();
  pullNoRelease(30,1200);
  disconnect();
  expect(addReps).toHaveBeenCalledTimes(1);
  const r=addReps.mock.calls[0][0][0];
  expect(r.actual_time_s).toBeGreaterThan(0);
  expect(r.end_reason).toBe('equipment_interruption');
  expect(isValidPeakMeasurement(r)).toBe(false);
  expect(screen.getByText('Connect the Tindeq to measure your peak.')).toBeInTheDocument();
});

test('browsing another tab preserves the round, session id, results and rest deadline',async()=>{
  const h=await setup();
  h.pull(25,3100);h.send(0);h.pull(30,3100);h.send(0);
  expect(h.addReps).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('timer',{name:'Rest'})).toBeInTheDocument();
  await act(async()=>h.leaveTab());
  act(()=>jest.advanceTimersByTime(30000));
  await act(async()=>h.returnTab());
  expect(screen.getByText('Round 2 of 3')).toBeInTheDocument();
  expect(Number(screen.getByRole('timer',{name:'Rest'}).textContent.replace('s',''))).toBeLessThanOrEqual(30);
  act(()=>jest.advanceTimersByTime(31000));
  h.hold(0,1000);h.pull(26,3100);
  expect(h.addReps).toHaveBeenCalledTimes(3);
  expect(new Set(h.addReps.mock.calls.map(c=>c[0][0].session_id)).size).toBe(1);
});

test('previous best follows the active hand and stays fixed when a new maximum is pulled', async () => {
  const previous = (hand, kg, extra = {}) => ({ grip: 'Micro', hand, date: '2026-09-24',
    actual_time_s: 3, avg_force_kg: kg - 5, peak_force_kg: kg, load_provenance: 'measured_force', failure_valid: true, ...extra });
  const h = await setup([
    previous('L', 20), previous('R', 24),
    previous('L', 90, { grip: 'Crusher' }),
    previous('L', 95, { failure_valid: false }),
    previous('R', 99, { failure_valid: false }),
  ]);
  expect(screen.getByText(/Previous instantaneous peak:/)).toHaveTextContent('20.0 kg');
  h.pull(30, 3100); h.send(0);
  expect(screen.getByText(/Previous instantaneous peak:/)).toHaveTextContent('24.0 kg');
  h.pull(32, 3100); h.send(0);
  act(() => jest.advanceTimersByTime(61000));
  expect(screen.getByText(/Previous instantaneous peak:/)).toHaveTextContent('20.0 kg');
});

test('peak test does not invent a previous maximum when there is no history', async () => {
  await setup();
  expect(screen.getByText('No previous peak')).toBeInTheDocument();
});

// The old "equipment handling cannot consume a hand slot until Ready
// is tapped" invariant was removed intentionally — the Ready click
// gate was dropped per user request. Handling during the ACTIVE 'ready'
// phase may consume a slot, which is an accepted trade-off; the user
// discards it via the Retry rep button. The rest-phase gating
// invariant (above, in the main round-trip test) still holds, enforced
// by callbacks.start's phase !== 'ready' check.

test('previous peak and sustained benchmarks remain distinct', async () => {
  await setup([{ grip: 'Micro', hand: 'L', date: '2026-09-24', actual_time_s: 4.1,
    avg_force_kg: 72, peak_force_kg: 74.1, load_provenance: 'measured_force', failure_valid: true }]);
  expect(screen.getByText(/Previous instantaneous peak:/)).toHaveTextContent('74.1 kg');
  expect(screen.getByText(/Previous best force held at least 2s:/)).toHaveTextContent('72.0 kg');
});
