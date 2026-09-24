/* eslint-env worker */
/* global globalThis */
import { evaluateHistorical } from './historicalEvaluation.js';

globalThis.onmessage = event => {
  try { globalThis.postMessage({ report: evaluateHistorical(event.data) }); }
  catch (error) { globalThis.postMessage({ error: error.message || 'Historical review failed' }); }
};
