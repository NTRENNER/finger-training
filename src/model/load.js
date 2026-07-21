// ──────────────────────────────────────────────────────────────
// LOAD EXTRACTION HELPERS
// ──────────────────────────────────────────────────────────────
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
    // Seed-artifact guard (July 2026, see isSeedArtifactRep below): an
    // avg==peak seeded/backfilled twin is not a real measurement, and
    // this function is the shared fit basis (priors, baselines, refit,
    // overlay, AUC history, endurance ceiling) — one inflated fake
    // point here poisons every fit at once. prescription.js guards its
    // own paths the same way.
    if (isSeedArtifactRep(r)) continue;
    const key = `${r.date}|${r.hand}|${r.grip}|${r.set_num}|${r.target_duration}|${r.actual_time_s}|${r.avg_force_kg}|${r.manual_load_kg}|${r.rep_num}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

// Data-integrity guard (July 2026). A hand-seeded / backfilled rep can
// carry a single intended load value mirrored into BOTH avg_force_kg and
// peak_force_kg (that's the signature of the corrupt "andr0520" Micro
// session — a manual twin of a real Tindeq session, logged at ~2x the
// true load). A genuinely MEASURED hold always has peak strictly above
// average — the force ramps and decays, so the mean is below the peak.
// So avg==peak (both finite, positive) means "not a real measurement" —
// exclude it from anything that reads capacity off a single rep (the
// demonstrated-capacity floor, the amplitude anchor, the curve-fit
// points), where one inflated point can dominate. Manual reps
// (avg_force_kg null, load in manual_load_kg) are NOT flagged — null is
// not a finite peak — so genuine manual endurance entries still count.
export function isSeedArtifactRep(r) {
  if (!r) return false;
  const a = Number(r.avg_force_kg);
  const p = Number(r.peak_force_kg);
  return Number.isFinite(a) && Number.isFinite(p) && a > 0 && p > 0
    && Math.abs(a - p) < 1e-6;
}

// A rep whose load was actually MEASURED (Tindeq average force present),
// as opposed to a manual/spring entry where the recorded load is a nominal
// setting the user pulls AGAINST — and, with a spring, deliberately
// over-pulls (see the spring-overpull note). effectiveLoad happily falls
// back to manual_load_kg / prescribed_load_kg, which is right for curve
// FITTING (a best-guess data point is better than none), but WRONG for any
// claim that a specific *sustained force* was demonstrated. The
// demonstrated-capacity FLOOR makes exactly that claim ("you held F kg for
// >= T seconds, so never prescribe below F"), so it must count measured
// reps only — otherwise a spring session logged as "9.1 kg for 258 s"
// pins an endurance floor at a force that was never actually sustained.
// July 2026: this is why a 160 s Micro target was floored at 9.1 kg when
// the genuine measured capacity was ~6-7 kg.
export function isMeasuredLoadRep(r) {
  return sane(r?.avg_force_kg) != null;
}
