// Descriptive force variation; valid measured efforts remain curve evidence.
export const FORCE_BAND_FRACTION = 0.15;

export function recordForce(samples, endTs = samples?.at(-1)?.ts, targetKg = null) {
  const start = samples?.[0]?.ts ?? 0;
  const intervals = [];
  let area = 0, squareArea = 0, covered = 0, peak = 0, gap = false;
  for (let i = 0; i < (samples?.length ?? 0); i++) {
    const s = samples[i];
    if (s.ts <= endTs) peak = Math.max(peak, s.kg);
    if (!i) continue;
    const p = samples[i - 1];
    if (p.ts >= endTs) break;
    const dt = s.ts - p.ts;
    if (dt <= 0 || dt > 1000) { gap = true; continue; }
    const used = Math.min(s.ts, endTs) - p.ts;
    intervals.push({ start: p.ts, end: p.ts + used, kg: p.kg, ms: used });
    area += p.kg * used;
    squareArea += p.kg * p.kg * used;
    covered += used;
  }
  const durationMs = Math.max(0, (endTs ?? start) - start);
  const signalValid = !gap && covered > 0 && covered === durationMs;
  const avg = covered ? area / covered : null;
  const sd = covered ? Math.sqrt(Math.max(0, squareArea / covered - avg * avg)) : null;
  const cv = avg > 0 ? sd / avg : null;
  const inBand = avg > 0 ? intervals.reduce((sum, x) =>
    sum + (Math.abs(x.kg / avg - 1) <= FORCE_BAND_FRACTION ? x.ms : 0), 0) / covered : 0;
  // Describe working variation separately from the initial acquisition second.
  // The force-time integral and elapsed duration above still preserve that work.
  const work = intervals.filter(x => x.start >= start + 1000);
  const workMs = work.reduce((sum, x) => sum + x.ms, 0);
  const workMean = workMs ? work.reduce((sum, x) => sum + x.kg * x.ms, 0) / workMs : avg;
  const workVariance = workMs ? work.reduce((sum, x) => sum + (x.kg - workMean) ** 2 * x.ms, 0) / workMs : sd ** 2;
  const workCv = workMean > 0 ? Math.sqrt(workVariance) / workMean : null;
  // Force variation and sustained overshoot remain usable observations.
  // Eligibility describes recording integrity, not closeness to the target.
  const eligible = signalValid && (!(targetKg > 0) || peak >= targetKg);

  // Retain the longest contiguous high-force phase, with its OWN duration.
  // It is descriptive only when weaker work continues after that phase.
  let best = { ms: 0, area: 0, start: start }, run = { ms: 0, area: 0, start: start, end: start };
  for (const x of intervals) {
    if (x.kg >= peak * 0.8) {
      if (run.end !== x.start) run = { ms: 0, area: 0, start: x.start, end: x.start };
      if (!run.ms) run.start = x.start;
      run.ms += x.ms; run.area += x.kg * x.ms; run.end = x.end;
      if (run.ms > best.ms) best = { ...run };
    } else run = { ms: 0, area: 0, start: x.end, end: x.end };
  }
  const startedAtMs = Number.isFinite(samples?.[0]?.at) ? samples[0].at : null;
  return { actualTime: durationMs / 1000, avgForce: avg, peakForce: peak || null,
    startedAtMs, endedAtMs: startedAtMs == null ? null : startedAtMs + durationMs,
    failureValid: eligible,
    endReason: !signalValid ? "equipment_interruption" : eligible ? "muscular_failure" : "target_not_reached",
    forceRecording: { version: 2, method: "time_weighted", observed_time_s: covered / 1000,
      duration_s: durationMs / 1000, impulse_kg_s: area / 1000,
      signal_quality: signalValid ? "complete" : "incomplete",
      force_sd_kg: sd, force_cv: cv, in_band_fraction: inBand,
      working_force_cv: workCv, target_kg: targetKg,
      band_fraction: FORCE_BAND_FRACTION, capacity_eligible: eligible,
      plateau: { avg_force_kg: best.ms ? best.area / best.ms : null,
        duration_s: best.ms / 1000, start_offset_s: (best.start - start) / 1000 } } };
}

export function isValidFailureRep(rep) {
  return !!rep && rep.failure_valid !== false;
}

export function loadProvenance(rep) {
  if (rep?.load_provenance) return rep.load_provenance;
  if (rep?.avg_force_kg > 0) return "legacy_measured";
  return "legacy_estimate";
}

export function isCapacityEvidenceRep(rep) {
  if (!isValidFailureRep(rep)) return false;
  if (rep.force_recording?.capacity_eligible === false) return false;
  return !["nominal_setting", "prescription_only"].includes(loadProvenance(rep));
}

export function evidenceLabel(rep) {
  if (rep?.force_recording?.duration_basis === "elapsed_activity_estimate") return "Interrupted — elapsed activity time is estimated";
  if (!isValidFailureRep(rep)) return "Interrupted — activity only";
  if (rep.force_recording?.capacity_eligible === false) return "Incomplete failure evidence — activity only";
  if (!isCapacityEvidenceRep(rep)) return "Load is an estimate — activity only";
  if (!rep.load_provenance) return "Legacy evidence — measurement uncertainty";
  return "Valid failure evidence";
}


