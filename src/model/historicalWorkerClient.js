export function createHistoricalReviewWorker() {
  return new Worker(new URL('./historicalEvaluation.worker.js', import.meta.url));
}
