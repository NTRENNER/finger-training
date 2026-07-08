// ─────────────────────────────────────────────────────────────
// SUPPORT EXERCISE RISK — decay-class staleness + regression (July 2026)
// ─────────────────────────────────────────────────────────────
// Ranks the A/B/C support exercises by how urgently they need a touch,
// for the busy-week check-in nudge ("next week, try to get: ...").
//
// Detraining basis for the windows (deliberately coarse — these are
// coaching heuristics, not lab constants):
//   • POWER/EXPLOSIVE (~10d): rate-of-force qualities decay fastest —
//     jumps, slams, and other elastic work show measurable drop-off
//     within ~1-2 weeks of cessation.
//   • STRENGTH (~14d): max strength maintains on remarkably little —
//     one quality session per week holds it for weeks (Bickel 2011;
//     Spiering 2021 review) — so past ~2 weeks untouched you're off
//     even the maintenance schedule and drifting toward detectable
//     loss at 3+.
//   • CONNECTIVE (~21d): tendon/structural adaptations build AND decay
//     slowest; pure-connective work tolerates the longest gaps.
//   • "restoration" exercises are excluded — nudging recovery work as
//     "at risk of detraining" would miss its point entirely.
//
// REGRESSION jumps the queue: an exercise whose logged performance
// (top done-set weight, or total done reps for weightless movements)
// has declined across its last three sessions is flagged regardless
// of staleness — it's telling you the current frequency isn't holding
// it. Two consecutive declines required; a single down session is
// noise (sleep, sequencing, life).
//
// Pure module, no React. Consumed by weeklyReview.gatherCheckInSignals.

import { workouts as SUPPORT_WORKOUTS, exercises as SUPPORT_EXERCISES } from "./supportTraining.js";
import { migrateExerciseId } from "./exerciseIds.js";
import { parseRepsCount } from "./workout-volume.js";

export const RISK_WINDOW_POWER_D      = 10;
export const RISK_WINDOW_STRENGTH_D   = 14;
export const RISK_WINDOW_CONNECTIVE_D = 21;

const DAY_MS = 86400 * 1000;
const dayNum = (ymd) => Math.round(new Date(`${ymd}T00:00:00Z`).getTime() / DAY_MS);

// Decay class from the exercise's own tags. Mixed strength+connective
// takes the strength window — the strength stimulus decays first.
export function decayWindowDays(exDef) {
  const tags = new Set(exDef?.tags || []);
  if (tags.has("power") || tags.has("explosive")) return RISK_WINDOW_POWER_D;
  if (tags.has("connective") && !tags.has("strength")) return RISK_WINDOW_CONNECTIVE_D;
  return RISK_WINDOW_STRENGTH_D;
}

// One session's performance value for an exercise: top done-set weight
// when the exercise logs weight and any was entered; otherwise total
// done reps (bilateral `reps` + unilateral leftReps/rightReps). Null
// when nothing was done.
export function sessionValue(exDef, ex) {
  const sets = Array.isArray(ex?.sets) ? ex.sets : [];
  let any = false, topW = 0, reps = 0;
  for (const t of sets) {
    if (!t || !t.done) continue;
    any = true;
    const w = Number(t.weight);
    if (w > 0 && w > topW) topW = w;
    reps += parseRepsCount(t.reps) + parseRepsCount(t.leftReps) + parseRepsCount(t.rightReps);
  }
  if (!any && ex?.done === true) return { metric: "done", value: 1 };  // simple done-toggle rows
  if (!any) return null;
  return exDef?.logWeight && topW > 0
    ? { metric: "weight", value: topW }
    : { metric: "reps", value: reps };
}

// All exercises that appear in the A/B/C workout defs, minus
// restoration work. Never-logged exercises are skipped — you can't
// "go cold" on something that was never warm, and the check-in
// shouldn't manufacture obligations.
function abcExerciseDefs() {
  const out = new Map();
  for (const wk of ["A", "B", "C"]) {
    for (const def of SUPPORT_WORKOUTS[wk]?.exercises || []) {
      if (!def || (def.tags || []).includes("restoration")) continue;
      out.set(def.id, def);
    }
  }
  return out;
}

// Rank support exercises by risk as of refDate.
// Returns [{ id, name, daysSince, windowDays, ratio, regressing }],
// highest urgency first, filtered to ratio ≥ 1 OR regressing.
// Regressing exercises sort strictly FIRST (a measured decline is
// direct evidence the current frequency isn't holding it — stronger
// than any staleness inference); within each group, overdue ratio.
export function exerciseSupportRisk(workoutSessions = [], refDate) {
  if (!refDate) return [];
  const defs = abcExerciseDefs();
  // exId → [{date, metric, value}] across ALL sessions (any A/B/C label —
  // piecemeal elements count; that's the whole point).
  const series = new Map();
  for (const w of workoutSessions || []) {
    if (!w || !w.date || w.date > refDate) continue;
    for (const [rawId, ex] of Object.entries(w.exercises || {})) {
      const id = migrateExerciseId(rawId);
      const def = defs.get(id);
      if (!def) continue;
      const v = sessionValue(def, ex);
      if (!v) continue;
      if (!series.has(id)) series.set(id, []);
      series.get(id).push({ date: w.date, ...v });
    }
  }
  const out = [];
  for (const [id, rows] of series) {
    rows.sort((a, b) => a.date.localeCompare(b.date));
    const def = defs.get(id);
    const last = rows[rows.length - 1];
    const daysSince = dayNum(refDate) - dayNum(last.date);
    const windowDays = decayWindowDays(def);
    const ratio = daysSince / windowDays;
    // Regression: strictly declining across the last three sessions of
    // the SAME metric ("done" toggles carry no trend information).
    let regressing = false;
    const metric = last.metric;
    if (metric !== "done") {
      const vals = rows.filter(r => r.metric === metric).map(r => r.value);
      const n = vals.length;
      if (n >= 3 && vals[n - 1] < vals[n - 2] && vals[n - 2] < vals[n - 3]) regressing = true;
    }
    if (ratio >= 1 || regressing) {
      out.push({ id, name: def.name || id, daysSince, windowDays, ratio, regressing });
    }
  }
  out.sort((a, b) => (Number(b.regressing) - Number(a.regressing)) || (b.ratio - a.ratio));
  return out;
}
