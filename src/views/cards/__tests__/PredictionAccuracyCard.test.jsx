import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { PredictionAccuracyCard } from '../PredictionAccuracyCard.jsx';
import { buildPredictionModels, preparePrediction, completePrediction } from '../../../model/predictionTracking.js';
import { buildThreeExpPriors } from '../../../model/threeExp.js';
import { recoveryRows } from '../../../testHelpers/recoveryRows.js';

test('empty state explains what is needed without claiming historical accuracy', () => {
  render(<PredictionAccuracyCard history={[]} />);
  expect(screen.getByText('0 of 10 training days')).toBeInTheDocument();
  expect(screen.getByText(/Recording starts with new standard sessions/)).toBeInTheDocument();
  expect(screen.getByText(/Recommendations stay unchanged/)).toBeInTheDocument();
  expect(screen.queryByText('Ready for a model review')).not.toBeInTheDocument();
});

test('ten independent days enable a review download, not an automatic model switch', () => {
  const history = Array.from({ length: 6 }, (_, i) => recoveryRows('legacy', {
    sessionId: `prior-${i}`, date: `2026-09-0${i + 1}`,
  })).flat();
  const model = buildPredictionModels(history, 'Crusher', 'L', 30, {
    referenceDate: '2026-09-10', threeExpPriors: buildThreeExpPriors(history) });
  const rows = Array.from({ length: 10 }, (_, i) => {
    const rep = recoveryRows('measured', { sessionId: `new-${i}`, date: `2026-09-${10 + i}` })[0];
    const p = preparePrediction(model, [], { loadKg: 30, target: 30, rest: 20, preparedAt: `${rep.date}T09:00:00Z` });
    rep.force_recording.prediction_check = completePrediction(p, [], rep);
    return rep;
  });
  render(<PredictionAccuracyCard history={rows} unit="lbs" />);
  expect(screen.getByText('Ready for a model review')).toBeInTheDocument();
  expect(screen.getByText(/next is in 10 more training days/)).toBeInTheDocument();
  expect(screen.getByText('Most recent 10 training days')).toBeInTheDocument();
  expect(screen.getByText('Established ability + recent performance')).toBeInTheDocument();
  expect(screen.getByText(/10 new training days/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Apply|Promote/ })).not.toBeInTheDocument();
  URL.createObjectURL = jest.fn(() => 'blob:report');
  URL.revokeObjectURL = jest.fn();
  const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  fireEvent.click(screen.getByRole('button', { name: 'Download review' }));
  expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
  expect(click).toHaveBeenCalledTimes(1);
  click.mockRestore();
});

test('research breakdown controls are labeled and missing forecasts stay explicitly unavailable', () => {
  render(<PredictionAccuracyCard history={[]} />);
  fireEvent.change(screen.getByLabelText('Comparison', { exact: true }), { target: { value: 'preSessionRecovery' } });
  fireEvent.change(screen.getByLabelText('Group by', { exact: true }), { target: { value: 'priorDaysBand' } });
  expect(screen.getByText('No comparable saved forecasts in this group yet.')).toBeInTheDocument();
  expect(screen.getByText('No comparable saved opening forecasts yet.')).toBeInTheDocument();
});
