// ──────────────────────────────────────────────────────────────
// COACH NOTES — behavioral coaching signals (July 2026)
// ──────────────────────────────────────────────────────────────
// The Session Plan's old "Why" line moonlighted as a second recommender
// (staleness arguments, coverage pleas) — signals the continuous engine
// already weighs. Design call (2026-07): coaching must never argue with
// the recommender; if it would, the recommender needs the fix. What a
// coach IS uniquely attentive to is BEHAVIOR over time — the things the
// curve engine deliberately ignores:
//
//   • adherence — you usually train every ~N days; it's been M.
//   • workload ramp — this week's volume vs your monthly norm
//     (acute:chronic, the classic tendon-safety ratio).
//   • trajectory — your modeled capacity over the last few sessions
//     is climbing (praise it) or slipping (flag it).
//
// Pure module, no React. buildCoachNotes returns AT MOST two notes,
// priority-ordered (worst first), each { key, tone, text } with tone in
// "warn" | "info" | "good". Every threshold is a named constant below —
// tune there, not inline. Volume = Σ effectiveLoad × actual_time_s
// (kg·s) per date; per-hand rows just sum (both hands' work is work).
//
// The recommendation EXPLANATION (one plain sentence for the engine's
// decisive factor) also lives here (decisiveWhy) so it's unit-testable
// without driving the SessionPlanCard render tree.

import { effectiveLoad } from "./load.js";
import { recoveryCoachSignals, GAP_NOISE_BAND } from "./recoveryDynamics.js";

// ── Thresholds ────────────────────────────────────
// Adherence: nag only when the current gap is well past the user's OWN
// cadence — both multiplicative and additive slack so a 2-day-cadence
// user isn't nagged on day 4, and a 7-day user isn't nagged on day 9.
export const ADHERENCE_MIN_GAPS   = 3;     // need ≥3 historical gaps to know a cadence
export const ADHERENCE_RATIO      = 1.75;  // gap > median × this …
export const ADHERENCE_SLACK_DAYS = 3;     // … AND gap ≥ median + this
// Ramp: acute (7d) vs chronic (28d ÷ 4) weekly volume. 1.5 is the
// classic acute:chronic "spike" line; 0.5 the detraining floor.
export const RAMP_WINDOW_ACUTE_D   = 7;
export const RAMP_WINDOW_CHRONIC_D = 28;
export const RAMP_SPIKE_RATIO      = 1.5;
export const RAMP_DROP_RATIO       = 0.5;
export const RAMP_MIN_SESSIONS     = 6;    // chronic window needs this many sessions to mean anything
// Trajectory: balanced-score change over the last N training days.
export const TREND_SESSIONS   = 3;
export const TREND_UP_PCT     = 3;   // ≥ +3% → praise
export const TREND_DOWN_PCT   = -5;  // ≤ −5% → flag

const DAY_MS = 86400 * 1000;
const dayNum = (ymd) => Math.round(new Date(`${ymd}T00:00:00`).getTime() / DAY_MS);

