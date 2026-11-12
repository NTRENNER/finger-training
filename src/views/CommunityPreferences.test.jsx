import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { CommunityPreferences } from './CommunityPreferences.jsx';

test('the sharing switch opts the member out', () => {
  const community = { owner: 'a', profile: { display_name: 'Climber A' }, sharing: true, update: jest.fn(), refresh: jest.fn() };
  render(<CommunityPreferences community={community} />);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Share achievements and peak force' }));
  expect(community.update).toHaveBeenCalledWith({ sharing_enabled: false });
});
