import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { PerformanceTrendCards } from '../PerformanceTrendCards.jsx';
import { PerformanceObservationDetails } from '../PerformanceTrendEvidence.jsx';
import { buildPerformanceObservations } from '../../../model/performanceTrendEvidence.js';

jest.mock('../../../model/performanceTrendEvidence.js', () => ({
  buildPerformanceObservations: jest.fn(),
  PERFORMANCE_REFERENCE_DURATIONS: [5, 30, 70, 115, 160, 220],
  DURATION_BAND_LABELS: { short: 'Short (≤45 s)', medium: 'Medium (>45–120 s)', long: 'Long (>120 s)' },
}));
jest.mock('recharts', () => {
  const React = require('react');
  const Wrap = ({ children }) => <div>{children}</div>;
  return {
    ResponsiveContainer: Wrap,
    ComposedChart: ({ data, children }) => <div data-testid="trend-chart" data-dates={data.map(row => row.date).join(',')} data-climbs={data.map(row => row.climbLoad == null ? 'unknown' : row.climbLoad).join(',')}>{children}</div>,
    Scatter: ({ data, line, name, onClick }) => <div data-testid="opening-hold-points" data-grip={name} data-holds={data.map(row => row.id).join(',')} data-connected={String(line)}>
      {data.map(row => <button key={row.id} data-testid={`point-${row.id}`}
        onClick={() => onClick({ payload: row })}>Point {row.id}</button>)}
    </div>,
    XAxis: ({ domain, ticks }) => <div data-testid="trend-x-axis" data-domain={JSON.stringify(domain)} data-ticks={JSON.stringify(ticks)} />,
    Bar: () => null, YAxis: () => null, Tooltip: () => null, CartesianGrid: () => null, ReferenceLine: ({ y, label }) => <div data-testid="reference-line" data-value={y}>{label?.value}</div>,
  };
});

const history = [], grips = ['Micro'];
const durations = [5, 30, 70, 115, 160, 220];

function diagnostics(status, date) {
  const referenceSupport = durations.map(duration => ({
    duration, status: duration <= 120 ? 'supported' : 'unobserved', dates: duration <= 120 ? 2 : 0,
  }));
  return {
    status,
    eligibleDates: 5,
    referenceSupport,
    perHand: ['L', 'R'].map(hand => ({ hand, eligibleDates: 5, eligibleHolds: 5, durationRange: { min: 5, max: 115 },
      referenceSupport: referenceSupport.map(support => ({ ...support, lastDate: support.dates ? date : null })),
    })),
    reasons: ['Long holds have limited support.'],
    recordingMethods: [{ label: 'Legacy whole-pull interval' }],
    ...(status === 'provisional' ? { stability: { status: 'insufficient', reason: 'Removing a date leaves too few eligible dates.' } } : {}),
  };
}

function makeAnalysis(scores = [100, 110, 120, 116, 112, 110]) {
  let peak = 0;
  const rows = scores.map((score, index) => {
    if (score > scores[peak]) peak = index;
    const date = `2026-08-0${index + 1}`;
    return {
      date, timestamp: Date.parse(date), Micro_long: score - 100, Micro_short: index - 3,
      Micro_evidence: {
        date, score,
        maturation: { ready: true, date: '2026-08-01', score: 100, improvement: score - 100,
          supportedDomains: 6, totalDomains: 6, requiredPointsPerDomain: 2 },
        baselineDate: '2026-08-01', baselineScore: 100,
        peakDate: `2026-08-0${peak + 1}`, peakScore: scores[peak], changeFromPeak: (score / scores[peak] - 1) * 100,
        referenceForces: durations.map(duration => ({
          duration, force: score / 5, baselineForce: 20, peakForce: scores[peak] / 5,
          currentSupport: duration <= 120 ? 'supported' : 'unobserved',
          peakSupport: duration <= 120 ? 'supported' : 'unobserved',
        })),
        baselineEvidence: diagnostics('provisional', '2026-08-01'), currentEvidence: diagnostics('limited', date),
      },
    };
  });
  const observations = rows.map((row, index) => ({
    id: `hold-${index}`, date: row.date, timestamp: row.timestamp, grip: 'Micro', hand: index % 2 ? 'R' : 'L',
    duration: durations[index], durationBand: index < 2 ? 'short' : index < 4 ? 'medium' : 'long',
    force: 20, expectedForce: 25, deviation: -20,
    context: ['first_recorded', 'after_training', 'unknown'][index % 3], earlierGrips: index % 3 === 1 ? ['Crusher'] : [],
    recordingCompatibility: 'Legacy recording interval; stopping details may be unknown.',
  }));
  return { rows, observations };
}

