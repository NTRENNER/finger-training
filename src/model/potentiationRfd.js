import { uuid } from "../util.js";

export const POTENTIATION_PROTOCOL_ID = "warmup_potentiation";
export const POTENTIATION_PROTOCOL_VERSION = 1;
export const POTENTIATION_PRETRIGGER_MS = 350;
export const POTENTIATION_TREND_MIN_SESSIONS = 6;

const finite = value => Number.isFinite(Number(value));

function median(values) {
  const sorted = values.filter(finite).map(Number).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function interpolate(samples, ts) {
  if (!samples.length || ts < samples[0].ts || ts > samples.at(-1).ts) return null;
  for (let i = 1; i < samples.length; i += 1) {
    const left = samples[i - 1];
    const right = samples[i];
    if (right.ts < ts) continue;
    if (right.ts === left.ts) return right.kg;
    const fraction = (ts - left.ts) / (right.ts - left.ts);
    return left.kg + (right.kg - left.kg) * fraction;
  }
  return samples.at(-1).kg;
}

function crossingTime(samples, threshold, startTs) {
  for (let i = 1; i < samples.length; i += 1) {
    const left = samples[i - 1];
    const right = samples[i];
    if (right.ts < startTs || left.kg >= threshold || right.kg < threshold) continue;
    const span = right.kg - left.kg;
    return span > 0 ? left.ts + ((threshold - left.kg) / span) * (right.ts - left.ts) : right.ts;
  }
  return null;
}

function impulseBetween(samples, startTs, endTs, baselineKg) {
  const points = [
    { ts: startTs, kg: interpolate(samples, startTs) },
    ...samples.filter(sample => sample.ts > startTs && sample.ts < endTs),
    { ts: endTs, kg: interpolate(samples, endTs) },
  ].filter(point => finite(point.kg));
  if (points.length < 2) return null;
  let area = 0;
  for (let i = 1; i < points.length; i += 1) {
    const left = Math.max(0, points[i - 1].kg - baselineKg);
    const right = Math.max(0, points[i].kg - baselineKg);
    area += ((left + right) / 2) * ((points[i].ts - points[i - 1].ts) / 1000);
  }
  return area;
}

export function measurePotentiationRfd(rawSamples = [], { targetKg = null, triggerTs = null } = {}) {
  const samples = rawSamples
    .filter(sample => finite(sample?.kg) && finite(sample?.ts))
    .map(sample => ({ kg: Math.max(0, Number(sample.kg)), ts: Number(sample.ts) }))
    .sort((a, b) => a.ts - b.ts)
    .filter((sample, index, rows) => index === 0 || sample.ts > rows[index - 1].ts);
  if (samples.length < 6 || !finite(triggerTs)) {
    return { version: 1, valid: false, reason: "insufficient_samples" };
  }

  const trigger = Number(triggerTs);
  const preTrigger = samples.filter(sample => sample.ts < trigger);
  const baselineCount = Math.max(3, Math.ceil(preTrigger.length * 0.35));
  // The final part of the pre-trigger window can already contain the force
  // ramp. Its quiet lower band is a better unloaded baseline than the median
  // of the whole window, especially for a deliberately smooth pull.
  const baselineWindow = preTrigger.slice().sort((a, b) => a.kg - b.kg).slice(0, baselineCount);
  const baselineKg = median(baselineWindow.map(sample => sample.kg));
  if (!finite(baselineKg) || baselineWindow.length < 3) {
    return { version: 1, valid: false, reason: "missing_baseline" };
  }

  const target = finite(targetKg) && Number(targetKg) > 0 ? Number(targetKg) : null;
  const onsetThresholdKg = Number(baselineKg) + Math.max(0.5, (target || 0) * 0.015);
  const onsetTs = crossingTime(samples, onsetThresholdKg, samples[0].ts);
  if (!finite(onsetTs)) return { version: 1, valid: false, reason: "onset_not_found" };

  const force100 = interpolate(samples, onsetTs + 100);
  const force200 = interpolate(samples, onsetTs + 200);
  const force500 = interpolate(samples, onsetTs + 500);
  const onsetForce = interpolate(samples, onsetTs);
  if (![onsetForce, force100, force200, force500].every(finite)) {
    return { version: 1, valid: false, reason: "pull_too_short" };
  }

  const measurementWindow = samples.filter(sample => sample.ts >= onsetTs - 50 && sample.ts <= onsetTs + 500);
  let maxSampleGapMs = 0;
  for (let i = 1; i < measurementWindow.length; i += 1) {
    maxSampleGapMs = Math.max(maxSampleGapMs, measurementWindow[i].ts - measurementWindow[i - 1].ts);
  }
  const peakKg = Math.max(...samples.filter(sample => sample.ts >= onsetTs).map(sample => sample.kg));
  const targetTime = target ? crossingTime(samples, target, onsetTs) : null;
  const baselineSpreadKg = Math.max(...baselineWindow.map(sample => sample.kg))
    - Math.min(...baselineWindow.map(sample => sample.kg));
  const targetReached = !target || peakKg >= target * 0.8;
  const valid = maxSampleGapMs <= 150 && targetReached;

  return {
    version: 1,
    valid,
    reason: valid ? null : maxSampleGapMs > 150 ? "sample_gap" : "target_not_reached",
    onset_threshold_kg: onsetThresholdKg,
    baseline_kg: Number(baselineKg),
    baseline_spread_kg: baselineSpreadKg,
    peak_kg: peakKg,
    target_kg: target,
    rfd_100_kg_s: (force100 - onsetForce) / 0.1,
    rfd_200_kg_s: (force200 - onsetForce) / 0.2,
    impulse_500_kg_s: impulseBetween(samples, onsetTs, onsetTs + 500, baselineKg),
    time_to_target_ms: finite(targetTime) ? targetTime - onsetTs : null,
    max_sample_gap_ms: maxSampleGapMs,
    sample_count: samples.length,
  };
}

export function isPotentiationMeasurement(rep) {
  const protocol = rep?.force_recording?.session_protocol;
  return protocol?.id === POTENTIATION_PROTOCOL_ID
    && protocol?.version === POTENTIATION_PROTOCOL_VERSION;
}

export function potentiationMeasurementRecord({
  stats,
  hand,
  grip,
  sessionId,
  date,
  startedAt,
  targetLoadKg,
  position,
  restSec,
}) {
  const measurement = stats?.potentiationRfd;
  if (!measurement?.valid) return null;
  return {
    id: uuid(),
    session_id: sessionId,
    session_started_at: startedAt,
    date,
    grip,
    hand,
    set_num: 0,
    rep_num: position,
    target_duration: 0,
    actual_time_s: Math.max(0, Number(stats.actualTime) || 0),
    rest_s: restSec,
    weight_kg: targetLoadKg,
    prescribed_load_kg: targetLoadKg,
    manual_load_kg: null,
    avg_force_kg: null,
    peak_force_kg: Number(stats.peakForce) || measurement.peak_kg || null,
    load_provenance: "measured_force",
    failure_valid: false,
    failed: false,
    end_reason: "potentiation_complete",
    rep_timing: {
      version: 1,
      started_at_ms: stats.startedAtMs ?? null,
      ended_at_ms: stats.endedAtMs ?? null,
      source: "device_aligned",
    },
    force_recording: {
      ...stats.forceRecording,
      version: stats.forceRecording?.version || 2,
      capacity_eligible: false,
      peak_valid: false,
      potentiation_rfd: measurement,
      session_protocol: {
        id: POTENTIATION_PROTOCOL_ID,
        version: POTENTIATION_PROTOCOL_VERSION,
        source: "climbing_warmup",
        position,
        duration_reference: "rapid_submaximal_pull",
      },
    },
  };
}

export function buildPotentiationSpeedTrend(history = [], { grips = null, hand = "pooled" } = {}) {
  const allowed = grips ? new Set(grips) : null;
  const grouped = new Map();
  for (const rep of history) {
    if (!isPotentiationMeasurement(rep) || !rep.date || !rep.grip) continue;
    if (allowed && !allowed.has(rep.grip)) continue;
    if (hand !== "pooled" && rep.hand !== hand) continue;
    const value = Number(rep.force_recording?.potentiation_rfd?.rfd_200_kg_s);
    if (!(value > 0) || rep.force_recording?.potentiation_rfd?.valid !== true) continue;
    const key = `${rep.date}|${rep.grip}|${rep.session_id || "session"}`;
    if (!grouped.has(key)) grouped.set(key, { date: rep.date, grip: rep.grip, values: [] });
    grouped.get(key).values.push(value);
  }

  const sessions = [...grouped.values()]
    .map(item => ({ ...item, value: median(item.values) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const availableGrips = [...new Set(sessions.map(item => item.grip))].sort();
  if (!sessions.length) return null;

  const byDate = new Map();
  for (const session of sessions) {
    const row = byDate.get(session.date) || { date: session.date };
    row[session.grip] = session.value;
    byDate.set(session.date, row);
  }
  const rows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

  for (const grip of availableGrips) {
    const gripSessions = sessions.filter(session => session.grip === grip);
    if (gripSessions.length < POTENTIATION_TREND_MIN_SESSIONS) continue;
    for (let index = 0; index < gripSessions.length; index += 1) {
      const window = gripSessions.slice(Math.max(0, index - 2), index + 1);
      const row = byDate.get(gripSessions[index].date);
      row[`${grip}_trend`] = median(window.map(item => item.value));
    }
  }

  return {
    grips: availableGrips,
    rows,
    sessionCount: sessions.length,
    latest: Object.fromEntries(availableGrips.map(grip => {
      const item = sessions.filter(session => session.grip === grip).at(-1);
      return [grip, item ? { date: item.date, kgPerSecond: item.value } : null];
    })),
  };
}
