# Fatigue rating and load choice

The cookedness slider records the athlete's report. For a nonzero rating, the planner offers two buttons:

- **Keep recommended load** (default): record the rating with no load reduction.
- **Adjust load accordingly**: reduce all displayed and prescribed loads by 2.5% per rating point, capped at 25%. Show the reduction before the athlete starts.

The runner saves `session_adjustment` with `reported_cooked`, `load_choice` (`keep` or `adjust`), and `applied_multiplier`. This version-1 JSON snapshot is fixed at session start. The existing JSON database field carries the choice; no migration is needed.

As of October 1, capacity fits and progress estimates use measured force without dividing it by the chosen load multiplier. Choosing a 20% reduction does not establish a measured 20% loss of capacity. The immutable choice is context and prescription provenance, not a physiological correction.

A reduced-load session cannot earn a higher fresh-load ladder rung. New ordinary sessions freeze their pre-adjustment base plan in `force_recording.session_prescription`. That known base plan can be restored at the same attempted rung; this is a return to a prior prescription, not a new capacity gain. Without that snapshot, retain actual measured load conservatively. Within-set recovery estimates remain separate from the chosen pre-session discount.

History rating edits preserve the existing adjustment. For legacy reps without a snapshot, the first edit preserves the interpretation already in use and labels its source as `legacy_session_estimate` or `unrecorded_adjustment`. This preserves the historical choice interpretation without claiming the old device recorded an adjustment or inflating the measured force. Each rep's rating and snapshot are queued together for offline sync. Clearing the rating also preserves the adjustment.

No historical data is rewritten when the app updates. Only an explicit rating edit saves a legacy snapshot.

Regression coverage checks the planner preview, session start and persistence, immutable choices, legacy edits and clears, offline replay, progression loads, and progress estimates. The displayed reduction rate is unchanged. Previously saved measurements and snapshots are not rewritten; new calculations use the corrected observation semantics.
