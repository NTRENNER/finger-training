// One set remains a complete workout. This helper only decides whether the
// completed set supports a gentle suggestion that another set may be useful.

import { isCapacityEvidenceRep } from "./forceRecording.js";
import { isShortfall } from "./prescription.js";
import { buildForecastSeries, buildPhysModel } from "./repCurveData.js";
import { effectiveLoad, isFirstSetRep } from "./load.js";
import { zoneOf } from "./zones.js";
import { today } from "../util.js";

export const ADD_SET_CONFORMANCE_MIN = 0.85;
export const ADD_SET_MIN_REPS = 3;
export const MAX_OPTIONAL_SETS = 5;
export const ADD_SET_RECENT_DAYS = 30;
export const ADD_SET_LATER_OPENER_RETENTION_MIN = 0.70;
export const ADD_SET_PLATEAU_SESSIONS = 3;
export const ADD_SET_PLATEAU_LOAD_RANGE = 0.03;

const mean = xs => xs.reduce((sum, x) => sum + x, 0) / xs.length;
const DAY_MS = 86400 * 1000;
const dayNumber = value => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value || "");
  return m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY_MS) : null;
};
const sessionKey = r => r.session_id || r.date;

function openingReps(rows, { grip, zone, targetTime, hand }) {
  const bySession = new Map();
  for (const r of rows) {
    if (!isFirstSetRep(r) || Number(r.rep_num ?? 1) !== 1) continue;
    if (r.grip !== grip || r.hand !== hand || zoneOf(r.target_duration) !== zone) continue;
    const target = Number(r.target_duration);
    if (!(target > 0) || Math.abs(target - targetTime) / targetTime > 0.20) continue;
    const key = sessionKey(r);
    if (!key) continue;
    const prior = bySession.get(key);
    if (!prior || (r.date || "") > (prior.date || "")) bySession.set(key, r);
  }
  return [...bySession.values()].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
}

// "Need" stays domain-specific: success elsewhere never substitutes for
// evidence in this grip + zone. A suggestion is justified by exactly one
// thing — three comparable successful openers that have held the SAME load,
// a plateau. Progress has stalled at a weight the athlete clearly tolerates,
// so more volume is a reasonable next lever.
//
// LOW EXPOSURE IS NOT A REASON (September 2026, per Nathan). An earlier
// version also suggested a set when the domain had been trained at most
// once in 30 days. That is backwards: rare exposure is precisely the state
// in which the app knows LEAST about what this athlete tolerates here, and
// volume is the wrong thing to add on the least evidence. A domain that is
// undertrained needs more sessions, which the zone-coverage and staleness
// surfaces already argue for — not a longer one.
//
// `recentSessions` is still reported for diagnostics (it explains why a
// suggestion did or did not appear) but nothing decides on it.
export function assessAdditionalSetNeed({ history = [], sessionReps = [], config }) {
  if (!config?.grip || !(config.targetTime > 0)) return null;
  const zone = zoneOf(config.targetTime);
  // `today()` is the app's LOCAL date. new Date().toISOString() is UTC, so
  // an evening session west of Greenwich landed on tomorrow and shifted the
  // 30-day exposure window by a day — the same rollover class of bug the
  // session-date anchoring already fixed elsewhere.
  const currentDay = dayNumber(sessionReps.find(r => r.date)?.date) ?? dayNumber(today());
  const sessionIds = new Set(sessionReps.map(sessionKey).filter(Boolean));
  const eligible = history.filter(r => !sessionIds.has(sessionKey(r))
    && isFirstSetRep(r) && r.grip === config.grip && zoneOf(r.target_duration) === zone);
  const recentSessions = new Set(eligible.filter(r => {
    const d = dayNumber(r.date);
    return d != null && currentDay != null && currentDay - d >= 0
      && currentDay - d <= ADD_SET_RECENT_DAYS;
  }).map(sessionKey).filter(Boolean)).size;

  const expectedHands = config.hand === "Both" ? ["L", "R"] : [config.hand];
  let plateau = true;
  for (const hand of expectedHands) {
    const openers = openingReps([...eligible, ...sessionReps], {
      grip: config.grip, zone, targetTime: config.targetTime, hand,
    }).filter(r => !isShortfall(Number(r.actual_time_s), Number(r.target_duration)))
      .slice(-ADD_SET_PLATEAU_SESSIONS);
    if (openers.length < ADD_SET_PLATEAU_SESSIONS) { plateau = false; break; }
    const loads = openers.map(effectiveLoad).filter(v => v > 0);
    if (loads.length !== openers.length) { plateau = false; break; }
    const lo = Math.min(...loads), hi = Math.max(...loads);
    if (!(lo > 0) || (hi - lo) / lo > ADD_SET_PLATEAU_LOAD_RANGE) { plateau = false; break; }
  }
  return plateau ? { needed: true, basis: "plateau", recentSessions } : null;
}

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
  const openerRetentionByHand = [];

  for (const hand of expectedHands) {
    const reps = thisSet
      .filter(r => r.hand === hand || (r.hand === "B" && expectedHands.length === 1))
      .sort((a, b) => (a.rep_num ?? 0) - (b.rep_num ?? 0));
    if (reps.length < ADD_SET_MIN_REPS || !reps.every(isCapacityEvidenceRep)) return null;
    const first = Number(reps[0].actual_time_s);
    if (!(first > 0)) return null;
    if (setNum === 1 && isShortfall(first, config.targetTime)) return null;
    if (setNum > 1) {
      const firstSetOpener = sessionReps
        .filter(r => (r.set_num ?? 1) === 1 && r.hand === hand)
        .sort((a, b) => (a.rep_num ?? 0) - (b.rep_num ?? 0))[0];
      const fresh = Number(firstSetOpener?.actual_time_s);
      if (!(fresh > 0)) return null;
      const retention = first / fresh;
      if (retention < ADD_SET_LATER_OPENER_RETENTION_MIN) return null;
      openerRetentionByHand.push(retention);
    }

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
  if (setNum === 1) {
    const need = assessAdditionalSetNeed({ history: priorHistory, sessionReps, config });
    if (!need) return null;
    return {
      recommend: true,
      conformance,
      basis: need.basis,
      recentSessions: need.recentSessions,
      text: "Your first-set quality is strong and this load has leveled off. Another set may be a useful volume progression.",
    };
  }
  return {
    recommend: true,
    conformance,
    basis: "set_tolerance",
    openerRetention: Math.min(...openerRetentionByHand),
    text: "This set retained enough quality for one more optional set.",
  };
}
