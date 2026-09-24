import React, { useEffect, useRef, useState } from 'react';
import { Card, Btn } from '../ui/components.js';
import { C } from '../ui/theme.js';
import { fmtW } from '../ui/format.js';
import { today, nowISO, uuid } from '../util.js';
import { startingHandForDay, otherHand } from '../model/handOrder.js';
import { PEAK_HOLD_S, PEAK_ROUNDS, PEAK_ROUND_REST_S, peakMeasurementRecord, isValidPeakMeasurement } from '../model/peakTest.js';
import { finalizeDeviceActivity } from '../model/forceRecording.js';
import { HandCue } from './cards/HandCue.jsx';
import { ForceGauge } from './cards/LiveForceCard.jsx';
import { TindeqBattery } from './cards/TindeqBattery.jsx';

// Shared complete protocol for the standalone test and the optional warmup block.
// Keep one sensor stream alive through hand changes/rest to observe releases.
export function PeakTestView({ grip, hand = 'Both', history = [], tindeq, addReps,
  source = 'standalone', onClose, unit = 'lbs', visible = true }) {
  const [context] = useState(() => {
    const date = today();
    const first = hand === 'Both' ? startingHandForDay(history, date) : hand;
    return { date, first, hands: hand === 'Both' ? [first, otherHand(first)] : [hand],
      sessionId: uuid(), startedAt: nowISO() };
  });
  const [state, setState] = useState({ phase: 'ready', index: 0, rows: [], elapsed: 0 });
  const live = useRef(state);
  const transition = next => { live.current = next; setState(next); };
  const startRef = useRef(null);
  const deadlineRef = useRef(null);
  const callbacks = useRef({});
  const [retry, setRetry] = useState(0);
  const activeHand = context.hands[state.index % context.hands.length];
  const round = Math.floor(state.index / context.hands.length);
  const total = context.hands.length * PEAK_ROUNDS;

  function complete(raw, interruption = false) {
    const current = live.current;
    if (current.phase !== 'active') return;
    // Freeze before saving; timer and BLE release can arrive in the same tick.
    live.current = { ...current, phase: 'completing' };
    const stats = finalizeDeviceActivity(raw, startRef.current, Date.now(), interruption);
    const h = context.hands[current.index % context.hands.length];
    const previous = [...current.rows].reverse().find(r => r.hand === h);
    const record = peakMeasurementRecord({ stats, hand: h,
      round: Math.floor(current.index / context.hands.length), grip,
      sessionId: context.sessionId, date: context.date, startedAt: context.startedAt,
      firstHand: context.first, source, previousEnd: previous?.rep_timing?.ended_at_ms });
    const rows = [...current.rows, record];
    addReps([record]);
    startRef.current = null;
    const next = current.index + 1;
    const phase = next >= total ? 'done' : next % context.hands.length === 0 ? 'rest' : 'ready';
    deadlineRef.current = phase === 'rest' ? Date.now() + PEAK_ROUND_REST_S * 1000 : null;
    transition({ phase, index: next, rows, elapsed: phase === 'rest' ? PEAK_ROUND_REST_S : 0 });
  }
  callbacks.current = {
    start: () => {
      if (live.current.phase !== 'ready') { tindeq.endRepAndRequireRelease(); return; }
      startRef.current = Date.now();
      transition({ ...live.current, phase: 'active', elapsed: 0 });
    },
    end: stats => complete(stats),
    complete,
  };

  useEffect(() => {
    if (!visible || !tindeq?.connected || state.phase === 'done') return;
    let disposed = false;
    tindeq.targetKgRef.current = null;
    Promise.resolve(tindeq.startAutoDetect(
      () => callbacks.current.start(), stats => callbacks.current.end(stats),
      { endOnTargetDrop: false },
    )).catch(() => { if (!disposed) transition({ ...live.current, phase: 'error' }); });
    return () => {
      disposed = true;
      Promise.resolve(tindeq.stopAutoDetect()).catch(() => {});
      tindeq.targetKgRef.current = null;
    };
    // Callbacks read refs; changing hand must not restart the sensor stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, tindeq?.connected, state.phase === 'done', retry]);

  useEffect(() => {
    if ((!visible || !tindeq?.connected) && live.current.phase === 'active') callbacks.current.complete({}, true);
  }, [visible, tindeq?.connected]);

  useEffect(() => {
    const timer = setInterval(() => {
      const current = live.current;
      if (current.phase === 'active') {
        const seconds = (Date.now() - startRef.current) / 1000;
        if (seconds >= PEAK_HOLD_S) {
          callbacks.current.complete(tindeq.endRepAndRequireRelease());
        } else transition({ ...current, elapsed: seconds });
      } else if (current.phase === 'rest') {
        const remaining = Math.max(0, Math.ceil((deadlineRef.current - Date.now()) / 1000));
        transition({ ...current, elapsed: remaining, phase: remaining ? 'rest' : 'ready' });
      }
    }, 100);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const endEarly = () => {
    if (live.current.phase === 'active') callbacks.current.complete({
      ...tindeq.endRepAndRequireRelease(), endReason: 'interrupted', failureValid: false,
    });
    transition({ ...live.current, phase: 'done' });
  };
  const best = h => Math.max(0, ...state.rows.filter(r => r.hand === h && isValidPeakMeasurement(r)).map(r => r.peak_force_kg));

  return <div>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
      <b>{grip} · Peak Test</b>
      {state.phase !== 'done' && <Btn small color={C.red} onClick={endEarly}>End test</Btn>}
    </div>
    <TindeqBattery battery={tindeq?.battery} connected={tindeq?.connected} warningOnly />
    {state.rows.length > 0 && !isValidPeakMeasurement(state.rows.at(-1)) && <p role="status" style={{ color: C.yellow }}>
      Last attempt was incomplete. Its activity was saved, but it will not count toward your measured peak.
    </p>}
    {state.phase === 'done' ? <Card>
      <h2>Peak Test complete</h2>
      {context.hands.map(h => <p key={h} style={{ fontSize: 22, fontWeight: 700 }}>
        {h === 'L' ? 'Left' : 'Right'}: {best(h) ? `${fmtW(best(h), unit)} ${unit}` : 'No valid measurement'}
      </p>)}
      <p>Best measured peak for each hand. Continue whenever you feel ready.</p>
      <Btn onClick={onClose}>{source === 'warmup' ? 'Continue warm-up' : 'Done'}</Btn>
    </Card> : <>
      <Card style={{ textAlign: 'center', padding: '32px 16px' }}>
        <div style={{ color: C.muted, marginBottom: 12 }}>Round {round + 1} of {PEAK_ROUNDS}</div>
        {state.phase === 'rest' ? <>
          <div>Release and rest</div>
          <div role="timer" aria-label="Rest" style={{ fontSize: 80, fontWeight: 900, color: C.blue }}>{state.elapsed}s</div>
          <p>Next: {activeHand === 'L' ? 'Left' : 'Right'} hand. Take longer if you need it.</p>
        </> : <>
          <HandCue hand={activeHand} />
          {state.phase === 'active'
            ? <div role="timer" aria-label="Peak pull" style={{ fontSize: 96, fontWeight: 900, color: C.blue }}>{state.elapsed.toFixed(1)}s</div>
            : <div style={{ fontSize: 22, fontWeight: 700 }}>Pull to begin</div>}
          <p>Build force smoothly. Pull as hard as you can for {PEAK_HOLD_S} seconds, then release.</p>
          <p style={{ color: C.muted }}>No target weight. Measures peak force, not time to failure.</p>
        </>}
        {state.phase === 'error' && <div role="alert"><p>Could not start the sensor. Release the handle and retry.</p>
          <Btn onClick={() => { transition({ ...live.current, phase: 'ready' }); setRetry(n => n + 1); }}>Retry sensor</Btn></div>}
        {!tindeq?.connected && <><p>Connect the Tindeq to measure your peak.</p><Btn onClick={() => tindeq?.connect?.()}>Connect Tindeq</Btn></>}
        {state.phase === 'active' && <Btn onClick={() => callbacks.current.complete({
          ...tindeq.endRepAndRequireRelease(), endReason: 'interrupted', failureValid: false,
        })}>Rep interrupted</Btn>}
      </Card>
      <Card style={{ marginTop: 12 }}><ForceGauge force={tindeq?.force || 0} emphasizePeak
        avg={state.phase === 'active' ? tindeq?.avgForce || 0 : 0}
        peak={state.phase === 'active' ? tindeq?.peak || 0 : 0} targetKg={null} maxDisplay={100} unit={unit} />
        {state.rows.length > 0 && <p>Best so far · {context.hands.map(h => `${h}: ${best(h) ? fmtW(best(h), unit) + ' ' + unit : '—'}`).join(' · ')}</p>}
      </Card>
    </>}
  </div>;
}
