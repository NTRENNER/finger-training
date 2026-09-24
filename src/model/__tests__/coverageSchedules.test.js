import { coachingRecommendationContinuous } from '../coaching.js';
import { computeDensityLadder } from '../densityLadder.js';
import { TRAINING_ZONE_KEYS, ZONE_REF_T, zoneOf } from '../zones.js';
import { getLastZoneTrainedDates } from '../lockout.js';
import { predForceThreeExp } from '../threeExp.js';

const date = day => new Date(Date.UTC(2026, 0, day)).toISOString().slice(0, 10);
const session = (day, T, n = 4) => ['L', 'R'].flatMap(hand => Array.from({ length: n }, (_, i) => ({
  id: `${day}-${hand}-${i}`, session_id: `s-${day}`, date: date(day), grip: 'Crusher', hand,
  set_num: 1, rep_num: i + 1, target_duration: T, rest_s: 20,
  actual_time_s: i ? T * .5 : T, avg_force_kg: predForceThreeExp([25, 15, 20], T),
  prescribed_load_kg: predForceThreeExp([25, 15, 20], T),
})));
const seed = () => [5, 30, 70, 115, 160, 220].flatMap((T, i) => session(i + 1, T));

test.each([3, 7])('all five domains remain reachable with %i-day gaps, climbing and a missed week', gap => {
  let history = seed();
  const selected = [];
  for (let i = 0; i < 15; i++) {
    const day = 14 + i * gap + (i >= 5 ? 7 : 0);
    const today = date(day);
    const activities = [{ type: 'climbing', date: today, rpe: 8 }];
    const rec = coachingRecommendationContinuous(history, 'Crusher', { today, activities });
    expect(rec).not.toBeNull();
    const withoutClimb = coachingRecommendationContinuous(history, 'Crusher', { today });
    expect(rec.zone).toBe(withoutClimb.zone);
    selected.push(rec.zone);
    // Exercise real selection and domain ladder independently. This synthetic
    // athlete lands the chosen domain; this is a scheduling test, not accuracy.
    const T = ZONE_REF_T[rec.zone];
    history = [...history, ...session(day, T)];
  }
  expect(new Set(selected)).toEqual(new Set(TRAINING_ZONE_KEYS));
});

test.each([4, 5, 6])('returning after other domains preserves the earned progression from %i holds', n => {
  const power = session(10, 30, n);
  const before = computeDensityLadder(power, 'Crusher', 'power', { expectedHands: ['L', 'R'] });
  const withOtherDomains = [...power, ...session(20, 115), ...session(30, 220)];
  expect(computeDensityLadder(withOtherDomains, 'Crusher', 'power', { expectedHands: ['L', 'R'] }))
    .toEqual(before);
  expect(before.reps).toBe(n === 6 ? 4 : n + 1);
});

test('later beta holds, optional sets and interruptions do not refresh opening-hold evidence', () => {
  const history = session(1, 115);
  const bad = session(20, 30).map(r => ({ ...r, failure_valid: false }));
  const optional = session(21, 70).map(r => ({ ...r, set_num: 2 }));
  const beta = TRAINING_ZONE_KEYS.map((zone, i) => ({ ...session(22, ZONE_REF_T[zone])[0],
    id: `beta-${i}`, rep_num: i + 1, force_recording: { session_protocol: {
      id: 'whole_curve_beta', role: i ? 'fatigued_hold' : 'opening_hold', zone,
    } } }));
  const dates = getLastZoneTrainedDates([...history, ...bad, ...optional, ...beta]);
  expect(dates.power).toBe(date(22));
  expect(dates.strength).toBe(date(1));
  expect(dates.power_strength).toBeNull();
  expect(dates.endurance).toBeNull();
});

test('future workouts cannot change an as-of recommendation', () => {
  const history = seed();
  const before = coachingRecommendationContinuous(history, 'Crusher', { today: date(15) });
  expect(coachingRecommendationContinuous([...history, ...session(40, 30)], 'Crusher', { today: date(15) })).toEqual(before);
  expect(zoneOf(before.T)).toBe(before.zone);
});
