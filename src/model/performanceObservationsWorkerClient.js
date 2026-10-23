export function createPerformanceObservationsWorker() {
  return new Worker(new URL('./performanceObservations.worker.js', import.meta.url), { type: 'module' });
}
