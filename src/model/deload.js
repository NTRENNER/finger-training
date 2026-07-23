// ──────────────────────────────────────────────────────────────
// DELOAD DETECTOR
// ──────────────────────────────────────────────────────────────
// Flags accumulating systemic fatigue and proposes a deload. NOT an
// injury system (the Micro/Crusher tools carry no finger-injury risk)
// — it's about catching non-functional overreaching, where fatigue is
// suppressing adaptation and backing off lets supercompensation happen.
//
// DESIGN (validated against real history, May 2026):
//
//  • The finger-training data is the SENSOR. It's densely instrumented
//    (per-rep failure curves), so total systemic fatigue — climbing +
//    lifting + life — shows up in it. Lifting/climbing are coarsely
//    logged by comparison, so they're CONTEXT, not the trigger.
//
//  • Trigger = cross-grip recovery-gap down. The per-grip rep2/rep1
//    recovery gap (observed − model-predicted, see recoveryDynamics)
//    must be below the noise band for EVERY trained grip over the last
//    N sessions. Cross-grip agreement is the key false-positive guard:
//    a single grip dipping is almost always a zone/training-phase
//    artifact (we saw Crusher dip in May purely from a shift to long
//    holds while Micro stayed flat — NOT fatigue). Real systemic
//    fatigue pulls every grip down together.
//
//  • Personal recovery taus (recoveryFit), not population, so "worse
//    than the model expects" means worse than YOUR normal — this
//    strips the long-hold tau-mismatch that otherwise masquerades as
//    fatigue.
//
//  • Lifting volume is the DISAMBIGUATOR / severity booster, not the
//    trigger. A completed-set acute-vs-chronic spike turns an ambiguous
//    cross-grip dip into a confident "strong" deload (both grips down
//    AND your heaviest lifting week = real overreaching). Set count, not
//    tonnage — the workout logs are too messy (string reps, empty =
//    bodyweight, unilateral L/R, duplicate rows) for reliable tonnage.
//
//  • Detraining guard: if there's no recent finger session, you're
//    rested, not fatigued — never deload.
//
// The detector only PROPOSES (returns a why-string for a banner); the
// UI surfaces it and the user accepts before any load is regulated.
// Pure functions; no React, no Supabase. Tested in isolation.

import { buildRecoveryTrend } from "./recoveryDynamics.js";
import { computePersonalRecoveryTausForGrip } from "./recoveryFit.js";
import { PHYS_MODEL_DEFAULT } from "./fatigue.js";

// Sustained: cross-grip recovery must be down over at least this many
// of each grip's most-recent finger sessions. 2 keeps a single rough
// day from firing while still catching a real run.
export const DELOAD_MIN_SESSIONS = 2;

// Per-grip trigger for the cross-grip deload gate, on the SAME statistic
// the gate reads: the mean of each grip's last DELOAD_MIN_SESSIONS
// HELD-OUT recovery gaps. Deliberately its OWN constant — NOT the chart /
// coaching band GAP_NOISE_BAND. That band is calibrated to the 3-session
// SMOOTHED gap; this gate reads a 2-session mean, a wider, noisier
// statistic (forward-chained holdout on ~5mo real data: std ≈ 0.15 Micro
// / 0.26 Crusher, centered POSITIVE at +0.09 / +0.14 — the model slightly
// under-predicts this user's recovery). A grip mean below -0.15 is
// ~1–1.5σ under the user's own baseline on THIS statistic — a beyond-noise
// systemic dip, not scatter. It equals the display band numerically on
// this data by coincidence, not construction. See
// scripts/recovery-validation.md; re-derive with recoveryModel.validation.
export const DELOAD_GAP_TRIGGER = 0.15;

// Detraining guard: if the most recent finger session on/before the
// evaluation date is older than this, return no-deload (rested).
export const DELOAD_STALE_DAYS = 14;

// Lifting acute-vs-chronic windows (days) + the completed-set rate
// ratio that counts as a volume spike, with a floor so a sparse
// history can't trivially "spike" off one session.
export const DELOAD_ACUTE_DAYS = 9;
export const DELOAD_CHRONIC_DAYS = 28;
export const DELOAD_LIFT_SPIKE_RATIO = 1.5;
export const DELOAD_LIFT_MIN_ACUTE_SETS = 12;

const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

