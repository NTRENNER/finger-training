// ──────────────────────────────────────────────────────────────
// DELOAD DETECTOR
// ──────────────────────────────────────────────────────────────
// Recovery comparisons can suggest reduced training; they do not establish
// systemic fatigue, injury risk, or readiness in the absence of current data.
import { buildRecoveryTrend } from "./recoveryDynamics.js";
import { computePersonalRecoveryTausForGrip } from "./recoveryFit.js";
import { PHYS_MODEL_DEFAULT } from "./fatigue.js";
import { sessionFatigueDetail } from "./climbingFatigue.js";

// Sustained: cross-grip recovery must be down over at least this many
// of each grip's most-recent finger sessions. 2 keeps a single rough
// day from firing while still catching a real run.
export const DELOAD_MIN_SESSIONS = 2;

// Provisional absolute recovery-gap threshold until there is enough
// held-out history to estimate the athlete's usual two-session average.
export const DELOAD_GAP_TRIGGER = 0.15;
export const DELOAD_GAP_TRIGGER_SD = 1.0;
export const DELOAD_BASELINE_MIN_SESSIONS = 6; // independent dates per half
export const DELOAD_BASELINE_FULL_DAYS = 12;
export const DELOAD_BASELINE_MIN_SD = 0.05;
// Require at least a 0.10 drop in the observed/predicted recovery ratio.
// This conservative guard prevents a nearly constant baseline turning
// tiny changes into alarms. It is a policy floor, not a measured SD.
export const DELOAD_MIN_MEANINGFUL_GAP = 0.10;

// Detraining guard: if the most recent finger session on/before the
// evaluation date is older than this, current recovery is unknown.
export const DELOAD_STALE_DAYS = 14;

// Lifting acute-vs-chronic windows (days) + the completed-set rate
// ratio that counts as a volume spike, with a floor so a sparse
// history can't trivially "spike" off one session.
export const DELOAD_ACUTE_DAYS = 9;
export const DELOAD_CHRONIC_DAYS = 28;
export const DELOAD_LIFT_SPIKE_RATIO = 1.5;
export const DELOAD_LIFT_MIN_ACUTE_SETS = 12;

// Climbing spike, on the same acute/chronic windows. Climbing is the
// largest systemic load in this athlete's week and the detector could not
// see any of it: it read finger sessions and lifting only. Across the real
// history the recovery statistic correlates with climbing load in the
// preceding three days at rho = -0.33 (n = 51, p < 0.05, correct sign —
// more climbing, slower between-rep recovery), which is the best evidence
// available that this gauge is reading systemic fatigue at all.
//
// It is a SEVERITY MODIFIER, never a gate, exactly like lifting. The
// decision to deload stays with the measured recovery, because that is the
// thing actually observed on the athlete rather than inferred about them.
// Climbing load says how hard to take the finding, not whether to have it.
//
// The ratio reuses the lifting threshold; on real climbing history the
// acute:chronic ratio is 1.05 at the median and 1.99 at p90, so 1.5 marks
// roughly the top eighth of days. The floor keeps a quiet fortnight from
// spiking off one session. Load is the session-fatigue score, so attempts
// and board tax carry through (see climbingFatigue.js).
export const DELOAD_CLIMB_SPIKE_RATIO = DELOAD_LIFT_SPIKE_RATIO;
export const DELOAD_CLIMB_MIN_ACUTE_LOAD = 20;

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
    return measurableGrips >= 1;
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

// Daily climbing load from the activity log: the session-fatigue score for
// each date that has one. Returns { "YYYY-MM-DD": 0..10 }.
export function climbingLoadByDate(activities) {
  const byDate = {};
  if (!Array.isArray(activities)) return byDate;
  const groups = new Map();
  for (const activity of activities) {
    if (activity?.type !== "climbing" || !activity.date) continue;
    if (!groups.has(activity.date)) groups.set(activity.date, []);
    groups.get(activity.date).push(activity);
  }
  for (const [d, rows] of groups) {
    const detail = sessionFatigueDetail(rows, d);
    if (detail && Number.isFinite(detail.scoreExact)) byDate[d] = detail.scoreExact;
  }
  return byDate;
}

