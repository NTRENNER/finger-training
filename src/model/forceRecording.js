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
  if (!isValidFailureRep(rep)) return "Interrupted — activity only";
  if (rep.force_recording?.capacity_eligible === false) return "Incomplete failure evidence — activity only";
  if (!isCapacityEvidenceRep(rep)) return "Load is an estimate — activity only";
  if (!rep.load_provenance) return "Legacy evidence — measurement uncertainty";
  return "Valid failure evidence";
}
