// ─────────────────────────────────────────────────────────────
// READINESS / RECOVERY MODEL — REMOVED
// ─────────────────────────────────────────────────────────────
// This module previously exported a computeReadiness(history)
// helper that returned a 1-10 fatigue score from a 24h-decay
// model over recent training load. It was used in two places:
//
//   1. As a UI display on the Setup tab (the "readiness" pill).
//   2. As a multiplier inside the coaching engine via
//      intensityMatch(zone, readiness) → [0.5, 1.0].
//
// Both call sites were removed. The display read as a number
// users couldn't act on, and the coaching multiplier was small
// relative to the gap/residual/focus factors that actually
// drive recommendations. The coaching engine now uses its
// default readiness=5 (neutral). The intensityMatch helper
// in src/model/coaching.js is kept for any future reintroduction.
//
// File retained only because the underlying filesystem doesn't
// permit deletes from this environment; it has no imports and
// no exports.