// Dates where the recovery gauge has enough cross-grip history to be
// meaningful. Once two grips each have `minSessions` gap-bearing sessions,
// every subsequent recovery session is a useful checkpoint. `today` is
// appended as the live endpoint so the slider can return to "Now" even
// when the last finger session was several days ago.
export function recoveryStatusDates(history, opts = {}) {
  const {
    today = null,
    minSessions = DELOAD_MIN_SESSIONS,
  } = opts;
  if (!Array.isArray(history) || history.length === 0) return [];

  const grips = [...new Set(history.map(rep => rep?.grip).filter(Boolean))];
  const datesByGrip = new Map();
  const dateUnion = new Set();
  for (const grip of grips) {
    const dates = buildRecoveryTrend(history, grip, { physModel: null })
      .map(row => row.date)
      .filter(date => date && (!today || date <= today));
    datesByGrip.set(grip, dates);
    for (const date of dates) dateUnion.add(date);
  }

  const checkpoints = [...dateUnion].sort().filter(date => {
    let measurableGrips = 0;
    for (const dates of datesByGrip.values()) {
      if (dates.filter(candidate => candidate <= date).length >= minSessions) {
        measurableGrips++;
      }
    }
    return measurableGrips >= 2;
  });

  if (today && checkpoints.length > 0 && today >= checkpoints[0]) {
    checkpoints.push(today);
  }
  return [...new Set(checkpoints)].sort();
}

// physModel from a fitted recovery-tau triple (or population when null).
function physModelFromTaus(taus) {
  const tauR = taus ? { fast: taus.fast, medium: taus.medium, slow: taus.slow } : PHYS_MODEL_DEFAULT.tauR;
  return { weights: PHYS_MODEL_DEFAULT.weights, tauD: PHYS_MODEL_DEFAULT.tauD, tauR };
}

// Completed working-set count per date from workout_sessions. Robust
// lifting-volume proxy: skips marker rows (__rotation_pin, STRETCH),
// non-set entries (stretch/jumps flags), and sets not marked done.
export function liftingVolumeByDate(workoutSessions) {
  const byDate = {};
  for (const w of workoutSessions || []) {
    if (!w || !w.date) continue;
    if (w.workout === "__rotation_pin" || w.workout === "STRETCH") continue;
    const ex = w.exercises;
    if (!ex || typeof ex !== "object") continue;
    let sets = 0;
    for (const k of Object.keys(ex)) {
      const val = ex[k];
      if (!val || !Array.isArray(val.sets)) continue;
      for (const s of val.sets) {
        if (s && (s.done === true || s.done === "true")) sets++;
      }
    }
    if (sets > 0) byDate[w.date] = (byDate[w.date] || 0) + sets;
  }
  return byDate;
}

// Acute-vs-chronic lifting-volume spike as of `today`.
function liftingSpike(volByDate, today) {
  let acute = 0, chronic = 0;
  for (const [d, sets] of Object.entries(volByDate)) {
    const ago = daysBetween(d, today);
    if (ago < 0) continue;                       // after the eval date — ignore
    if (ago < DELOAD_ACUTE_DAYS) acute += sets;
    if (ago < DELOAD_CHRONIC_DAYS) chronic += sets;
  }
  const acuteRate = acute / DELOAD_ACUTE_DAYS;
  const chronicRate = chronic / DELOAD_CHRONIC_DAYS;
  const ratio = chronicRate > 0 ? acuteRate / chronicRate : 0;
  const spike = acute >= DELOAD_LIFT_MIN_ACUTE_SETS && ratio >= DELOAD_LIFT_SPIKE_RATIO;
  return { acuteSets: acute, chronicSets: chronic, ratio, spike };
}

// Mean recovery gap for a grip over its last `n` finger sessions
// on/before `today`, scored HELD-OUT: personal recovery taus are fit
// ONLY on that grip's sessions BEFORE this recent window, then the recent
// `n` are scored as out-of-sample. Without this, the very sessions being
// evaluated pulled the tau fit toward their own recovery (worst on sparse
// grips), partly masking a real dip — the look-ahead leakage the offline
// validation avoids but production used to have. Null when fewer than `n`
// gap-bearing sessions exist on/before `today`.
export function recentGapHeldOut(history, grip, today, n) {
  // Sessions that can carry a gap (>=2 timed reps), oldest→newest. No
  // physModel needed just to enumerate the dates.
  const sessions = buildRecoveryTrend(history, grip, { physModel: null })
    .filter(r => r.date && r.date <= today);
  if (sessions.length < n) return null;
  const recent = sessions.slice(-n);
  const cutoff = recent[0].date;                    // earliest of the window
  const baseline = history.filter(r => r.grip === grip && r.date && r.date < cutoff);
  const physModel = physModelFromTaus(computePersonalRecoveryTausForGrip(baseline, grip));
  const scored = buildRecoveryTrend(history, grip, { physModel })
    .filter(r => r.date && r.date <= today && Number.isFinite(r.gapAtTarget));
  if (scored.length < n) return null;
  const last = scored.slice(-n);
  const mean = last.reduce((s, r) => s + r.gapAtTarget, 0) / last.length;
  return { mean, n: last.length, lastDate: last[last.length - 1].date };
}

