// A reload (or the phone closing the view) used to end the running session:
// finished reps were saved, but the rest had to be restarted as a new
// session. The runner now saves its place and picks it up on the next start.
import React from 'react';
import { act, render, renderHook, screen } from '@testing-library/react';
import { useSessionRunner } from '../useSessionRunner.js';
import { RestView } from '../../views/ActiveSessionViews.jsx';
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
    updateRep: (rep, updates) => {
      store.history = store.history.map(r => r.id === rep.id ? { ...r, ...updates } : r);
      return Promise.resolve();
    }, tindeqConnected: true,
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
  expect(r.phase).toBe('resting');
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
  expect(view.result.current.phase).toBe('resting');
  expect(view.result.current.resumeWantsTindeq).toBe(true);
  view.rerender({ tindeqConnected: true });
  expect(view.result.current.resumeWantsTindeq).toBe(false);
});

test('reload preserves the original rest deadline and last result across repeated reloads', () => {
  jest.useFakeTimers().setSystemTime(new Date('2026-11-11T12:00:00Z'));
  try {
    const store = { history: [] };
    let view = mountApp(store);
    act(() => view.result.current.startSession(cfg));
    act(() => view.result.current.handleRepDone(rep));
    const result = view.result.current.lastRepResult;
    view.unmount();
    jest.advanceTimersByTime(7000);
    view = mountApp(store);
    expect(view.result.current.phase).toBe('resting');
    expect(view.result.current.lastRepResult).toEqual(result);
    expect(result.restStartedAtMs + cfg.restTime * 1000 - Date.now()).toBe(13000);
    view.unmount();
    jest.advanceTimersByTime(5000);
    view = mountApp(store);
    expect(view.result.current.lastRepResult.restStartedAtMs).toBe(result.restStartedAtMs);
    expect(view.result.current.currentRep).toBe(1);
    view.unmount();
  } finally { jest.useRealTimers(); }
});

test('pending redo survives repeated reloads with the same UUID, exact target and disputed work', () => {
  const store = { history: [] };
  let view = mountApp(store);
  act(() => view.result.current.startSession(cfg));
  const attempt = { ...rep, manualLoadKg: 22.753, forceRecording: {
    capacity_eligible: true, recording_stop_reason: 'release',
    activity: { duration_s: 28, impulse_kg_s: 560 },
  } };
  act(() => view.result.current.handleRepDone(attempt));
  const original = store.history[0];
  act(() => view.result.current.handleRedoLastRep());
  for (let n = 0; n < 2; n++) {
    view.unmount(); view = mountApp(store);
    expect(view.result.current.retryTargetKg).toBe(22.753);
    expect(view.result.current.currentRep).toBe(0);
    expect(view.result.current.activeHand).toBe(original.hand);
  }
  act(() => view.result.current.handleRepDone(attempt));
  expect(store.history).toHaveLength(1);
  expect(store.history[0]).toMatchObject({ id: original.id, session_id: original.session_id,
    set_num: 1, rep_num: 1, force_recording: { capacity_eligible: false, recovery_eligible: false,
      redo_attempts: [expect.objectContaining({ actualTime: 28 })], activity: { duration_s: 56 } } });
  // A second redo after another reload still combines each attempt just once.
  act(() => view.result.current.handleRedoLastRep());
  view.unmount(); view = mountApp(store);
  act(() => view.result.current.handleRepDone(attempt));
  expect(store.history).toHaveLength(1);
  expect(store.history[0].force_recording.redo_attempts).toHaveLength(2);
  expect(store.history[0].force_recording.activity.duration_s).toBe(84);
});

test('a pending redo cannot resurrect a rep deleted before reload', () => {
  const store = { history: [] };
  let view = mountApp(store);
  act(() => view.result.current.startSession(cfg));
  act(() => view.result.current.handleRepDone(rep));
  act(() => view.result.current.handleRedoLastRep());
  view.unmount(); store.history = [];
  view = mountApp(store);
  expect(view.result.current.phase).toBe('idle');
  expect(loadLS(LS_SESSION_RESUME_KEY)).toBeNull();
});

test.each([7000, 25000])('rest reloaded after %s ms finishes at the original deadline, once', elapsed => {
  jest.useFakeTimers().setSystemTime(new Date('2026-11-11T12:00:00Z'));
  try {
    const store = { history: [] };
    let view = mountApp(store);
    act(() => view.result.current.startSession(cfg));
    act(() => view.result.current.handleRepDone(rep));
    view.unmount(); jest.advanceTimersByTime(elapsed); view = mountApp(store);
    const done = jest.fn(() => view.result.current.handleRestDone());
    const utils = render(React.createElement(RestView, {
      lastRep: view.result.current.lastRepResult, restSeconds: cfg.restTime,
      repNum: 1, repsPerSet: 3, onRestDone: done,
      onRestClockChange: view.result.current.handleRestClockChange,
    }));
    const remaining = Math.max(0, 20 - elapsed / 1000);
    expect(screen.getByText(`${remaining}s`)).toBeInTheDocument();
    expect(done).toHaveBeenCalledTimes(remaining === 0 ? 1 : 0);
    act(() => jest.advanceTimersByTime(remaining * 1000 + 1000));
    expect(done).toHaveBeenCalledTimes(1);
    expect(view.result.current.phase).toBe('rep_ready');
    utils.unmount(); view.unmount();
  } finally { jest.useRealTimers(); }
});

test('the delayed rest clock is persisted after an unloaded-handle check', () => {
  jest.useFakeTimers().setSystemTime(new Date('2026-11-11T12:00:00Z'));
  try {
    const store = { history: [] };
    let view = mountApp(store);
    act(() => view.result.current.startSession(cfg));
    act(() => view.result.current.handleRepDone(rep));
    act(() => view.result.current.handleRestClockChange(null));
    expect(loadLS(LS_SESSION_RESUME_KEY).lastRepResult.restStartedAtMs).toBeNull();
    jest.advanceTimersByTime(30000);
    const releasedAt = Date.now();
    act(() => view.result.current.handleRestClockChange(releasedAt));
    view.unmount(); jest.advanceTimersByTime(5000); view = mountApp(store);
    expect(view.result.current.lastRepResult.restStartedAtMs).toBe(releasedAt);
    expect(view.result.current.phase).toBe('resting');
    view.unmount();
  } finally { jest.useRealTimers(); }
});

test.each(['completed', 'moved', 'legacy'])('a %s retry snapshot is discarded without changing history', change => {
  const store = { history: [] };
  let view = mountApp(store);
  act(() => view.result.current.startSession(cfg));
  act(() => view.result.current.handleRepDone(rep));
  act(() => view.result.current.handleRedoLastRep());
  view.unmount();
  if (change === 'completed') store.history[0].force_recording.redo_pending = false;
  if (change === 'moved') store.history[0].hand = 'other-hand';
  if (change === 'legacy') saveLS(LS_SESSION_RESUME_KEY, { ...loadLS(LS_SESSION_RESUME_KEY), version: 1 });
  const before = JSON.stringify(store.history);
  view = mountApp(store);
  expect(view.result.current.phase).toBe('idle');
  expect(JSON.stringify(store.history)).toBe(before);
  expect(loadLS(LS_SESSION_RESUME_KEY)).toBeNull();
});