beforeEach(() => buildPerformanceObservations.mockReturnValue(makeAnalysis()));

test('keeps calibrated session performance after estimated capacity is removed', () => {
  render(<PerformanceTrendCards history={history} grips={grips} />);
  expect(screen.getByRole('heading', { name: 'Recent Performance vs Prediction' })).toBeInTheDocument();
  expect(screen.queryByText(/Session Performance =/)).not.toBeInTheDocument();
  expect(screen.queryByText('Estimated Capacity Over Time')).not.toBeInTheDocument();
});

test('the date window filters actual comparison points without refitting', () => {
  render(<PerformanceTrendCards history={history} grips={grips} />);
  expect(screen.getAllByTestId('trend-chart')).toHaveLength(1);
  expect(buildPerformanceObservations).toHaveBeenCalledWith(history, grips, 'pooled');
  fireEvent.change(screen.getByRole('slider', { name: 'Start date' }), { target: { value: 2 } });
  fireEvent.change(screen.getByRole('slider', { name: 'End date' }), { target: { value: 4 } });
  expect(screen.getByTestId('trend-chart')).toHaveAttribute('data-dates', '2026-08-03,2026-08-04,2026-08-05');
  expect(screen.getByTestId('opening-hold-points')).toHaveAttribute('data-holds', 'hold-2,hold-3,hold-4');
  expect(buildPerformanceObservations).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByRole('slider', { name: 'Start date' }), { target: { value: 0 } });
  fireEvent.change(screen.getByRole('slider', { name: 'End date' }), { target: { value: 5 } });
  expect(screen.getByText('Showing 6 of 6 training dates')).toBeInTheDocument();
});

