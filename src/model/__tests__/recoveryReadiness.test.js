import { measuredRecoveryFields } from '../../testHelpers/recovery.js';
import { buildRecoveryTrend, buildRecoveryReadinessTrend } from '../recoveryDynamics.js';
import { computeDeload, recentGapHeldOut, deloadStatus } from '../deload.js';

const TODAY = '2026-09-30';
const session = (date, grip, secondTime = 28, { hour = 8, set = 1, hand = 'L', ...extra } = {}) =>
  [30, secondTime].map((time, i) => ({
    ...measuredRecoveryFields(120), id: `${date}-${grip}-${hour}-${hand}-${set}-${i}`,
    session_id: `${date}-${grip}-${hour}`, session_started_at: `${date}T${String(hour).padStart(2, '0')}:00:00Z`,
    date, grip, hand, set_num: set, rep_num: i + 1, actual_time_s: time,
    target_duration: 30, rest_s: 120, ...extra,
  }));
const grips = ['Micro', 'Crusher'];
const normal = ['2026-09-27', '2026-09-28', TODAY]
  .flatMap(date => grips.flatMap(grip => session(date, grip)));

test('normal morning followed by depleted evening does not establish a sustained decline', () => {
  const extra = grips.flatMap(grip => session(TODAY, grip, 10, { hour: 18 }));
  const before = computeDeload(normal, [], { today: TODAY });
  const after = computeDeload([...normal, ...extra], [], { today: TODAY });
  expect(before.state).toBe('normal');
  expect(after).toEqual(before);
  expect(buildRecoveryTrend([...normal, ...extra], 'Micro')).toHaveLength(4);
  expect(buildRecoveryReadinessTrend([...normal, ...extra], 'Micro')).toHaveLength(3);
});

test('two sessions and both hands on one day remain one independent observation', () => {
  const rows = grips.flatMap(grip => ['L', 'R'].flatMap(hand => [8, 18]
    .flatMap(hour => session(TODAY, grip, 10, { hand, hour }))));
  expect(computeDeload(rows, [], { today: TODAY }).state).toBe('insufficient');
  expect(buildRecoveryReadinessTrend(rows, 'Micro')).toHaveLength(1);
});

test('optional sets cannot pull first-set recovery below expected', () => {
  const extra = grips.flatMap(grip => session(TODAY, grip, 1, { set: 2 }));
  expect(computeDeload([...normal, ...extra], [], { today: TODAY }))
    .toEqual(computeDeload(normal, [], { today: TODAY }));
  // Descriptive work still sees the additional set.
  expect(buildRecoveryTrend([...normal, ...extra], 'Micro').at(-1).observedAtTarget)
    .toBeLessThan(buildRecoveryTrend(normal, 'Micro').at(-1).observedAtTarget);
});

test('two genuinely poor first sets on separate days still trigger concern', () => {
  const rows = ['2026-09-28', TODAY].flatMap(date => grips.flatMap(grip => session(date, grip, 10)));
  const result = computeDeload(rows, [], { today: TODAY });
  expect(result).toMatchObject({ deload: true, severity: 'mild', state: 'systemic_concern' });
  expect(result.signals.gripGaps.Micro).toMatchObject({ independentDates: 2,
    evidenceScope: 'first_session_first_set', firstDate: '2026-09-28', lastDate: TODAY });
});

test('uncertain session order does not promote either session to a readiness check', () => {
  const rows = [8, 18].flatMap(hour => session(TODAY, 'Micro', 10, { hour, session_started_at: null }));
  expect(buildRecoveryReadinessTrend(rows, 'Micro')).toEqual([]);
  expect(buildRecoveryTrend(rows, 'Micro')).toHaveLength(2);
});

test.each(['chaos', 'interrupted'])('a preceding %s workout prevents a later ordinary set from becoming fresh', kind => {
  const earlier = session(TODAY, 'Micro', 10).map(r => ({ ...r,
    ...(kind === 'interrupted' ? { failure_valid: false, end_reason: 'equipment_interruption' } : {}),
    force_recording: { ...r.force_recording,
      ...(kind === 'chaos' ? { session_protocol: { id: 'whole_curve_beta', version: 2 } } : {}),
    },
  }));
  const later = session(TODAY, 'Micro', 10, { hour: 18 });
  expect(buildRecoveryReadinessTrend([...earlier, ...later], 'Micro')).toEqual([]);
  expect(buildRecoveryTrend([...earlier, ...later], 'Micro')).toHaveLength(1);
});

test('a new day does not revive old pre-break evidence; missing current data stays unknown', () => {
  const rows = ['2026-08-01', TODAY].flatMap(date => grips.flatMap(grip => session(date, grip, 10)));
  expect(deloadStatus(rows, [], { today: TODAY })).toMatchObject({ level: 'unknown', haveSignal: false });
});

test('baseline calibration is invariant to later same-day work', () => {
  const history = Array.from({ length: 30 }, (_, i) => {
    const date = new Date(Date.UTC(2026, 8, i + 1)).toISOString().slice(0, 10);
    return session(date, 'Micro', 24 + (i % 5));
  }).flat();
  const extras = history.filter(r => r.rep_num === 1).flatMap(r => session(r.date, 'Micro', 3, { hour: 18 }));
  expect(recentGapHeldOut([...history, ...extras], 'Micro', TODAY, 2))
    .toEqual(recentGapHeldOut(history, 'Micro', TODAY, 2));
});

test('passing time does not make a yellow result green without new measurements', () => {
  const rows = ['2026-09-28', TODAY].flatMap(date => grips.flatMap(grip => session(date, grip, 10)));
  expect(deloadStatus(rows, [], { today: TODAY }).level).toBe('yellow');
  expect(deloadStatus(rows, [], { today: '2026-10-01' }).level).toBe('yellow');
  expect(deloadStatus(rows, [], { today: '2026-10-15' }).level).toBe('unknown');
});
