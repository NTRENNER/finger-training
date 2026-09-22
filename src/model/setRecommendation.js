// One set remains a complete workout. This helper only decides whether the
// completed set supports a gentle suggestion that another set may be useful.

import { isCapacityEvidenceRep } from "./forceRecording.js";
import { isShortfall } from "./prescription.js";
import { buildForecastSeries, buildPhysModel } from "./repCurveData.js";

export const ADD_SET_CONFORMANCE_MIN = 0.85;
export const ADD_SET_MIN_REPS = 3;
export const MAX_OPTIONAL_SETS = 5;

const mean = xs => xs.reduce((sum, x) => sum + x, 0) / xs.length;

// The weakest hand gates Both-mode, so a strong side never hides a side that
// did not absorb the set well. The action remains available even when this
// returns null; this function controls suggestion copy, not permission.
export function recommendAnotherSet({ history = [], sessionReps = [], config, setNum = 1 }) {
  if (!config?.grip || !(config.targetTime > 0)) return null;
  const expectedHands = config.hand === "Both" ? ["L", "R"] : [config.hand];
  const thisSet = sessionReps.filter(r => (r.set_num ?? 1) === setNum);
  const sessionIds = new Set(sessionReps.map(r => r.session_id).filter(Boolean));
  const priorHistory = history.filter(r => !sessionIds.has(r.session_id));
  const byHand = [];

  for (const hand of expectedHands) {
    const reps = thisSet
      .filter(r => r.hand === hand || (r.hand === "B" && expectedHands.length === 1))
      .sort((a, b) => (a.rep_num ?? 0) - (b.rep_num ?? 0));
    if (reps.length < ADD_SET_MIN_REPS || !reps.every(isCapacityEvidenceRep)) return null;
    const first = Number(reps[0].actual_time_s);
    if (!(first > 0) || isShortfall(first, config.targetTime)) return null;

    const forecast = buildForecastSeries({
      numReps: reps.length,
      firstRepTime: first,
      restSeconds: Number(config.restTime) >= 0 ? Number(config.restTime) : 20,
      physModel: buildPhysModel(priorHistory, hand, config.grip),
    });
    if (forecast.length !== reps.length) return null;
    const ratios = reps.slice(1).map((r, i) => {
      const predicted = Number(forecast[i + 1]?.t);
      return predicted > 0 ? Number(r.actual_time_s) / predicted : null;
    }).filter(Number.isFinite);
    if (ratios.length < ADD_SET_MIN_REPS - 1) return null;
    byHand.push(mean(ratios));
  }

  if (byHand.length !== expectedHands.length) return null;
  const conformance = Math.min(...byHand);
  if (conformance < ADD_SET_CONFORMANCE_MIN) return null;
  return {
    recommend: true,
    conformance,
    text: conformance >= 1
      ? "You matched or beat the recovery forecast. Another set looks productive if you want it."
      : "You stayed close to the recovery forecast. Another set looks reasonable if you want it.",
  };
}
