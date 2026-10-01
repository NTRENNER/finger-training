import { detectPlateaus } from '../../../model/plateau.js';
import { betaEligibility } from '../../../model/betaEligibility.js';
import React, { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SessionPlanCard } from '../SessionPlanCard.jsx';
import { createVolumeExperiment } from '../../../model/volumeExperiment.js';
import { computeDensityLadder } from '../../../model/densityLadder.js';
import { coachingRecommendationContinuous } from '../../../model/coaching.js';
import { today } from '../../../util.js';
import { TRAINING_ZONE_KEYS, ZONE_REF_T } from '../../../model/zones.js';
jest.mock('../../../model/plateau.js', () => ({ detectPlateaus: jest.fn(() => ({ byGrip: [] })) }));
beforeEach(() => detectPlateaus.mockReturnValue({ byGrip: [] }));
jest.mock('../../../model/betaEligibility.js', () => ({ ...jest.requireActual('../../../model/betaEligibility.js'), betaEligibility: jest.fn(() => ({ eligible: true })) }));
beforeEach(() => betaEligibility.mockReturnValue({ eligible: true }));

jest.mock('../../../model/prescription.js', () => ({ ...jest.requireActual('../../../model/prescription.js'),
  prescription: (history, h, g, t) => ({ value: 40 - t / 10 }) }));
jest.mock('../../../model/coaching.js', () => ({
  coachingRecommendationContinuous: jest.fn(), COLD_START_BOUNDARY_REPS: 4, COLD_START_BOUNDARY_REST_S: 20,
}));
jest.mock('../../../util.js', () => ({ ...jest.requireActual('../../../util.js'), today: jest.fn() }));
const goals = Object.fromEntries(TRAINING_ZONE_KEYS.map(key => [key, { label: key, color: '#fff', refTime: ZONE_REF_T[key] }]));
const props = { history: [], grip: 'Micro', hand: 'Both', unit: 'kg', GOAL_CONFIG: goals };
const newExperiment = (overrides = {}) => ({ ...createVolumeExperiment({ history: [], grips: ['Micro', 'Crusher'],
  startDate: '2026-10-01', id: 'volume-test' }), ...overrides });
const volumeSwitch = () => screen.getByRole('switch', { name: 'Volume (Beta)' });
const chaosSwitch = () => screen.getByRole('switch', { name: 'Chaos Machine (Beta)' });
const lastPlan = apply => apply.mock.calls.at(-1)[0];

beforeEach(() => {
  today.mockReturnValue('2026-10-01');
  coachingRecommendationContinuous.mockReturnValue({ zone: 'power', T: 30, loadByHand: { L: 30, R: 30 }, reasons: [] });
});

