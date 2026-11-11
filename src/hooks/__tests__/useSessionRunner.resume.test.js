// A reload (or the phone closing the view) used to end the running session:
// finished reps were saved, but the rest had to be restarted as a new
// session. The runner now saves its place and picks it up on the next start.
import { act, renderHook } from '@testing-library/react';
import { useSessionRunner } from '../useSessionRunner.js';
import { loadLS, saveLS } from '../../lib/storage.js';
import { LS_SESSION_RESUME_KEY, SESSION_RESUME_MAX_AGE_MS } from '../../lib/sessionResume.js';

jest.mock('../../lib/sync.js', () => ({ pushDailyState: jest.fn() }));

const cfg = { grip: 'Micro', hand: 'Both', goal: 'strength', targetTime: 30, repsPerSet: 3, restTime: 20,
  plannedLoadByHand: { L: 20, R: 21 }, plannedSets: 1, cooked: 4, adjustLoadForFatigue: true,
  decision: { version: 1, rule: 'test-rule' } };
const rep = { actualTime: 28, avgForce: 20, peakForce: 22 };

// Stands in for the app: reps the runner records land in history, which
// survives the "reload" (a fresh hook instance) the way localStorage does.
function mountApp(store) {
  return renderHook(() => useSessionRunner({
    history: store.history,
    addReps: reps => { store.history = [...reps, ...store.history]; },
    updateRep: jest.fn(), tindeqConnected: true,
  }));
}
// What the runner stamps on a rep that the pilot's records depend on.
const stamped = r => ({
  session_id: r.session_id, set_num: r.set_num, rep_num: r.rep_num, hand: r.hand, date: r.date,
  session_started_at: r.session_started_at, target_duration: r.target_duration,
  prescribed_load_kg: r.prescribed_load_kg, session_adjustment: r.session_adjustment,
  session_prescription: r.force_recording?.session_prescription ?? r.session_prescription,
  decision: r.force_recording?.decision ?? r.decision,
});

beforeEach(() => localStorage.clear());

function step(view) {
  if (view.result.current.phase === 'switch_hands') act(() => view.result.current.handleSwitchHandsReady());
  if (view.result.current.phase === 'resting') act(() => view.result.current.handleRestDone());
  expect(view.result.current.phase).toBe('rep_ready');
  act(() => view.result.current.handleRepDone(rep));
}

function runSession({ reloadAfterReps }) {
  const store = { history: [] };
  let view = mountApp(store);
  act(() => { view.result.current.startSession(cfg); });
  const total = cfg.repsPerSet * 2;
  for (let done = 0; done < total; done++) {
    if (done === reloadAfterReps) { view.unmount(); view = mountApp(store); }
    const current = view;
    step(current);
  }
  return { view, store };
}

test('a session resumes after a reload at the same hand, set and rep', () => {
  const store = { history: [] };
  let view = mountApp(store);
  act(() => { view.result.current.startSession(cfg); });
  const firstHand = view.result.current.activeHand;
  const sessionId = view.result.current.sessionId;
  act(() => view.result.current.handleRepDone(rep));
  act(() => view.result.current.handleRestDone());
  act(() => view.result.current.handleRepDone(rep));
  expect(view.result.current.phase).toBe('resting');

  view.unmount();
  view = mountApp(store);

  const r = view.result.current;
  expect(r.phase).toBe('rep_ready');
  expect(r.sessionId).toBe(sessionId);
  expect(r.activeHand).toBe(firstHand);
  expect(r.currentSet).toBe(1);
  expect(r.currentRep).toBe(2);
  expect(r.sessionReps).toHaveLength(2);
  expect(r.config).toMatchObject({ grip: 'Micro', hand: 'Both', repsPerSet: 3 });
});

test('reps recorded after a reload are stamped exactly as in an uninterrupted session', () => {
  jest.useFakeTimers().setSystemTime(new Date('2026-11-11T12:00:00Z'));
  try {
    const straight = runSession({ reloadAfterReps: -1 });
    localStorage.clear();
    const resumed = runSession({ reloadAfterReps: 4 });
    expect(straight.view.result.current.phase).toBe('done');
    expect(resumed.view.result.current.phase).toBe('done');
    const a = [...straight.store.history].reverse();
    const b = [...resumed.store.history].reverse();
    expect(b).toHaveLength(6);
    // Session ids are random per run; compare everything else.
    const normal = rows => rows.map(r => ({ ...stamped(r), session_id: 'same' }));
    expect(normal(b)).toEqual(normal(a));
    expect(stamped(b[5]).session_prescription).toMatchObject({ target_duration_s: 30, reps_per_set: 3 });
    expect(stamped(b[5]).decision).toMatchObject({ rule: 'test-rule' });
    expect(stamped(b[5]).session_adjustment).toMatchObject({ reported_cooked: 4 });
    // The whole record matches too, apart from the random ids.
    const whole = rows => rows.map(({ id, session_id, ...rest }) => rest);
    expect(whole(b)).toEqual(whole(a));
    expect(new Set(b.map(r => r.session_id)).size).toBe(1);
  } finally { jest.useRealTimers(); }
});

test('the saved place is forgotten when the session ends', () => {
  const { view } = runSession({ reloadAfterReps: -1 });
  expect(view.result.current.phase).toBe('done');
  expect(loadLS(LS_SESSION_RESUME_KEY)).toBeNull();
});

test('an old snapshot, or one whose reps are gone, is dropped without resuming', () => {
  const store = { history: [] };
  let view = mountApp(store);
  act(() => { view.result.current.startSession(cfg); });
  act(() => view.result.current.handleRepDone(rep));
  view.unmount();
  const snap = loadLS(LS_SESSION_RESUME_KEY);
  expect(snap.repIds).toHaveLength(1);

  saveLS(LS_SESSION_RESUME_KEY, { ...snap, savedAtMs: Date.now() - SESSION_RESUME_MAX_AGE_MS - 1000 });
  view = mountApp(store);
  expect(view.result.current.phase).toBe('idle');
  expect(loadLS(LS_SESSION_RESUME_KEY)).toBeNull();
  view.unmount();

  saveLS(LS_SESSION_RESUME_KEY, snap);
  view = mountApp({ history: [] });   // the rep was deleted meanwhile
  expect(view.result.current.phase).toBe('idle');
});

test('Peak Test and Chaos sessions are never saved for resume', () => {
  const view = mountApp({ history: [] });
  act(() => { view.result.current.startSession({ ...cfg, peakTest: true }); });
  expect(view.result.current.phase).not.toBe('idle');
  expect(loadLS(LS_SESSION_RESUME_KEY)).toBeNull();
});

test('a resumed Tindeq session asks for the reconnect until the Tindeq is back', () => {
  const store = { history: [] };
  const mount = connected => renderHook(({ tindeqConnected }) => useSessionRunner({
    history: store.history, addReps: reps => { store.history = [...reps, ...store.history]; },
    updateRep: jest.fn(), tindeqConnected,
  }), { initialProps: { tindeqConnected: connected } });

  let view = mount(true);
  act(() => { view.result.current.startSession(cfg); });
  act(() => view.result.current.handleRepDone(rep));
  expect(view.result.current.resumeWantsTindeq).toBe(false);
  view.unmount();

  view = mount(false);                       // the reload dropped Bluetooth
  expect(view.result.current.phase).toBe('rep_ready');
  expect(view.result.current.resumeWantsTindeq).toBe(true);
  view.rerender({ tindeqConnected: true });
  expect(view.result.current.resumeWantsTindeq).toBe(false);
});
