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

## Audit follow-up: boundaries and navigation

Peak measurements use the same `< 200 kg` sanity guard as other measured loads,
including when reading already-saved rows. Invalid peaks cannot seed a cold-start
endurance prescription. Recording a new peak can still update the observed peak
and its existing prescription ceiling, but it does not enter the failure curve.

Peak-only measurement days do not count toward hard finger-training days,
weekly training volume/coverage, or session-pace projections. History retains the
measurements. Older sustained peak-test protocols retain their own history label
and are not reinterpreted as version-2 brief pulls.

Warmup ramp percentages retain their existing **regular-training peak** reference
(or the curve fallback). Dedicated peak tests do not automatically increase this
reference. This preserves the existing calibration rather than inventing new
percentages. If measured capacity is unavailable, fresh explicit manual-load
anchors may supply a labeled warmup estimate; interrupted, mixed-protocol and
optional-set rows cannot supply that fallback.

Both the standalone test and warmup retain progress during tab navigation.
Sensor acquisition pauses while hidden; rest deadlines keep running. Leaving
mid-pull records an interrupted attempt rather than a valid maximum. This is
in-memory navigation continuity, not resumption after closing or reloading the app.

## Demonstrated two-second force

New sensor recordings persist `force_recording.sustained_max`: the highest
**time-weighted two-second average**, with its start/end offsets relative to the
activity recording, method/version and window quality. It uses actual device
timestamps, never bridges a gap over 250 ms, and rejects reversed timestamps,
nonfinite values and readings outside the existing 200 kg sanity bound. Only
this small summary is stored, not sample arrays. An intact window may establish
a record even when a later interruption makes the full rep unsuitable for
failure fitting. The window does not certify the rest of that recording.

Analysis shows **Best max of at least 2s** for each grip and hand, above the
force-duration chart. The headline searches all available history for the
highest recorded average over at least two seconds: either an intact measured
hold average with its original duration, or a verified two-second window.
Every headline shows the original date and duration. Older hold averages are
never converted into synthetic two-second windows. A full-history step chart
tracks the running record for each grip and hand, with solid left-hand and
dashed right-hand lines. Tooltips retain the producing record date and duration.
The chart and headline use the same selected scale: absolute force or bodyweight
ratio. Relative records rank each eligible measurement using bodyweight on its
recorded date (falling back to the current bodyweight when no log exists). A new
absolute record does not lower a better historical relative record.
This avoids presenting a recently introduced measurement as a lifetime limit.
Instantaneous peaks remain in workout history. Later sessions, extra sets,
and fatigued Chaos Machine holds can set records. Lower results never erase a
record. Peak Test summaries retain their separate measurements. This display
change does not alter prescription caps, failure-curve fitting, or stored rows.
Historical peaks cannot be converted into two-second records without raw samples.

Prescription safeguards retain **separate instantaneous and two-second
references**, rather than mixing them into one force value before discounting.
The existing 0.95 allowance applies only to a valid max-intent instantaneous
peak. A qualifying two-second demonstration may raise the ceiling to its full
measured value; no additional percentage or invented failure point is applied.
For example, 62 kg instantaneous / 56 kg over two seconds gives a 58.9 kg ceiling
whether the two-second field exists, is unavailable, or predates the feature.
A 60 kg verified two-second demonstration can raise that ceiling to 60 kg.
This is a bound on model extrapolation, not a prescription to use that force.

A missing two-second window does not invalidate an independently valid
instantaneous peak. Incomplete/interrupted recordings cannot supply that
instantaneous fallback. An intact two-second window retains its own quality
contract even if a later interruption invalidates the full recording.
Ordinary instantaneous references retain first-set/opening-rep and max-intent
requirements, but unknown or later session order cannot erase those safeguards.
Any verified two-second window can raise an established maximum, including
later sets and Chaos Machine holds. Routine submaximal work alone cannot create
a falsely low max-force ceiling. Peak caps read the complete dated history;
fresh fitting, capacity floors, endurance bounds and the 4–5–6 ladder retain
their separate eligibility rules and reconciled recording intervals.

References expose instantaneousKg, sustainedKg, capKg and capBasis. The overload
ceiling uses the larger measured force, while the base prescription uses capKg.
Grip, hand, strictly-before-date replay boundaries and recent/historical fallback
remain explicit. Historical records and two-second PRs are never rewritten.
