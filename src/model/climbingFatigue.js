// ─────────────────────────────────────────────────────────────
// CLIMBING SESSION FATIGUE
// ─────────────────────────────────────────────────────────────
// Aggregates a climbing day's logged efforts into a single session-
// fatigue scalar (1-10): "how systemically cooked were you after
// climbing that day," which is distinct from per-climb RPE, which is
// the difficulty of that one route.
//
// Why we need both: one 5.13a attempt at RPE 9 (single max effort,
// minutes of wall time) leaves you fresher than eight 5.12a's at RPE 7
// (an hour of sustained moderate-high pulling). Same peak RPE, very
// different systemic fatigue. Per-climb RPE measures route difficulty;
// session fatigue measures cumulative load.
//
// ── September 2026 rewrite ───────────────────────────────────
// The previous formula was `clamp(1, 10, round(Σ·0.12 + max·0.4))`,
// counting one unit of volume per LOGGED ROW. Replaying the real log
// showed two defects that compounded:
//
//   1. It saturated. Any day past a weighted RPE sum of ~50 clamped to
//      10, so 50 of 69 logged climbing days — 72% — scored exactly 10.
//      A 15-climb day and a 45-climb day were indistinguishable, which
//      makes the number nearly constant on the days it is asked about.
//
//   2. Rows are not efforts. A projecting session — eight burns on one
//      boulder, sent on the eighth — is ONE row, so it landed in the
//      un-saturated minority at 5-7 while a twenty-climb lap day scored
//      10. The scale was ordered backwards exactly in the tail that
//      matters most, because the hardest sessions are the ones with the
//      fewest rows per unit of work.
//
// Both are fixed here. Volume counts `attempts` (one row can now record
// eight burns — see the activities.attempts column added the same day),
// and the linear sum passes through a concave saturating map that is
// strictly increasing everywhere, so more work always scores higher:
//
//   effort_i = rpe_i × board_factor_i        per-attempt intensity
//   volume   = Σ_i attempts_i × effort_i
//   peak     = max_i effort_i
//   raw      = VOLUME_COEF·volume + PEAK_COEF·peak
//   score    = 10 × (1 − exp(−raw / SATURATION_K))
//
// The Σ term captures volume (more pulling = more fatigue); the peak
// term gives weight to intensity (one all-out attempt does tax you).
// SATURATION_K is set so the old "1 × RPE 9 alone → 5" anchor is
// preserved exactly, while the ceiling is reserved for genuinely
// exceptional days:
//
//   - 1× RPE 9 alone                      → 5   (single max attempt)
//   - 8× RPE 7 (eight separate climbs)    → 8   (was 10: see below)
//   - 1× V7 at RPE 8 over 8 attempts,
//     plus 2 warm-ups at RPE 5            → 9   (was 6 — the inversion)
//   - 20-climb gym day, sum 100, peak 8   → 9
//   - 45-climb outdoor day, sum 258       → 10  (was tied with the above)
//
// The "8× RPE 7 → 10" anchor deliberately moved to 8. Under the old
// clamp it shared the ceiling with days carrying three times the work;
// 9 and 10 now mean something.
//
// Returns null if there are no usable efforts on the date (no session =
// no fatigue signal). Caller treats null as "no climbing fatigue input."
//
// WHAT THIS NUMBER IS FOR: the climb log's own display and the deload
// detector. It is deliberately NOT an input to load prescription. See
// cookedScaling.js for why that loop was opened.

// Board-wall tax (June 2026): MoonBoard / Kilter climbing is more
// finger-taxing per climb than a commercial set at the same RPE —
// RPE measures whole-effort, but board style loads the fingers
// disproportionately (small holds, full crimp, no rests). A "short
// but fierce" board session was scoring like a casual gym hour and
// under-suggesting cookedness. Each board climb's RPE is multiplied
// by this factor in both the volume and peak terms before the
// session-fatigue aggregation.
export const BOARD_WALL_KEYS = new Set(["moonboard", "kilter"]);
export const BOARD_WALL_FACTOR = 1.3;

