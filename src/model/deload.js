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

// ── Why the trigger above is no longer the primary gate ──────
// (September 2026.) DELOAD_GAP_TRIGGER is an ABSOLUTE threshold against
// zero, and zero is not where this statistic lives. Replaying the whole
// real history — 51 checkpoints across five months — the per-grip mean
// gap sits at a median of +0.187 (Crusher) and +0.157 (Micro), because
// the recovery model under-predicts this athlete. Against their own
// spread that puts -0.15 at 1.85 sd (Crusher) and 2.02 sd (Micro) below
// typical, and the cross-grip gate then demands BOTH grips be there at
// once — on the order of a 0.07% event per checkpoint.
//
// It behaved exactly as that arithmetic predicts: 48 of 51 checkpoints
// green, 3 yellow on a single grip, and the deload recommendation never
// fired once. That is not five months without fatigue; it is a detector
// whose operating point sits two standard deviations outside its own
// data. The bias was even documented in the comment above — "centered
// POSITIVE at +0.09 / +0.14" — and the absolute threshold was kept anyway.
//
// So the gate now reads each grip against ITS OWN distribution of this
// statistic. "Recovery is softening" means softer than normal for you,
// which is what the card claimed all along.
//
// What that changed on the real history, replayed: yellow 3 → 5, and the
// gauge acquired a working range — pressure now spans 0 to 0.64 with a
// median of 0.02, where before it was pinned at 0 because the average gap
// was positive at nearly every checkpoint. Two of the yellows are genuine
// CROSS-GRIP softening (2026-06-05 at 0.64, 2026-07-11 at 0.51), which the
// absolute gauge had no way to express at all.
//
// Red still never fires: both grips a full sd below their own medians at
// once did not happen in five months. The threshold is deliberately NOT
// tuned down to manufacture a firing — after recentering, "it did not
// happen" is a finding about the training, where before it was an artifact
// of an operating point two sd outside the data.
//
// The best evidence that this reads something real is 2026-06-05. Recovery
// was down on both grips (-0.62, -0.67 sd), climbing acute:chronic hit
// 1.77×, and the log shows 19 climbs that day — and the athlete rated
// themselves cooked = 0. Three measurements agreeing against one
// self-report is the case for keeping this detector and not asking people
// how they feel.
//
// An earlier pass at this claimed the gate fires on 2026-07-06 and 07-11.
// It does not: that estimate z-scored each window against the FULL history
// including its own future. With honest out-of-sample baselines those days
// are -0.44 and -0.66 sd, well short. Lookahead flatters a detector, which
// is why the baseline below is split-half rather than global.
//
// DELOAD_GAP_TRIGGER survives only as the fallback for a grip with too
// little history to have a baseline yet — 13 of 51 checkpoints here, all
// early.
export const DELOAD_GAP_TRIGGER_SD = 1.0;

// Sessions of out-of-sample baseline needed before a grip can be judged
// against itself; below this the absolute fallback applies. The split
// that produces them needs twice this many pre-window sessions.
export const DELOAD_BASELINE_MIN_SESSIONS = 6;

