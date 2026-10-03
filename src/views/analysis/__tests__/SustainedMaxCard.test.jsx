import React from 'react';
import { render, screen } from '@testing-library/react';
import { SustainedMaxCard } from '../SustainedMaxCard.jsx';
import { measureSustainedMax } from '../../../model/sustainedMax.js';
beforeAll(() => { global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }; });
afterAll(() => { delete global.ResizeObserver; });
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
  expect(screen.getByText(/No qualifying holds yet/)).toBeInTheDocument();
});


test('older strong holds remain prominent when exact two-second recording started recently', () => {
  render(<SustainedMaxCard history={[
    {grip:'Crusher',hand:'L',date:'2026-09-20',actual_time_s:4.1,avg_force_kg:72,
      peak_force_kg:74.1,load_provenance:'measured_force',failure_valid:true},
    {...row('L',18.8),grip:'Crusher',date:'2026-10-02'},
  ]} unit="lbs" />);
  expect(screen.getByText('158.7 lbs')).toBeInTheDocument();
  expect(screen.getByText('2026-09-20 · 4.1s')).toBeInTheDocument();
  expect(screen.queryByText(/41.4/)).not.toBeInTheDocument();
  expect(screen.getByRole('heading', {name: 'Best max of at least 2s'})).toBeInTheDocument();
  expect(screen.getByRole('img', {name: /All-time best force history/})).toBeInTheDocument();
});


test('bodyweight scale selects the relative best and labels the chart in the same units', () => {
  const history = [
    {...row('L',60),date:'2026-09-01'},
    {...row('L',65),date:'2026-09-30'},
  ];
  const {rerender} = render(<SustainedMaxCard history={history} unit="kg" normalizeOn bodyWeight={80}
    bwLog={[{date:'2026-09-01',kg:60},{date:'2026-09-30',kg:80}]} />);
  expect(screen.getByText('1.00 × BW')).toBeInTheDocument();
  expect(screen.getByText('2026-09-01 · 2.0s')).toBeInTheDocument();
  expect(screen.getByRole('img', {name:/history in × BW/})).toBeInTheDocument();
  rerender(<SustainedMaxCard history={history} unit="kg" />);
  expect(screen.getByText('65.0 kg')).toBeInTheDocument();
  expect(screen.getByRole('img', {name:/history in kg/})).toBeInTheDocument();
});
