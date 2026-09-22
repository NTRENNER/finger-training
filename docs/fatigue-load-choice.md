# Fatigue rating and load choice

The cookedness slider records the athlete's report. For a nonzero rating, the planner offers two buttons:

- **Keep recommended load** (default): record the rating with no load reduction.
- **Adjust load accordingly**: reduce all displayed and prescribed loads by 2.5% per rating point, capped at 25%. Show the reduction before the athlete starts.

The runner saves `session_adjustment` with `reported_cooked`, `load_choice` (`keep` or `adjust`), and `applied_multiplier`. This version-1 JSON snapshot is fixed at session start. The existing JSON database field carries the choice; no migration is needed.

Capacity fitting, progression loads, and fresh-equivalent progress estimates use the saved multiplier, not a later rating. In particular, rating 8 with keep-load saves multiplier 1; it must not increase the measured capacity by 25%.

History rating edits preserve the existing adjustment. For legacy reps without a snapshot, the first edit preserves the interpretation already in use and labels its source as `legacy_session_estimate` or `unrecorded_adjustment`. This preserves historical estimates without claiming the old device recorded an adjustment. Each rep's rating and snapshot are queued together for offline sync. Clearing the rating also preserves the adjustment.

No historical data is rewritten when the app updates. Only an explicit rating edit saves a legacy snapshot.

Regression coverage checks the planner preview, session start and persistence, immutable choices, legacy edits and clears, offline replay, progression loads, and progress estimates. The existing adjustment model for athletes who choose a reduced load is unchanged.