// Main entry. Returns:
//   { deload: bool, severity: "none"|"mild"|"strong", signals, why }
// `signals` exposes the raw inputs so the UI can show its work.
export function computeDeload(history, workoutSessions = [], opts = {}) {
  const { today = null, minSessions = DELOAD_MIN_SESSIONS } = opts;
  const none = (why, signals = {}) => ({ deload: false, severity: "none", signals, why });

  if (!Array.isArray(history) || history.length === 0) return none("No training history.");

  const datesAsc = history.filter(r => r.date).map(r => r.date).sort();
  const ref = today || datesAsc[datesAsc.length - 1];
  if (!ref) return none("No dated sessions.");

  // Detraining guard — most recent finger session on/before ref.
  const lastOnOrBefore = datesAsc.filter(d => d <= ref).pop();
  if (!lastOnOrBefore || daysBetween(lastOnOrBefore, ref) > DELOAD_STALE_DAYS) {
    return none("No recent finger sessions — rested, not fatigued.");
  }

  // Per-grip recent recovery gap with personal taus.
  const grips = [...new Set(history.filter(r => r.grip).map(r => r.grip))];
  const gripGaps = {};
  for (const g of grips) {
    const rg = recentGapHeldOut(history, g, ref, minSessions);
    if (rg) gripGaps[g] = rg;
  }
  const measured = Object.keys(gripGaps);
  const lifting = liftingSpike(liftingVolumeByDate(workoutSessions), ref);
  const signals = { today: ref, gripGaps, lifting };

  if (measured.length < 2) {
    return none("Not enough cross-grip recovery data yet.", signals);
  }

  // Cross-grip gate: EVERY measured grip's recent mean gap below the band.
  const downGrips = measured.filter(g => gripGaps[g].mean < -DELOAD_GAP_TRIGGER);
  signals.downGrips = downGrips;
  signals.crossGripDown = downGrips.length === measured.length;

  if (!signals.crossGripDown) {
    const why = downGrips.length > 0
      ? `Only ${downGrips.join(", ")} recovery is down — looks grip-specific (a zone/phase artifact), not systemic. No deload.`
      : "Recovery is within your normal range across grips. No deload.";
    return none(why, signals);
  }

  const severity = lifting.spike ? "strong" : "mild";
  const gapStr = measured
    .map(g => `${g} ${gripGaps[g].mean >= 0 ? "+" : ""}${gripGaps[g].mean.toFixed(2)}`)
    .join(", ");
  const why = lifting.spike
    ? `Both grips' between-rep recovery is below your model over the last ${minSessions} sessions (${gapStr}), and lifting volume is ${lifting.ratio.toFixed(1)}× your 4-week average. Signs of accumulating systemic fatigue — consider an easier finger session and trimming your next lifting workout.`
    : `Both grips' between-rep recovery is below your model over the last ${minSessions} sessions (${gapStr}). An early fatigue signal — consider a lighter finger session.`;

  return { deload: true, severity, signals, why };
}

// ──────────────────────────────────────────────────────────────
// DELOAD READINESS (green / yellow / red gauge)
// ──────────────────────────────────────────────────────────────
// A continuous "how close to a deload am I" status, so a deload has a
// runway instead of appearing out of nowhere. Driven by the SAME
// conservative signal as computeDeload (cross-grip recovery gap on
// personal taus) — pressure rises only as recovery genuinely softens,
// and RED is reserved for the full strong-deload condition so a single
// rough session can't flip the light.

// The gauge is a deliberate EARLY RUNWAY: it softens the light BEFORE the
// hard cross-grip deload so a deload never appears out of nowhere.
// Pressure is scaled so 1.0 lands exactly at the deload line
// (avgGap = -DELOAD_GAP_TRIGGER); yellow lights partway down that runway.
// avgGap normally sits POSITIVE here (the model slightly under-predicts
// this user's recovery), so the gauge is green unless cross-grip recovery
// genuinely drifts negative.
export const DELOAD_PRESSURE_SCALE = DELOAD_GAP_TRIGGER;   // full pressure at the deload line
// green → yellow at/above this pressure. 0.5 ⇒ avgGap ≈ -0.075, about
// halfway to the deload line — an intentional heads-up, not the decision.
export const DELOAD_YELLOW_AT = 0.5;

