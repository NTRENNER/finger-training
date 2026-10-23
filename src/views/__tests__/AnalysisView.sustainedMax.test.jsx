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
test('the active finger Analysis page exposes instantaneous peaks and honors grip and hand filters', () => {
  render(<AnalysisView history={[peak('Micro', 'L', 20), peak('Micro', 'R', 25), peak('Crusher', 'L', 40)]} unit="kg" />);
  expect(screen.getByRole('heading', { name: 'Peak force — max strength over time' })).toBeInTheDocument();
  const peakCard = screen.getByRole('region', { name: 'Peak force history' });
  expect(within(peakCard).getByText('Micro')).toBeInTheDocument();
  expect(within(peakCard).getByText('Crusher')).toBeInTheDocument();
  expect(screen.queryByText('Recovery status')).not.toBeInTheDocument();
  const curveImprovement = screen.getByText('Curve Improvement by Duration');
  const recentPerformance = screen.getByRole('heading', { name: 'Recent Performance vs Expected' });
  const peakForce = screen.getByRole('heading', { name: 'Peak force — max strength over time' });
  expect(curveImprovement.compareDocumentPosition(recentPerformance) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(recentPerformance.compareDocumentPosition(peakForce) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByText('Curve coverage')).not.toBeInTheDocument();
  expect(screen.queryByText('Recorded pulls and current curve')).not.toBeInTheDocument();
  expect(screen.queryByText('Overall curve summary')).not.toBeInTheDocument();
  expect(screen.queryByText('Training & measurements')).not.toBeInTheDocument();
  const scope = within(screen.getByRole('group', { name: 'Analysis scope' }));
  fireEvent.click(scope.getByRole('button', { name: /^Micro/ }));
  expect(within(peakCard).queryByText('Crusher')).not.toBeInTheDocument();
  fireEvent.click(scope.getByRole('button', { name: 'Left' }));
  expect(within(peakCard).getByText('20.0 kg')).toBeInTheDocument();
  expect(within(peakCard).queryByText('25.0 kg')).not.toBeInTheDocument();
});
