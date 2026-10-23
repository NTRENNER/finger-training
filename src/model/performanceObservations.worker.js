import { buildPerformanceObservations } from './performanceTrendEvidence.js';

globalThis.onmessage = ({ data: { id, history, grips, hand } }) => {
  try {
    globalThis.postMessage({ id, result: buildPerformanceObservations(history, grips, hand) });
  } catch {
    globalThis.postMessage({ id, result: null });
  }
};
