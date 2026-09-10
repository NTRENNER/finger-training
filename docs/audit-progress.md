# Audit follow-up status

Included in this release: target-force failure detection; measured force evidence including sustained overshoot and variable pulls; actual-rest recording; recovery comparisons using consecutive comparable opening reps and measured intervals; interruption exclusion from peak records; provenance labels and exclusion of new estimated loads from capacity evidence.

Validation: automated model, sensor-hook, recording, persistence and UI checks; production and offline-shell build. No physical sensor trial yet. The database migration was applied on September 10, 2026 before publishing this client.

Follow-up implemented: stale-grip deload filtering, neutral insufficient-evidence state, local concern for single-grip decline, revisable historical-best floors, and deterministic timestamp-based anchor/recovery ordering. This follow-up is included in the September 10, 2026 release. Validation: 902 passing tests plus production and offline builds.

Deload comparisons require the full recent scoring window for each participating grip to fall within 14 days. Old grips cannot veto current systemic concern. Missing evidence does not imply readiness. One measured grip supports an observed/local assessment, not a systemic fatigue conclusion.

The capacity floor retains its 90-day best reference unless three later independent valid measured opening efforts, all within 30 days, are more than 10% lower at comparable durations (80–125% of the best hold, still at least the requested duration) and matching recorded setup. Then the highest of those three becomes the working floor. These are conservative engineering defaults. Best-ever records and curve anti-collapse protection remain intact. Equipment matching is limited by available setup metadata.

Same-day sessions use date, session start timestamp (creation timestamp fallback), then stable identifiers. The actual first-set opening rep supplies the anchor. Unknown historical ordering has a deterministic fallback rather than an invented time.

Remaining audit work: schedule-aware deload plans, broader calibration and longitudinal validation, recommendation-purpose labels, between-session readiness assumptions, session-based confidence and benchmarks. No protocol, ladder, or zone-name changes.