// Returns:
//   { level: "green"|"yellow"|"red", pressure: 0..1, avgGap, haveSignal,
//     label, deload }
// `deload` is the full computeDeload result (for the why-string / banner).
export function deloadStatus(history, workoutSessions = [], opts = {}) {
  const res = computeDeload(history, workoutSessions, opts);
  const gaps = res.signals && res.signals.gripGaps ? res.signals.gripGaps : {};
  const means = Object.values(gaps).map(g => g.mean).filter(Number.isFinite);
  const haveSignal = means.length >= 2;
  const avgGap = haveSignal ? means.reduce((s, v) => s + v, 0) / means.length : 0;

  // Pressure rises as average cross-grip recovery degrades below zero.
  const pressure = haveSignal
    ? Math.max(0, Math.min(1, -avgGap / DELOAD_PRESSURE_SCALE))
    : 0;

  // Level: red only at the full strong-deload condition; yellow on a
  // mild deload OR meaningful pressure; green otherwise. Mirrors the
  // computeDeload severity so the gauge and the banner never disagree.
  let level;
  if (res.severity === "strong") level = "red";
  else if (res.severity === "mild") level = "yellow";
  else if (haveSignal && pressure >= DELOAD_YELLOW_AT) level = "yellow";
  else level = "green";

  const label =
    level === "red" ? "Deload recommended" :
    level === "yellow" ? "Recovery softening — ease up soon" :
    haveSignal ? "Fresh — absorbing your load well" : "Not enough recent data";

  return {
    level,
    pressure: Math.round(pressure * 100) / 100,
    avgGap: haveSignal ? Math.round(avgGap * 100) / 100 : null,
    haveSignal,
    label,
    deload: res,
  };
}

// ──────────────────────────────────────────────────────────────
// WEEKLY DELOAD PLAN
// ──────────────────────────────────────────────────────────────
// A deload is a WEEK-scoped intervention, not a per-session tweak. The
// plan cuts VOLUME ~50% (Climb Strong's deload heuristic) while keeping
// the loads you do hit near-normal — the recovery comes from less
// volume, not from making sessions easy (that would also detrain). So
// the plan caps sessions/days rather than scaling prescribed loads.

export const DELOAD_WEEK_DAYS = 7;

// Distinct finger-training days within the 7 days ending at `today`.
// A lightweight weekly-session counter so the reminder can say
// "you've done N this week" (the app has no weekly session target).
export function fingerSessionsThisWeek(history, today) {
  if (!Array.isArray(history) || !today) return 0;
  const dates = new Set();
  for (const r of history) {
    if (!r.date || !(r.actual_time_s > 0)) continue;
    const ago = daysBetween(r.date, today);
    if (ago >= 0 && ago < DELOAD_WEEK_DAYS) dates.add(r.date);
  }
  return dates.size;
}

// Weekly volume prescription for a deload, by severity. Strong = a full
// deload week (one finger session, skip the heavy lifting day "A", drop
// a climbing day). Mild = a soft cap, no skips. Null when no deload.
export function deloadPlan(severity) {
  if (severity === "strong") return { fingerCap: 1, skipWorkout: "A", climbDays: 2, climbFrom: 3 };
  if (severity === "mild")   return { fingerCap: 2, skipWorkout: null, climbDays: null, climbFrom: null };
  return null;
}

// Banner-ready guidance: the action text + the weekly counts, derived
// from a computeDeload result (or a stored severity during an accepted
// deload week). Pure — the UI owns acceptance/persistence.
export function buildDeloadGuidance(severity, history, opts = {}) {
  const plan = deloadPlan(severity);
  if (!plan) return null;
  const datesAsc = (history || []).filter(r => r.date).map(r => r.date).sort();
  const today = opts.today || datesAsc[datesAsc.length - 1] || null;
  const done = today ? fingerSessionsThisWeek(history, today) : 0;
  const action = severity === "strong"
    ? `This week: limit finger training to ${plan.fingerCap} session (you've done ${done} so far), skip Workout ${plan.skipWorkout}, and drop to ${plan.climbDays} climbing days from ${plan.climbFrom}. Keep the loads you do hit near-normal — cut volume, not intensity.`
    : `Keep it light this week — no more than ${plan.fingerCap} hard finger sessions (you've done ${done} so far) and hold off adding lifting or climbing volume.`;
  return { severity, plan, fingerDoneThisWeek: done, action };
}
