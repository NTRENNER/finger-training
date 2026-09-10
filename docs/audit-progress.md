# Audit follow-up status

Included in this release: target-force failure detection; measured force evidence including sustained overshoot and variable pulls; actual-rest recording; recovery comparisons using consecutive comparable opening reps and measured intervals; interruption exclusion from peak records; provenance labels and exclusion of new estimated loads from capacity evidence.

Validation: automated model, sensor-hook, recording, persistence and UI checks; production and offline-shell build. No physical sensor trial yet. The database migration was applied on September 10, 2026 before publishing this client.

Follow-up implemented: stale-grip deload filtering, neutral insufficient-evidence state, local concern for single-grip decline, revisable historical-best floors, and deterministic timestamp-based anchor/recovery ordering. This follow-up is included in the September 10, 2026 release. Validation: 902 passing tests plus production and offline builds.

Deload comparisons require the full recent scoring window for each participating grip to fall within 14 days. Old grips cannot veto current systemic concern. Missing evidence does not imply readiness. One measured grip supports an observed/local assessment, not a systemic fatigue conclusion.

The capacity floor retains its 90-day best reference unless three later independent valid measured opening efforts, all within 30 days, are more than 10% lower at comparable durations (80–125% of the best hold, still at least the requested duration) and matching recorded setup. Then the highest of those three becomes the working floor. These are conservative engineering defaults. Best-ever records and curve anti-collapse protection remain intact. Equipment matching is limited by available setup metadata.

Same-day sessions use date, session start timestamp (creation timestamp fallback), then stable identifiers. The actual first-set opening rep supplies the anchor. Unknown historical ordering has a deterministic fallback rather than an invented time.

Remaining audit work: schedule-aware deload plans, broader calibration and longitudinal validation, recommendation-purpose labels, between-session readiness assumptions, session-based confidence and benchmarks. No protocol, ladder, or zone-name changes.

Recommendation purpose and measured progress are now included in this release. See `docs/measured-progress.md` for comparison rules and limitations. This provides descriptive progress tracking; prospective policy evaluation and session-based model confidence remain unfinished.

Within-set recovery is now separated from calendar-recency scoring in this release. Personalized recovery still drives rep forecasts, but no longer stretches the days-long recommendation penalty. An expandable setup note describes comparable opener trends separately from repeated-effort trends, with cookedness retained as the current load adjustment. Fixed zone-recency/cost assumptions remain heuristics; this does not add a validated readiness estimator. Validation: 914 tests passed, 3 external-data tests skipped.

Zone-boundary smoothing and independent-session confidence are included in this release. Calendar-recency and cost constants interpolate in log duration through the unchanged zone reference values. Each session contributes its strongest duration-local observation to confidence (at most one), with a 90-day recency half-life and reduced weight for legacy provenance. Every usable rep remains in fitting and residual calculations. Missing session IDs fall back to date. Confidence is a heuristic evidence weight, not a calibrated probability. Zone names, reference durations and ladder rules remain unchanged. Categorical coverage/goal rules may still change the chosen zone; this resolves the recency/cost boundary discontinuity, not every discrete selection rule. Session-held-out model validation remains future work.

Release verification: all pending purpose/progress, recovery separation, zone smoothing, and independent-session confidence changes included. 918 tests passed; production and offline builds passed.
