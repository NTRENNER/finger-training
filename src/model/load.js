// ─────────────────────────────────────────────────────────────
// LOAD EXTRACTION HELPERS
// ─────────────────────────────────────────────────────────────
// Single source of truth for pulling a usable kg load value off a rep
// record. Lives in its own dependency-free leaf module (no imports)
// so EVERY layer can use it without circular-import problems — in
// particular threeExp.js (which prescription.js imports, so threeExp
// cannot import back from prescription). prescription.js re-exports
// these for backward compatibility with existing call sites.
//
// Schema split (May 2026): the legacy `weight_kg` field used to be
// overloaded — written as "what the program prescribed", read as
// "what actually happened". It's now split into:
//   - prescribed_load_kg → what the program suggested (set on every write)
//   - manual_load_kg     → user-entered actual load for non-Tindeq sessions
//   - avg_force_kg       → Tindeq-measured actual average (preferred when present)
//   - weight_kg          → LEGACY tail; unsynced offline reps + safety net
//
// The fallback chain encodes "what actually happened" in priority order:
//   Tindeq measurement > user manual override > prescribed value > legacy

// Physical ceiling for a finger force/load (kg). No isometric finger
// hold or prescribed load approaches this — anything at/above is
// corrupt data (a Tindeq/units glitch), so sane() rejects it. This
// guards every downstream consumer (fits, ladder, peak, prescription)
// from garbage. Was 500 until June 2026, which let a 284 kg glitch
// slip through; the strongest real pull on record is ~77 kg.
export const SANE_MAX_KG = 200;

export function sane(v) {
  const n = Number(v);
  return n > 0 && n < SANE_MAX_KG ? n : null;
}

// Pull the prescribed value with legacy fallback. Helper so callers
// that explicitly want "what the program suggested" (separate from
// "what actually happened") stay readable.
export function prescribedLoad(r) {
  return sane(r.prescribed_load_kg) ?? sane(r.weight_kg) ?? 0;
}

// Effective load for a rep — "what actually happened" in priority order:
//   avg_force_kg (Tindeq actual)
//     ?? manual_load_kg (user entry, non-Tindeq sessions)
//     ?? prescribed_load_kg (program suggestion, best-guess)
//     ?? weight_kg (legacy fallback for unmigrated rows)
// Used for CURVE FITTING and all baseline/prior/AUC analysis — the
// F-D curve is shaped by actual force delivered, so Tindeq wins, then
// a manual override, then the prescribed value as a best-guess when
// neither is available. Filtering or fitting on raw avg_force_kg
// silently drops manual (non-Tindeq) reps; always go through this.
export function effectiveLoad(r) {
  return sane(r.avg_force_kg)
      ?? sane(r.manual_load_kg)
      ?? sane(r.prescribed_load_kg)
      ?? sane(r.weight_kg)
      ?? 0;
}

// Prescribable load — what the user should aim to produce next
// session. For Tindeq-isometric setups (spring/anchor, no pin),
// avg_force_kg IS the actual load delivered, AND it's what the
// prescription should be in. Kept distinct from effectiveLoad so the
// semantic is named — when we add weighted-rep support (hangboard
// with pulley + weight pin + inline Tindeq), this is what flips to
// prefer prescribed_load_kg. Same fallback shape as effectiveLoad.
export function loadedWeight(r) {
  return sane(r.avg_force_kg)
      ?? sane(r.manual_load_kg)
      ?? sane(r.prescribed_load_kg)
      ?? sane(r.weight_kg)
      ?? 0;
}

// Reps suitable for CURVE FITTING — fresh + de-duplicated (May 2026).
//
//  - rep_num === 1 (or null for legacy/manual rows): only the fresh
//    first rep of each set. Later within-set reps are fatigued and fail
//    at shorter durations; they drag the fitted curve — and especially a
//    small BASELINE window — downward, inflating and de-symmetrizing the
//    improvement %. Matches the coverage rep-1-only fix and the limiter.
//  - content de-dup: some early sessions were double-logged (identical
//    rows). Collapse exact-duplicate content (NOT by id — duplicates are
//    distinct rows with the same content). The key includes set_num and
//    manual_load_kg (July 2026): without them, two REAL rep-1s from
//    different sets/sessions on the same day with equal target/actual
//    and null avg_force_kg — typical manual-timer entries — collapsed
//    to one point even when their manual loads differed, thinning
//    exactly the small baseline windows this function protects. The
//    double-logging bug produced fully identical rows, so the stricter
//    key still catches those.
//
// Lives in this leaf module so EVERY fit path can share it — the prior
// (threeExp.buildThreeExpPriors), the baselines/estimates (baselines.js),
// AND the Force Curves overlay (useHistoryOverlay) — so they all fit the
// same data and can't disagree. (The coaching engine uses freshMap-
// adjusted loads, a different but compatible de-fatigue.)
export function freshFitReps(history) {
  const seen = new Set();
  const out = [];
  for (const r of history || []) {
    if (!r) continue;
    if (!(r.rep_num == null || r.rep_num === 1)) continue;
    const key = `${r.date}|${r.hand}|${r.grip}|${r.set_num}|${r.target_duration}|${r.actual_time_s}|${r.avg_force_kg}|${r.manual_load_kg}|${r.rep_num}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