// Capacity force and duration share one acquisition-to-end interval. The
// original integral remains activity metadata, including ramp-up work.
export function recordCapacityForce(samples, endTs = samples?.at(-1)?.ts, targetKg = null) {
  const activity = recordForce(samples, endTs, targetKg);
  if (!(targetKg > 0)) return activity;
  const first = samples.findIndex(s => s.ts <= endTs && s.kg >= targetKg);
  if (first < 0) return activity;
  const capacity = recordForce(samples.slice(first), endTs, targetKg);
  return { ...capacity, peakForce: activity.peakForce,
    failureValid: capacity.failureValid && activity.failureValid,
    endReason: activity.failureValid ? capacity.endReason : activity.endReason,
    forceRecording: { ...capacity.forceRecording, version: 3, basis: 'target_acquired',
      capacity_eligible: capacity.failureValid && activity.failureValid,
      activity: { duration_s: activity.actualTime, avg_force_kg: activity.avgForce,
        impulse_kg_s: activity.forceRecording.impulse_kg_s,
        started_at_ms: activity.startedAtMs, ended_at_ms: activity.endedAtMs,
        signal_quality: activity.forceRecording.signal_quality },
      acquisition_s: (samples[first].ts - samples[0].ts) / 1000 } };
}

// Sensor duration wins when available. An empty stream is elapsed activity,
// never a zero-second failure or a fabricated measured force-time point.
export function finalizeDeviceActivity(stats, startedAtMs, endedAtMs, interrupted = false) {
  const measured = Number.isFinite(stats?.actualTime) && stats.actualTime > 0;
  const elapsed = Math.max(0, (endedAtMs - startedAtMs) / 1000);
  const invalid = interrupted || !measured || stats?.failureValid === false;
  return { ...stats,
    actualTime: measured ? stats.actualTime : elapsed,
    startedAtMs: measured && Number.isFinite(stats.startedAtMs) ? stats.startedAtMs : startedAtMs,
    endedAtMs: measured && Number.isFinite(stats.endedAtMs) ? stats.endedAtMs : endedAtMs,
    failureValid: !invalid,
    endReason: interrupted || !measured ? 'equipment_interruption' : stats.endReason,
    forceRecording: { ...stats?.forceRecording,
      ...(!measured ? { capacity_eligible:false, duration_basis:'elapsed_activity_estimate',
        elapsed_activity_s:elapsed, observed_time_s:stats?.forceRecording?.observed_time_s ?? 0 } : {}),
      ...(invalid ? {capacity_eligible:false} : {}) } };
}

export function isNominalPrescriptionRep(rep) {
  return rep?.load_provenance === 'nominal_setting' && rep.failure_valid !== false
    && !['interrupted','equipment_interruption','target_not_reached'].includes(rep.end_reason)
    && Number.isFinite(Number(rep.manual_load_kg)) && Number(rep.manual_load_kg) > 0
    && Number(rep.manual_load_kg) < 200 && rep.actual_time_s > 0
    && Number(rep.rep_num ?? 1) === 1 && Number(rep.set_num ?? 1) === 1;
}

// Express a target-acquired rep on the earlier recording interval.
//
// Pre-basis rows timed the whole pull, from the 4 kg start threshold to
// release. A v3 row times only the at-or-above-target interval, and stores
// the difference as `acquisition_s` — so adding it back reproduces the
// earlier interval exactly. The force axis needs no adjustment: both bases
// average the working phase, and the recorded values agree to 2 d.p.
//
// The conversion only runs this direction. Pre-basis rows never recorded
// their acquisition time, so they cannot be moved onto the newer interval;
// the newer rows move instead, which is also the cheaper side — a grip
// typically has hundreds of pre-basis rows and a handful of v3 ones.
export function legacyIntervalRep(rep) {
  const acquisition = Number(rep?.force_recording?.acquisition_s);
  if (rep?.force_recording?.basis !== 'target_acquired') return rep;
  if (!Number.isFinite(acquisition) || acquisition < 0) return null;
  if (!(Number(rep.actual_time_s) > 0)) return rep;
  return { ...rep, actual_time_s: Number(rep.actual_time_s) + acquisition,
    force_recording: { ...rep.force_recording, interval_basis_applied: 'legacy_elapsed' } };
}

// One comparable capacity series per grip.
//
// A grip recorded entirely on one basis keeps its native intervals. A grip
// that spans the change has its v3 rows converted to the earlier interval
// (see above) rather than having either generation discarded — dropping the
// pre-basis rows costs a grip its baseline, its curve and the capacity floor
// that bounds how fast a prescription may fall, all on the strength of one
// session. A v3 row that cannot be converted (no `acquisition_s`) is the only
// thing excluded, and only from a grip that spans the change.
// `dropUnconvertible: false` keeps such a row at its native interval — for
// display surfaces that show every recorded pull rather than a fitted series.
export function comparableCapacityHistory(history, { dropUnconvertible = true } = {}) {
  const rows = history || [];
  const acquired = new Set(), earlier = new Set();
  for (const r of rows) {
    if (!isCapacityEvidenceRep(r)) continue;
    if (r.force_recording?.basis === 'target_acquired') acquired.add(r.grip);
    else earlier.add(r.grip);
  }
  const spans = new Set([...acquired].filter(g => earlier.has(g)));
  if (spans.size === 0) return rows;
  const out = [];
  for (const r of rows) {
    if (!spans.has(r.grip)) { out.push(r); continue; }
    const converted = legacyIntervalRep(r);
    if (converted) out.push(converted);
    else if (!dropUnconvertible) out.push(r);
  }
  return out;
}
