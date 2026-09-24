import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { SessionPlanCard } from '../SessionPlanCard.js';
import { computeDensityLadder } from '../../../model/densityLadder.js';
import { ZONE_REF_T, TRAINING_ZONE_KEYS } from '../../../model/zones.js';
jest.mock('../../../model/coaching.js', () => ({ coachingRecommendationContinuous: () => ({
  zone: 'power', T: 30, loadByHand: { L: 30, R: 30 }, reasons: [],
}) }));
const goals = Object.fromEntries(TRAINING_ZONE_KEYS.map(key => [key, { label: key, color: '#fff', refTime: ZONE_REF_T[key] }]));
const history = ['L', 'R'].flatMap(hand => Array.from({ length: 4 }, (_, i) => ({
  id: `${hand}-${i}`, session_id: 'strength', date: '2026-09-20', grip: 'Micro', hand,
  set_num: 1, rep_num: i + 1, target_duration: 110, actual_time_s: i ? 60 : 110,
  avg_force_kg: 20, prescribed_load_kg: 20, rest_s: 20,
})));
test('any alternate domain can be selected and returning to it keeps its earned rung and load', () => {
  const apply = jest.fn();
  const earned = computeDensityLadder(history, 'Micro', 'strength', { expectedHands: ['L', 'R'] });
  render(<SessionPlanCard history={history} grip="Micro" hand="Both" unit="kg" GOAL_CONFIG={goals} onApplyPlan={apply} />);
  fireEvent.click(screen.getByRole('button', { name: 'Train strength at 110 seconds' }));
  expect(apply.mock.calls.at(-1)[0]).toMatchObject({ goal: 'strength', targetTime: 110,
    repsPerSet: 5, ladderLoadByHand: earned.loadByHand });
  fireEvent.click(screen.getByRole('button', { name: 'Train endurance at 220 seconds' }));
  expect(apply.mock.calls.at(-1)[0].goal).toBe('endurance');
  fireEvent.click(screen.getByRole('button', { name: 'Train strength at 110 seconds' }));
  expect(apply.mock.calls.at(-1)[0].repsPerSet).toBe(5);
  fireEvent.click(screen.getByRole('button', { name: 'Use recommended session' }));
  expect(apply.mock.calls.at(-1)[0].goal).toBe('power');
});
