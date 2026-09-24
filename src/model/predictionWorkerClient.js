export function createPredictionWorker() {
  return new Worker(new URL('./predictionBuild.worker.js', import.meta.url));
}