// Acute-vs-chronic climbing-load spike as of `today`. Same shape as
// liftingSpike so the two read identically at the call site.
function climbingSpike(loadByDate, today) {
  let acute = 0, chronic = 0;
  for (const [d, load] of Object.entries(loadByDate)) {
    const ago = daysBetween(d, today);
    if (ago < 0) continue;                       // after the eval date — ignore
    if (ago < DELOAD_ACUTE_DAYS) acute += load;
    if (ago < DELOAD_CHRONIC_DAYS) chronic += load;
  }
  const acuteRate = acute / DELOAD_ACUTE_DAYS;
  const chronicRate = chronic / DELOAD_CHRONIC_DAYS;
  const ratio = chronicRate > 0 ? acuteRate / chronicRate : 0;
  const spike = acute >= DELOAD_CLIMB_MIN_ACUTE_LOAD && ratio >= DELOAD_CLIMB_SPIKE_RATIO;
  return { acuteLoad: Math.round(acute * 10) / 10, chronicLoad: Math.round(chronic * 10) / 10, ratio, spike };
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
  // Recency belongs to the latest qualifying session, not the window span.
  if (daysBetween(sessions[sessions.length - 1].date, today) > DELOAD_STALE_DAYS) return null;
  const recent = sessions.slice(-n);
  const cutoff = recent[0].date;                    // earliest of the window
  const baseline = history.filter(r => r.grip === grip && r.date && r.date < cutoff);
  const physModel = physModelFromTaus(computePersonalRecoveryTausForGrip(baseline, grip));
  const scored = buildRecoveryTrend(history, grip, { physModel })
    .filter(r => r.date && r.date <= today && Number.isFinite(r.gapAtTarget));
  if (scored.length < n) return null;
  const last = scored.slice(-n);
  const mean = last.reduce((s, r) => s + r.gapAtTarget, 0) / last.length;

  // Split complete dates, never individual sessions sharing a date. The
  // actual halves must each have enough independent training days.
  const dates = [...new Set(sessions.filter(r => r.date < cutoff).map(r => r.date))];
  let baselineStats = null;
  if (dates.length >= 2 * DELOAD_BASELINE_MIN_SESSIONS) {
    const split = dates[Math.floor(dates.length / 2)];
    const older = history.filter(r => r.grip === grip && r.date && r.date < split);
    const basePhys = physModelFromTaus(computePersonalRecoveryTausForGrip(older, grip));
    const evaluation = buildRecoveryTrend(history, grip, { physModel: basePhys })
      .filter(r => r.date && r.date >= split && r.date < cutoff && Number.isFinite(r.gapAtTarget));
    const independentDates = new Set(evaluation.map(r => r.date)).size;
    const vals = evaluation.map(r => r.gapAtTarget);
    const windows = vals.slice(n - 1).map((_, i) =>
      vals.slice(i, i + n).reduce((sum, v) => sum + v, 0) / n);
    if (independentDates >= DELOAD_BASELINE_MIN_SESSIONS && windows.length >= 2) {
      const mu = windows.reduce((sum, v) => sum + v, 0) / windows.length;
      const rawSd = Math.sqrt(windows.reduce((sum, v) => sum + (v - mu) ** 2, 0) / (windows.length - 1));
      baselineStats = { mean: mu, sd: Math.max(rawSd, DELOAD_BASELINE_MIN_SD), rawSd,
        n: windows.length, sessionCount: vals.length, independentDates, windowSize: n, splitDate: split,
        // Overlapping windows are not independent observations. Readiness
        // to personalize depends on distinct training dates instead.
        weight: Math.min(1, (independentDates - DELOAD_BASELINE_MIN_SESSIONS)
          / (DELOAD_BASELINE_FULL_DAYS - DELOAD_BASELINE_MIN_SESSIONS)) };
    }
  }
  const weight = baselineStats?.weight ?? 0;
  const personalDistance = baselineStats
    ? Math.max(DELOAD_MIN_MEANINGFUL_GAP, baselineStats.sd * DELOAD_GAP_TRIGGER_SD) : DELOAD_GAP_TRIGGER;
  const center = weight * (baselineStats?.mean ?? 0);
  const distance = (1 - weight) * DELOAD_GAP_TRIGGER + weight * personalDistance;
  return { mean, n: last.length, lastDate: last[last.length - 1].date,
    confidence: last.some(r => r.confidence === "historical_estimate") ? "historical_estimate" : "measured",
    baseline: baselineStats, center, distance, threshold: center - distance,
    assessment: weight >= 1 ? "personalized" : "provisional",
    // With zero spread there is no statistical z-score; the policy guard
    // still supplies a stable threshold and shared gauge/decision scale.
    z: baselineStats?.rawSd > 0 ? (mean - baselineStats.mean) / baselineStats.sd : null };
}

