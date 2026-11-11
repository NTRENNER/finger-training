// ─────────────────────────────────────────────────────────────
// SESSION AWARDS — what a finished finger session earned
// ─────────────────────────────────────────────────────────────
// Four separate achievements, each judged per hand on set one:
//
//   heaviest       — the level for this grip and zone went up (levels.js).
//   curve          — the opening hold carried more force than the curve
//                    frozen before the session expected for its duration.
//   recommendation — the opening hold met the recommended weight and
//                    outlasted the recommended time.
//   recovery       — the second hold kept more of the first hold's time
//                    than the recovery model expected, after a first hold
//                    that reached its target.
//
// Only the opening hold can earn `curve` and `recommendation`: later holds
// are fatigued. Awards are read-only over rep history and never feed a
// prescription. Thresholds were set from a replay of real sessions
// (scripts/awards-replay.mjs) so that each award stays uncommon.

import { zoneOf } from "./zones.js";
import { calcLevel } from "./levels.js";
import { buildPhysModel } from "./repCurveData.js";
import { buildRecoveryBundle } from "./recoveryDynamics.js";
import { isCapacityEvidenceRep, loadProvenance } from "./forceRecording.js";

export const AWARD_THRESHOLDS = {
  // Opening-hold force ÷ force the pre-session curve gives at that duration.
  curveRatio: 1.15,
  // Opening hold: force ÷ recommended weight, and time ÷ recommended time.
  recommendationLoadRatio: 0.98,
  recommendationTimeRatio: 1.25,
  // Rep 2 retention minus the model's expected retention (fraction of rep 1).
  recoveryGap: 0.15,
};

export const AWARD_ORDER = ["heaviest", "curve", "recommendation", "recovery"];

const positive = n => Number.isFinite(n) && n > 0;
const isSetOne = r => (r.set_num ?? 1) === 1;

function openerFor(reps, hand) {
  const rep = reps.find(r => r.hand === hand && isSetOne(r) && Number(r.rep_num ?? 1) === 1);
  return rep && isCapacityEvidenceRep(rep) && loadProvenance(rep) === "measured_force"
    && positive(rep.avg_force_kg) && positive(rep.actual_time_s) ? rep : null;
}

// Raw numbers behind each award, one entry per hand. Kept separate from the
// thresholds so the replay can study the distributions.
export function sessionAwardMetrics({ before = [], reps = [], grip, targetTime, hands, restSeconds = 20 }) {
  const zone = zoneOf(targetTime);
  return hands.map(hand => {
    const mine = reps.filter(r => r.hand === hand);
    const opener = openerFor(mine, hand);
    const levelBefore = calcLevel(before, hand, grip, zone);
    const levelAfter = calcLevel([...before, ...mine], hand, grip, zone);

    const check = opener?.force_recording?.prediction_check;
    const curveRatio = check?.kind === "capacity" && check.comparison?.status === "recorded"
      && positive(check.comparison.current) && positive(check.comparison.actual)
      ? check.comparison.actual / check.comparison.current : null;

    const followedPlan = opener && opener.force_recording?.decision?.overridden !== true
      && !positive(opener.manual_load_kg) && positive(opener.prescribed_load_kg)
      && positive(opener.target_duration)
      && (opener.session_adjustment?.load_choice ?? "keep") === "keep";
    const recommendation = followedPlan ? {
      loadRatio: opener.avg_force_kg / opener.prescribed_load_kg,
      timeRatio: opener.actual_time_s / opener.target_duration,
    } : null;

    let recoveryGap = null;
    if (opener && positive(opener.target_duration) && opener.actual_time_s >= opener.target_duration) {
      const bundle = buildRecoveryBundle({ reps: mine.filter(isSetOne), restSeconds,
        physModel: buildPhysModel(before, hand, grip) });
      if (bundle.confidence === "measured" && Number.isFinite(bundle.gapAtTarget)) recoveryGap = bundle.gapAtTarget;
    }
    return { hand, zone, levelBefore, levelAfter, curveRatio, recommendation, recoveryGap };
  });
}

// Awards earned by a finished session: [{ type, hand, ...detail }], ordered
// by AWARD_ORDER then hand.
export function sessionAwards(input, thresholds = AWARD_THRESHOLDS) {
  const awards = [];
  for (const m of sessionAwardMetrics(input)) {
    if (m.levelAfter > m.levelBefore) awards.push({ type: "heaviest", hand: m.hand, zone: m.zone, level: m.levelAfter });
    if (m.curveRatio != null && m.curveRatio >= thresholds.curveRatio) {
      awards.push({ type: "curve", hand: m.hand, ratio: m.curveRatio });
    }
    if (m.recommendation && m.recommendation.loadRatio >= thresholds.recommendationLoadRatio
      && m.recommendation.timeRatio >= thresholds.recommendationTimeRatio) {
      awards.push({ type: "recommendation", hand: m.hand, ...m.recommendation });
    }
    if (m.recoveryGap != null && m.recoveryGap >= thresholds.recoveryGap) {
      awards.push({ type: "recovery", hand: m.hand, gap: m.recoveryGap });
    }
  }
  return awards.sort((a, b) => AWARD_ORDER.indexOf(a.type) - AWARD_ORDER.indexOf(b.type)
    || a.hand.localeCompare(b.hand));
}