export const FATIGUE_VOLUME_COEF = 0.12;
export const FATIGUE_PEAK_COEF   = 0.4;
// raw → score curve constant. 6 reproduces the historical "1× RPE 9
// → 5" calibration point and puts "8× RPE 7" at 8. Changing it
// rescales every score; it does not change their ORDER, which is the
// property the rewrite exists to guarantee.
export const FATIGUE_SATURATION_K = 6;

// Attempts recorded on one logged climb. Absent (every row written
// before the column existed) means one — which is what the old
// row-counting formula assumed, so history keeps its meaning.
// Non-integer, zero, negative and absurd values fall back to 1 rather
// than letting a typo dominate a session's volume term.
export const MAX_ATTEMPTS_PER_CLIMB = 99;
export function attemptsOf(activity) {
  const n = Number(activity?.attempts);
  if (!Number.isFinite(n)) return 1;
  const i = Math.round(n);
  if (i < 1) return 1;
  return Math.min(i, MAX_ATTEMPTS_PER_CLIMB);
}

// Per-attempt weighted efforts on the date: rpe × (board tax when the
// wall is a board), paired with how many times that effort was made.
// Skips rows with no usable rpe.
function weightedEffortsForDate(activities, dateStr) {
  if (!activities || !dateStr) return [];
  const out = [];
  for (const a of activities) {
    if (!a || a.type !== "climbing") continue;
    if (a.date !== dateStr) continue;
    const r = Number(a.rpe);
    if (!(Number.isFinite(r) && r >= 1 && r <= 10)) continue;
    out.push({
      effort: BOARD_WALL_KEYS.has(a.wall) ? r * BOARD_WALL_FACTOR : r,
      attempts: attemptsOf(a),
    });
  }
  return out;
}

// Full detail behind a date's session fatigue. `score` is the rounded
// 1-10 user-facing scale; `scoreExact` is the same quantity before
// rounding and is what callers should use for ORDERING two days,
// since the integer scale necessarily ties at the top.
//
// An explicit `session_rpe` on any row for the date (the user rating
// the whole session) overrides the derivation — that is a self-report
// and outranks an inference. It is NOT board-taxed: the user already
// rated the session as a whole.
export function sessionFatigueDetail(activities, dateStr) {
  if (!activities || !dateStr) return null;

  for (const a of activities) {
    if (a?.type !== "climbing") continue;
    if (a.date !== dateStr) continue;
    const sr = Number(a.session_rpe);
    if (Number.isFinite(sr) && sr >= 1 && sr <= 10) {
      const score = Math.max(1, Math.min(10, Math.round(sr)));
      return { score, scoreExact: score, volume: null, peak: null, raw: null,
        nClimbs: null, nAttempts: null, source: "session_rpe" };
    }
  }

  const efforts = weightedEffortsForDate(activities, dateStr);
  if (efforts.length === 0) return null;

  const volume = efforts.reduce((acc, e) => acc + e.attempts * e.effort, 0);
  const peak = Math.max(...efforts.map(e => e.effort));
  const raw = FATIGUE_VOLUME_COEF * volume + FATIGUE_PEAK_COEF * peak;
  const scoreExact = 10 * (1 - Math.exp(-raw / FATIGUE_SATURATION_K));

  return {
    score: Math.max(1, Math.min(10, Math.round(scoreExact))),
    scoreExact,
    volume,
    peak,
    raw,
    nClimbs: efforts.length,
    nAttempts: efforts.reduce((acc, e) => acc + e.attempts, 0),
    source: "derived",
  };
}

// Compute session fatigue 1-10 (or null) for a specific date.
export function computeSessionFatigue(activities, dateStr) {
  return sessionFatigueDetail(activities, dateStr)?.score ?? null;
}