// Both displays and decisions use the same runway, including equality.
export function gripPressure(gap) {
  if (!gap) return 0;
  const raw = Number.isFinite(gap.center) && gap.distance > 0
    ? (gap.center - gap.mean) / gap.distance
    : gap.z != null ? -gap.z / DELOAD_GAP_TRIGGER_SD : -gap.mean / DELOAD_GAP_TRIGGER;
  return raw >= 1 - 1e-12 ? 1 : Math.max(0, Math.min(1, raw));
}
export function gripIsDown(gap) {
  return !!gap && gripPressure(gap) === 1;
}

// Main entry. Returns:
//   { deload: bool, severity: "none"|"mild"|"strong", signals, why }
// `signals` exposes the raw inputs so the UI can show its work.
export function computeDeload(history, workoutSessions = [], opts = {}) {
  const { today = null, minSessions = DELOAD_MIN_SESSIONS, activities = null } = opts;
  const none = (why, signals = {}, state = "insufficient") => ({ deload: false, severity: "none", state, signals, why });

  if (!Array.isArray(history) || history.length === 0) return none("No training history.");

  const datesAsc = history.filter(r => r.date).map(r => r.date).sort();
  const ref = today || datesAsc[datesAsc.length - 1];
  if (!ref) return none("No dated sessions.");

  // Detraining guard — most recent finger session on/before ref.
  const lastOnOrBefore = datesAsc.filter(d => d <= ref).pop();
  if (!lastOnOrBefore || daysBetween(lastOnOrBefore, ref) > DELOAD_STALE_DAYS) {
    return none("No recent finger recovery evidence — current recovery is unknown.");
  }

  // Per-grip recent recovery gap with personal taus.
  const grips = [...new Set(history.filter(r => r.grip && r.date && r.date <= ref).map(r => r.grip))];
  const gripGaps = {};
  for (const g of grips) {
    const rg = recentGapHeldOut(history, g, ref, minSessions);
    if (rg) gripGaps[g] = rg;
  }
  const measured = Object.keys(gripGaps);
  const lifting = liftingSpike(liftingVolumeByDate(workoutSessions), ref);
  const climbing = climbingSpike(climbingLoadByDate(activities), ref);
  const unassessedGrips = grips.filter(g => !gripGaps[g]);
  const signals = { today: ref, gripGaps, unassessedGrips, lifting, climbing };

  if (measured.length === 0) {
    return none("Not enough current recovery data yet.", signals);
  }

  // Cross-grip gate: EVERY measured grip's recent recovery below ITS OWN
  // typical value. A grip without enough baseline yet falls back to the
  // absolute threshold rather than being assumed healthy.
  const downGrips = measured.filter(g => gripIsDown(gripGaps[g]));
  signals.downGrips = downGrips;
  signals.crossGripDown = measured.length >= 2 && downGrips.length === measured.length;

  if (!signals.crossGripDown) {
    const why = downGrips.length > 0
      ? `Recovery is below the expected range in ${downGrips.join(", ")}. Consider an easier session. We cannot tell yet whether this is limited to ${downGrips.length === 1 ? "that grip" : "those grips"} or reflects broader fatigue.`
      : "Observed recovery is within your normal range for the currently measured grips.";
    return none(why, signals, downGrips.length > 0 ? "local_concern" : "normal");
  }

  // Either outside load escalates. The recovery finding is the same
  // either way; a spike says the cause is probably still in front of you.
  const severity = (lifting.spike || climbing.spike) ? "strong" : "mild";
  // Report how far below normal each grip is, in its own terms. The raw
  // gap was never interpretable on its own — that was the whole problem.
  const gapStr = measured
    .map(g => gripGaps[g].assessment === "provisional"
      ? `${g}: provisional recovery signal`
      : `${g}: recovery below usual range`)
    .join(", ");
  const loadParts = [];
  if (lifting.spike) loadParts.push(`lifting volume is ${lifting.ratio.toFixed(1)}× your 4-week average`);
  if (climbing.spike) loadParts.push(`climbing load is ${climbing.ratio.toFixed(1)}× your 4-week average`);
  const why = loadParts.length > 0
    ? `Between-rep recovery is below your own normal on every measured grip over the last ${minSessions} sessions (${gapStr}), and ${loadParts.join(", and ")}. Signs of accumulating systemic fatigue — consider an easier finger session and trimming the load that spiked.`
    : `Between-rep recovery is below your own normal on every measured grip over the last ${minSessions} sessions (${gapStr}). An early fatigue signal — consider a lighter finger session.`;

  return { deload: true, severity, state: "systemic_concern", signals, why };
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
// Compatibility export for callers displaying the provisional threshold.
export const DELOAD_PRESSURE_SCALE = DELOAD_GAP_TRIGGER;
// Yellow is an early heads-up halfway along the current blended runway.
export const DELOAD_YELLOW_AT = 0.5;

// Returns:
//   { level: "green"|"yellow"|"red", pressure: 0..1, avgGap, haveSignal,
//     label, deload }
// `deload` is the full computeDeload result (for the why-string / banner).
export function deloadStatus(history, workoutSessions = [], opts = {}) {
  const res = computeDeload(history, workoutSessions, opts);
  const gaps = res.signals && res.signals.gripGaps ? res.signals.gripGaps : {};
  const entries = Object.values(gaps).filter(g => Number.isFinite(g.mean));
  const haveSignal = entries.length >= 1;
  const means = entries.map(g => g.mean);
  const avgGap = haveSignal ? means.reduce((s, v) => s + v, 0) / means.length : 0;

  // Pressure is averaged over each grip's OWN runway rather than over the
  // raw gaps. Averaging the gaps first assumed the grips shared a scale
  // and a centre, and they do not: their baselines differ in both.
  const pressure = haveSignal
    ? entries.reduce((s, g) => s + gripPressure(g), 0) / entries.length
    : 0;

  // Level: red only at the full strong-deload condition; yellow on a
  // mild deload OR meaningful pressure; green otherwise. Mirrors the
  // computeDeload severity so the gauge and the banner never disagree.
  let level;
  if (!haveSignal) level = "unknown";
  else if (res.severity === "strong") level = "red";
  else if (res.severity === "mild" || res.state === "local_concern") level = "yellow";
  else if (haveSignal && pressure >= DELOAD_YELLOW_AT) level = "yellow";
  else level = "green";

  const label =
    level === "red" ? "Deload recommended" :
    level === "yellow" ? "Recovery softening — ease up soon" :
    haveSignal ? "Observed recovery within range" : "Not enough recent data";

  return {
    level,
    state: res.state,
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
