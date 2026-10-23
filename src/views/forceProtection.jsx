// ─────────────────────────────────────────────────────────────
// FORCE PROTECTION — shared rep-end tolerance helper
// ─────────────────────────────────────────────────────────────
// Pulled out of ActiveSessionViews so WarmupView and PeakTestView
// credit hold time the same way: brief force dips don't end the rep.
// Stateless formatting around the tindeq hook's forceLoss observation
// (status: 'holding' | 'pending' | 'complete'). Dips and signal drops
// are not announced on screen; live values simply blank out.

// Elapsed seconds credited toward the hold, accounting for a
// pending dip (freezes the clock) or completion (locks the
// recorded time). Returns a 1-decimal string. Falls through to
// the raw elapsed value when no forceLoss state exists yet.
export function creditedSeconds(state, elapsed) {
  if (!state) return elapsed;
  const start = Object.hasOwn(state, "pullStartTs") ? state.pullStartTs : state.startTs;
  if (start == null) return "0.0";
  const end = state.status === "complete" ? state.endTs : state.pendingEndTs ?? state.observedTs;
  return Number.isFinite(end) ? Math.max(0, (end - start) / 1000).toFixed(1) : "0.0";
}
