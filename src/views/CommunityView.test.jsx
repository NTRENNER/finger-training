import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CommunityScreen } from './CommunityView.jsx';
import { readCommunityFeed, readCommunityRanking, readCommunityGroups, readCommunityImprovements, hideCommunityCard, celebrateCommunityCard } from '../lib/communityApi.js';
jest.mock('../lib/communityApi.js', () => ({ readCommunityFeed: jest.fn(), readCommunityRanking: jest.fn(), readCommunityGroups: jest.fn(), readCommunityImprovements: jest.fn(), hideCommunityCard: jest.fn(), celebrateCommunityCard: jest.fn() }));
const community = { owner: 'a', profile: { display_name: 'Climber A' }, sharing: true, update: jest.fn(), refresh: jest.fn() };
const card = { id: '1', user_id: 'a', display_name: 'Climber A', grip: 'Crusher', metric: 'power', milestone_pct: 1,
  improvement_pct: 1.12, baseline_date: '2026-01-01', achieved_date: '2026-03-01', baseline_force_kg: 40,
  current_force_kg: 40.448, support_keys: ['power'], celebrations: 2, celebrated: false };
beforeEach(() => { readCommunityGroups.mockResolvedValue([]); readCommunityImprovements.mockResolvedValue([]); readCommunityFeed.mockResolvedValue([card]); readCommunityRanking.mockResolvedValue([]); hideCommunityCard.mockResolvedValue(null); celebrateCommunityCard.mockResolvedValue(null); });
test('renders balanced plus all six subdomains without fabricating unsupported scores', async () => {
  render(<CommunityScreen community={community} progress={{ stars: [], current: [] }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Achievements', exact: true }));
  await screen.findByText('Power breakthrough');
  fireEvent.click(screen.getByText('Your stars · ★ 0'));
  for (const text of ['Balanced curve', 'Max Strength', 'Power', 'Power/Strength', 'Strength', 'Strength/Endurance', 'Endurance']) expect(screen.getByText(text)).toBeInTheDocument();
  expect(screen.getAllByText('Building evidence')).toHaveLength(7);
});
test('peak ranks are a separate grip and hand filtered view', async () => {
  render(<CommunityScreen community={community} progress={{ stars: [], current: [] }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Peak force', exact: true }));
  await waitFor(() => expect(readCommunityRanking).toHaveBeenLastCalledWith('a', 'Crusher', null));
  fireEvent.click(screen.getByRole('button', { name: 'Left', exact: true }));
  await waitFor(() => expect(readCommunityRanking).toHaveBeenLastCalledWith('a', 'Crusher', 'L'));
  fireEvent.click(screen.getByRole('button', { name: 'Prime', exact: true }));
  await waitFor(() => expect(readCommunityRanking).toHaveBeenLastCalledWith('a', 'Prime', 'L'));
});
test('hide and celebrate use owned API calls, and the sharing switch is not on the dashboard', async () => {
  render(<CommunityScreen community={community} progress={{ stars: [], current: [] }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Achievements', exact: true }));
  fireEvent.click(await screen.findByRole('button', { name: 'Celebrate · 2' }));
  await waitFor(() => expect(celebrateCommunityCard).toHaveBeenCalledWith('a', '1', false));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Hide card' })).not.toBeDisabled());
  fireEvent.click(screen.getByRole('button', { name: 'Hide card' }));
  await waitFor(() => expect(hideCommunityCard).toHaveBeenCalledWith('a', '1'));
  // The sharing switch lives in Settings only.
  expect(screen.queryByRole('checkbox', { name: 'Share achievements and peak force' })).not.toBeInTheDocument();
});
