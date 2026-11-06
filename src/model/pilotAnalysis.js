// Emphasis-block pilot analysis (docs/emphasis-block-protocol.md,
// "Measurement", "Background load" and "Outcomes"). Pure functions over one
// athlete's exported records: reps (training holds and Peak Tests), climbing
// activities and support workouts. Offline and descriptive: nothing here is
// stored or shown in the app, and results are reported as aggregates.
import { effectiveLoad, freshFitReps } from './load.js';
import {
  computeBalancedCurveScore, CURVE_MODEL_VERSION, fitThreeExpAmps, predForceThreeExp, THREE_EXP_LAMBDA_DEFAULT,
} from './threeExp.js';
import { isPeakMeasurement, isValidPeakMeasurement } from './peakTest.js';
import { isPotentiationMeasurement } from './potentiationRfd.js';
import { sessionFatigueDetail } from './climbingFatigue.js';
import { zoneOf } from './zones.js';
import { EMPHASIS_PILOTS } from './emphasisPilot.js';

export const PILOT_ANALYSIS_VERSION = 1;
// Short end: holds under 90 s; long end: 90 s and up (the blocks' split).
export const LONG_END_S = 90;
// Force-based failure began on 2026-09-10; earlier holds ended on release
// and are not comparable, so the coverage reference starts there.
export const COVERAGE_START = '2026-09-10';
// A block whose weekly background load differs by more than this from the
// other block is flagged as contextually mismatched.
export const BACKGROUND_MISMATCH = 0.25;

const DAY_MS = 864e5;
const dayIndex = date => Date.parse(`${date}T00:00:00Z`) / DAY_MS;
const addDays = (date, n) => new Date((dayIndex(date) + n) * DAY_MS).toISOString().slice(0, 10);
const within = (date, w) => date >= w.start && date <= w.end;
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const pct = logRatio => Math.exp(logRatio) - 1;
const r3 = v => Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;

const isTrainingHold = r => r && !isPeakMeasurement(r) && !isPotentiationMeasurement(r)
  && r.force_recording?.session_protocol?.id !== 'peak_test';
const usableOpener = r => r.actual_time_s > 0 && effectiveLoad(r) > 0 && r.load_provenance !== 'nominal_setting';

// The windows compared: two coverage-rotation windows of about four weeks
// before the pilot, then the pilot's blocks.
export function pilotWindows(pilot = EMPHASIS_PILOTS['emphasis-2026-11']) {
  const first = pilot.blocks[0].start;
  const split = addDays(COVERAGE_START, 27);
  return [
    { id: 'coverage-1', label: 'Coverage rotation 1', start: COVERAGE_START, end: split },
    { id: 'coverage-2', label: 'Coverage rotation 2', start: addDays(split, 1), end: addDays(first, -1) },
    ...pilot.blocks.map(b => ({ id: `block-${b.label}`, label: `Block ${b.label} (${b.emphasis} end)`,
      start: b.start, end: b.end, emphasis: b.emphasis })),
  ];
}

// The frozen yardstick: per grip and hand, the curve fitted on every fresh
// opener before the pilot (curve model v1), shrunk toward the grip's pooled
// curve the way the app's per-hand fits are. Fixed for the whole pilot, so
// its own shape errors cancel when one duration is compared over time.
export function frozenYardstick(reps, cutoff) {
  const openers = freshFitReps((reps || []).filter(r => r.date && r.date < cutoff && isTrainingHold(r)))
    .filter(usableOpener);
  const curves = {};
  const grips = [...new Set(openers.map(r => r.grip))];
  for (const grip of grips) {
    const gripReps = openers.filter(r => r.grip === grip);
    const prior = gripReps.length >= 2
      ? fitThreeExpAmps(gripReps.map(r => ({ T: r.actual_time_s, F: effectiveLoad(r) })), { lambda: 0 }) : null;
    for (const hand of ['L', 'R']) {
      const pts = gripReps.filter(r => r.hand === hand).map(r => ({ T: r.actual_time_s, F: effectiveLoad(r) }));
      if (pts.length < 3 || !prior) continue;
      const amps = fitThreeExpAmps(pts, { prior, lambda: THREE_EXP_LAMBDA_DEFAULT / pts.length });
      if (!amps) continue;
      (curves[grip] ||= {})[hand] = { amps: amps.map(r3), n: pts.length,
        days: new Set(gripReps.filter(r => r.hand === hand).map(r => r.date)).size,
        balanced_kg: r3(computeBalancedCurveScore(amps)) };
    }
  }
  return { version: PILOT_ANALYSIS_VERSION, curve_version: CURVE_MODEL_VERSION, cutoff, curves };
}

