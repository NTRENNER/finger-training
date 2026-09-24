/* eslint-env worker */
/* global globalThis */
import { buildPredictionModels } from './predictionTracking.js';

globalThis.onmessage = ({ data: { history, grip, target, day } }) => {
  try {
    const models = Object.fromEntries(['L', 'R'].map(hand => [hand,
      buildPredictionModels(history, grip, hand, target, { referenceDate: day })]));
    globalThis.postMessage({ models });
  } catch (_) { globalThis.postMessage({ models: {} }); }
};
