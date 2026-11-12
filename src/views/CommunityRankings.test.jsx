import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CommunityRankings } from './CommunityRankings.jsx';
import { readCommunityGroups, readCommunityImprovements } from '../lib/communityApi.js';
jest.mock('../lib/communityApi.js', () => ({ readCommunityGroups: jest.fn(), readCommunityImprovements: jest.fn() }));
const low = { baseline_band: 30, support_keys: ['max_strength','power'], members: 2 };
const high = { ...low, baseline_band: 60, members: 1 };
const row = name => ({ user_id: name, display_name: name, metric: 'balanced', baseline_force_kg: 35,
  current_force_kg: 36.05, improvement_pct: 3, milestone_pct: 2, baseline_date: '2026-01-01', measured_date: '2026-11-11', place: 1 });
const props = { owner: 'a', grip: 'Crusher', unit: 'kg', revision: 0 };
beforeEach(() => { readCommunityGroups.mockResolvedValue([low, high]); readCommunityImprovements.mockResolvedValue([row('Climber A')]); });
test('starts with the member’s own comparable group and sends the exact selected duration basis', async () => {
  render(<CommunityRankings {...props} ownSnapshots={[{ grip: 'Crusher', group_force_kg: 65, support_keys: high.support_keys }]} />);
  await screen.findByText('Climber A');
  expect(readCommunityImprovements).toHaveBeenLastCalledWith('a','Crusher',high);
  fireEvent.change(screen.getByRole('combobox', { name: 'Starting capacity group' }), { target: { value: '30|max_strength,power' } });
  await waitFor(() => expect(readCommunityImprovements).toHaveBeenLastCalledWith('a','Crusher',low));
});
test('live refresh preserves visible rows until the replacement arrives, then removes obsolete entries', async () => {
  const { rerender } = render(<CommunityRankings {...props} liveStatus="live" />);
  await screen.findByText('Climber A');
  let finish;
  readCommunityGroups.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  readCommunityImprovements.mockResolvedValue([row('Climber B')]);
  rerender(<CommunityRankings {...props} revision={1} liveStatus="live" />);
  expect(screen.getByText('Climber A')).toBeInTheDocument();
  expect(screen.getByText('● Live')).toBeInTheDocument();
  await act(async () => finish([low,high]));
  await screen.findByText('Climber B');
  expect(screen.queryByText('Climber A')).not.toBeInTheDocument();
});
test('late responses for another grip cannot overwrite the current ranking', async () => {
  let oldResponse;
  readCommunityGroups.mockImplementationOnce(() => new Promise(resolve => { oldResponse = resolve; }));
  const { rerender } = render(<CommunityRankings {...props} />);
  rerender(<CommunityRankings {...props} grip="Prime" />);
  await screen.findByText('Climber A');
  await act(async () => oldResponse([high]));
  expect(readCommunityImprovements).toHaveBeenCalledTimes(1);
  expect(readCommunityImprovements).toHaveBeenCalledWith('a','Prime',low);
});
test('all seven domains stay visible, and an unavailable server cannot look like an empty leaderboard', async () => {
  readCommunityGroups.mockRejectedValueOnce(new Error('offline'));
  render(<CommunityRankings {...props} liveStatus="offline" />);
  await screen.findByText('Rankings could not load. Please try again when you’re online.');
  expect(screen.getByText('Offline')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry rankings' }));
  await screen.findByText('Climber A');
  for (const name of ['Balanced curve improvement','Max Strength','Power','Power/Strength','Strength','Strength/Endurance','Endurance']) {
    expect(screen.getByRole('heading', { name, exact: true })).toBeInTheDocument();
  }
});
