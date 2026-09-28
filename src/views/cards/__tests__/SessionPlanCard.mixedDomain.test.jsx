import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { SessionPlanCard } from '../SessionPlanCard.js';
import { MIXED_DOMAIN_LABELS, MIXED_DOMAIN_ZONES } from '../../../model/mixedDomain.js';
import { ZONE_REF_T } from '../../../model/zones.js';
jest.mock('../../../model/prescription.js', () => ({ prescription: (history, h, g, t) => ({ value: 40 - t / 10 }) }));
jest.mock('../../../model/coaching.js', () => ({ coachingRecommendationContinuous: () => ({
  zone: 'power', T: 45, loadKg: 20, loadByHand: { L: 20, R: 20 }, reasons: [],
}) }));
const goals = Object.fromEntries(MIXED_DOMAIN_ZONES.map(key => [key, { label: MIXED_DOMAIN_LABELS[key], color: '#fff', refTime: ZONE_REF_T[key] }]));
test('beta is off by default, previews the five loads, supports another opener and returns to the regular plan', () => {
  const apply = jest.fn();
  render(<SessionPlanCard history={[]} grip="Micro" hand="Both" unit="kg" GOAL_CONFIG={goals} onApplyPlan={apply} />);
  const toggle = screen.getByRole('checkbox', { name: 'Chaos Machine (Beta)' });
  expect(toggle).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'Use recommended session' })).toBeInTheDocument();
  fireEvent.click(toggle);
  expect(screen.getByRole('region', { name: 'Chaos Machine beta plan' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Use recommended session' })).not.toBeInTheDocument();
  expect(apply.mock.calls.at(-1)[0]).toMatchObject({ repsPerSet: 5, restTime: 30,
    ladderLoadByHand: null, mixedDomainPlan: { id: 'whole_curve_beta', adjustLoads: true } });
  fireEvent.change(screen.getByRole('combobox', { name: 'First domain' }), { target: { value: 'endurance' } });
  expect(apply.mock.calls.at(-1)[0]).toMatchObject({ goal: 'endurance', targetTime: 220, plannedLoadByHand: { L: 18, R: 18 } });
  fireEvent.click(toggle);
  expect(apply.mock.calls.at(-1)[0]).toMatchObject({ goal: 'power', targetTime: 45, restTime: 20, mixedDomainPlan: null });
});
test('missing domain estimates disable the beta', () => {
  render(<SessionPlanCard history={[]} grip="Micro" unit="kg" GOAL_CONFIG={{ power: goals.power }} />);
  expect(screen.getByRole('checkbox', { name: 'Chaos Machine (Beta)' })).toBeDisabled();
});

test('adaptive loads are automatic, show total target time and remain enabled for another grip', () => {
  const apply = jest.fn();
  const view = render(<SessionPlanCard history={[]} grip="Micro" hand="Both" unit="kg" GOAL_CONFIG={goals} onApplyPlan={apply} />);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Chaos Machine (Beta)' }));
  expect(screen.queryByRole('checkbox', { name:'Adjust loads to target times' })).not.toBeInTheDocument();
  expect(apply.mock.calls.at(-1)[0].mixedDomainPlan.adjustLoads).toBe(true);
  expect(screen.getByText(/About 23:50 for both hands/)).toBeInTheDocument();
  expect(screen.getAllByText('Starting reference · adjusted before this hold')).toHaveLength(8);
  view.rerender(<SessionPlanCard history={[]} grip="Crusher" hand="Both" unit="kg" GOAL_CONFIG={goals} onApplyPlan={apply} />);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Chaos Machine (Beta)' }));
  expect(screen.queryByRole('checkbox', { name:'Adjust loads to target times' })).not.toBeInTheDocument();
  expect(apply.mock.calls.at(-1)[0].mixedDomainPlan.adjustLoads).toBe(true);
});
