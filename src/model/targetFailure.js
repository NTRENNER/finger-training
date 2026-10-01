// Engineering tolerances, not a physiological diagnosis. Device timestamps
// drive every window so batched Bluetooth notifications behave identically.
export const TARGET_FAILURE_POLICY = Object.freeze({
  version: 8, below_target_fraction: 0.93, confirmation_ms: 4000,
  smoothing_ms: 300, recovery_ms: 750, acquisition_ms: 300,
  maximum_recovered_unload_ms: 300,
  release_confirmation_ms: 1000, release_fraction: 0.10, release_max_kg: 0.5,
  minimum_drop_kg: 0.45359237, maximum_drop_fraction: 0.20,
});

export const RELEASE_BACKSTOP_POLICY = Object.freeze({ version: 1, after_confirmation_ms: 15000 });
export const FORCE_LOSS_DETAIL_LIMIT = 16;
function retainEnds(items, item) {
  items.push(item);
  if (items.length > FORCE_LOSS_DETAIL_LIMIT) items.splice(FORCE_LOSS_DETAIL_LIMIT / 2, 1);
}

export function targetFailureBoundary(targetKg) {
  return Math.max(targetKg * (1 - TARGET_FAILURE_POLICY.maximum_drop_fraction),
    Math.min(targetKg * TARGET_FAILURE_POLICY.below_target_fraction,
      targetKg - TARGET_FAILURE_POLICY.minimum_drop_kg));
}

export function repDetectionThresholds(targetKg) {
  const target = Number(targetKg);
  if (!(target > 0) || !Number.isFinite(target)) return { startKg: 4, releaseKg: 3 };
  return { startKg: Math.min(4, target * 0.8),
    releaseKg: Math.min(TARGET_FAILURE_POLICY.release_max_kg, target * TARGET_FAILURE_POLICY.release_fraction) };
}

export function createTargetFailureDetector(targetKg) {
  const target = Number(targetKg), boundary = targetFailureBoundary(target);
  let acquisition = null, startTs = null, belowSince = null, recoverySince = null;
  let result = null, previous = null, window = [], runs = [], excursions = [];
  let runCount = 0, excursionCount = 0, belowMs = 0, recoveredMs = 0;
  // Summarize smoothed-force runs for auditing recovery decisions. These are
  // not a raw trace and cannot reconstruct a different force threshold.
  const snapshot = (details = true) => {
    const live = { startTs, endTs: result?.endTs ?? null, confirmedTs: result?.confirmedTs ?? null,
      status: result ? 'complete' : belowSince !== null ? 'recovering' : 'holding', boundaryKg: boundary };
    // The provisional cutoff is live-only: credit resumes if this dip recovers.
    if (!details) return { ...live, pendingEndTs: result ? null : belowSince };
    const offset = ts => ts == null || startTs == null ? null : Math.round(ts - startTs);
    return { ...live, version: 2, time_basis: 'acquisition_offset_ms',
      startTs: startTs == null ? null : 0, endTs: offset(live.endTs), confirmedTs: offset(live.confirmedTs),
      run_count: runCount, excursion_count: excursionCount,
      runs_truncated: runCount > runs.length, excursions_truncated: excursionCount > excursions.length,
      below_boundary_ms: belowMs, recovered_excursion_ms: recoveredMs,
      excursions: excursions.map(x => ({ onset_ms: offset(x.onset_ms), recovered_at_ms: offset(x.recovered_at_ms) })),
      runs: runs.map(x => ({ from_ms: offset(x.from_ms), to_ms: offset(x.to_ms), above: x.above })) };
  };
  const detect = ({ ts, kg }) => {
    if (!(target > 0) || !Number.isFinite(target) || !Number.isFinite(ts) || !Number.isFinite(kg)) return null;
    if (previous && ts <= previous.ts) return result;
    if (result) return result;
    if (previous) window.push({ from: previous.ts, to: ts, kg: previous.kg });
    previous = { ts, kg };
    const cutoff = ts - TARGET_FAILURE_POLICY.smoothing_ms;
    window = window.filter(x => x.to > cutoff);
    let area = 0, duration = 0;
    for (const x of window) {
      const dt = x.to - Math.max(x.from, cutoff);
      area += dt * x.kg; duration += dt;
    }
    const smooth = duration ? area / duration : kg;
    if (startTs === null) {
      if (kg >= boundary) {
        if (acquisition === null) acquisition = ts;
        if (ts - acquisition >= TARGET_FAILURE_POLICY.acquisition_ms) startTs = acquisition;
      } else acquisition = null;
      if (startTs === null) return null;
    }
    const above = smooth >= boundary;
    const last = runs.at(-1);
    if (last) {
      if (!last.above) belowMs += ts - last.to_ms;
      last.to_ms = ts;
    }
    if (!last || last.above !== above) {
      runCount++;
      retainEnds(runs, { from_ms: last ? ts : startTs, to_ms: ts, above });
    }
    if (!above) {
      recoverySince = null;
      if (belowSince === null) belowSince = ts;
    } else if (belowSince !== null) {
      if (recoverySince === null) recoverySince = ts;
      if (ts - recoverySince >= TARGET_FAILURE_POLICY.recovery_ms) {
        excursionCount++;
        recoveredMs += ts - belowSince;
        retainEnds(excursions, { onset_ms: belowSince, recovered_at_ms: ts });
        belowSince = null; recoverySince = null;
      }
    }
    // A sustained return clears the drop; a lone good sample never does.
    // At the deadline an incomplete recovery still counts as unrecovered.
    if (belowSince !== null && ts - belowSince >= TARGET_FAILURE_POLICY.confirmation_ms) {
      result = { endTs: belowSince, startTs, confirmedTs: ts, targetAcquired: true, reason: 'sustained_force_loss' };
    }
    return result;
  };
  detect.snapshot = snapshot;
  detect.finish = releaseTs => ({ ...(result || {}), startTs,
    endTs: Math.min(result?.endTs ?? belowSince ?? releaseTs, releaseTs),
    targetAcquired: startTs !== null,
    reason: result || (belowSince !== null && belowSince < releaseTs) ? 'sustained_force_loss' : 'release' });
  return detect;
}
