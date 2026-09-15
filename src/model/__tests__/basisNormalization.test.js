import { comparableCapacityHistory, legacyIntervalRep } from '../forceRecording.js';
import { freshFitReps } from '../load.js';
import { buildGripBaselines, gripBaselineProgress,
  GRIP_BASELINE_REP_THRESHOLD, GRIP_BASELINE_DURATION_THRESHOLD } from '../baselines.js';
import { buildThreeExpPriors } from '../threeExp.js';

// Pre-basis row: whole-pull timing, no provenance/recording columns.
const earlier = (date, secs, kg, over = {}) => ({
  id: `e-${date}-${secs}`, session_id: `e-${date}`, date, grip: 'Micro', hand: 'L',
  set_num: 1, rep_num: 1, target_duration: secs, actual_time_s: secs,
  avg_force_kg: kg, peak_force_kg: kg + 1, failed: true, ...over,
});

// v3 row: at-target interval only, with the acquisition offset recorded.
const acquired = (date, secs, kg, acquisition = 1.4, over = {}) => ({
  id: `a-${date}-${secs}`, session_id: `a-${date}`, date, grip: 'Micro', hand: 'L',
  set_num: 1, rep_num: 1, target_duration: secs, actual_time_s: secs,
  avg_force_kg: kg, peak_force_kg: kg + 1, failed: true,
  load_provenance: 'measured_force', failure_valid: true, end_reason: 'target_force_failure',
  force_recording: { version: 3, basis: 'target_acquired', capacity_eligible: true,
    signal_quality: 'complete', duration_s: secs, acquisition_s: acquisition,
    activity: { duration_s: secs + acquisition, avg_force_kg: kg * 0.96 } },
  ...over,
});

test('a v3 rep is expressed on the earlier whole-pull interval', () => {
  const converted = legacyIntervalRep(acquired('2026-09-14', 45.5, 13.7, 3.77));
  expect(converted.actual_time_s).toBeCloseTo(49.27, 5);
  expect(converted.avg_force_kg).toBe(13.7);              // force axis is unchanged
  expect(converted.force_recording.interval_basis_applied).toBe('legacy_elapsed');
  expect(converted.force_recording.duration_s).toBe(45.5); // native record preserved
});

test('a grip spanning the change keeps both generations in one series', () => {
  const history = [earlier('2026-08-01', 30, 15), earlier('2026-08-08', 90, 12),
    acquired('2026-09-14', 45.5, 13.7, 3.77)];
  const out = comparableCapacityHistory(history);
  expect(out).toHaveLength(3);
  expect(out.map(r => Math.round(r.actual_time_s * 100) / 100)).toEqual([30, 90, 49.27]);
});

test('a grip recorded entirely on one basis keeps its native intervals', () => {
  const onlyEarlier = [earlier('2026-08-01', 30, 15), earlier('2026-08-08', 90, 12)];
  expect(comparableCapacityHistory(onlyEarlier)).toEqual(onlyEarlier);

  const onlyAcquired = [acquired('2026-09-14', 45.5, 13.7), acquired('2026-09-18', 20, 16)];
  expect(comparableCapacityHistory(onlyAcquired).map(r => r.actual_time_s)).toEqual([45.5, 20]);
});

test('one grip switching does not disturb another grip', () => {
  const history = [earlier('2026-08-01', 30, 15),
    acquired('2026-09-14', 45.5, 13.7, 3.77),
    earlier('2026-08-02', 30, 25, { id: 'c1', grip: 'Crusher' }),
    earlier('2026-08-09', 90, 20, { id: 'c2', grip: 'Crusher' })];
  const out = comparableCapacityHistory(history);
  expect(out.filter(r => r.grip === 'Crusher').map(r => r.actual_time_s)).toEqual([30, 90]);
  expect(out.filter(r => r.grip === 'Micro')).toHaveLength(2);
});

test('only an unconvertible v3 rep is dropped, and only from a spanning grip', () => {
  const noOffset = acquired('2026-09-14', 45.5, 13.7);
  delete noOffset.force_recording.acquisition_s;
  const out = comparableCapacityHistory([earlier('2026-08-01', 30, 15), noOffset,
    acquired('2026-09-18', 20, 16, 1.1)]);
  expect(out.map(r => r.id)).toEqual(['e-2026-08-01-30', 'a-2026-09-18-20']);
});

// The regression this replaces: one session on the new basis used to purge
// every earlier rep for that grip, taking the grip's baseline with it.
describe('a long history plus one new-basis session', () => {
  const history = [];
  for (let i = 0; i < 40; i++) {
    const secs = [20, 45, 90, 160][i % 4];
    history.push(earlier(new Date(Date.UTC(2026, 3, 20) + i * 3 * 86400000).toISOString().slice(0, 10),
      secs, [24, 18, 15, 13][i % 4]));
  }
  // One session, one target duration — the shape that cannot seed a baseline.
  const session = [45.5, 15.9, 7.3].map((secs, n) =>
    acquired('2026-09-14', secs, 13.7, 1.4, { id: `s-${n}`, session_id: 's', rep_num: n + 1, target_duration: 50 }));
  const mixed = [...history, ...session];

  test('the earlier reps stay in the fit', () => {
    expect(freshFitReps(mixed).filter(r => r.grip === 'Micro').length).toBeGreaterThan(30);
  });

  test('the grip keeps its baseline', () => {
    const priors = buildThreeExpPriors(mixed);
    const baselines = buildGripBaselines(mixed, priors);
    expect(baselines.Micro).toBeTruthy();
    expect(Array.isArray(baselines.Micro.amps)).toBe(true);
  });

  test('baseline progress is not reset to the early-days state', () => {
    const progress = gripBaselineProgress(mixed, 'Micro');
    expect(progress.qualifyingReps).toBeGreaterThanOrEqual(GRIP_BASELINE_REP_THRESHOLD);
    expect(progress.distinctDurations).toBeGreaterThanOrEqual(GRIP_BASELINE_DURATION_THRESHOLD);
  });
});
