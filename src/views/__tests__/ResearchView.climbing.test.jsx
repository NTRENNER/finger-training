import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ResearchView } from '../ResearchView.jsx';
import { createHistoricalReviewWorker } from '../../model/historicalWorkerClient.js';
import { evaluateHistorical } from '../../model/historicalEvaluation.js';
import { recoveryRows } from '../../testHelpers/recoveryRows.js';
jest.mock('../../model/historicalWorkerClient.js', () => ({ createHistoricalReviewWorker: jest.fn() }));

test('the historical review shows trend-model accuracy without a model comparison chart', async () => {
  const history = recoveryRows('measured');
  const worker = { postMessage: jest.fn(), terminate: jest.fn() };
  createHistoricalReviewWorker.mockReturnValue(worker);
  render(<ResearchView history={history} activities={[]} unit="lbs" signedIn historySynced />);
  fireEvent.click(screen.getByRole('button', { name: 'Review earlier workouts' }));
  await waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith(history));
  const score = { trainingDays: 1, observations: 1, mae: 2, rmse: 2, bias: -2 };
  const report = { ...evaluateHistorical(history), contextualTrends: {
    all: { original: score, contextOnly: score, contextRobust: score }, byGrip: {}, byContext: {},
  } };
  act(() => worker.onmessage({ data: { report } }));
  expect(screen.getByText('Does earlier training explain trend changes?')).toBeInTheDocument();
  expect(screen.getAllByText('4.41 lbs').length).toBeGreaterThan(0);
  expect(screen.queryByRole('checkbox', { name: 'Compare trend charts', hidden: true })).not.toBeInTheDocument();
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Download historical review' })).toBeInTheDocument();
});
