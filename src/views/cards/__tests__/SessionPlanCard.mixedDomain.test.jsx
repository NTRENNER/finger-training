import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { SessionPlanCard } from '../SessionPlanCard.jsx';
import { MIXED_DOMAIN_LABELS, MIXED_DOMAIN_ZONES } from '../../../model/mixedDomain.js';
import { coachingRecommendationContinuous } from '../../../model/coaching.js';
import { ZONE_REF_T } from '../../../model/zones.js';
import { betaEligibility } from '../../../model/betaEligibility.js';
import { detectPlateaus } from '../../../model/plateau.js';
import { saveLS, LS_EXPERIMENT_UNLOCKS_KEY } from '../../../lib/storage.js';

jest.mock('../../../model/betaEligibility.js', () => ({
  betaEligibility: jest.fn(() => ({ eligible: true })),
}));
jest.mock('../../../model/plateau.js', () => ({
  detectPlateaus: jest.fn(() => ({ byGrip: [] })),
}));
jest.mock('../../../model/prescription.js', () => ({
  prescription: (history, hand, grip, time) => ({ value: 40 - time / 10 }),
}));
jest.mock('../../../model/coaching.js', () => ({
  coachingRecommendationContinuous: jest.fn(),
  COLD_START_BOUNDARY_REPS: 4,
  COLD_START_BOUNDARY_REST_S: 20,
  FRESH_TEST_SHORT_T_MAX: 12,
}));

const goals = Object.fromEntries(MIXED_DOMAIN_ZONES.map(key => [key, {
  label: MIXED_DOMAIN_LABELS[key],
  color: '#fff',
  refTime: ZONE_REF_T[key],
}]));

beforeEach(() => {
  localStorage.clear();
  betaEligibility.mockReturnValue({ eligible: true });
  detectPlateaus.mockReturnValue({ byGrip: [] });
  coachingRecommendationContinuous.mockReturnValue({
    zone: 'power',
    T: 45,
    loadKg: 20,
    loadByHand: { L: 20, R: 20 },
    reasons: [],
  });
});

test('the unlock dialog previews Chaos without replacing the ordinary recommendation by default', () => {
  const apply = jest.fn();
  render(<SessionPlanCard history={[]} grip="Micro" hand="Both" unit="kg"
    GOAL_CONFIG={goals} onApplyPlan={apply} />);
  expect(screen.getByRole('button', { name: 'Use recommended session' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Preview Chaos session' }));
  expect(screen.getByRole('region', { name: 'Chaos Machine beta plan' })).toBeInTheDocument();
  expect(apply.mock.calls.at(-1)[0]).toMatchObject({
    repsPerSet: 5,
    restTime: 30,
    plannedSets: 1,
    mixedDomainPlan: { id: 'whole_curve_beta', adjustLoads: true },
  });
  fireEvent.click(screen.getByRole('button', { name: 'One more work set per hand' }));
  fireEvent.click(screen.getByRole('button', { name: 'One more work set per hand' }));
  expect(apply.mock.calls.at(-1)[0].plannedSets).toBe(3);
  expect(screen.getByRole('switch', { name: 'Chaos Machine' })).toBeChecked();
  fireEvent.click(screen.getByRole('switch', { name: 'Chaos Machine' }));
  expect(screen.getByRole('button', { name: 'Use recommended session' })).toBeInTheDocument();
  expect(apply.mock.calls.at(-1)[0].mixedDomainPlan).toBeNull();
  expect(screen.getByRole('switch', { name: 'Chaos Machine' })).not.toBeChecked();
});

test('Chaos remains available after its unlock explanation is dismissed', () => {
  const view = render(<SessionPlanCard history={[]} grip="Micro" hand="Both" unit="kg"
    GOAL_CONFIG={goals} />);
  fireEvent.click(screen.getByRole('button', { name: 'Keep recommendation' }));
  expect(screen.getByRole('switch', { name: 'Chaos Machine' })).not.toBeChecked();
  view.unmount();

  render(<SessionPlanCard history={[]} grip="Micro" hand="Both" unit="kg"
    GOAL_CONFIG={goals} />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('switch', { name: 'Chaos Machine' }));
  expect(screen.getByRole('region', { name: 'Chaos Machine beta plan' })).toBeInTheDocument();
});

test('Chaos starts at the recommended domain and both hands share the same sequence', () => {
  coachingRecommendationContinuous.mockReturnValue({
    zone: 'strength_endurance',
    T: 160,
    loadKg: 20,
    loadByHand: { L: 20, R: 20 },
    reasons: [],
  });
  const apply = jest.fn();
  render(<SessionPlanCard history={[]} grip="Micro" hand="Both" unit="kg"
    GOAL_CONFIG={goals} onApplyPlan={apply} />);
  fireEvent.click(screen.getByRole('button', { name: 'Preview Chaos session' }));
  expect(screen.getByRole('combobox', { name: 'First domain' })).toHaveValue('strength_endurance');
  expect(apply.mock.calls.at(-1)[0].mixedDomainPlan.steps.map(step => step.zone)).toEqual([
    'strength_endurance', 'endurance', 'power', 'power_strength', 'strength',
  ]);
  const left = within(screen.getByRole('list', { name: 'Left hand holds' }))
    .getAllByRole('listitem').map(element => element.textContent);
  const right = within(screen.getByRole('list', { name: 'Right hand holds' }))
    .getAllByRole('listitem').map(element => element.textContent);
  expect(left).toEqual(right);
});

test('incomplete domain estimates do not advertise Chaos', () => {
  saveLS(LS_EXPERIMENT_UNLOCKS_KEY, { 'chaos:Micro': true });
  render(<SessionPlanCard history={[]} grip="Micro" unit="kg" GOAL_CONFIG={{ power: goals.power }} />);
  expect(screen.queryByRole('dialog', { name: /Chaos Machine/ })).not.toBeInTheDocument();
  expect(screen.getByRole('switch', { name: 'Chaos Machine' })).toBeDisabled();
});