test('short chart has individual unconnected points and keyboard-selectable duration and session filters', () => {
  render(<PerformanceTrendCards history={history} grips={grips} />);
  expect(screen.queryByTestId('connected-trend')).not.toBeInTheDocument();
  expect(screen.getByTestId('opening-hold-points')).toHaveAttribute('data-connected', 'false');
  fireEvent.change(screen.getByRole('combobox', { name: 'Hold duration' }), { target: { value: 'long' } });
  expect(screen.getByTestId('opening-hold-points')).toHaveAttribute('data-holds', 'hold-4,hold-5');
  fireEvent.change(screen.getByRole('combobox', { name: 'Finger session order' }), { target: { value: 'after_training' } });
  expect(screen.getByTestId('opening-hold-points')).toHaveAttribute('data-holds', 'hold-4');
  expect(screen.getByText('Showing 1 of 6 comparable opening holds in this date range.')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox', { name: 'Finger session order' }), { target: { value: 'first_recorded' } });
  expect(screen.getByText(/No opening holds match these filters/)).toBeInTheDocument();
  expect(screen.queryByTestId('trend-chart')).not.toBeInTheDocument();
  expect(buildPerformanceObservations).toHaveBeenCalledTimes(1);
});

test('the chart retains the exact shown date domain and unique ticks when observations start later', () => {
  const analysis = makeAnalysis();
  analysis.observations = [...analysis.observations.slice(2), { ...analysis.observations[4], id: 'another-hold-same-date' }];
  buildPerformanceObservations.mockReturnValue(analysis);
  render(<PerformanceTrendCards history={history} grips={grips} />);
  const timestamps = analysis.rows.map(row => row.timestamp);
  screen.getAllByTestId('trend-x-axis').forEach(axis => {
    expect(axis).toHaveAttribute('data-domain', JSON.stringify([timestamps[0], timestamps.at(-1)]));
    expect(axis).toHaveAttribute('data-ticks', JSON.stringify(timestamps));
  });
  fireEvent.change(screen.getByRole('slider', { name: 'Start date' }), { target: { value: 1 } });
  screen.getAllByTestId('trend-x-axis').forEach(axis => {
    expect(axis).toHaveAttribute('data-domain', JSON.stringify([timestamps[1], timestamps.at(-1)]));
    expect(axis).toHaveAttribute('data-ticks', JSON.stringify(timestamps.slice(1)));
  });
  expect(buildPerformanceObservations).toHaveBeenCalledTimes(1);
});

test('grips with no observations do not render empty Scatter series that could inherit chart data', () => {
  render(<PerformanceTrendCards history={history} grips={['Micro', 'Prime']} />);
  expect(screen.getAllByTestId('opening-hold-points')).toHaveLength(1);
  expect(screen.getByTestId('opening-hold-points')).toHaveAttribute('data-grip', 'Micro');
});

test('point details expose the compact comparison fields without a duplicate inspector', () => {
  render(<PerformanceTrendCards history={history} grips={grips} />);
  fireEvent.click(screen.getByTestId('point-hold-4'));
  const details = screen.getByRole('region', { name: 'Selected opening hold' });
  expect(within(details).getByRole('heading', { name: 'Micro · Left · 2026-08-05' })).toBeInTheDocument();
  expect(within(details).getByText('20.0 kg')).toBeInTheDocument();
  expect(within(details).getByText('25.0 kg')).toBeInTheDocument();
  expect(within(details).getByText('160 s')).toBeInTheDocument();
  expect(within(details).getByText('After earlier finger training')).toBeInTheDocument();
  expect(within(details).queryByText('Expectation source')).not.toBeInTheDocument();
  expect(within(details).queryByText(/Earlier recorded finger training/)).not.toBeInTheDocument();
  expect(screen.queryByText('Inspect opening-hold measurements')).not.toBeInTheDocument();
});

test('empty history explains that calibrated opening-hold comparisons are unavailable', () => {
  buildPerformanceObservations.mockReturnValue({ rows: [], observations: [] });
  render(<PerformanceTrendCards history={null} grips={grips} />);
  expect(screen.getByText(/Comparisons appear once a pre-workout prediction is available/)).toBeInTheDocument();
  expect(screen.queryByText('Estimated Capacity Over Time')).not.toBeInTheDocument();
  expect(screen.queryByRole('slider')).not.toBeInTheDocument();
});

test('partial-hand evidence can show the available opening holds', () => {
  const analysis = makeAnalysis();
  buildPerformanceObservations.mockReturnValue({
    rows: analysis.rows.map(({ date, timestamp, Micro_short }) => ({ date, timestamp, Micro_short })),
    observations: analysis.observations.filter(item => item.hand === 'L'),
  });
  render(<PerformanceTrendCards history={history} grips={grips} />);
  expect(screen.getAllByTestId('trend-chart')).toHaveLength(1);
  expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
});

test('deleting dates in a selected window keeps charts and handles usable', () => {
  const view = render(<PerformanceTrendCards history={history} grips={grips} />);
  fireEvent.change(screen.getByRole('slider', { name: 'Start date' }), { target: { value: 4 } });
  buildPerformanceObservations.mockReturnValue(makeAnalysis([100, 110, 120, 116, 112]));
  view.rerender(<PerformanceTrendCards history={[{ id: 'changed' }]} grips={grips} />);
  expect(screen.getByText('Showing 2 of 5 training dates')).toBeInTheDocument();
  screen.getAllByTestId('trend-chart').forEach(chart => expect(chart).toHaveAttribute('data-dates', '2026-08-04,2026-08-05'));
  fireEvent.change(screen.getByRole('slider', { name: 'Start date' }), { target: { value: 0 } });
  expect(screen.getByText('Showing 5 of 5 training dates')).toBeInTheDocument();
});

test('climbing context never refits the calibrated comparison and missing entries stay unknown', () => {
  const view = render(<PerformanceTrendCards history={history} grips={grips} />);
  screen.getAllByTestId('trend-chart').forEach(chart => expect(chart).toHaveAttribute('data-climbs', 'unknown,unknown,unknown,unknown,unknown,unknown'));
  view.rerender(<PerformanceTrendCards history={history} grips={grips} activities={[{ type: 'climbing', date: '2026-08-04', rpe: 8 }]} />);
  expect(buildPerformanceObservations).toHaveBeenCalledTimes(1);
  expect(screen.getAllByTestId('trend-chart')).toHaveLength(1);
});

test('shares the calibrated observations with the surrounding analysis view', () => {
  const onAnalysis = jest.fn();
  const analysis = makeAnalysis();
  buildPerformanceObservations.mockReturnValue(analysis);
  render(<PerformanceTrendCards history={history} grips={grips} onAnalysis={onAnalysis} />);
  expect(onAnalysis).toHaveBeenCalledWith(analysis);
});

test('click opens the actual observation and close, escape, or a second click dismisses it', () => {
  const analysis = makeAnalysis();
  const crusherHold = { ...analysis.observations[1], id: 'crusher-only', grip: 'Crusher', hand: 'R', force: 15, expectedForce: 30, deviation: -50 };
  analysis.observations = [analysis.observations[0], crusherHold, ...analysis.observations.slice(2)];
  buildPerformanceObservations.mockReturnValue(analysis);
  render(<PerformanceTrendCards history={history} grips={['Micro', 'Crusher']} />);
  fireEvent.click(screen.getByTestId('point-crusher-only'));
  const popup = screen.getByRole('dialog', { name: 'Opening hold details' });
  expect(within(popup).getByRole('heading', { name: 'Crusher · Right · 2026-08-02' })).toBeInTheDocument();
  expect(within(popup).getByText('15.0 kg')).toBeInTheDocument();
  expect(within(popup).getByText('-50.0% versus predicted force')).toBeInTheDocument();
  fireEvent.click(within(popup).getByRole('button', { name: 'Close point details' }));
  expect(screen.queryByRole('dialog', { name: 'Opening hold details' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByTestId('point-crusher-only'));
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: 'Opening hold details' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByTestId('point-crusher-only'));
  fireEvent.click(screen.getByTestId('point-crusher-only'));
  expect(screen.queryByRole('dialog', { name: 'Opening hold details' })).not.toBeInTheDocument();
});

test('hold details respect display units and do not call unknown sessions rested', () => {
  const observation = { ...makeAnalysis().observations[2], force: 10, expectedForce: 12.5,
    expectationBasis: 'workout_plan', plannedLoad: 10, plannedDuration: 160, calibrationScale: 1.36 };
  const view = render(<PerformanceObservationDetails observation={observation} unit="lbs" />);
  expect(screen.getByText('22.0 lbs')).toBeInTheDocument();
  expect(screen.getByText('27.6 lbs')).toBeInTheDocument();
  expect(screen.getByText('22.0 lbs for 160 s')).toBeInTheDocument();
  expect(screen.queryByText(/Personal calibration applied/)).not.toBeInTheDocument();
  expect(screen.getByText('Session order unknown')).toBeInTheDocument();
  expect(screen.queryByText('Expectation source')).not.toBeInTheDocument();
  expect(screen.queryByText(/do not establish this session’s order or your recovery/)).not.toBeInTheDocument();
  view.rerender(<PerformanceObservationDetails observation={null} />);
  expect(screen.queryByRole('region', { name: 'Selected opening hold' })).not.toBeInTheDocument();
});
