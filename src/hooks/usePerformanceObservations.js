import { useEffect, useMemo, useState } from 'react';
import { buildPerformanceObservations } from '../model/performanceTrendEvidence.js';

// Results depend only on (history, grips, hand). Keeping them per history
// array makes switching hand views or revisiting Analysis instant.
const cache = new WeakMap();
const cached = (history, key) => cache.get(history)?.get(key);
const remember = (history, key, result) => {
  if (!cache.has(history)) cache.set(history, new Map());
  cache.get(history).set(key, result);
};

// Older holds have no saved pre-session curve, so each training date's curve
// is rebuilt from the history before it. That costs seconds on a long
// history, so it runs off the UI thread. Without Worker support (tests, old
// browsers) or if the worker fails, it computes on the main thread instead.
export function usePerformanceObservations(history, grips, hand) {
  const key = `${grips.join('|')}::${hand}`;
  const synchronous = typeof Worker === 'undefined';
  const [revision, setRevision] = useState(0);
  const hit = useMemo(() => cached(history, key), [history, key, revision]); // eslint-disable-line react-hooks/exhaustive-deps
  const syncResult = useMemo(
    () => (synchronous && !hit ? buildPerformanceObservations(history, grips, hand) : null),
    [synchronous, hit, history, grips, hand],
  );

  useEffect(() => {
    if (synchronous || hit) return undefined;
    let disposed = false, worker = null;
    const settle = result => {
      worker?.terminate();
      if (disposed) return;
      remember(history, key, result ?? buildPerformanceObservations(history, grips, hand));
      setRevision(n => n + 1);
    };
    import('../model/performanceObservationsWorkerClient.js').then(({ createPerformanceObservationsWorker }) => {
      if (disposed) return;
      worker = createPerformanceObservationsWorker();
      worker.onmessage = ({ data }) => settle(data?.result);
      worker.onerror = () => settle(null);
      worker.postMessage({ history, grips, hand });
    }).catch(() => settle(null));
    return () => { disposed = true; worker?.terminate(); };
  }, [synchronous, hit, history, grips, hand, key]);

  const result = hit ?? syncResult;
  return { loading: !result, result };
}
