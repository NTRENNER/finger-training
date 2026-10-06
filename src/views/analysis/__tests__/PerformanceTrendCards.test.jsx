import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { PerformanceTrendCards } from '../PerformanceTrendCards.jsx';
import { PerformanceObservationDetails, PerformancePointTooltip } from '../PerformanceTrendEvidence.jsx';
import { buildPerformanceTrendAnalysis } from '../../../model/performanceTrendEvidence.js';

jest.mock('../../../model/performanceTrendEvidence.js', () => ({
  buildPerformanceTrendAnalysis: jest.fn(),
  PERFORMANCE_REFERENCE_DURATIONS: [5, 30, 70, 115, 160, 220],
  DURATION_BAND_LABELS: { short: 'Short (≤45 s)', medium: 'Medium (>45–120 s)', long: 'Long (>120 s)' },
}));
jest.mock('recharts', () => {
  const React = require('react');
  const Wrap = ({ children }) => <div>{children}</div>;
  return {
    ResponsiveContainer: Wrap,
    ComposedChart: ({ data, children }) => <div data-testid="trend-chart" data-dates={data.map(row => row.date).join(',')} data-climbs={data.map(row => row.climbLoad == null ? 'unknown' : row.climbLoad).join(',')}>{children}</div>,
    Line: ({ dataKey }) => <div data-testid="connected-trend" data-key={dataKey} />,
    Scatter: ({ data, line, name, onMouseEnter, onMouseLeave, onClick }) => <div data-testid="opening-hold-points" data-grip={name} data-holds={data.map(row => row.id).join(',')} data-connected={String(line)}>
      {data.map(row => <button key={row.id} data-testid={`point-${row.id}`} onMouseEnter={() => onMouseEnter({ payload: row })}
        onMouseLeave={onMouseLeave} onClick={() => onClick({ payload: row })}>Point {row.id}</button>)}
    </div>,
    XAxis: ({ domain, ticks }) => <div data-testid="trend-x-axis" data-domain={JSON.stringify(domain)} data-ticks={JSON.stringify(ticks)} />,
    Bar: () => null, YAxis: () => null, Tooltip: () => null, CartesianGrid: () => null, ReferenceLine: () => null,
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
        date, score, baselineDate: '2026-08-01', baselineScore: 100,
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

beforeEach(() => buildPerformanceTrendAnalysis.mockReturnValue(makeAnalysis()));

test('makes the two comparison meanings explicit and reports a ratio from the historical high', () => {
  render(<PerformanceTrendCards history={history} grips={grips} normalizeOn />);
  expect(screen.getByRole('heading', { name: 'Estimated finger capacity over time' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Session performance versus expected curve' })).toBeInTheDocument();
  expect(screen.getByText(/not a 20% loss of maximum strength/)).toBeInTheDocument();
  const summary = screen.getByRole('region', { name: 'Micro capacity summary' });
  expect(within(summary).getByText('+10.0%', { exact: false })).toBeInTheDocument();
  expect(within(summary).getByText('-8.3%', { exact: false })).toBeInTheDocument();
  expect(within(summary).getByText('2026-08-03')).toBeInTheDocument();
  expect(within(summary).getByText('Starting reference: provisional')).toBeInTheDocument();
  expect(screen.getByText(/bodyweight toggle applies to the other curve charts/)).toBeInTheDocument();
  expect(screen.getByText(/including dates before the shown range/)).toBeInTheDocument();
});

test('both charts share the date window without refitting and use the latest visible date for summaries', () => {
  render(<PerformanceTrendCards history={history} grips={grips} />);
  expect(screen.getAllByTestId('trend-chart')).toHaveLength(2);
  expect(buildPerformanceTrendAnalysis).toHaveBeenCalledWith(history, grips, 'pooled', { model: 'contextOnly' });
  fireEvent.change(screen.getByRole('slider', { name: 'Start date' }), { target: { value: 2 } });
  fireEvent.change(screen.getByRole('slider', { name: 'End date' }), { target: { value: 4 } });
  screen.getAllByTestId('trend-chart').forEach(chart => expect(chart).toHaveAttribute('data-dates', '2026-08-03,2026-08-04,2026-08-05'));
  expect(screen.getByTestId('opening-hold-points')).toHaveAttribute('data-holds', 'hold-2,hold-3,hold-4');
  expect(within(screen.getByRole('region', { name: 'Micro capacity summary' })).getByText('+12.0%', { exact: false })).toBeInTheDocument();
  expect(buildPerformanceTrendAnalysis).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByRole('slider', { name: 'Start date' }), { target: { value: 0 } });
  fireEvent.change(screen.getByRole('slider', { name: 'End date' }), { target: { value: 5 } });
  expect(screen.getByText('Showing 6 of 6 training dates')).toBeInTheDocument();
});

test('duration breakdown compares actual estimates at the selected dates without rebasing the curve', () => {
  render(<PerformanceTrendCards history={history} grips={grips} />);
  const section = screen.getByRole('region', { name: 'Capacity by hold duration' });
  expect(within(section).getByText('Micro: 2026-08-03 → 2026-08-06')).toBeInTheDocument();
  expect(within(section).getAllByText('-8.3%')).toHaveLength(6);
  expect(within(section).getAllByText('Limited support')).toHaveLength(2);
  fireEvent.change(screen.getByRole('slider', { name: 'Start date' }), { target: { value: 3 } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Compare latest shown estimate with' }), { target: { value: 'range' } });
  expect(within(section).getByText('Micro: 2026-08-04 → 2026-08-06')).toBeInTheDocument();
  expect(within(section).getAllByText('-5.2%')).toHaveLength(6);
  expect(buildPerformanceTrendAnalysis).toHaveBeenCalledTimes(1);
});

test('short chart has individual unconnected points and keyboard-selectable duration and session filters', () => {
  render(<PerformanceTrendCards history={history} grips={grips} />);
  expect(screen.getAllByTestId('connected-trend')).toHaveLength(1);
  expect(screen.getByTestId('connected-trend')).toHaveAttribute('data-key', 'Micro_long');
  expect(screen.getByTestId('opening-hold-points')).toHaveAttribute('data-connected', 'false');
  fireEvent.change(screen.getByRole('combobox', { name: 'Hold duration' }), { target: { value: 'long' } });
  expect(screen.getByTestId('opening-hold-points')).toHaveAttribute('data-holds', 'hold-4,hold-5');
  fireEvent.change(screen.getByRole('combobox', { name: 'Finger session order' }), { target: { value: 'after_training' } });
  expect(screen.getByTestId('opening-hold-points')).toHaveAttribute('data-holds', 'hold-4');
  expect(screen.getByText('Showing 1 of 6 comparable opening holds in this date range.')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox', { name: 'Finger session order' }), { target: { value: 'first_recorded' } });
  expect(screen.getByText(/No opening holds match these filters/)).toBeInTheDocument();
  expect(screen.getAllByTestId('trend-chart')).toHaveLength(1);
  expect(buildPerformanceTrendAnalysis).toHaveBeenCalledTimes(1);
});

test('both charts retain the exact shown date domain and unique ticks when observations start later', () => {
  const analysis = makeAnalysis();
  analysis.observations = [...analysis.observations.slice(2), { ...analysis.observations[4], id: 'another-hold-same-date' }];
  buildPerformanceTrendAnalysis.mockReturnValue(analysis);
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
  expect(buildPerformanceTrendAnalysis).toHaveBeenCalledTimes(1);
});

test('grips with no observations do not render empty Scatter series that could inherit chart data', () => {
  render(<PerformanceTrendCards history={history} grips={['Micro', 'Prime']} />);
  expect(screen.getAllByTestId('opening-hold-points')).toHaveLength(1);
  expect(screen.getByTestId('opening-hold-points')).toHaveAttribute('data-grip', 'Micro');
  expect(within(screen.getByRole('region', { name: 'Prime capacity summary' })).getByText(/A starting reference is not available/)).toBeInTheDocument();
});

test('an accessible hold inspector exposes force, prior expectation, duration, hand and workload limits', () => {
  render(<PerformanceTrendCards history={history} grips={grips} />);
  fireEvent.click(screen.getByText('Inspect opening-hold measurements'));
  fireEvent.change(screen.getByRole('combobox', { name: 'Opening hold' }), { target: { value: 'hold-4' } });
  const details = screen.getByRole('region', { name: 'Selected opening hold' });
  expect(within(details).getByRole('heading', { name: 'Micro · Left · 2026-08-05' })).toBeInTheDocument();
  expect(within(details).getByText('20.0 kg')).toBeInTheDocument();
  expect(within(details).getByText('25.0 kg')).toBeInTheDocument();
  expect(within(details).getByText('160 s')).toBeInTheDocument();
  expect(within(details).getByText('After earlier finger training')).toBeInTheDocument();
  expect(within(details).getByText('Earlier recorded finger training: Crusher.')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox', { name: 'Opening hold' }), { target: { value: 'hold-0' } });
  expect(within(details).getByText(/First recorded does not establish recovery/)).toBeInTheDocument();
  expect(screen.getByText(/Missing climbing logs leave workload unknown/)).toBeInTheDocument();
});

test('empty history explains both unavailable charts without presenting a decline', () => {
  buildPerformanceTrendAnalysis.mockReturnValue({ rows: [], observations: [] });
  render(<PerformanceTrendCards history={null} grips={grips} />);
  expect(screen.getByText(/More training dates needed/)).toBeInTheDocument();
  expect(screen.getByText(/Missing estimates do not indicate declining performance/)).toBeInTheDocument();
  expect(screen.queryByRole('slider')).not.toBeInTheDocument();
});

test('partial-hand evidence can show an opening hold without inventing a both-hand capacity curve', () => {
  const analysis = makeAnalysis();
  buildPerformanceTrendAnalysis.mockReturnValue({
    rows: analysis.rows.map(({ date, timestamp, Micro_short }) => ({ date, timestamp, Micro_short })),
    observations: analysis.observations.filter(item => item.hand === 'L'),
  });
  render(<PerformanceTrendCards history={history} grips={grips} />);
  expect(screen.getByText(/A starting reference is not available/)).toBeInTheDocument();
  expect(screen.getByText(/No capacity estimates in this range/)).toBeInTheDocument();
  expect(screen.getAllByTestId('trend-chart')).toHaveLength(1);
  expect(screen.queryByRole('region', { name: 'Capacity by hold duration' })).not.toBeInTheDocument();
  expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
});

test('deleting dates in a selected window keeps charts and handles usable', () => {
  const view = render(<PerformanceTrendCards history={history} grips={grips} />);
  fireEvent.change(screen.getByRole('slider', { name: 'Start date' }), { target: { value: 4 } });
  buildPerformanceTrendAnalysis.mockReturnValue(makeAnalysis([100, 110, 120, 116, 112]));
  view.rerender(<PerformanceTrendCards history={[{ id: 'changed' }]} grips={grips} />);
  expect(screen.getByText('Showing 2 of 5 training dates')).toBeInTheDocument();
  screen.getAllByTestId('trend-chart').forEach(chart => expect(chart).toHaveAttribute('data-dates', '2026-08-04,2026-08-05'));
  fireEvent.change(screen.getByRole('slider', { name: 'Start date' }), { target: { value: 0 } });
  expect(screen.getByText('Showing 5 of 5 training dates')).toBeInTheDocument();
});

test('climbing context never refits either estimate and missing entries stay unknown', () => {
  const view = render(<PerformanceTrendCards history={history} grips={grips} />);
  screen.getAllByTestId('trend-chart').forEach(chart => expect(chart).toHaveAttribute('data-climbs', 'unknown,unknown,unknown,unknown,unknown,unknown'));
  view.rerender(<PerformanceTrendCards history={history} grips={grips} activities={[{ type: 'climbing', date: '2026-08-04', rpe: 8 }]} />);
  expect(buildPerformanceTrendAnalysis).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/Same-day climbing may have happened before or after finger training/)).toBeInTheDocument();
});

test('coverage exposes historical measurement dates and distinguishes support from reference stability', () => {
  render(<PerformanceTrendCards history={history} grips={grips} />);
  fireEvent.click(screen.getByText('Starting reference and data coverage'));
  const evidence = screen.getByRole('region', { name: 'Micro reference evidence' });
  expect(within(evidence).getByText(/Reference stability has not been established/)).toBeInTheDocument();
  expect(within(evidence).getAllByRole('table', { name: 'Last nearby measurement by hold duration' })).toHaveLength(2);
  expect(screen.getByText(/including older measurements, within 25%/)).toBeInTheDocument();
});

test('hover and click inspect the actual observation when grip series have different dates and lengths', () => {
  const analysis = makeAnalysis();
  const crusherHold = { ...analysis.observations[1], id: 'crusher-only', grip: 'Crusher', hand: 'R', force: 15, expectedForce: 30, deviation: -50 };
  analysis.observations = [analysis.observations[0], crusherHold, ...analysis.observations.slice(2)];
  buildPerformanceTrendAnalysis.mockReturnValue(analysis);
  render(<PerformanceTrendCards history={history} grips={['Micro', 'Crusher']} />);
  fireEvent.mouseEnter(screen.getByTestId('point-crusher-only'));
  const tooltip = screen.getByRole('tooltip');
  expect(within(tooltip).getByRole('heading', { name: 'Crusher · Right · 2026-08-02' })).toBeInTheDocument();
  expect(within(tooltip).getByText('15.0 kg')).toBeInTheDocument();
  expect(within(tooltip).getByText('-50.0% versus expected force')).toBeInTheDocument();
  fireEvent.mouseLeave(screen.getByTestId('point-crusher-only'));
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  fireEvent.click(screen.getByTestId('point-crusher-only'));
  expect(screen.getByRole('combobox', { name: 'Opening hold' })).toHaveValue('crusher-only');
  expect(within(screen.getByRole('region', { name: 'Selected opening hold' })).getByRole('heading', { name: 'Crusher · Right · 2026-08-02' })).toBeInTheDocument();
});

test('tooltip and hold details respect display units and do not call unknown sessions rested', () => {
  const observation = { ...makeAnalysis().observations[2], force: 10, expectedForce: 12.5 };
  const view = render(<PerformancePointTooltip observation={observation} unit="lbs" />);
  expect(screen.getByText('22.0 lbs')).toBeInTheDocument();
  expect(screen.getByText('27.6 lbs')).toBeInTheDocument();
  expect(screen.getByText('Session order unknown')).toBeInTheDocument();
  expect(screen.getByText(/do not establish this session’s order or your recovery/)).toBeInTheDocument();
  view.rerender(<PerformanceObservationDetails observation={null} />);
  expect(screen.queryByRole('region', { name: 'Selected opening hold' })).not.toBeInTheDocument();
});
