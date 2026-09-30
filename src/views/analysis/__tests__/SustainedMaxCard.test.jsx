import React from 'react';
import { render, screen } from '@testing-library/react';
import { SustainedMaxCard } from '../SustainedMaxCard.jsx';
import { measureSustainedMax } from '../../../model/sustainedMax.js';
const row = (hand, kg) => ({ grip: 'Micro', hand, date: '2026-09-30',
  force_recording: { sustained_max: measureSustainedMax(Array.from({ length: 21 }, (_, i) => ({ ts: i * 100, kg }))) } });
test('shows separate per-hand sustained records without mixing instantaneous peaks', () => {
  render(<SustainedMaxCard history={[row('L', 20), row('L', 19), row('R', 25)]} unit="kg" />);
  expect(screen.getByText('Micro · Left hand')).toBeInTheDocument();
  expect(screen.getByText('Micro · Right hand')).toBeInTheDocument();
  expect(screen.getByText('20.0 kg')).toBeInTheDocument();
  expect(screen.getByText('25.0 kg')).toBeInTheDocument();
  expect(screen.queryByText('19.0 kg')).not.toBeInTheDocument();
});
test('old peaks get an honest empty state instead of a fabricated two-second record', () => {
  render(<SustainedMaxCard history={[{ grip: 'Micro', hand: 'L', peak_force_kg: 90, actual_time_s: 10 }]} />);
  expect(screen.getByText(/No verified two-second measurement yet/)).toBeInTheDocument();
});
