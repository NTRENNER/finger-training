#!/usr/bin/env node
// Controlled counterexamples, kept separate from real-history accuracy scores.
import { fitEstablishedTrend, averagedAnchorAmps } from '../src/model/capacityTrendExperiment.js';
import { predForceThreeExp, buildThreeExpPriors } from '../src/model/threeExp.js';
import { prescription, loadBounds } from '../src/model/prescription.js';
import { freshFitReps } from '../src/model/load.js';
import { buildAdaptiveCapacity, adaptiveFloorReplay, applyAdaptiveBounds } from '../src/model/adaptiveCapacityExperiment.js';

const amps = [20, 25, 30];
const durations = [30, 70, 115, 160, 220];
const date = n => new Date(Date.UTC(2026, 0, 1 + 3 * n)).toISOString().slice(0, 10);
const row = (n, duration, factor = 1) => {
  const force = predForceThreeExp(amps, duration) * factor;
  return { id: `s-${n}`, session_id: `s-${n}`, date: date(n), grip: 'Crusher', hand: 'L',
    rep_num: 1, set_num: 1, target_duration: duration, actual_time_s: duration,
    avg_force_kg: force, peak_force_kg: force * 1.1, prescribed_load_kg: force, weight_kg: force,
    load_provenance: 'measured_force', failure_valid: true, end_reason: 'target_force_failure',
    force_recording: { capacity_eligible: true, signal_quality: 'complete' } };
};
const base = Array.from({ length: 30 }, (_, i) => row(i, durations[i % durations.length]));
const summarize = (history, trueFactor) => {
  const reference = new Date(Date.parse(history.at(-1).date) + 86400000).toISOString().slice(0, 10);
  const trend = fitEstablishedTrend(history, 'L', 'Crusher', reference);
  const priors = buildThreeExpPriors(history);
  const adaptive = process.argv.includes('--adaptive') ? buildAdaptiveCapacity(history, 'L', 'Crusher', reference) : null;
  const replayCache = new Map();
  return Object.fromEntries([30, 160, 220].map(T => {
    const result = prescription(history, 'L', 'Crusher', T, { referenceDate: reference, threeExpPriors: priors, captureCurve: true });
    const snap = result.curveSnapshot;
    if (!snap) throw new Error('Synthetic baseline curve unavailable');
    const modelAmps = { current: snap.amps.map(a => a * snap.scale),
      averagedAnchor: averagedAnchorAmps(snap.amps, freshFitReps(history)),
      established: trend.established, establishedRecent: trend.establishedRecent };
    const truth = predForceThreeExp(amps, T) * trueFactor;
    const bounds = loadBounds(history, 'L', 'Crusher', T, { referenceDate: reference });
    const revision = adaptive ? adaptiveFloorReplay(history, 'L', 'Crusher', T, reference, bounds.floorKg, replayCache) : null;
    return [T, { trueForce: truth,
      force: Object.fromEntries(Object.entries(modelAmps).map(([m, a]) => [m, predForceThreeExp(a, T)])),
      boundedForce: Object.fromEntries(Object.entries(modelAmps).map(([m, a]) =>
        [m, bounds.capValue(Math.round(predForceThreeExp(a, T) * 10) / 10)])),
      errorPct: Object.fromEntries(Object.entries(modelAmps).map(([m, a]) => [m, 100 * (predForceThreeExp(a, T) / truth - 1)])),
      ...(adaptive ? { adaptive: { force: adaptive.forceAt(T), errorPct: 100 * (adaptive.forceAt(T) / truth - 1),
        bounded: applyAdaptiveBounds(Math.round(adaptive.forceAt(T) * 10) / 10, bounds, revision.floor),
        unchangedBounds: applyAdaptiveBounds(Math.round(adaptive.forceAt(T) * 10) / 10, bounds),
        evidence: adaptive.evidenceAt(T), revision } } : {}) }];
  }));
};
const out = { method: 'Synthetic 30-day stable baseline; one opener every three days across five durations. No within-set fatigue. Changes are known by construction, not inferred physiology.',
  baseline: summarize(base, 1),
  isolatedEnduranceDip: summarize([...base, row(30, 220, 0.65)], 1),
  afterThreeNormal: summarize([...base, row(30, 220, 0.65), ...[31, 32, 33].map(i => row(i, durations[i % 5]))], 1),
  sustainedDecline: Object.fromEntries([3, 6, 12, 24].map(n => [n, summarize([...base,
    ...Array.from({ length: n }, (_, i) => row(30 + i, durations[i % 5], 0.65))], 0.65)])),
  sustainedGrowth: Object.fromEntries([3, 6, 12].map(n => [n, summarize([...base,
    ...Array.from({ length: n }, (_, i) => row(30 + i, durations[i % 5], 1.15))], 1.15)])) };
console.log(JSON.stringify(out, null, 2));
