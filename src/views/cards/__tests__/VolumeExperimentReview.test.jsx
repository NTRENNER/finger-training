import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { VolumeExperimentReview } from '../VolumeExperimentReview.jsx';
import { createVolumeExperiment } from '../../../model/volumeExperiment.js';

const plan = () => createVolumeExperiment({ grips: ['Micro'], startDate: '2026-10-01', id: 'trial' });

test('a sparse historical baseline is explained without claiming a gain', () => {
  render(<VolumeExperimentReview experiments={{ trial: plan() }} date="2026-10-03" />);
  expect(screen.getByText('Micro: 0 of 18 two-set sessions')).toBeInTheDocument();
  expect(screen.getAllByText(/No comparable historical starting measurement/)).toHaveLength(2);
  expect(screen.queryByText(/Recent holds:/)).not.toBeInTheDocument();
  expect(screen.getByText(/personal before-and-after pilot/)).toBeInTheDocument();
});

test('weekly review and pause preserve the original plan and baseline', () => {
  const experiment = plan(), save = jest.fn().mockReturnValue(true);
  render(<VolumeExperimentReview experiments={{ trial: experiment }} onSave={save} date="2026-10-10" />);
  fireEvent.change(screen.getByLabelText('Climbing this week'), { target: { value: 'worse' } });
  fireEvent.change(screen.getByLabelText('Weekly notes'), { target: { value: 'More climbing than usual.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save weekly review', hidden: true }));
  expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ ...experiment,
    reviews: { 2: expect.objectContaining({ climbing: 'worse', notes: 'More climbing than usual.' }) },
  }), { reviewWeek: 2 });
  fireEvent.click(screen.getByRole('button', { name: 'Pause plan' }));
  expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ ...experiment, status: 'paused' }), { statusOnly: true });
});

test('ending is explicit and completed plans remain reviewable', () => {
  const experiment = plan(), save = jest.fn();
  const view = render(<VolumeExperimentReview experiments={{ trial: experiment }} onSave={save} date="2026-10-10" />);
  fireEvent.click(screen.getByRole('button', { name: 'End plan' }));
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'End experiment' }));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ ...experiment, status: 'ended' }), { statusOnly: true });
  view.rerender(<VolumeExperimentReview experiments={{ trial: experiment }} onSave={save} date="2026-11-12" />);
  expect(screen.queryByRole('button', { name: 'Resume plan' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'End plan' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Download Volume review' })).toBeInTheDocument();
});

test('research cannot resume an ineligible plan but can retain reviews and end it', () => {
  const experiment = { ...plan(), status: 'paused' }, save = jest.fn();
  render(<VolumeExperimentReview experiments={{ trial: experiment }} onSave={save} date="2026-10-10" />);
  expect(screen.getByRole('button', { name: 'Resume plan' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Resume plan' }));
  expect(save).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Download Volume review' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'End plan' })).toBeEnabled();
  expect(screen.getByText(/Betas unlock after three calendar months/)).toBeInTheDocument();
});
test('research checks every enrolled grip before resuming a mixed-eligibility legacy plan', () => {
  const history = Array.from({ length: 15 }, (_, w) => [1, 4].map(d => ({
    date: new Date(Date.parse('2026-10-01') - (w * 7 + d) * 86400000).toISOString().slice(0, 10),
    grip: 'Micro', hand: 'L', target_duration: 30, actual_time_s: 30, avg_force_kg: 20, peak_force_kg: 22,
  }))).flat();
  const experiment = { ...plan(), status: 'paused' }, save = jest.fn();
  const view = render(<VolumeExperimentReview experiments={{ trial: experiment }} history={history} onSave={save} date="2026-10-10" />);
  expect(screen.getByRole('button', { name: 'Resume plan' })).toBeEnabled();
  const mixed = { ...createVolumeExperiment({ grips: ['Micro', 'Prime'], startDate: '2026-10-01', id: 'trial' }), status: 'paused' };
  view.rerender(<VolumeExperimentReview experiments={{ trial: mixed }} history={history} onSave={save} date="2026-10-10" />);
  expect(screen.getByRole('button', { name: 'Resume plan' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'End plan' })).toBeEnabled();
});
