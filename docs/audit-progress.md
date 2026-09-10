# Audit follow-up status

Included in this release: target-force failure detection; measured force evidence including sustained overshoot and variable pulls; actual-rest recording; recovery comparisons using consecutive comparable opening reps and measured intervals; interruption exclusion from peak records; provenance labels and exclusion of new estimated loads from capacity evidence.

Validation: automated model, sensor-hook, recording, persistence and UI checks; production and offline-shell build. No physical sensor trial yet. The database migration was applied on September 10, 2026 before publishing this client.

Remaining audit work: stale-grip deload behavior, revisable historical-best floors, deterministic same-day ordering, broader calibration and longitudinal validation. Existing deload behavior is not claimed fixed by stricter recovery eligibility.
