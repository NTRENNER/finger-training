import { buildFingerTrainingLoad } from "./fingerTrainingLoad.js";

// Descriptive personal dose-response analysis. It uses the same weekly work
// totals and calibrated opening-hold residuals already shown in Analysis, but
// never feeds a prescription. The outer-third comparison and rank agreement
// keep one unusual week from producing a directional claim.
const DAY_MS = 86400000;

export const VOLUME_RESPONSE_POLICY = Object.freeze({
  minimumPairs: 12,
  minimumGroupSize: 4,
  minimumOutcomeDates: 10,
  minimumDoseRatio: 1.2,
  minimumEffectPoints: 2,
  minimumAbsoluteCorrelation: 0.2,
});

export const VOLUME_RESPONSE_WINDOWS = Object.freeze([
  Object.freeze({ id: "acute", label: "Next 7 days", startDay: 7, endDay: 13 }),
  Object.freeze({ id: "delayed", label: "Days 8–21", startDay: 14, endDay: 27 }),
]);

const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function addDays(ymd, days) {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function ranks(values) {
  const ordered = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const result = Array(values.length);
  for (let start = 0; start < ordered.length;) {
    let end = start + 1;
    while (end < ordered.length && ordered[end].value === ordered[start].value) end += 1;
    const rank = (start + end - 1) / 2 + 1;
    for (let index = start; index < end; index += 1) result[ordered[index].index] = rank;
    start = end;
  }
  return result;
}

function correlation(xs, ys) {
  const xMean = mean(xs), yMean = mean(ys);
  let numerator = 0, xSquares = 0, ySquares = 0;
  for (let index = 0; index < xs.length; index += 1) {
    const x = xs[index] - xMean, y = ys[index] - yMean;
    numerator += x * y;
    xSquares += x * x;
    ySquares += y * y;
  }
  const denominator = Math.sqrt(xSquares * ySquares);
  return denominator > 0 ? numerator / denominator : null;
}

function spearman(pairs) {
  if (pairs.length < 2) return null;
  return correlation(ranks(pairs.map(pair => pair.dose)), ranks(pairs.map(pair => pair.response)));
}

function outcomeDates(observations, grips, hand, throughDate) {
  const gripSet = new Set((grips || []).filter(Boolean));
  const byDate = new Map();
  for (const observation of observations || []) {
    if (!observation?.date || observation.date > throughDate) continue;
    if (gripSet.size && !gripSet.has(observation.grip)) continue;
    if (hand !== "pooled" && observation.hand !== hand) continue;
    if (observation.context === "after_training" || observation.extrapolated) continue;
    if (!Number.isFinite(observation.deviation)) continue;
    if (!byDate.has(observation.date)) byDate.set(observation.date, []);
    byDate.get(observation.date).push(observation.deviation);
  }
  return [...byDate].map(([date, values]) => ({ date, performance: mean(values) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function compareDoseGroups(pairs) {
  const ordered = [...pairs].sort((a, b) => a.dose - b.dose || a.week.localeCompare(b.week));
  // Compare the outer thirds. Middle-dose weeks add sample size but do not
  // blur the practical question: what followed clearly higher versus clearly
  // lower training loads for this athlete?
  const size = Math.floor(ordered.length / 3);
  const lower = ordered.slice(0, size), higher = ordered.slice(-size);
  if (lower.length < VOLUME_RESPONSE_POLICY.minimumGroupSize
    || higher.length < VOLUME_RESPONSE_POLICY.minimumGroupSize) return null;
  const lowDose = median(lower.map(pair => pair.dose));
  const highDose = median(higher.map(pair => pair.dose));
  const doseRatio = lowDose > 0 ? highDose / lowDose : highDose > 0 ? Infinity : 1;
  return {
    lowDose,
    highDose,
    doseRatio,
    lowerWeeks: lower.length,
    higherWeeks: higher.length,
    effect: median(higher.map(pair => pair.response)) - median(lower.map(pair => pair.response)),
  };
}

function analyzeWindow(loadRows, outcomes, window, doseKey, throughDate) {
  const pairs = loadRows.filter(row => addDays(row.week, window.endDay) <= throughDate)
    .map(row => {
      const start = addDays(row.week, window.startDay);
      const end = addDays(row.week, window.endDay);
      const later = outcomes.filter(outcome => outcome.date >= start && outcome.date <= end);
      return later.length ? {
        week: row.week,
        dose: row[doseKey],
        response: median(later.map(outcome => outcome.performance)),
        outcomeDates: later.map(outcome => outcome.date),
      } : null;
    }).filter(Boolean);
  const dates = new Set(pairs.flatMap(pair => pair.outcomeDates));
  const groups = compareDoseGroups(pairs);
  const enoughEvidence = pairs.length >= VOLUME_RESPONSE_POLICY.minimumPairs
    && dates.size >= VOLUME_RESPONSE_POLICY.minimumOutcomeDates
    && groups
    && groups.highDose > groups.lowDose
    && groups.doseRatio >= VOLUME_RESPONSE_POLICY.minimumDoseRatio;
  const rankCorrelation = enoughEvidence ? spearman(pairs) : null;
  const aligned = groups && rankCorrelation != null
    && Math.sign(groups.effect) === Math.sign(rankCorrelation);
  const direction = enoughEvidence && aligned
    && Math.abs(groups.effect) >= VOLUME_RESPONSE_POLICY.minimumEffectPoints
    && Math.abs(rankCorrelation) >= VOLUME_RESPONSE_POLICY.minimumAbsoluteCorrelation
    ? groups.effect > 0 ? "up" : "down"
    : "neutral";
  return {
    ...window,
    status: enoughEvidence ? "ready" : "insufficient",
    pairs: pairs.length,
    outcomeDates: dates.size,
    effect: enoughEvidence ? groups.effect : null,
    correlation: rankCorrelation,
    direction,
    dose: groups,
  };
}

function responseSummary(windows) {
  const acute = windows.find(window => window.id === "acute")?.direction;
  const delayed = windows.find(window => window.id === "delayed")?.direction;
  if (acute === "down" && delayed === "up") return "Short dip, later rebound";
  if (acute === "down" && delayed === "down") return "Lower performance after higher volume";
  if (acute === "up" && delayed === "up") return "Stronger performance after higher volume";
  if (delayed === "up") return "Possible later rebound";
  if (delayed === "down") return "Possible delayed dip";
  if (acute === "down") return "Possible short-term fatigue";
  if (acute === "up") return "Possible short-term lift";
  return "No consistent pattern yet";
}

export function buildVolumeResponse(history = [], observations = [], {
  grips = [],
  hand = "pooled",
  mode = "volume",
  throughDate,
} = {}) {
  if (!throughDate) return null;
  const load = buildFingerTrainingLoad(history, { grips, hand, throughDate });
  if (!load) return null;
  const outcomes = outcomeDates(observations, grips, hand, throughDate);
  if (!outcomes.length) return null;
  const doseKey = mode === "time" ? "tutS" : "volumeKgS";
  const windows = VOLUME_RESPONSE_WINDOWS.map(window =>
    analyzeWindow(load.rows, outcomes, window, doseKey, throughDate));
  if (!windows.some(window => window.status === "ready")) return null;
  return {
    mode,
    summary: responseSummary(windows),
    windows,
  };
}
