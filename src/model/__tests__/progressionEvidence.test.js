import { computeDensityLadder } from '../densityLadder.js';
import { progressionSetEvidence } from '../progressionEvidence.js';
import { sessionAdjustment } from '../cookedScaling.js';
import { predictRepTimes } from '../fatigue.js';
import { buildPhysModel } from '../repCurveData.js';
import { recommendAnotherSet } from '../setRecommendation.js';

const session = (times = [40, 24, 16, 12], options = {}) => {
  const { date = '2026-09-29', id = date, rest = 20, count = times.length,
    loads = times.map(() => 40), adjusted = false, base = 40, snapshot = true } = options;
  return times.map((t, i) => ({ id: `${id}-${i}`, session_id: id, date,
    session_started_at: `${date}T08:00:00Z`, grip: 'Crusher', hand: 'L', set_num: 1, rep_num: i + 1,
    target_duration: 40, actual_time_s: t, avg_force_kg: loads[i], peak_force_kg: loads[i] + 1,
    prescribed_load_kg: loads[0], rest_s: 20, failure_valid: true, load_provenance: 'measured_force',
    session_adjustment: sessionAdjustment(8, adjusted),
    rep_timing: { rest_before_s: i ? rest : null },
    force_recording: { version: 4, capacity_eligible: true, acquisition_s: 2,
      ...(snapshot ? { session_prescription: { version: 1, target_duration_s: 40, reps_per_set: count,
        rest_s: 20, load_kg: loads[0], base_load_kg: base, hand_mode: 'L' } } : {}) },
  }));
};
const ladder = h => computeDensityLadder(h, 'Crusher', 'power');

test('an interrupted attempted rung repeats its frozen plan instead of returning the new-domain default', () => {
  const prior = session(undefined, { date: '2026-09-28' });
  expect(ladder(prior)).toMatchObject({ decision: 'advance', reps: 5 });
  const interrupted = session([40, 24, 16, 12, 10]);
  interrupted[2].failure_valid = false;
  expect(ladder([...prior, ...interrupted])).toMatchObject({ decision: 'incomplete', reps: 5, loadByHand: { L: 40 } });
  const repeatedInterruption = session([40], { date: '2026-09-30', count: 5 });
  repeatedInterruption[0].failure_valid = false;
  expect(ladder([...prior, ...interrupted, ...repeatedInterruption])).toMatchObject({ decision: 'incomplete', reps: 5, loadByHand: { L: 40 } });
});

test('an old partial attempt preserves the prior earned rung without granting another advancement', () => {
  const prior = session(undefined, { date: '2026-09-28', snapshot: false });
  const partial = session([40, 24], { snapshot: false });
  expect(ladder([...prior, ...partial])).toMatchObject({ decision: 'incomplete', reps: 5, loadByHand: { L: 40 } });
});

test.each([
  ['missing opener', rs => rs.slice(1)],
  ['missing middle rep', rs => rs.filter(r => r.rep_num !== 3)],
  ['deleted last rep', rs => rs.slice(0, -1)],
  ['duplicate slot', rs => [...rs.slice(0, -1), rs[2]]],
  ['interrupted opener', rs => rs.map((r, i) => i ? r : { ...r, failure_valid: false })],
])('%s cannot earn a new rung', (_, alter) => {
  expect(ladder(alter(session()))).toMatchObject({ decision: 'incomplete', reps: 4, loadByHand: { L: 40 } });
});

test('easier later loads cannot earn advancement at the opening load', () => {
  const h = session([40, 40, 40, 40], { loads: [40, 15, 15, 15] });
  expect(ladder(h)).toMatchObject({ decision: 'incomplete', reps: 4, loadByHand: { L: 40 },
    basis: { evidenceByHand: { L: { reason: 'force_changed' } } } });
});

test('normal delay and ramp-up preserve measured rest and normal 4–5–6 progression', () => {
  for (const count of [4, 5, 6]) {
    const h = session(Array(count).fill(40), { rest: 22 });
    const evidence = progressionSetEvidence(h);
    expect(evidence.complete).toBe(true);
    expect(evidence.rests).toEqual(Array(count - 1).fill(22)); // acquisition_s=2 is separate
    expect(ladder(h)).toMatchObject({ decision: count === 6 ? 'step_load' : 'advance',
      reps: count === 6 ? 4 : count + 1 });
  }
});

test('actual rest qualifies the collapse forecast rather than being an adherence gate', () => {
  const physModel = buildPhysModel([], 'L', 'Crusher');
  const atFive = predictRepTimes({ numReps: 4, firstRepTime: 40, restSeconds: 5, physModel });
  expect(ladder(session(atFive, { rest: 5 }))).toMatchObject({ decision: 'repeat', loadByHand: { L: 40 }, basis: { collapseByHand: {} } });
  const atFifty = predictRepTimes({ numReps: 4, firstRepTime: 40, restSeconds: 50, physModel });
  const underperforming = atFifty.map((t, i) => i ? t * .7 : t);
  expect(ladder(session(underperforming, { rest: 50 }))).toMatchObject({ decision: 'down_step', loadByHand: { L: 36 },
    basis: { collapseByHand: { L: { C: .7 } } } });
  expect(ladder(session(atFifty, { rest: 50 }))).toMatchObject({ decision: 'advance', reps: 5 });
});

