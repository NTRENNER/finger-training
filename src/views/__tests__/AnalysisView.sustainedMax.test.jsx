import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { AnalysisView } from '../AnalysisView.jsx';
import { recordForce } from '../../model/forceRecording.js';
import { peakMeasurementRecord } from '../../model/peakTest.js';

beforeAll(() => { global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }; });
afterAll(() => { delete global.ResizeObserver; });
const peak = (grip, hand, kg) => peakMeasurementRecord({
  stats: recordForce(Array.from({ length: 301 }, (_, i) => ({ ts: i * 10, kg }))),
  grip, hand, round: 0, firstHand: 'L', date: '2026-09-30', sessionId: `${grip}-${hand}`,
});
test('the active finger Analysis page exposes sustained records and honors grip and hand filters', () => {
  render(<AnalysisView history={[peak('Micro', 'L', 20), peak('Micro', 'R', 25), peak('Crusher', 'L', 40)]} unit="kg" />);
  expect(screen.getByRole('heading', { name: 'Best max of at least 2s' })).toBeInTheDocument();
  expect(screen.getByText('Micro · Left hand')).toBeInTheDocument();
  expect(screen.getByText('Micro · Right hand')).toBeInTheDocument();
  expect(screen.getByText('Crusher · Left hand')).toBeInTheDocument();
  const scope = within(screen.getByRole('group', { name: 'Analysis scope' }));
  fireEvent.click(scope.getByRole('button', { name: /^Micro/ }));
  expect(screen.queryByText('Crusher · Left hand')).not.toBeInTheDocument();
  fireEvent.click(scope.getByRole('button', { name: 'Left' }));
  expect(screen.getByText('Micro · Left hand')).toBeInTheDocument();
  expect(screen.queryByText('Micro · Right hand')).not.toBeInTheDocument();
});
