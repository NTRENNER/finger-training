import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SessionPlanCard } from '../SessionPlanCard.jsx';
import { createVolumeExperiment } from '../../../model/volumeExperiment.js';
import { saveLS, LS_EXPERIMENT_UNLOCKS_KEY } from '../../../lib/storage.js';
import { TRAINING_ZONE_KEYS, ZONE_REF_T } from '../../../model/zones.js';
import { coachingRecommendationContinuous } from '../../../model/coaching.js';
import { today } from '../../../util.js';
import { betaEligibility } from '../../../model/betaEligibility.js';
import { detectPlateaus } from '../../../model/plateau.js';

jest.mock('../../../model/betaEligibility.js', () => ({
  betaEligibility: jest.fn(() => ({ eligible: true })),
}));
jest.mock('../../../model/plateau.js', () => ({
  detectPlateaus: jest.fn(() => ({
    byGrip: [{ grip: 'Micro', recommendation: 'consider_volume_beta' }],
  })),
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
jest.mock('../../../util.js', () => ({
  ...jest.requireActual('../../../util.js'),
  today: jest.fn(),
}));

const goals = Object.fromEntries(TRAINING_ZONE_KEYS.map(key => [key, {
  label: key,
  color: '#fff',
  refTime: ZONE_REF_T[key],
}]));
const props = {
  history: [],
  grip: 'Micro',
  hand: 'Both',
  unit: 'kg',
  GOAL_CONFIG: goals,
  onStartVolumeExperiment: jest.fn(),
};
const lastPlan = apply => apply.mock.calls.at(-1)[0];

beforeEach(() => {
  localStorage.clear();
  today.mockReturnValue('2026-10-01');
  betaEligibility.mockReturnValue({ eligible: true });
  detectPlateaus.mockReturnValue({
    byGrip: [{ grip: 'Micro', recommendation: 'consider_volume_beta' }],
  });
  coachingRecommendationContinuous.mockReturnValue({
    zone: 'power',
    T: 30,
    loadKg: 30,
    loadByHand: { L: 30, R: 30 },
    reasons: [],
  });
});

test('newly available experiments are explained once instead of occupying the training page', () => {
  const view = render(<SessionPlanCard {...props} />);
  expect(screen.getByRole('dialog', { name: 'New training options available' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Keep recommendation' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('switch', { name: 'Chaos Machine' })).not.toBeChecked();
  expect(screen.queryByText(/Your choice for this workout/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Betas unlock after/)).not.toBeInTheDocument();
  view.unmount();
  render(<SessionPlanCard {...props} />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('switch', { name: 'Chaos Machine' })).toBeInTheDocument();
});

test('the compact work-set selector defaults to one and updates only this workout', () => {
  saveLS(LS_EXPERIMENT_UNLOCKS_KEY, { 'chaos:Micro': true, 'volume:Micro': true });
  const apply = jest.fn();
  render(<SessionPlanCard {...props} onApplyPlan={apply} />);
  expect(screen.getByRole('group', { name: 'Work sets per hand' })).toHaveTextContent('1set / hand');
  fireEvent.click(screen.getByRole('button', { name: 'One more work set per hand' }));
  fireEvent.click(screen.getByRole('button', { name: 'One more work set per hand' }));
  expect(lastPlan(apply)).toMatchObject({ plannedSets: 3, volumePlan: null, mixedDomainPlan: null });
  expect(screen.getByText(/5 min recovery between sets/)).toBeInTheDocument();
});

test('the Volume unlock dialog opens enrollment and starts only after confirmation', async () => {
  saveLS(LS_EXPERIMENT_UNLOCKS_KEY, { 'chaos:Micro': true });
  const start = jest.fn(() => true);
  render(<SessionPlanCard {...props} onStartVolumeExperiment={start} />);
  expect(screen.getByRole('dialog', { name: 'Volume Beta is available' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Review Volume Beta' }));
  expect(screen.getByRole('dialog', { name: 'Review Volume Beta' })).toBeInTheDocument();
  expect(screen.getByRole('switch', { name: 'Micro' })).toBeChecked();
  expect(start).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Start Volume Beta' }));
  await waitFor(() => expect(start).toHaveBeenCalledWith({
    grips: ['Micro'],
    trigger: 'plateau_prompt',
  }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('Volume stays reviewable after its unlock explanation is dismissed, while the plateau lasts', async () => {
  saveLS(LS_EXPERIMENT_UNLOCKS_KEY, { 'chaos:Micro': true });
  const start = jest.fn(() => true);
  const view = render(<SessionPlanCard {...props} onStartVolumeExperiment={start} />);
  fireEvent.click(screen.getByRole('button', { name: 'Keep recommendation' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  expect(screen.getByRole('dialog', { name: 'Review Volume Beta' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Start Volume Beta' }));
  await waitFor(() => expect(start).toHaveBeenCalledWith({ grips: ['Micro'], trigger: 'plateau_prompt' }));
  view.unmount();

  detectPlateaus.mockReturnValue({ byGrip: [] });
  render(<SessionPlanCard {...props} />);
  expect(screen.queryByText('Volume Beta')).not.toBeInTheDocument();
});

test('an active Volume plan selects two sets, while a manual count opts this workout out', () => {
  saveLS(LS_EXPERIMENT_UNLOCKS_KEY, { 'chaos:Micro': true, 'volume:Micro': true });
  const experiment = createVolumeExperiment({
    history: [],
    grips: ['Micro'],
    startDate: '2026-10-01',
    id: 'volume-test',
  });
  const apply = jest.fn();
  render(<SessionPlanCard {...props} volumeExperiment={experiment} onApplyPlan={apply} />);
  expect(screen.getByRole('group', { name: 'Work sets per hand' })).toHaveTextContent('2sets / hand');
  expect(lastPlan(apply).volumePlan).toMatchObject({ id: 'volume_beta', sets: 2 });
  fireEvent.click(screen.getByRole('button', { name: 'One more work set per hand' }));
  fireEvent.click(screen.getByRole('button', { name: 'One more work set per hand' }));
  expect(lastPlan(apply)).toMatchObject({ plannedSets: 4, volumePlan: null });
});

test('peak tests do not expose the work-set selector', () => {
  saveLS(LS_EXPERIMENT_UNLOCKS_KEY, { 'chaos:Micro': true, 'volume:Micro': true });
  coachingRecommendationContinuous.mockReturnValue({
    peakTest: true,
    zone: 'max_strength',
    T: 3,
    reasons: [],
  });
  render(<SessionPlanCard {...props} />);
  expect(screen.queryByRole('group', { name: 'Work sets per hand' })).not.toBeInTheDocument();
});
