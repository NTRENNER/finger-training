import { useCallback, useEffect, useRef } from 'react';
import { today } from '../util.js';

// Research is optional. Build while the plan is visible, off the UI thread.
// Starting early or a failed worker skips diagnostics; it never delays a hold.
export function usePreparedPredictions(history, config, enabled) {
  const ready = useRef(null);
  const day = today();
  const grip = config.grip, target = config.targetTime;
  const eligible = enabled && !config.peakTest && !config.mixedDomainPlan && !!grip;
  useEffect(() => {
    if (!eligible || typeof Worker === 'undefined') return;
    ready.current = null;
    let disposed = false, worker;
    const snapshot = JSON.parse(JSON.stringify(history));
    import('../model/predictionWorkerClient.js').then(({ createPredictionWorker }) => {
      if (disposed) return;
      worker = createPredictionWorker();
      worker.onmessage = ({ data }) => {
        if (!disposed) ready.current = { history, grip, target, day, models: data.models || {} };
        worker.terminate();
      };
      worker.onerror = () => worker.terminate();
      worker.postMessage({ history: snapshot, grip, target, day });
    }).catch(() => { worker?.terminate(); /* Research must never interrupt training. */ });
    return () => { disposed = true; worker?.terminate(); };
  }, [history, grip, target, day, eligible]);
  return useCallback((requested, startDay) => {
    const cache = ready.current;
    return cache && cache.history === history && cache.grip === requested.grip
      && cache.target === requested.targetTime && cache.day === startDay
      ? cache.models : {};
  }, [history]);
}
