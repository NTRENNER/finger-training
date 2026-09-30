import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { WorkoutEffort } from '../WorkoutEffort.jsx';
test('optional effort can be selected and cleared after actual work', () => {
  const change = jest.fn();
  const { rerender } = render(<WorkoutEffort name="Bench" data={{ sets: [{ done: false }] }} onChange={change} />);
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  rerender(<WorkoutEffort name="Bench" data={{ sets: [{ done: true }], effort: 'at_limit' }} onChange={change} />);
  const button = screen.getByRole('button', { name: 'At my limit' });
  expect(button).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(button); expect(change).toHaveBeenLastCalledWith(null);
  fireEvent.click(screen.getByRole('button', { name: 'About right' }));
  expect(change).toHaveBeenLastCalledWith('about_right');
});
