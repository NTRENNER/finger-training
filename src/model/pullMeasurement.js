import { repDetectionThresholds } from './targetFailure.js';

// Prefix integrals allow the live average to rewind to a provisional failure
// endpoint without rescanning a long endurance trace on every UI frame.
export function createPullMeasurement(targetKg) {
  const entries = [];
  let pullStartTs = null;
  const startKg = targetKg > 0 ? repDetectionThresholds(targetKg).startKg : 0;
  return {
    get pullStartTs() { return pullStartTs; },
    get averageStartTs() { return entries[0]?.ts ?? null; },
    push({ kg, ts }) {
      if (pullStartTs == null && kg >= startKg) pullStartTs = ts;
      if (!entries.length && targetKg > 0 && kg < targetKg) return;
      const previous = entries.at(-1);
      const dt = previous ? ts - previous.ts : 0;
      const covered = dt > 0 && dt <= 1000 ? dt : 0;
      entries.push({ ts, kg, area: (previous?.area ?? 0) + (previous?.kg ?? 0) * covered,
        covered: (previous?.covered ?? 0) + covered });
    },
    average(endTs = entries.at(-1)?.ts) {
      if (!entries.length || endTs < entries[0].ts) return null;
      const end = Math.min(endTs, entries.at(-1).ts);
      let low = 0, high = entries.length - 1;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (entries[mid].ts <= end) low = mid;
        else high = mid - 1;
      }
      const point = entries[low], next = entries[low + 1];
      const tail = next && next.ts - point.ts <= 1000 ? end - point.ts : 0;
      const covered = point.covered + tail;
      return covered > 0 ? (point.area + point.kg * tail) / covered : null;
    },
  };
}

// New recordings explicitly preserve the visible pull clock separately from
// the matched duration/force pair used internally. Legacy displays stay intact.
export function displayedRepTime(seconds, recording) {
  return Number.isFinite(recording?.pull_duration_s) ? recording.pull_duration_s : seconds;
}

export function editedRepTime(rep, seconds) {
  const recording = rep.force_recording;
  if (!Number.isFinite(recording?.pull_duration_s)) return { actual_time_s: seconds };
  const ramp = Number.isFinite(recording.ramp_duration_s) ? recording.ramp_duration_s : 0;
  const hold = Math.max(0, seconds - ramp);
  return { actual_time_s: hold,
    ...(hold === 0 ? { failure_valid: false } : {}),
    force_recording: { ...recording, pull_duration_s: seconds, duration_s: hold,
      ...(hold === 0 ? { capacity_eligible: false } : {}) } };
}
