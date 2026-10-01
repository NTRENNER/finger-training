import React, { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toggle } from '../Toggle.jsx';

test('switch exposes its state and description, and works with keyboard activation', () => {
  function Host() {
    const [checked, setChecked] = useState(false);
    return <Toggle label="Volume (Beta)" checked={checked} onChange={setChecked} description="Try two sets." />;
  }
  render(<Host />);
  const toggle = screen.getByRole('switch', { name: 'Volume (Beta)' });
  expect(toggle).toHaveAccessibleDescription('Try two sets.');
  expect(toggle).not.toBeChecked();
  userEvent.tab();
  expect(toggle).toHaveFocus();
  userEvent.keyboard(' ');
  expect(toggle).toBeChecked();
  userEvent.keyboard('{Enter}');
  expect(toggle).not.toBeChecked();
});