// Every fresh opener scored against the yardstick: the load held as a
// percentage above or below the yardstick's force at that hold time, with
// the covariates the protocol records.
export function openerResiduals(reps, yardstick, { activities = [] } = {}) {
  const training = (reps || []).filter(isTrainingHold);
  const gripDays = {};
  for (const r of training) if (r.date && r.grip) (gripDays[r.grip] ||= new Set()).add(r.date);
  const sortedDays = Object.fromEntries(Object.entries(gripDays).map(([g, s]) => [g, [...s].sort()]));
  const out = [];
  for (const r of freshFitReps(training).filter(usableOpener)) {
    const curve = yardstick.curves[r.grip]?.[r.hand];
    if (!curve) continue;
    const predicted = predForceThreeExp(curve.amps, r.actual_time_s);
    if (!(predicted > 0)) continue;
    const load = effectiveLoad(r);
    const previous = (sortedDays[r.grip] || []).filter(d => d < r.date).at(-1);
    const residual = Math.log(load / predicted);
    out.push({
      date: r.date, grip: r.grip, hand: r.hand, t_s: r3(r.actual_time_s), target_s: r.target_duration,
      domain: zoneOf(r.target_duration), end: r.actual_time_s < LONG_END_S ? 'short' : 'long',
      load_kg: r3(load), yardstick_kg: r3(predicted), residual: r3(residual), pct: r3(pct(residual)),
      days_since_grip: previous ? dayIndex(r.date) - dayIndex(previous) : null,
      climbing_score: r3(sessionFatigueDetail(activities, r.date)?.scoreExact ?? 0),
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// Least-squares trend within groups (a grip-and-hand's own level is removed
// first), as change per day.
function withinSlope(rows, groupOf, x, y) {
  const groups = new Map();
  for (const row of rows) {
    const key = groupOf(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  let sxy = 0, sxx = 0;
  for (const members of groups.values()) {
    const mx = mean(members.map(x)), my = mean(members.map(y));
    for (const m of members) { sxy += (x(m) - mx) * (y(m) - my); sxx += (x(m) - mx) ** 2; }
  }
  return sxx > 0 ? sxy / sxx : null;
}

function seededRandom(seed) {
  let state = seed;
  return () => (state = (state * 48271) % 2147483647) / 2147483647;
}

// Change across a window: the within-group trend times the window's length,
// with a 90% day-bootstrap range. Null without at least three days and two
// observations in some group on different days.
export function trendChange(rows, window, { groupOf = r => `${r.grip}|${r.hand}`, y = r => r.residual,
  boots = 1000, seed = 7 } = {}) {
  const inWindow = rows.filter(r => within(r.date, window));
  const x = r => dayIndex(r.date) - dayIndex(window.start);
  const days = [...new Set(inWindow.map(r => r.date))];
  const slope = withinSlope(inWindow, groupOf, x, y);
  if (days.length < 3 || slope == null) return { n: inWindow.length, days: days.length, change: null };
  const length = dayIndex(window.end) - dayIndex(window.start);
  const random = seededRandom(seed);
  const sample = [];
  for (let i = 0; i < boots; i++) {
    const picked = days.map(() => days[Math.floor(random() * days.length)]);
    const resampled = picked.flatMap(d => inWindow.filter(r => r.date === d));
    const s = withinSlope(resampled, groupOf, x, y);
    if (s != null) sample.push(s * length);
  }
  sample.sort((a, b) => a - b);
  return { n: inWindow.length, days: days.length, change: r3(pct(slope * length)),
    low: sample.length ? r3(pct(sample[Math.floor(sample.length * 0.05)])) : null,
    high: sample.length ? r3(pct(sample[Math.floor(sample.length * 0.95) - 1])) : null };
}

// Change at each end of the curve, per window: all grips together and per grip.
export function endChanges(residuals, windows) {
  const out = {};
  for (const w of windows) {
    out[w.id] = {};
    for (const end of ['short', 'long']) {
      const rows = residuals.filter(r => r.end === end);
      out[w.id][end] = { all: trendChange(rows, w),
        byGrip: Object.fromEntries([...new Set(rows.map(r => r.grip))].map(g => [g, trendChange(rows.filter(r => r.grip === g), w)])) };
    }
  }
  return out;
}

// Peak force trend per window from the warm-up Peak Tests. A test is the
// best of its pulls: one slipped pull (8 kg among 70 kg pulls) is not a
// measurement of peak force.
export function peakChanges(reps, windows) {
  const best = new Map();
  for (const r of (reps || []).filter(isValidPeakMeasurement)) {
    const key = `${r.grip}|${r.hand}|${r.date}`;
    if (!(best.get(key)?.peak_force_kg >= r.peak_force_kg)) best.set(key, r);
  }
  const peaks = [...best.values()]
    .map(r => ({ date: r.date, grip: r.grip, hand: r.hand, logPeak: Math.log(r.peak_force_kg) }));
  return Object.fromEntries(windows.map(w => [w.id, {
    all: trendChange(peaks, w, { y: r => r.logPeak }),
    byGrip: Object.fromEntries([...new Set(peaks.map(r => r.grip))]
      .map(g => [g, trendChange(peaks.filter(r => r.grip === g), w, { y: r => r.logPeak })])),
  }]));
}

// Model-free check: openers repeated at the same grip, hand, target and
// prescribed load within a window; change in first-rep hold time.
export function fixedLoadRepeats(reps, windows) {
  const openers = freshFitReps((reps || []).filter(isTrainingHold)).filter(r => r.actual_time_s > 0);
  const out = [];
  for (const w of windows) {
    const groups = new Map();
    for (const r of openers.filter(r => within(r.date, w))) {
      const load = Number(r.prescribed_load_kg);
      if (!(load > 0)) continue;
      const key = `${r.grip}|${r.hand}|${r.target_duration}|${load.toFixed(1)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    for (const [key, rows] of groups) {
      const dates = [...new Set(rows.map(r => r.date))].sort();
      if (dates.length < 2) continue;
      const first = rows.find(r => r.date === dates[0]), last = rows.find(r => r.date === dates.at(-1));
      const [grip, hand, target, load] = key.split('|');
      out.push({ window: w.id, grip, hand, target_s: Number(target), load_kg: Number(load),
        first: { date: first.date, t_s: r3(first.actual_time_s) }, last: { date: last.date, t_s: r3(last.actual_time_s) },
        change: r3(last.actual_time_s / first.actual_time_s - 1) });
    }
  }
  return out;
}

// Whole-curve score per window: each grip and hand refitted on the window's
// openers with the yardstick as prior, as a change against the yardstick.
export function balancedScores(reps, yardstick, windows) {
  const openers = freshFitReps((reps || []).filter(isTrainingHold)).filter(usableOpener);
  const out = {};
  for (const w of windows) {
    const parts = [];
    for (const [grip, hands] of Object.entries(yardstick.curves)) {
      for (const [hand, curve] of Object.entries(hands)) {
        const pts = openers.filter(r => r.grip === grip && r.hand === hand && within(r.date, w))
          .map(r => ({ T: r.actual_time_s, F: effectiveLoad(r) }));
        if (pts.length < 2) continue;
        const amps = fitThreeExpAmps(pts, { prior: curve.amps, lambda: THREE_EXP_LAMBDA_DEFAULT / pts.length });
        const score = amps ? computeBalancedCurveScore(amps) : 0;
        if (score > 0 && curve.balanced_kg > 0) parts.push({ grip, hand, n: pts.length, logRatio: Math.log(score / curve.balanced_kg) });
      }
    }
    out[w.id] = { change: parts.length ? r3(pct(mean(parts.map(p => p.logRatio)))) : null,
      parts: parts.map(p => ({ grip: p.grip, hand: p.hand, n: p.n, change: r3(pct(p.logRatio)) })) };
  }
  return out;
}

// Training exposure per window and grip: all qualifying holds, later reps
// included, by domain, with time under tension and load × duration.
export function trainingExposure(reps, windows) {
  const holds = (reps || []).filter(r => isTrainingHold(r) && r.failure_valid !== false && r.actual_time_s > 0);
  const out = {};
  for (const w of windows) {
    out[w.id] = {};
    for (const r of holds.filter(r => within(r.date, w))) {
      const g = (out[w.id][r.grip] ||= { sessions: new Set(), holds: 0, long_end_holds: 0, by_domain: {}, tut_s: 0, load_time_kg_s: 0 });
      g.sessions.add(r.date);
      g.holds++;
      if (r.target_duration >= LONG_END_S) g.long_end_holds++;
      const domain = zoneOf(r.target_duration);
      g.by_domain[domain] = (g.by_domain[domain] || 0) + 1;
      g.tut_s += r.actual_time_s;
      g.load_time_kg_s += effectiveLoad(r) * r.actual_time_s;
    }
    for (const g of Object.values(out[w.id])) {
      g.sessions = g.sessions.size;
      g.tut_s = Math.round(g.tut_s);
      g.load_time_kg_s = Math.round(g.load_time_kg_s);
    }
  }
  return out;
}

const mondayOf = date => addDays(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));

// Weekly background load: finger training, climbing and support workouts.
// Climbing style is not in the log yet; weekly notes cover it.
export function weeklyBackground(reps, activities, workouts, { start, end }) {
  const weeks = [];
  for (let monday = mondayOf(start); monday <= end; monday = addDays(monday, 7)) {
    const week = { start: monday, end: addDays(monday, 6) };
    const holds = (reps || []).filter(r => isTrainingHold(r) && r.actual_time_s > 0 && within(r.date, week));
    const climbs = (activities || []).filter(a => a?.type === 'climbing' && a.date && within(a.date, week));
    const sessions = (workouts || []).filter(s => s?.date && within(s.date, week) && s.workout !== '__rotation_pin');
    const climbDays = [...new Set(climbs.map(a => a.date))];
    const rpes = climbs.map(a => Number(a.rpe)).filter(Number.isFinite);
    weeks.push({ ...week,
      finger_sessions: new Set(holds.map(r => `${r.grip}|${r.date}`)).size,
      finger_tut_s: Math.round(holds.reduce((s, r) => s + r.actual_time_s, 0)),
      finger_load_time_kg_s: Math.round(holds.reduce((s, r) => s + effectiveLoad(r) * r.actual_time_s, 0)),
      climbing_days: climbDays.length, climbs: climbs.length,
      climbing_load: r3(climbDays.reduce((s, d) => s + (sessionFatigueDetail(activities, d)?.scoreExact ?? 0), 0)),
      mean_climb_rpe: r3(mean(rpes)),
      support_workouts: sessions.filter(s => s.workout !== 'STRETCH').length,
      mobility_sessions: sessions.filter(s => s.workout === 'STRETCH').length,
    });
  }
  return weeks;
}

// Block-to-block comparison of weekly background load; flags any measure
// whose weekly mean differs by more than BACKGROUND_MISMATCH.
export function backgroundComparison(weeks, blocks) {
  const keys = ['finger_sessions', 'finger_tut_s', 'climbing_days', 'climbs', 'climbing_load', 'support_workouts'];
  const perBlock = blocks.map(b => {
    const inBlock = weeks.filter(w => w.start >= b.start && w.end <= b.end);
    return { id: b.id, weeks: inBlock.length, means: Object.fromEntries(keys.map(k => [k, r3(mean(inBlock.map(w => w[k] ?? 0)))])) };
  });
  const [a, b] = perBlock;
  const flags = a && b && a.weeks && b.weeks ? keys.filter(k => {
    const x = a.means[k], y = b.means[k];
    return Math.max(x, y) > 0 && Math.abs(x - y) / Math.max(x, y) > BACKGROUND_MISMATCH;
  }) : [];
  return { blocks: perBlock, mismatched: flags };
}

// The full report for one athlete.
export function pilotReport({ reps = [], activities = [], workouts = [] }, { pilot = EMPHASIS_PILOTS['emphasis-2026-11'],
  asOf = null } = {}) {
  const windows = pilotWindows(pilot);
  const cutoff = pilot.blocks[0].start;
  const yardstick = frozenYardstick(reps, cutoff);
  const residuals = openerResiduals(reps, yardstick, { activities });
  const last = asOf || [...reps.map(r => r.date), ...activities.map(a => a.date)].filter(Boolean).sort().at(-1) || cutoff;
  const blocks = windows.filter(w => w.id.startsWith('block-'));
  const weeks = weeklyBackground(reps, activities, workouts, { start: COVERAGE_START, end: last });
  return {
    version: PILOT_ANALYSIS_VERSION, pilot: pilot.id, as_of: last, windows, yardstick,
    openers: residuals,
    ends: endChanges(residuals, windows),
    peaks: peakChanges(reps, windows),
    fixed_load: fixedLoadRepeats(reps, windows),
    balanced: balancedScores(reps, yardstick, windows),
    exposure: trainingExposure(reps, windows),
    background: { weeks, comparison: backgroundComparison(weeks, blocks) },
  };
}
