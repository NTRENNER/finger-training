import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { HistoryView } from '../HistoryView.js';
import { AnalysisView } from '../AnalysisView.js';
import { recoveryRows } from '../../testHelpers/recoveryRows.js';

jest.mock('../cards/RepCurveChart.jsx', () => ({ RepCurveChart: ({ actual }) =>
  <div data-testid="rep-curve-times">{JSON.stringify(actual.map(p => p.t))}</div> }));
jest.mock('../analysis/ForceDurationCard.jsx', () => ({ ForceDurationCard: props =>
  <button onClick={() => props.handleDotClick({ session_id: 'volume-session' })}>Inspect workout</button> }));

beforeAll(() => { global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }; });
afterAll(() => { delete global.ResizeObserver; });
beforeEach(() => localStorage.clear());
const history = [1, 2].flatMap(set_num => recoveryRows('measured', { sessionId: 'volume-session' })
  .map(r => ({ ...r, id: `${set_num}-${r.id}`, set_num, actual_time_s: r.actual_time_s / set_num })));

test('History compares set one without concatenating set two and retains every recorded hold', () => {
  render(<HistoryView history={history} unit="kg" />);
  expect(screen.getByTestId('rep-curve-times')).toHaveTextContent('[40,24,16,12]');
  expect(screen.getByText(/Set 1 comparison/)).toBeInTheDocument();
  expect(screen.getAllByText(/^Set 2 · Rep/)).toHaveLength(4);
});

test('Analysis labels its first-set comparison and never draws a combined eight-rep curve', () => {
  render(<AnalysisView history={history} unit="kg" />);
  fireEvent.click(screen.getByRole('button', { name: 'Inspect workout' }));
  expect(screen.getByTestId('rep-curve-times')).toHaveTextContent('[40,24,16,12]');
  expect(screen.getByText(/Set 1 comparison/)).toBeInTheDocument();
});