// Floor on the baseline spread. Dividing by a near-zero sd would turn an
// unremarkable wobble into a 6-sigma alarm, which is how a metronomically
// consistent athlete — or a synthetic fixture — gets told to deload for
// nothing. Real per-grip baselines here run 0.17-0.30, so this only binds
// on a degenerate one, and when it binds it makes the gate HARDER to trip,
// never easier.
export const DELOAD_BASELINE_MIN_SD = 0.05;

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
  for (const d of new Set(activities.filter(a => a?.type === "climbing" && a.date).map(a => a.date))) {
    const detail = sessionFatigueDetail(activities, d);
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

  // The athlete's own baseline for this statistic, so "recovery is down"
  // can mean down FOR THEM. See DELOAD_GAP_TRIGGER_SD for why an absolute
  // threshold could not work here.
  //
  // The baseline must be scored the same way the window is — out of
  // sample — or the comparison is between two different things. Reusing
  // `scored` for it would not do: those earlier sessions are IN sample for
  // the tau fit above, and on this user's real history that shifts the
  // Crusher baseline median by 0.062 (0.25 sd) relative to forward-chained
  // scoring, in the direction that makes the window look healthier than it
  // is. Micro shifts by 0.001, so the bias is per-grip and cannot be
  // constant-corrected. Instead the pre-window sessions are split: taus fit
  // on the older half, the newer half scored out-of-sample against them.
  const preWindow = sessions.slice(0, -n);
  let baselineStats = null;
  if (preWindow.length >= 2 * DELOAD_BASELINE_MIN_SESSIONS) {
    const split = preWindow[Math.floor(preWindow.length / 2)].date;
    const older = history.filter(r => r.grip === grip && r.date && r.date < split);
    const basePhys = physModelFromTaus(computePersonalRecoveryTausForGrip(older, grip));
    const vals = buildRecoveryTrend(history, grip, { physModel: basePhys })
      .filter(r => r.date && r.date >= split && r.date < cutoff && Number.isFinite(r.gapAtTarget))
      .map(r => r.gapAtTarget);
    if (vals.length >= DELOAD_BASELINE_MIN_SESSIONS) {
      const sorted = [...vals].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const mu = vals.reduce((s, v) => s + v, 0) / vals.length;
      const sd = Math.sqrt(vals.reduce((s, v) => s + (v - mu) ** 2, 0) / (vals.length - 1));
      if (sd > 0) baselineStats = { median, sd: Math.max(sd, DELOAD_BASELINE_MIN_SD), n: vals.length };
    }
  }

  return { mean, n: last.length, lastDate: last[last.length - 1].date,
    confidence: last.some(r => r.confidence === "historical_estimate") ? "historical_estimate" : "measured",
    baseline: baselineStats,
    // Standard deviations below the athlete's own typical value. Null when
    // the baseline is too thin, and callers then fall back to the absolute
    // threshold rather than guessing.
    z: baselineStats ? (mean - baselineStats.median) / baselineStats.sd : null };
}

// Is this grip's recent recovery below its own normal? Prefers the
// self-referenced z-score; falls back to the absolute threshold only when
// the grip has too little history to have a baseline.
export function gripIsDown(gap) {
  if (!gap) return false;
  return gap.z != null ? gap.z <= -DELOAD_GAP_TRIGGER_SD : gap.mean < -DELOAD_GAP_TRIGGER;
}

// How far along the runway to a deload this grip sits, 0..1, with 1.0 at
// the trigger. Same preference order as gripIsDown, so the gauge and the
// gate can never disagree about which grips are down.
export function gripPressure(gap) {
  if (!gap) return 0;
  const raw = gap.z != null
    ? -gap.z / DELOAD_GAP_TRIGGER_SD
    : -gap.mean / DELOAD_PRESSURE_SCALE;
  return Math.max(0, Math.min(1, raw));
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
  const grips = [...new Set(history.filter(r => r.grip).map(r => r.grip))];
  const gripGaps = {};
  for (const g of grips) {
    const rg = recentGapHeldOut(history, g, ref, minSessions);
    if (rg) gripGaps[g] = rg;
  }
  const measured = Object.keys(gripGaps);
  const lifting = liftingSpike(liftingVolumeByDate(workoutSessions), ref);
  const climbing = climbingSpike(climbingLoadByDate(activities), ref);
  const signals = { today: ref, gripGaps, lifting, climbing };

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
      ? `Only ${downGrips.join(", ")} recovery is below its own normal — a grip-specific concern. Consider an easier session for that grip; systemic recovery is not established.`
      : "Observed recovery is within your normal range for the currently measured grips.";
    return none(why, signals, downGrips.length > 0 ? "local_concern" : "normal");
  }

  // Either outside load escalates. The recovery finding is the same
  // either way; a spike says the cause is probably still in front of you.
  const severity = (lifting.spike || climbing.spike) ? "strong" : "mild";
  // Report how far below normal each grip is, in its own terms. The raw
  // gap was never interpretable on its own — that was the whole problem.
  const gapStr = measured
    .map(g => gripGaps[g].z != null
      ? `${g} ${Math.abs(gripGaps[g].z).toFixed(1)} sd below normal`
      : `${g} ${gripGaps[g].mean >= 0 ? "+" : ""}${gripGaps[g].mean.toFixed(2)}`)
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