test('both switches start off; setup and cancel do not enroll or change the workout dose', () => {
  const start = jest.fn(), apply = jest.fn();
  render(<SessionPlanCard {...props} onStartVolumeExperiment={start} onApplyPlan={apply} />);
  expect(volumeSwitch()).not.toBeChecked();
  expect(chaosSwitch()).not.toBeChecked();
  fireEvent.click(volumeSwitch());
  expect(screen.getByRole('region', { name: 'Set up Volume Beta' })).toBeInTheDocument();
  expect(screen.getByRole('switch', { name: 'Micro' })).toBeChecked();
  expect(screen.getByRole('switch', { name: 'Crusher' })).not.toBeChecked();
  expect(lastPlan(apply).volumePlan).toBeNull();
  fireEvent.click(screen.getByRole('switch', { name: 'Micro' }));
  expect(screen.getByRole('button', { name: 'Start Volume Beta' })).toBeDisabled();
  fireEvent.click(screen.getByRole('switch', { name: 'Micro' }));
  fireEvent.click(screen.getByRole('switch', { name: 'Crusher' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(start).not.toHaveBeenCalled();
  expect(volumeSwitch()).not.toBeChecked();
});

test('only explicit Start enrolls the selected grips and applies the persistent ordinary plan', async () => {
  const start = jest.fn(), apply = jest.fn();
  function Host() {
    const [experiment, setExperiment] = useState(null);
    return <SessionPlanCard {...props} volumeExperiment={experiment} onApplyPlan={apply}
      onVolumeExperimentStatusChange={jest.fn()} onStartVolumeExperiment={({ grips }) => {
        start({ grips }); setExperiment(createVolumeExperiment({ history: [], grips, startDate: today(), id: 'created' }));
      }} />;
  }
  render(<Host />);
  fireEvent.click(volumeSwitch());
  fireEvent.click(screen.getByRole('switch', { name: 'Crusher' }));
  expect(start).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Start Volume Beta' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Set up Volume Beta' })).not.toBeInTheDocument());
  expect(start).toHaveBeenCalledWith({ grips: ['Micro', 'Crusher'] });
  expect(volumeSwitch()).toBeChecked();
  expect(lastPlan(apply)).toMatchObject({ mixedDomainPlan: null, volumePlan: { id: 'volume_beta', experiment_id: 'created', sets: 2, rest_s: 300 } });
  expect(screen.getByText('Micro: 0 of 18 complete sessions')).toBeInTheDocument();
  expect(screen.getByText(/historical starting comparison is provisional/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Research' })).toHaveAttribute('href', '/research');
});

test('Chaos replaces Volume for the workout without pausing the experiment or reverting on sync', () => {
  const apply = jest.fn(), statusChange = jest.fn(), experiment = newExperiment();
  const view = render(<SessionPlanCard {...props} volumeExperiment={experiment}
    onVolumeExperimentStatusChange={statusChange} onApplyPlan={apply} />);
  expect(volumeSwitch()).toBeChecked();
  fireEvent.click(chaosSwitch());
  expect(volumeSwitch()).not.toBeChecked();
  expect(lastPlan(apply)).toMatchObject({ volumePlan: null, mixedDomainPlan: { id: 'whole_curve_beta' } });
  view.rerender(<SessionPlanCard {...props} history={[]} volumeExperiment={{ ...experiment }}
    onVolumeExperimentStatusChange={statusChange} onApplyPlan={apply} />);
  expect(chaosSwitch()).toBeChecked();
  expect(statusChange).not.toHaveBeenCalled();
  expect(screen.getByText(/Your Volume plan continues. This workout uses Chaos Machine/)).toBeInTheDocument();
  fireEvent.click(chaosSwitch());
  expect(volumeSwitch()).not.toBeChecked();
  expect(lastPlan(apply)).toMatchObject({ mixedDomainPlan: null, volumePlan: null });
  fireEvent.click(volumeSwitch());
  expect(chaosSwitch()).not.toBeChecked();
  expect(volumeSwitch()).toBeChecked();
  expect(lastPlan(apply).mixedDomainPlan).toBeNull();
  expect(lastPlan(apply).volumePlan.experiment_id).toBe(experiment.id);
  expect(statusChange).not.toHaveBeenCalled();
});

test('turning Volume off pauses; resuming retains the six-week dates', async () => {
  const statusChange = jest.fn(), apply = jest.fn(), initial = newExperiment();
  function Host() {
    const [experiment, setExperiment] = useState(initial);
    return <SessionPlanCard {...props} volumeExperiment={experiment} onApplyPlan={apply}
      onVolumeExperimentStatusChange={status => { statusChange(status); setExperiment({ ...experiment, status }); }} />;
  }
  render(<Host />);
  fireEvent.click(volumeSwitch());
  expect(await screen.findByText('Volume Beta paused')).toBeInTheDocument();
  expect(statusChange).toHaveBeenLastCalledWith('paused');
  expect(lastPlan(apply).volumePlan).toBeNull();
  await waitFor(() => expect(volumeSwitch()).not.toBeDisabled());
  fireEvent.click(volumeSwitch());
  await waitFor(() => expect(volumeSwitch()).toBeChecked());
  expect(statusChange).toHaveBeenLastCalledWith('active');
  expect(lastPlan(apply).volumePlan).toMatchObject({ experiment_id: initial.id, started_on: initial.startDate, ends_on: initial.endDate });
});

test('expiry disables Volume and offers review without extending or writing the plan', () => {
  today.mockReturnValue('2026-11-12');
  const apply = jest.fn(), change = jest.fn();
  render(<SessionPlanCard {...props} volumeExperiment={newExperiment()} onVolumeExperimentStatusChange={change} onApplyPlan={apply} />);
  expect(volumeSwitch()).not.toBeChecked();
  expect(volumeSwitch()).toBeDisabled();
  expect(lastPlan(apply).volumePlan).toBeNull();
  expect(screen.getByRole('link', { name: 'Review results' })).toHaveAttribute('href', '/research');
  expect(change).not.toHaveBeenCalled();
});

test.each(['completed', 'ended'])('a %s experiment can be followed by an explicitly enrolled new experiment', async status => {
  today.mockReturnValue('2026-11-12');
  const initial = newExperiment({ status }), saved = [initial], start = jest.fn(), change = jest.fn(), apply = jest.fn();
  function Host() {
    const [experiment, setExperiment] = useState(initial);
    return <SessionPlanCard {...props} volumeExperiment={experiment} onApplyPlan={apply}
      onVolumeExperimentStatusChange={change} onStartVolumeExperiment={({ grips }) => {
        start({ grips });
        const next = createVolumeExperiment({ history: [], grips, startDate: today(), id: 'new-experiment' });
        saved.push(next); setExperiment(next); return true;
      }} />;
  }
  render(<Host />);
  expect(volumeSwitch()).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Set up another experiment' }));
  expect(volumeSwitch()).toBeChecked();
  expect(volumeSwitch()).not.toBeDisabled();
  expect(screen.getByRole('switch', { name: 'Micro' })).toBeChecked();
  expect(screen.getByRole('switch', { name: 'Crusher' })).not.toBeChecked();
  expect(start).not.toHaveBeenCalled();
  expect(lastPlan(apply).volumePlan).toBeNull();
  fireEvent.click(volumeSwitch());
  expect(screen.queryByRole('region', { name: 'Set up Volume Beta' })).not.toBeInTheDocument();
  expect(volumeSwitch()).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Set up another experiment' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(saved).toEqual([initial]);
  fireEvent.click(screen.getByRole('button', { name: 'Set up another experiment' }));
  fireEvent.click(screen.getByRole('button', { name: 'Start Volume Beta' }));
  await waitFor(() => expect(lastPlan(apply).volumePlan?.experiment_id).toBe('new-experiment'));
  expect(start).toHaveBeenCalledTimes(1);
  expect(saved).toHaveLength(2);
  expect(saved[0]).toBe(initial);
  expect(saved[0].endDate).toBe('2026-11-11');
  expect(saved[1].startDate).toBe('2026-11-12');
  expect(change).not.toHaveBeenCalled();
});

test('a new experiment after expiry still requires loaded history and ordinary training eligibility', () => {
  today.mockReturnValue('2026-11-12');
  const start = jest.fn(), initial = newExperiment();
  const view = render(<SessionPlanCard {...props} volumeExperiment={initial} volumeReady={false} onStartVolumeExperiment={start} />);
  expect(screen.getByRole('button', { name: 'Set up another experiment' })).toBeDisabled();
  coachingRecommendationContinuous.mockReturnValue({ peakTest: true, zone: 'max_strength', T: 3, reasons: [] });
  view.rerender(<SessionPlanCard {...props} history={[]} volumeExperiment={initial} volumeReady onStartVolumeExperiment={start} />);
  expect(screen.getByRole('button', { name: 'Set up another experiment' })).toBeDisabled();
  expect(start).not.toHaveBeenCalled();
});

test('Volume respects selected grips and defaults back to the active plan when a grip changes', () => {
  const apply = jest.fn(), experiment = newExperiment(), change = jest.fn();
  const view = render(<SessionPlanCard {...props} volumeExperiment={experiment} onVolumeExperimentStatusChange={change} onApplyPlan={apply} />);
  fireEvent.click(chaosSwitch());
  view.rerender(<SessionPlanCard {...props} grip="Crusher" volumeExperiment={experiment} onVolumeExperimentStatusChange={change} onApplyPlan={apply} />);
  expect(volumeSwitch()).toBeChecked();
  expect(chaosSwitch()).not.toBeChecked();
  view.rerender(<SessionPlanCard {...props} grip="Prime" volumeExperiment={experiment} onVolumeExperimentStatusChange={change} onApplyPlan={apply} />);
  expect(volumeSwitch()).not.toBeChecked();
  expect(volumeSwitch()).toBeDisabled();
  expect(lastPlan(apply).volumePlan).toBeNull();
});

test('alternate domains keep their earned 4–5–6 progression and targets inside Volume', () => {
  const history = ['L', 'R'].flatMap(hand => Array.from({ length: 4 }, (_, i) => ({
    id: `${hand}-${i}`, session_id: 'strength', date: '2026-09-20', grip: 'Micro', hand,
    set_num: 1, rep_num: i + 1, target_duration: 110, actual_time_s: i ? 60 : 110,
    avg_force_kg: 20, prescribed_load_kg: 20, rest_s: 20,
  })));
  const apply = jest.fn(), earned = computeDensityLadder(history, 'Micro', 'strength', { expectedHands: ['L', 'R'] });
  render(<SessionPlanCard {...props} history={history} volumeExperiment={newExperiment()}
    onVolumeExperimentStatusChange={jest.fn()} onApplyPlan={apply} />);
  fireEvent.click(screen.getByRole('button', { name: 'Train strength at 110 seconds' }));
  expect(lastPlan(apply)).toMatchObject({ goal: 'strength', targetTime: 110, repsPerSet: 5,
    ladderLoadByHand: earned.loadByHand, volumePlan: { sets: 2 } });
  fireEvent.click(screen.getByRole('button', { name: 'Train endurance at 220 seconds' }));
  expect(lastPlan(apply).goal).toBe('endurance');
  expect(lastPlan(apply).volumePlan.sets).toBe(2);
});

test.each([
  { peakTest: true, zone: 'max_strength', T: 3 },
  { boundaryProbe: true, coldStartStage: 'lower', zone: 'endurance', T: 220 },
])('peak and boundary measurements stay single protocol sessions: %j', recommendation => {
  coachingRecommendationContinuous.mockReturnValue({ ...recommendation, loadByHand: { L: 10, R: 10 }, reasons: [] });
  const apply = jest.fn();
  render(<SessionPlanCard {...props} volumeExperiment={newExperiment()} onVolumeExperimentStatusChange={jest.fn()} onApplyPlan={apply} />);
  expect(volumeSwitch()).toBeDisabled();
  expect(volumeSwitch()).not.toBeChecked();
  expect(lastPlan(apply).volumePlan).toBeNull();
  expect(screen.getByText(/Complete the initial measurements first/)).toBeInTheDocument();
});

test('unresolved history or settings cannot enroll or apply a two-set plan', () => {
  const apply = jest.fn();
  render(<SessionPlanCard {...props} volumeExperiment={newExperiment()} volumeReady={false}
    onVolumeExperimentStatusChange={jest.fn()} onApplyPlan={apply} />);
  expect(screen.queryByRole('switch', { name: 'Volume (Beta)' })).not.toBeInTheDocument();
  expect(lastPlan(apply).volumePlan).toBeNull();
  expect(screen.getByText(/training history and plan are still loading/)).toBeInTheDocument();
});

test.each(['rejected', 'false'])('an enrollment save failure (%s) leaves setup retryable and the workout unchanged', async failure => {
  const apply = jest.fn();
  render(<SessionPlanCard {...props} onApplyPlan={apply}
    onStartVolumeExperiment={() => failure === 'false' ? false : Promise.reject(new Error('offline'))} />);
  fireEvent.click(volumeSwitch());
  fireEvent.click(screen.getByRole('button', { name: 'Start Volume Beta' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not start Volume Beta');
  expect(screen.getByRole('button', { name: 'Start Volume Beta' })).not.toBeDisabled();
  expect(lastPlan(apply).volumePlan).toBeNull();
});

test('both betas stay locked without consistent history even with an existing active experiment', () => {
  betaEligibility.mockImplementation(jest.requireActual('../../../model/betaEligibility.js').betaEligibility);
  const apply = jest.fn(), start = jest.fn();
  render(<SessionPlanCard {...props} volumeExperiment={newExperiment()} onStartVolumeExperiment={start}
    onVolumeExperimentStatusChange={jest.fn()} onApplyPlan={apply} />);
  expect(screen.queryByRole('switch', { name: 'Volume (Beta)' })).not.toBeInTheDocument();
  expect(screen.queryByRole('switch', { name: 'Chaos Machine (Beta)' })).not.toBeInTheDocument();
  expect(screen.getByText(/Betas unlock after three calendar months/)).toBeInTheDocument();
  expect(start).not.toHaveBeenCalled();
  expect(lastPlan(apply)).toMatchObject({ volumePlan: null, mixedDomainPlan: null });
  expect(screen.getByRole('link', { name: 'Research' })).toBeInTheDocument();
});
test('deleting qualifying history removes a selected beta from the applied plan', () => {
  const apply = jest.fn();
  const view = render(<SessionPlanCard {...props} onApplyPlan={apply} />);
  fireEvent.click(chaosSwitch());
  expect(lastPlan(apply).mixedDomainPlan).not.toBeNull();
  betaEligibility.mockReturnValue({ eligible: false, qualifyingWeeks: 9, hasThreeMonths: true });
  view.rerender(<SessionPlanCard {...props} history={[{}]} onApplyPlan={apply} />);
  expect(screen.queryByRole('switch', { name: 'Chaos Machine (Beta)' })).not.toBeInTheDocument();
  expect(lastPlan(apply).mixedDomainPlan).toBeNull();
});
test('historically consistent training keeps both toggles visible after a break without inviting more volume', () => {
  betaEligibility.mockImplementation(jest.requireActual('../../../model/betaEligibility.js').betaEligibility);
  const history = Array.from({ length: 13 }, (_, w) => [0, 3].map(offset => ({
    date: new Date(Date.parse('2026-04-20') + (w * 7 + offset) * 86400000).toISOString().slice(0, 10),
    grip: 'Micro', hand: 'L', target_duration: 30, actual_time_s: 30, avg_force_kg: 20, peak_force_kg: 22,
  }))).flat();
  const detect = jest.requireActual('../../../model/plateau.js').detectPlateaus;
  detectPlateaus.mockImplementation(detect);
  render(<SessionPlanCard {...props} history={history} onStartVolumeExperiment={jest.fn()} />);
  expect(volumeSwitch()).not.toBeChecked();
  expect(chaosSwitch()).not.toBeChecked();
  expect(screen.queryByRole('button', { name: 'Review Volume Beta' })).not.toBeInTheDocument();
});
test('only eligible grips appear in enrollment and switching to Prime hides beta controls but keeps sets', () => {
  betaEligibility.mockImplementation(jest.requireActual('../../../model/betaEligibility.js').betaEligibility);
  const history = Array.from({ length: 15 }, (_, w) => [1, 4].map(d => ({
    date: new Date(Date.parse('2026-10-01') - (w * 7 + d) * 86400000).toISOString().slice(0, 10),
    grip: 'Micro', hand: 'L', target_duration: 30, actual_time_s: 30, avg_force_kg: 20, peak_force_kg: 22,
  }))).flat();
  const apply = jest.fn();
  const view = render(<SessionPlanCard {...props} history={history} onApplyPlan={apply} onStartVolumeExperiment={jest.fn()} />);
  fireEvent.click(volumeSwitch());
  expect(screen.getByRole('switch', { name: 'Micro' })).toBeInTheDocument();
  expect(screen.queryByRole('switch', { name: 'Crusher' })).not.toBeInTheDocument();
  expect(screen.queryByRole('switch', { name: 'Prime' })).not.toBeInTheDocument();
  view.rerender(<SessionPlanCard {...props} grip="Prime" history={history} onApplyPlan={apply} />);
  expect(screen.queryByRole('switch', { name: 'Chaos Machine (Beta)' })).not.toBeInTheDocument();
  expect(screen.queryByRole('switch', { name: 'Volume (Beta)' })).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Set up Volume Beta' })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Sets per hand'), { target: { value: '3' } });
  expect(lastPlan(apply)).toMatchObject({ plannedSets: 3, mixedDomainPlan: null, volumePlan: null });
});
test('both betas wait for account history loading to finish', () => {
  render(<SessionPlanCard {...props} volumeReady={false} />);
  expect(screen.queryByRole('switch', { name: 'Volume (Beta)' })).not.toBeInTheDocument();
  expect(screen.queryByRole('switch', { name: 'Chaos Machine (Beta)' })).not.toBeInTheDocument();
});

test('eligible users see purpose descriptions without a plateau prompt', () => {
  render(<SessionPlanCard {...props} onStartVolumeExperiment={jest.fn()} />);
  expect(volumeSwitch()).toBeEnabled();
  expect(chaosSwitch()).toBeEnabled();
  expect(screen.getByText(/Five different loads per set/)).toBeInTheDocument();
  expect(screen.getByText(/test whether extra volume helps when progress stalls/)).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Plateau experiment suggestion' })).not.toBeInTheDocument();
});
test('plateau invitation opens optional setup and records its source only after explicit start', async () => {
  detectPlateaus.mockReturnValue({ byGrip: [{ grip: 'Micro', recommendation: 'consider_volume_beta' }] });
  const start = jest.fn().mockReturnValue(true);
  render(<SessionPlanCard {...props} onStartVolumeExperiment={start} />);
  expect(screen.getByRole('region', { name: 'Plateau experiment suggestion' })).toBeInTheDocument();
  expect(volumeSwitch()).not.toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'Review Volume Beta' }));
  expect(start).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Start Volume Beta' }));
  await waitFor(() => expect(start).toHaveBeenCalledWith({ grips: ['Micro'], trigger: 'plateau_prompt' }));
});
test('dismissing an invitation retains manual beta access', () => {
  detectPlateaus.mockReturnValue({ byGrip: [{ grip: 'Micro', recommendation: 'consider_volume_beta' }] });
  render(<SessionPlanCard {...props} onStartVolumeExperiment={jest.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
  expect(screen.queryByRole('region', { name: 'Plateau experiment suggestion' })).not.toBeInTheDocument();
  expect(volumeSwitch()).toBeEnabled();
  expect(chaosSwitch()).toBeEnabled();
});


test('self-selected sets are available before research eligibility and never enroll', () => {
  betaEligibility.mockReturnValue({ eligible: false, qualifyingWeeks: 1 });
  const apply = jest.fn(), start = jest.fn();
  render(<SessionPlanCard {...props} onApplyPlan={apply} onStartVolumeExperiment={start} />);
  fireEvent.change(screen.getByRole('combobox', { name: 'Sets per hand' }), { target: { value: '3' } });
  expect(lastPlan(apply)).toMatchObject({ plannedSets: 3, volumePlan: null, mixedDomainPlan: null });
  expect(start).not.toHaveBeenCalled();
});
test('Chaos retains the chosen set count and ordinary mode keeps the choice', () => {
  const apply = jest.fn();
  render(<SessionPlanCard {...props} onApplyPlan={apply} />);
  fireEvent.change(screen.getByRole('combobox', { name: 'Sets per hand' }), { target: { value: '3' } });
  fireEvent.click(chaosSwitch());
  expect(lastPlan(apply)).toMatchObject({ plannedSets: 3, volumePlan: null, mixedDomainPlan: { id: 'whole_curve_beta' } });
  fireEvent.click(chaosSwitch());
  expect(lastPlan(apply)).toMatchObject({ plannedSets: 3, volumePlan: null, mixedDomainPlan: null });
});
test('changing sets takes this workout outside Volume Beta without changing the study', () => {
  const apply = jest.fn(), change = jest.fn();
  render(<SessionPlanCard {...props} volumeExperiment={newExperiment()} onApplyPlan={apply} onVolumeExperimentStatusChange={change} />);
  expect(lastPlan(apply)).toMatchObject({ plannedSets: 2, volumePlan: { id: 'volume_beta' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Sets per hand' }), { target: { value: '4' } });
  expect(lastPlan(apply)).toMatchObject({ plannedSets: 4, volumePlan: null });
  expect(change).not.toHaveBeenCalled();
});
