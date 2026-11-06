import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { SessionPlanCard } from '../SessionPlanCard.jsx';
import { ZONE_REF_T, TRAINING_ZONE_KEYS } from '../../../model/zones.js';
import { pilotEnrollment } from '../../../model/emphasisPilot.js';
jest.mock('../../../model/coaching.js', () => ({ coachingRecommendationContinuous: () => ({
  zone: 'power', T: 30, hand: 'L', loadByHand: { L: 30, R: 30 }, reasons: [], candidates: [],
}) }));
jest.mock('../../../util.js', () => ({ ...jest.requireActual('../../../util.js'), today: () => '2026-11-05' }));

const goals = Object.fromEntries(TRAINING_ZONE_KEYS.map(key => [key, { label: key, color: '#fff', refTime: ZONE_REF_T[key] }]));
const ladderSession = ['L', 'R'].flatMap(hand => Array.from({ length: 4 }, (_, i) => ({
  id: `${hand}-${i}`, session_id: 'strength', date: '2026-09-20', grip: 'Micro', hand,
  set_num: 1, rep_num: i + 1, target_duration: 110, actual_time_s: i ? 60 : 110,
  avg_force_kg: 20, prescribed_load_kg: 20, rest_s: 20,
})));
const enrollment = pilotEnrollment('emphasis-2026-11', 'active');

// Pilot sessions use one fixed time per domain on every grip (Strength 115 s).
// A ladder pinned at another time (here 110 s) restarts at the target.
test('an enrolled athlete is shown the pilot step at its fixed time, with the engine pick logged', () => {
  const apply = jest.fn();
  render(<SessionPlanCard history={ladderSession} grip="Micro" hand="Both" unit="kg" GOAL_CONFIG={goals}
    onApplyPlan={apply} pilotEnrollment={enrollment} />);
  expect(screen.getByText('★ Pilot · Long end · day 4 of 28')).toBeInTheDocument();
  const plan = apply.mock.calls.at(-1)[0];
  expect(plan).toMatchObject({ goal: 'strength', targetTime: 115, peakTest: false, ladderLoadByHand: null });
  expect(plan.decision).toMatchObject({
    recommended: { zone: 'power' }, overridden: false, plan_source: 'curve',
    pilot: { version: 2, block: 'B', emphasis: 'long', step: 1, cycle_length: 8, zone: 'strength' },
  });

  fireEvent.click(screen.getByRole('button', { name: 'Train endurance at 220 seconds' }));
  expect(screen.getByText('↩ Use pilot session')).toBeInTheDocument();
  expect(apply.mock.calls.at(-1)[0].decision).toMatchObject({ overridden: true, pilot: { zone: 'strength' } });
});

test('a domain without a ladder starts from the curve at its reference duration', () => {
  const apply = jest.fn();
  const history = [...ladderSession, ...['L', 'R'].map(hand => ({ ...ladderSession[0], id: `nov-${hand}`,
    session_id: 'nov', date: '2026-11-03', hand }))];
  render(<SessionPlanCard history={history} grip="Micro" hand="Both" unit="kg" GOAL_CONFIG={goals}
    onApplyPlan={apply} pilotEnrollment={enrollment} />);
  expect(apply.mock.calls.at(-1)[0]).toMatchObject({ goal: 'strength_endurance', targetTime: 160, ladderLoadByHand: null });
  expect(screen.getByText(/Step 2 of 8 in the long-end block/)).toBeInTheDocument();
});

test('without enrollment the plan card is unchanged', () => {
  const apply = jest.fn();
  render(<SessionPlanCard history={ladderSession} grip="Micro" hand="Both" unit="kg" GOAL_CONFIG={goals} onApplyPlan={apply} />);
  expect(screen.getByText('★ Recommended')).toBeInTheDocument();
  expect(apply.mock.calls.at(-1)[0]).toMatchObject({ goal: 'power' });
  expect(apply.mock.calls.at(-1)[0].decision.pilot).toBeNull();
});

test('a ladder already at the fixed time carries over', () => {
  const apply = jest.fn();
  const at115 = ladderSession.map(r => ({ ...r, target_duration: 115, actual_time_s: r.rep_num === 1 ? 115 : 60 }));
  render(<SessionPlanCard history={at115} grip="Micro" hand="Both" unit="kg" GOAL_CONFIG={goals}
    onApplyPlan={apply} pilotEnrollment={enrollment} />);
  const plan = apply.mock.calls.at(-1)[0];
  expect(plan).toMatchObject({ goal: 'strength', targetTime: 115 });
  expect(plan.decision.plan_source).toBe('ladder');
});

test('the pilot targets are one time per domain', () => {
  const { PILOT_TARGET_S } = require('../../../model/emphasisPilot.js');
  expect(PILOT_TARGET_S).toMatchObject({ power: 20, power_strength: 70, strength: 115, strength_endurance: 160, endurance: 220 });
});