// Σ effectiveLoad × actual_time_s per date (kg·s). Dates ascending.
export function volumeByDate(history) {
  const map = new Map();
  for (const r of history || []) {
    if (!r || !r.date) continue;
    const load = effectiveLoad(r);
    const t = Number(r.actual_time_s);
    if (!(load > 0) || !(t > 0)) continue;
    map.set(r.date, (map.get(r.date) || 0) + load * t);
  }
  return new Map([...map.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// "You usually train every ~N days — it's been M." Personal cadence =
// median of the last 8 gaps between training dates. Null when the
// cadence is unknown (too few sessions) or the user is on schedule.
export function adherenceNote(history, todayStr) {
  const dates = [...volumeByDate(history).keys()];
  if (dates.length < ADHERENCE_MIN_GAPS + 1) return null;
  const nums = dates.map(dayNum);
  const gaps = [];
  for (let i = 1; i < nums.length; i++) gaps.push(nums[i] - nums[i - 1]);
  const med = median(gaps.slice(-8));
  if (!(med > 0)) return null;
  const sinceLast = dayNum(todayStr) - nums[nums.length - 1];
  if (sinceLast > med * ADHERENCE_RATIO && sinceLast >= med + ADHERENCE_SLACK_DAYS) {
    const medStr = Math.round(med);
    return {
      key: "adherence", tone: "warn",
      text: `It's been ${sinceLast} days since your last finger session — you usually train every ~${medStr}. Ease back in rather than making up for lost time.`,
    };
  }
  return null;
}

// Acute (7d) vs chronic (28d ÷ 4) weekly volume. Returns a spike note,
// a drop note, or null. Drop is suppressed when the adherence note
// already covers the absence (caller handles priority; we just also
// require at least one session inside the acute window for "spike").
export function volumeRampNote(history, todayStr) {
  const vols = volumeByDate(history);
  if (vols.size < RAMP_MIN_SESSIONS) return null;
  const today = dayNum(todayStr);
  let acute = 0, chronic = 0, chronicSessions = 0;
  for (const [d, v] of vols) {
    const age = today - dayNum(d);
    if (age < 0 || age >= RAMP_WINDOW_CHRONIC_D) continue;
    chronic += v;
    chronicSessions += 1;
    if (age < RAMP_WINDOW_ACUTE_D) acute += v;
  }
  if (chronicSessions < RAMP_MIN_SESSIONS) return null;
  const chronicWeekly = chronic / (RAMP_WINDOW_CHRONIC_D / 7);
  if (!(chronicWeekly > 0)) return null;
  const ratio = acute / chronicWeekly;
  // `ratio` rides along on both notes (July 2026) so the weekly
  // check-in can cross-reference the drop against the recovery signal
  // and rephrase (deload framing) instead of quoting this text verbatim.
  if (ratio >= RAMP_SPIKE_RATIO) {
    return {
      key: "ramp-spike", tone: "warn", ratio,
      text: `This week's finger volume is running ~${ratio.toFixed(1)}× your monthly average — tendons adapt slower than muscles, so ramp gently.`,
    };
  }
  if (ratio <= RAMP_DROP_RATIO) {
    return {
      key: "ramp-drop", tone: "info", ratio,
      text: `This week's volume is well under your monthly norm (~${Math.round(ratio * 100)}%). If life got busy, a lighter session still protects the base you've built.`,
    };
  }
  return null;
}

// Capacity trajectory for one grip: balanced score (geometric-mean
// force across the zone refTs) from a cumulative fit at the latest
// training date vs TREND_SESSIONS training dates earlier. The fit
// function is INJECTED (fitScoreAt(date) → score|null) so this module
// stays free of fit-stack imports and the caller reuses whatever
// memoized fits it already has.
export function trendNote(dates, fitScoreAt) {
  if (!dates || dates.length < TREND_SESSIONS + 1 || !fitScoreAt) return null;
  const nowDate  = dates[dates.length - 1];
  const thenDate = dates[dates.length - 1 - TREND_SESSIONS];
  const now  = fitScoreAt(nowDate);
  const then = fitScoreAt(thenDate);
  if (!(now > 0) || !(then > 0)) return null;
  const pct = Math.round((now / then - 1) * 100);
  if (pct <= TREND_DOWN_PCT) {
    return {
      key: "trend-down", tone: "warn",
      text: `Modeled capacity has slipped ~${Math.abs(pct)}% over your last ${TREND_SESSIONS} sessions — fatigue, sleep, or missed load can all do this. Worth a fresher, lighter day.`,
    };
  }
  if (pct >= TREND_UP_PCT) {
    return {
      key: "trend-up", tone: "good",
      text: `Up ~${pct}% over your last ${TREND_SESSIONS} sessions — the progression is landing.`,
    };
  }
  return null;
}

// ── Per-grip recovery note (Aug 2026) ────────────────────────
// Complements the DeloadGauge, which by design only reacts CROSS-grip
// (every grip down) — so it can't catch one grip slipping and never
// reassures. For the most salient grip this note does both:
//   • EARLY-WARN when a grip's recent modeled recovery gap sits below
//     the noise band (recovering worse than the model predicts) — a
//     grip-specific fatigue sign before the systemic gauge trips.
//   • REASSURE when a grip's rep-duration ratio has drifted down but the
//     gap is still within the band — expected under progressive load,
//     so the declining line isn't misread as fatigue.
// Consumes the compact signals from recoveryCoachSignals (percentage
// points). Pure over the injected array.
export const RECOVERY_BAND_PP    = Math.round(GAP_NOISE_BAND * 100); // ±10pp "matches model" band
export const RECOVERY_DECLINE_PP = -8;  // smoothed duration ratio dropped ≥ this to reassure

export function recoveryNote(signals) {
  if (!Array.isArray(signals) || signals.length === 0) return null;
  // Early-warn: the grip whose recent gap is furthest below the band.
  const slipping = signals
    .filter(s => Number.isFinite(s.recentGapPct) && s.recentGapPct <= -RECOVERY_BAND_PP)
    .sort((a, b) => a.recentGapPct - b.recentGapPct);
  if (slipping.length) {
    const s = slipping[0];
    return {
      key: "recovery-warn", tone: "warn",
      text: `Between-rep recovery on ${s.grip} is running ~${Math.abs(s.recentGapPct)}pp under your model over recent sessions — a grip-specific early fatigue sign the recovery gauge won't flag until every grip dips. A fresher or lighter ${s.grip} day would help.`,
    };
  }
  // Reassure: biggest recovery decline that's still tracking the model.
  const declining = signals
    .filter(s => Number.isFinite(s.recoveryDeltaPct) && s.recoveryDeltaPct <= RECOVERY_DECLINE_PP
      && (s.recentGapPct == null || s.recentGapPct > -RECOVERY_BAND_PP))
    .sort((a, b) => a.recoveryDeltaPct - b.recoveryDeltaPct);
  if (declining.length) {
    const s = declining[0];
    return {
      key: "recovery-ok", tone: "info",
      text: `Your ${s.grip} rep-time retention has drifted down lately, but it's still tracking the nonlinear fatigue model — expected as your failure times lengthen, not a fatigue sign by itself.`,
    };
  }
  return null;
}

// Priority-ordered assembly: regressions first, then workload warnings,
// then adherence, then the pat on the back. At most two notes so the
// card coaches instead of lecturing.
const PRIORITY = ["trend-down", "recovery-warn", "ramp-spike", "adherence", "ramp-drop", "recovery-ok", "trend-up"];

export function buildCoachNotes(history, { todayStr, gripDates = null, fitScoreAt = null, recoverySignals = null } = {}) {
  // Injectable so a caller with memoized fits can pass its own; else
  // compute internally from history (guarded — the fits can throw on
  // sparse data). buildCoachNotes already receives history.
  let recSignals = recoverySignals;
  if (recSignals == null) { try { recSignals = recoveryCoachSignals(history); } catch (e) { recSignals = []; } }
  const candidates = [
    adherenceNote(history, todayStr),
    volumeRampNote(history, todayStr),
    trendNote(gripDates, fitScoreAt),
    recoveryNote(recSignals),
  ].filter(Boolean);
  candidates.sort((a, b) => PRIORITY.indexOf(a.key) - PRIORITY.indexOf(b.key));
  // Adherence already explains an empty week — don't also show the drop.
  const hasAdherence = candidates.some(n => n.key === "adherence");
  const out = candidates.filter(n => !(hasAdherence && n.key === "ramp-drop"));
  return out.slice(0, 2);
}

// ── Recommendation explanation ────────────────────────────
// ONE plain sentence for the engine's decisive factor — explanation,
// not persuasion. The engine already picked; this just says why in
// coach language. Order mirrors the engine's own weighting: a measured
// below-curve model gap is the strongest signal, then coverage states,
// then the calibrated default. Ladder sessions explain the protocol
// instead (the numbers on screen are the ladder's, not the curve's).
export function decisiveWhy(rec, { ladderText = null } = {}) {
  if (ladderText) return ladderText;
  if (!rec) return null;
  if (rec.coldStart) {
    return "new grip — mid-length sessions first, so each failure maps a stretch of the curve";
  }
  const room = rec.room ?? (1 - (rec.localRatio ?? 1));
  if (!rec.coverageSnap && rec.adaptBoost != null && rec.adaptBoost > 1.05) {
    const pct = Math.max(1, Math.round(room * 100));
    return `reps near ${rec.T != null ? `${Math.round(rec.T)}s` : "here"} run ~${pct}% below your modeled curve — the strongest measured gap`;
  }
  if (rec.staleStatus === "never") {
    return "first data at this duration — one honest rep anchors the curve here";
  }
  if (rec.staleStatus === "stale") {
    return `${String(rec.zone || "").replace(/_/g, " ")} is your longest-unvisited zone`;
  }
  if (rec.coverageSnap) {
    return "centered in the zone (heavier · shorter) so a strong rep still lands in-window";
  }
  return "your curve is best supported here — this pick keeps every zone fresh";
}
