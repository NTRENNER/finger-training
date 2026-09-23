// One set remains a complete workout. This helper only decides whether the
// completed set supports a gentle suggestion that another set may be useful.

import { isCapacityEvidenceRep } from "./forceRecording.js";
import { isShortfall } from "./prescription.js";
import { buildForecastSeries, buildPhysModel } from "./repCurveData.js";
import { effectiveLoad, isFirstSetRep } from "./load.js";
import { computeDensityLadder, LADDER_MIN_REPS } from "./densityLadder.js";
import { zoneOf } from "./zones.js";
import { today } from "../util.js";

export const ADD_SET_CONFORMANCE_MIN = 0.85;
export const ADD_SET_MIN_REPS = 3;
export const MAX_OPTIONAL_SETS = 5;
export const ADD_SET_RECENT_DAYS = 30;
export const ADD_SET_LATER_OPENER_RETENTION_MIN = 0.70;
export const ADD_SET_PLATEAU_SESSIONS = 3;
export const ADD_SET_PLATEAU_LOAD_RANGE = 0.03;
export const ADD_SET_PLATEAU_TIME_RANGE = 0.03;

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

// Optional volume comes after the existing 4–6 ladder. Stable force alone
// is not a plateau: more reps or longer holds at that force are progress.
// Use consecutive comparable sessions, including unsuccessful attempts, so
// filtering away an interruption or a shortfall cannot manufacture a plateau.
export function assessAdditionalSetNeed({ history = [], sessionReps = [], config }) {
  if (!config?.grip || !(config.targetTime > 0)) return null;
  const zone = zoneOf(config.targetTime);
  // `today()` is the app's LOCAL date. new Date().toISOString() is UTC, so
  // an evening session west of Greenwich landed on tomorrow and shifted the
  // 30-day exposure window by a day — the same rollover class of bug the
  // session-date anchoring already fixed elsewhere.
  const currentDay = dayNumber(sessionReps.find(r => r.date)?.date) ?? dayNumber(today());
  const sessionIds = new Set(sessionReps.map(sessionKey).filter(Boolean));
  const isRecent = r => {
    const d = dayNumber(r.date);
    return d != null && currentDay != null && currentDay - d >= 0
      && currentDay - d <= ADD_SET_RECENT_DAYS;
  };
  const eligible = history.filter(r => !sessionIds.has(sessionKey(r))
    && isFirstSetRep(r) && r.grip === config.grip
    && zoneOf(r.target_duration) === zone && isRecent(r));
  const recentSessions = new Set(eligible.filter(isCapacityEvidenceRep).map(sessionKey).filter(Boolean)).size;
  const rows = [...eligible, ...sessionReps.filter(isRecent)];
  const expectedHands = config.hand === "Both" ? ["L", "R"] : [config.hand];
  // The next session still adds rep 5, then rep 6, then increases load.
  // Optional-set advice must never compete with those earned steps.
  const ladder = computeDensityLadder(rows, config.grip, zone, { expectedHands });
  if (ladder?.decision !== "repeat") return null;
  let plateau = true;
  for (const hand of expectedHands) {
    const openers = openingReps(rows, {
      grip: config.grip, zone, targetTime: config.targetTime, hand,
    }).slice(-ADD_SET_PLATEAU_SESSIONS);
    if (openers.length < ADD_SET_PLATEAU_SESSIONS) { plateau = false; break; }
    const sets = openers.map(opener => rows.filter(r => sessionKey(r) === sessionKey(opener)
      && r.hand === hand && isFirstSetRep(r))
      .sort((a, b) => Number(a.rep_num) - Number(b.rep_num)));
    const count = sets[0].length;
    if (count < LADDER_MIN_REPS || sets.some(set => set.length !== count
      || set.some((r, i) => Number(r.rep_num) !== i + 1 || !isCapacityEvidenceRep(r)))
      || openers.some(r => isShortfall(Number(r.actual_time_s), Number(r.target_duration)))) {
      plateau = false; break;
    }
    // Setup, rest and intended duration must match; otherwise the sessions
    // ask different questions even when the opening load is the same.
    if (openers.some(r => (r.setup_id ?? null) !== (openers[0].setup_id ?? null)
      || Number(r.target_duration) !== Number(openers[0].target_duration))
      || sets.some(set => set.some((r, i) => i > 0
        && Number(r.rest_s) !== Number(sets[0][i].rest_s)))) {
      plateau = false; break;
    }
    const stable = (values, tolerance) => values.every(v => Number.isFinite(v) && v > 0)
      && (Math.max(...values) - Math.min(...values)) / Math.min(...values) <= tolerance;
    if (!stable(openers.map(effectiveLoad), ADD_SET_PLATEAU_LOAD_RANGE)
      || sets[0].some((_, i) => !stable(sets.map(set => Number(set[i].actual_time_s)), ADD_SET_PLATEAU_TIME_RANGE))) {
      plateau = false; break;
    }
  }
  return plateau ? { needed: true, basis: "plateau", recentSessions } : null;
}

// Completion describes recorded activity, independently of whether those
// reps are suitable model evidence. Interrupted reps keep their own labels.
export function isSetComplete({ sessionReps = [], config, setNum = 1 }) {
  const count = Number(config?.repsPerSet);
  if (!Number.isInteger(count) || count < 1) return false;
  const hands = config.hand === "Both" ? ["L", "R"] : [config.hand];
  return hands.every(hand => {
    const numbers = new Set(sessionReps.filter(r => Number(r.set_num ?? 1) === setNum
      && (r.hand === hand || (r.hand === "B" && hands.length === 1)))
      .map(r => Number(r.rep_num)));
    return Array.from({ length: count }, (_, i) => i + 1).every(n => numbers.has(n));
  });
}

// The weakest hand gates Both-mode, so a strong side never hides a side that
// did not absorb the set well. The action remains available even when this
// returns null; this function controls suggestion copy, not permission.
export function recommendAnotherSet({ history = [], sessionReps = [], config, setNum = 1 }) {
  if (!config?.grip || !(config.targetTime > 0)) return null;
  const expectedHands = config.hand === "Both" ? ["L", "R"] : [config.hand];
  if (!isSetComplete({ sessionReps, config, setNum }) || setNum >= MAX_OPTIONAL_SETS) return null;
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
      text: "Your reps and hold times have stayed steady across recent sessions. If you feel ready, another set is optional.",
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
