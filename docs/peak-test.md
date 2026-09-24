# Peak Test in warmup and training

The planner shows five routine training domains in full-width stacked rows.
Optional Peak Test lives in warmup rather than a sixth training tile.
For a grip that still needs its initial upper measurement, the coach can
recommend a Peak Test directly; this preserves the initial calibration path. Max remains in
six-domain analysis and historical records. The 4–5–6 ladder is unchanged.

Peak Test now measures brief maximal force: three 3-second pulls per hand,
alternating hands, with 60 seconds after each completed round except the last.
There is no target load or requirement to reach failure. Build force smoothly,
pull hard, then release. The sensor starts each pull; the timer ends it and
requires release before another can begin. After rest the app waits for the
user's next pull, so additional recovery is always possible. Single-hand tests
use three attempts and two rests. Tindeq is required for a measured peak.

In warmup, “Include Peak Test today” is off on every new warmup. When selected,
it replaces the BORK maximal block after the normal two-handed ramp. Route
warmup also supports this optional block after its ramp. Normal warmup holds
remain timed and unsaved. Users see the same hand cue as training. The shared
Peak Test flow saves each attempt, shows each hand's best valid result, and
lets the user continue with no forced rest after the last round.

New tests use force_recording.session_protocol version 2 with id peak_test,
source warmup/standalone, capacity_eligible false, peak_valid, failure_valid
false and end_reason peak_test_complete for usable measurements. Interrupted
attempts remain activity but cannot update peak history or the reminder.
Brief pulls under one second and incomplete sensor traces are not accepted.
The average and measured duration are retained for context; they are never
used as a failure-capacity point. Version 1 sustained Peak Tests and all legacy
records retain their existing meaning. No database migration is required.

Valid version 2 peaks update peak history, the optional 28-day reminder and the
measured peak ceiling. During sparse-history calibration they can satisfy the
upper measurement check; a conservative 20% of peak is only an initial lower
probe estimate, never a fabricated sustained-force observation. Warmup curve
fitting and ordinary recovery/capacity fitting exclude peak-only rows.

Starting hands alternate on actual recorded finger-training days, not calendar
days. The initial default is left; existing historical two-hand sessions are
interpreted as left-first. Every new rep saves force_recording.hand_order with
the date and first hand. All grips, extra sets and Peak Tests on that day use
the same choice. Skipped calendar days and starts cancelled before a pull do
not rotate it. Explicit single-hand sessions still honor their selected hand.
A session crossing midnight retains its starting date/order. This survives
reload and cloud history sync; simultaneous offline devices cannot coordinate
until their histories synchronize.
