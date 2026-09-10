// Device timestamps are milliseconds here; transport converts microseconds.
// Integrate the full effort, including weaker work, up to the first release
// sample. Never extend the strong opening to cover the later duration.
export function recordForce(samples, endTs = samples?.at(-1)?.ts) {
  if (!samples?.length) return { actualTime: 0, avgForce: null, peakForce: null,
    failureValid: false, endReason: "missing_force", forceRecording: { version: 1, method: "time_weighted" } };
  const start = samples[0].ts;
  let area = 0, covered = 0, peak = 0, gap = false;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (s.ts <= endTs) peak = Math.max(peak, s.kg);
    if (!i) continue;
    const p = samples[i - 1];
    const dt = s.ts - p.ts;
    if (dt <= 0) { gap = true; continue; }
    if (p.ts >= endTs) break;
    const used = Math.min(s.ts, endTs) - p.ts;
    if (dt > 1000) { gap = true; continue; }
    // Left-held integration: the first below-release sample marks the
    // boundary; its near-zero force belongs to the release, not the hold.
    area += p.kg * used;
    covered += used;
  }
  const durationMs = Math.max(0, endTs - start);
  const valid = !gap && covered > 0 && covered === durationMs;
  return { actualTime: durationMs / 1000, avgForce: covered ? area / covered : null,
    peakForce: peak || null, failureValid: valid,
    endReason: valid ? "muscular_failure" : "equipment_interruption",
    forceRecording: { version: 1, method: "time_weighted", observed_time_s: covered / 1000,
      duration_s: durationMs / 1000, impulse_kg_s: area / 1000 } };
}

// Missing flag means a historical rep recorded under the failure protocol.
export function isValidFailureRep(rep) {
  return !!rep && rep.failure_valid !== false;
}
