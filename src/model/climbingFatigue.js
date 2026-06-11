// ─────────────────────────────────────────────────────────────
// CLIMBING SESSION FATIGUE
// ─────────────────────────────────────────────────────────────
// Aggregates a climbing day's per-climb RPEs into a single session-
// fatigue scalar (1-10). The number answers "how systemically cooked
// were you after climbing that day," which is the right input for
// scaling finger-training prescriptions the next day — distinct from
// per-climb RPE, which is the difficulty of that one route.
//
// Why we need both: one 5.13a attempt at RPE 9 (single max effort,
// minutes of wall time) leaves you fresher than eight 5.12a's at RPE 7
// (an hour of sustained moderate-high pulling). Same peak RPE, very
// different systemic fatigue. Per-climb RPE measures route difficulty;
// session fatigue measures cumulative load.
//
// Formula:
//   fatigue = clamp(1, 10, round( Σ(RPE_i) × 0.12 + max(RPE_i) × 0.4 ))
//
// The Σ term captures volume (more climbs = more fatigue); the max
// term gives some weight to peak intensity (one all-out attempt does
// tax you). Coefficients were tuned to produce intuitive scores:
//   - 1× RPE 9 alone           → 5  (single max attempt)
//   - 8× RPE 7                 → 10 (volume slogfest)
//   - 4× RPE 8                 → 7  (moderate session)
//   - Yesterday's 9 mixed climbs (sum 63, max 9) → 10 (cooked)
//
// Returns null if there are no climbs on the date (no session = no
// fatigue signal). Caller treats null as "no climbing fatigue input."
//
// Phase A: derived only. Phase B will add an optional `session_rpe`
// column to the activities table so the user can confirm/override
// the derived value at session-end. Until then the formula is the
// single source of truth.

// Numeric RPE on each activity row. Skips rows with no usable rpe.
function rpesForDate(activities, dateStr) {
  if (!activities || !dateStr) return [];
  const out = [];
  for (const a of activities) {
    if (!a || a.type !== "climbing") continue;
    if (a.date !== dateStr) continue;
    const r = Number(a.rpe);
    if (Number.isFinite(r) && r >= 1 && r <= 10) out.push(r);
  }
  return out;
}

// Compute session fatigue 1-10 (or null) for a specific date.
// If a row has an explicit `session_rpe` field (Phase B), use that
// directly instead of deriving — same field will be carried on every
// climb row in a session.
export function computeSessionFatigue(activities, dateStr) {
  if (!activities || !dateStr) return null;
  // Phase B override: prefer explicit session_rpe if present on any
  // row for that date. All rows in a session share the value.
  for (const a of activities) {
    if (a?.type !== "climbing") continue;
    if (a.date !== dateStr) continue;
    const sr = Number(a.session_rpe);
    if (Number.isFinite(sr) && sr >= 1 && sr <= 10) return Math.round(sr);
  }
  const rpes = rpesForDate(activities, dateStr);
  if (rpes.length === 0) return null;
  const sum = rpes.reduce((acc, x) => acc + x, 0);
  const peak = Math.max(...rpes);
  const raw = sum * 0.12 + peak * 0.4;
  return Math.max(1, Math.min(10, Math.round(raw)));
}

// ── Climb-derived cookedness suggestion ──────────────────────
// The cookedness slider is only as good as the user's self-rating,
// and the June 2026 review showed those ratings can invert reality:
// cooked = 0 logged on a triple-climbing-day with same-day V8
// attempts, cooked = 5 on a lighter day. Since the climb log already
// carries the ground truth (per-climb RPE + volume), derive a
// suggested cooked value from it and PRE-FILL the slider — the user
// confirms or overrides, so the β-learner's input semantics don't
// change, but the default is now evidence-based instead of 0.
//
// Formula: today's session fatigue (computeSessionFatigue, 1–10)
// plus a 40%-decayed carryover of yesterday's. Day-level resolution
// because activities carry no timestamps; the 0.4 carryover matches
// the spirit of fatigueToModifier's 48h linear decay (~half left a
// day later) without claiming hour precision.
//
// Returns { cooked, todayFatigue, yesterdayFatigue, nClimbsToday }
// or null when neither day has any logged climbs (no signal — leave
// the slider alone rather than suggesting a fabricated 0).
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
  const todayFatigue = computeSessionFatigue(activities, dateStr);
  const yDate = prevDateStr(dateStr);
  const yesterdayFatigue = yDate ? computeSessionFatigue(activities, yDate) : null;
  if (todayFatigue == null && yesterdayFatigue == null) return null;
  const raw = (todayFatigue ?? 0) + YESTERDAY_CARRYOVER * (yesterdayFatigue ?? 0);
  const cooked = Math.max(0, Math.min(10, Math.round(raw)));
  const nClimbsToday = activities.filter(
    a => a?.type === "climbing" && a.date === dateStr
  ).length;
  return { cooked, todayFatigue, yesterdayFatigue, nClimbsToday };
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

// Map a session fatigue score and zone to a load-modifier multiplier.
// 1.0 = no impact; <1.0 = scale prescription down. Slope is steeper
// for short-T near-MVC zones (more sensitive to acute systemic
// fatigue) than for long-T sustained zones (which tolerate stacked
// load better).
//
//   fatigue 1-3 (warmup day)       → ~no impact (0.95 - 1.0)
//   fatigue 4-6 (moderate session) → 0.80 - 0.95 depending on zone
//   fatigue 7-9 (hard session)     → 0.55 - 0.85 depending on zone
//   fatigue 10  (cooked)           → 0.40 - 0.75 depending on zone
//
// Also factors in hours-ago — fatigue decays linearly over 48h. A
// fatigue 10 session 36 hours ago is treated as fatigue 10 × 0.25
// remaining = effective fatigue 2.5.
export function fatigueToModifier(zone, fatigue, hoursAgo) {
  if (fatigue == null || !Number.isFinite(fatigue)) return 1.0;
  if (!Number.isFinite(hoursAgo) || hoursAgo > 48 || hoursAgo < 0) return 1.0;
  // Decay: fully present at 0h, fully gone at 48h.
  const present = Math.max(0, 1 - hoursAgo / 48);
  const effective = fatigue * present;  // in [0, 10]
  // Zone sensitivity: how much a fatigue-10 day suppresses this zone.
  const fullSuppression =
      zone === "max_strength"        ? 0.60
    : zone === "power"               ? 0.55
    : zone === "power_strength"      ? 0.45
    : zone === "strength"            ? 0.35
    : zone === "strength_endurance"  ? 0.25
    :                                  0.15;  // endurance
  // Linear blend from 1.0 (effective=0) to (1 - fullSuppression) (effective=10).
  return 1.0 - (effective / 10) * fullSuppression;
}
