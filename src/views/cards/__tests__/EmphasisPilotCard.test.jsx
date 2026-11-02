import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { EmphasisPilotCard } from '../EmphasisPilotCard.jsx';
import { pilotEnrollment } from '../../../model/emphasisPilot.js';

test('joining saves an active enrollment', () => {
  const save = jest.fn();
  render(<EmphasisPilotCard enrollment={null} onSave={save} date="2026-11-02" />);
  expect(screen.getByText(/Every session on Micro, Crusher and Prime follows the block plan/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Join pilot' }));
  expect(save.mock.calls[0][0]).toMatchObject({ version: 1, pilot_id: 'emphasis-2026-11', status: 'active' });
});

test('a joined athlete sees the block day and each grip\'s next step, and can leave', () => {
  const save = jest.fn();
  const history = [{ date: '2026-11-03', grip: 'Micro', hand: 'L', target_duration: 115 }];
  render(<EmphasisPilotCard enrollment={pilotEnrollment('emphasis-2026-11', 'active')} history={history}
    onSave={save} date="2026-11-04" />);
  expect(screen.getByRole('status')).toHaveTextContent('Pilot · Long end · day 2 of 28');
  expect(screen.getByText('Micro: Strength/Endurance · step 2 of 8')).toBeInTheDocument();
  expect(screen.getByText('Crusher: Strength · step 1 of 4')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Leave pilot' }));
  expect(save.mock.calls[0][0]).toMatchObject({ status: 'left' });
});

test('before the first block a joined athlete sees the start date', () => {
  render(<EmphasisPilotCard enrollment={pilotEnrollment('emphasis-2026-11', 'active')} onSave={jest.fn()} date="2026-11-02" />);
  expect(screen.getByRole('status')).toHaveTextContent(/^Starts Nov 3$/);
});