// ── Climb-derived cookedness suggestion ──────────────────────
// The climb log carries evidence about how hard a day was — per-climb
// RPE, attempt counts, volume — so it can offer the user a starting
// point for the cookedness slider rather than making them guess from
// a cold 0.
//
// It is a SUGGESTION and nothing more. It is shown next to the slider
// and applied only when the user taps it; it is never written to
// reps.session_cooked on its own, because a number the app inferred
// is not a number the athlete reported, and storing one as the other
// silently poisons the only field that could carry real information
// about perceived fatigue. (September 2026 — this function used to
// pre-fill the slider on mount, and that fill was persisted as a
// self-report. See SessionPlanCard.)
//
// Formula: today's session fatigue plus a 40%-decayed carryover of
// yesterday's. Day-level resolution because activities carry no
// timestamps; the 0.4 carryover assumes roughly half is gone a day
// later without claiming hour precision.
//
// Returns { cooked, todayFatigue, yesterdayFatigue, nClimbsToday,
// nAttemptsToday } or null when neither day has any logged climbs
// (no signal — offer nothing rather than a fabricated 0).
const YESTERDAY_CARRYOVER = 0.4;

function prevDateStr(dateStr) {
  // Noon anchor avoids DST-boundary off-by-one when subtracting a day.
  const d = new Date(`${dateStr}T12:00:00`);
  if (isNaN(d.getTime())) return null;
  d.setDate(d.getDate() - 1);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function suggestCookedFromClimbs(activities, dateStr) {
  if (!activities || !dateStr) return null;
  const todayDetail = sessionFatigueDetail(activities, dateStr);
  const yDate = prevDateStr(dateStr);
  const yesterdayFatigue = yDate ? computeSessionFatigue(activities, yDate) : null;
  const todayFatigue = todayDetail?.score ?? null;
  if (todayFatigue == null && yesterdayFatigue == null) return null;
  // Order on the unrounded score where we have it, so two days that
  // both display 10 don't collapse to the same suggestion.
  const rawToday = todayDetail?.scoreExact ?? todayFatigue ?? 0;
  const raw = rawToday + YESTERDAY_CARRYOVER * (yesterdayFatigue ?? 0);
  const cooked = Math.max(0, Math.min(10, Math.round(raw)));
  return {
    cooked,
    todayFatigue,
    yesterdayFatigue,
    nClimbsToday: todayDetail?.nClimbs ?? 0,
    nAttemptsToday: todayDetail?.nAttempts ?? 0,
  };
}

// Most recent climbing date in the past `withinDays` days, or null.
// Used by the ClimbingLogCard display to surface recent session
// fatigue. (No longer consumed by the coaching engine — the
// externalLoadModifier term was removed May 2026.)
export function mostRecentClimbDate(activities, today = new Date(), withinDays = 3) {
  if (!activities || activities.length === 0) return null;
  const todayMs = today instanceof Date ? today.getTime() : Date.parse(today);
  const cutoffMs = todayMs - withinDays * 24 * 60 * 60 * 1000;
  let best = null;
  let bestMs = -Infinity;
  for (const a of activities) {
    if (a?.type !== "climbing") continue;
    if (!a.date) continue;
    const ms = Date.parse(a.date);
    if (!Number.isFinite(ms)) continue;
    if (ms < cutoffMs || ms > todayMs) continue;
    if (ms > bestMs) {
      bestMs = ms;
      best = a.date;
    }
  }
  return best;
}

// `fatigueToModifier` lived here until September 2026: a zone-sensitive
// map from climbing fatigue to a load multiplier, with a 48-hour linear
// decay. Its only caller — the coaching engine's externalLoadModifier
// term — was removed in May 2026, and the September review decided
// against reinstating any open-loop fatigue-to-load path at all (see
// cookedScaling.js). It is deleted rather than left dormant: a scaler
// with no caller and no test of its effect on real prescriptions is a
// loaded gun, which is exactly how the β learner got to where it did.
