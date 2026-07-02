// ─────────────────────────────────────────────────────────────
// useLSValue — live read of a logical localStorage key
// ─────────────────────────────────────────────────────────────
// The React face of storage.js's reactive layer (see the
// SUBSCRIPTIONS + SNAPSHOT CACHE section there for the ownership
// story). A component that renders `useLSValue(key)` re-renders
// whenever saveLS writes that key — from this component, another
// view, the cloud reconcile, pullFromCloud, or another tab. This
// replaces the mount-time loadLS snapshots (stale after any post-
// mount write), the tick-counter forced re-reads, and the
// per-render JSON parses that views grew individually.
//
// `key` is a LOGICAL key (an LS_*_KEY constant); pass the same
// string you'd pass to loadLS/saveLS.
//
// TREAT THE RETURNED VALUE AS IMMUTABLE. useSyncExternalStore
// requires snapshots to be referentially stable between writes, so
// getLSSnapshot hands every caller the SAME cached object. Mutating
// it corrupts what other subscribers (and this component's next
// render) see without triggering any re-render. To update: build a
// NEW array/object and persist it with saveLS —
//
//   const log = useLSValue(LS_WORKOUT_LOG_KEY) || [];
//   ...
//   saveLS(LS_WORKOUT_LOG_KEY, [...log, newEntry]);   // ✓ new array
//   // log.push(newEntry); saveLS(..., log);          // ✗ mutation
//
// Returns null when the key is absent — same contract as loadLS —
// so `useLSValue(key) || fallback` reads naturally. If the value
// feeds a useMemo dep, derive the fallback INSIDE a memo keyed on
// the raw value (a bare `|| []` makes a fresh array identity every
// render and defeats the memo).
//
// Reads that only need a point-in-time value inside an event handler
// or async callback should keep calling loadLS directly — no reason
// to subscribe a render to a key it doesn't display.

import { useCallback, useSyncExternalStore } from "react";
import { subscribeLS, getLSSnapshot } from "../lib/storage.js";

export function useLSValue(key) {
  // Memoize per key: useSyncExternalStore resubscribes whenever the
  // subscribe fn identity changes, so an inline closure would tear
  // down and re-create the subscription on every render.
  const subscribe = useCallback((cb) => subscribeLS(key, cb), [key]);
  const getSnapshot = useCallback(() => getLSSnapshot(key), [key]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
