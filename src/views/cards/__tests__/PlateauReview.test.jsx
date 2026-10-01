import React from 'react';
import { render, screen } from '@testing-library/react';
import { PlateauReview } from '../PlateauReview.jsx';
test('sparse history clearly reports uncertainty without recommending more volume', () => {
  render(<PlateauReview history={[]} date="2026-10-01" />);
  expect(screen.getByText('Plateau review · Research')).toBeInTheDocument();
  expect(screen.getAllByText(/More comparable holds needed/)).toHaveLength(30);
  expect(screen.queryByText(/may be worth testing for the duration/)).not.toBeInTheDocument();
  expect(screen.getAllByText(/Missing logs do not mean no climbing/)).toHaveLength(3);
});