test('release not observed or missing modern timing retains the rung without interpreting unknown recovery', () => {
  for (const unknown of ['release', 'rest']) {
    const h = session();
    if (unknown === 'release') h[1].force_recording.recording_stop_reason = 'release_not_observed';
    else h[1].rep_timing.rest_before_s = null;
    expect(ladder(h)).toMatchObject({ decision: 'incomplete', reps: 4, loadByHand: { L: 40 } });
  }
});

test('old untimed data remains explicitly estimated instead of being rewritten', () => {
  const h = session(undefined, { snapshot: false }).map(({ rep_timing, ...r }) => r);
  expect(progressionSetEvidence(h)).toMatchObject({ complete: true, restBasis: 'planned_rest_estimate', rests: [20, 20, 20] });
});

test('reduced-load performance restores only the saved base plan and cannot earn a higher rung', () => {
  const h = session(undefined, { adjusted: true, base: 50 });
  expect(ladder(h)).toMatchObject({ decision: 'repeat', reps: 4, loadByHand: { L: 50 },
    basis: { restoredPlanByHand: { L: 50 } } });
  const legacy = session(undefined, { adjusted: true, snapshot: false });
  expect(ladder(legacy)).toMatchObject({ decision: 'repeat', reps: 4, loadByHand: { L: 40 },
    basis: { restoredPlanByHand: {} } });
});

test('optional volume uses measured rest and does not reward easier later loads', () => {
  const config = { grip: 'Crusher', hand: 'L', targetTime: 40, repsPerSet: 4, restTime: 20 };
  const first = session();
  const next = session([40, 18.34, 16.73, 15.89], { rest: 50 }).map(r => ({ ...r, set_num: 2 }));
  expect(recommendAnotherSet({ sessionReps: [...first, ...next], config, setNum: 2 })).toBeNull();
  const changed = session([40, 40, 40, 40], { loads: [40, 15, 15, 15] }).map(r => ({ ...r, set_num: 2 }));
  expect(recommendAnotherSet({ sessionReps: [...first, ...changed], config, setNum: 2 })).toBeNull();
  const ordinary = session([40, 24, 20, 18], { rest: 22 }).map(r => ({ ...r, set_num: 2 }));
  expect(recommendAnotherSet({ sessionReps: [...first, ...ordinary], config, setNum: 2 })?.recommend).toBe(true);
});


test.each([
  ['missing opener', rs => rs.slice(1)],
  ['interrupted opener', rs => rs.map((r, i) => i ? r : { ...r, failure_valid: false })],
  ['changed first-set load', rs => rs.map((r, i) => i ? { ...r, avg_force_kg: 15 } : r)],
])('a valid optional set cannot mask %s in the original set', (_, alter) => {
  const first = alter(session());
  const optional = session().map(r => ({ ...r, id: `${r.id}-optional`, set_num: 2 }));
  expect(ladder([...first, ...optional])).toMatchObject({ decision: 'incomplete', reps: 4,
    loadByHand: { L: 40 } });
});

test('modern records require original slot numbers while unnumbered untimed legacy data remains explicit', () => {
  const modern = session().map(({ rep_num, ...r }) => r);
  expect(progressionSetEvidence(modern)).toMatchObject({ complete: false, reason: 'missing_or_duplicate_rep' });
  const legacy = modern.map(({ rep_timing, force_recording, ...r }) => r);
  expect(progressionSetEvidence(legacy)).toMatchObject({ complete: true, restBasis: 'planned_rest_estimate' });
});


test('optional-set retention requires a complete comparable original set', () => {
  const config = { grip: 'Crusher', hand: 'L', targetTime: 40, repsPerSet: 4, restTime: 20 };
  const first = session();
  const optional = session([40, 24, 20, 18]).map(r => ({ ...r, set_num: 2 }));
  expect(recommendAnotherSet({ sessionReps: [...first.slice(1), ...optional], config, setNum: 2 })).toBeNull();
  const interrupted = first.map((r, i) => i ? r : { ...r, failure_valid: false });
  expect(recommendAnotherSet({ sessionReps: [...interrupted, ...optional], config, setNum: 2 })).toBeNull();
  const lighter = optional.map(r => ({ ...r, avg_force_kg: 15 }));
  expect(recommendAnotherSet({ sessionReps: [...first, ...lighter], config, setNum: 2 })).toBeNull();
});
