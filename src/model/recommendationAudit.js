// Read-only audit of the session recommender; never tunes recommendations.
// Replays the live engine on every past training date using only earlier
// history, then reruns it with one score term neutralized at a time. A term
// decided a pick when removing it changes the recommended domain or hand.
// Accounts are reported by pseudonym (an `athlete` label in the export, or a
// running number), never by account identifier.
import { isPotentiationMeasurement } from './potentiationRfd.js';
import { freshFitReps, isFirstSetRep } from './load.js';
import { buildFreshLoadMap, fitDoseK } from './prescription.js';
import { buildThreeExpPriors } from './threeExp.js';
import { computePersonalRecoveryTaus } from './recoveryFit.js';
import { PHYS_MODEL_DEFAULT } from './fatigue.js';
import { coachingRecommendationContinuous } from './coaching.js';

export const AUDIT_TERMS = ['residual', 'staleness', 'recency', 'cost', 'hand'];

const tally = (out, key) => { out[key] = (out[key] || 0) + 1; };

// The live app's engine inputs (useRepHistory + SetupView), rebuilt from
// strictly earlier history. Day ratings are not in rep exports.
function engineInputs(prior) {
  const firstSet = prior.filter(isFirstSetRep);
  return {
    freshMap: buildFreshLoadMap(firstSet, {
      doseK: fitDoseK(firstSet) ?? PHYS_MODEL_DEFAULT.doseK,
      personalTausByGrip: computePersonalRecoveryTaus(firstSet),
    }),
    threeExpPriors: buildThreeExpPriors(prior),
  };
}

function auditAthlete(rows, { minPriorFresh }) {
  const picks = [];
  let coldStart = 0;
  const fresh = freshFitReps(rows);
  const dates = [...new Set(fresh.map(r => r.date).filter(Boolean))].sort();
  for (const date of dates) {
    const prior = rows.filter(r => r.date < date);
    const priorFresh = freshFitReps(prior);
    const grips = [...new Set(fresh.filter(r => r.date === date).map(r => r.grip).filter(Boolean))]
      .filter(grip => priorFresh.filter(r => r.grip === grip).length >= minPriorFresh);
    if (grips.length === 0) continue;
    const inputs = engineInputs(prior);
    for (const grip of grips) {
      const run = ablate => coachingRecommendationContinuous(prior, grip, { today: date, ...inputs, ablate });
      const base = run({});
      if (!base) continue;
      if (base.coldStartStage) { coldStart++; continue; }
      const alternatives = Object.fromEntries(AUDIT_TERMS.map(term => [term, run({ [term]: true })]));
      const decidedBy = AUDIT_TERMS.filter(term => {
        const alt = alternatives[term];
        return alt && (alt.zone !== base.zone || alt.hand !== base.hand);
      });
      picks.push({ date, grip, zone: base.zone, status: base.staleStatus, decidedBy,
        withoutResidual: alternatives.residual?.zone ?? null });
    }
  }
  const summary = list => {
    const status = {}, decisive = Object.fromEntries(AUDIT_TERMS.map(t => [t, 0]));
    for (const p of list) {
      tally(status, p.status);
      for (const t of p.decidedBy) decisive[t]++;
    }
    // Where the residual term moved picks: "domain without it → domain with it".
    const residualShifts = {};
    for (const p of list) {
      if (p.withoutResidual && p.withoutResidual !== p.zone) tally(residualShifts, `${p.withoutResidual} → ${p.zone}`);
    }
    return { picks: list.length, status, decisive,
      residualOnly: list.filter(p => p.decidedBy.length === 1 && p.decidedBy[0] === 'residual').length,
      residualShifts };
  };
  const byMonth = {};
  for (const p of picks) (byMonth[p.date.slice(0, 7)] ||= []).push(p);
  return { trainingDates: dates.length, coldStartPicks: coldStart, ...summary(picks),
    byMonth: Object.fromEntries(Object.entries(byMonth).sort().map(([m, list]) => [m, summary(list)])) };
}

export function auditRecommendations(input, { minPriorFresh = 8 } = {}) {
  if (!Array.isArray(input)) throw new Error('Expected a JSON array of rep rows');
  const groups = new Map();
  for (const r of input) {
    if (!r || isPotentiationMeasurement(r)) continue;
    const key = r.athlete ?? r.user_id ?? 'all';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  let n = 0;
  const athletes = {};
  for (const [key, rows] of groups) {
    const label = typeof key === 'string' && /^A\d+$/.test(key) ? key : `athlete ${++n}`;
    athletes[label] = auditAthlete(rows, { minPriorFresh });
  }
  return { version: 1,
    method: 'Live engine replayed on each training date with strictly earlier history (the app\'s fresh-load map and priors rebuilt the same way), once as-is and once per neutralized term. "decisive" counts picks whose domain or hand changes without that term; "status" is the coverage state of the picked domain.',
    terms: AUDIT_TERMS, athletes };
}
