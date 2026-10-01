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
