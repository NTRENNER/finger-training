# Chaos Machine (Beta)

An optional mixed-load session inspired by the Whole HoG format. This is an
experimental format, not a reproduction or validation of Grip Goblins' model.
Enable **Chaos Machine (Beta)** in the Fingers session planner. It is off by
default and requires an available load estimate for every selected hand in
all five domains.

## Session

- Five holds per hand: Power, Power/Strength, Strength, Strength/Endurance,
  and Endurance. The regular five-domain system remains unchanged.
- The ordinary recommended training domain is the default opener. The user can
  choose another first domain; that override resets when changing grips.
- Version 2 plans continue through the five domains in their listed order,
  wrapping Endurance to Power, with 30 seconds of rest. For example:
  Strength/Endurance → Endurance → Power → Power/Strength → Strength.
  Both hands use the same sequence, frozen at session start. Version 1 saved
  plans retain their original per-hand descending-load order after the opener.
- When the recommendation is a peak test or unavailable, Power is the fallback;
  all five domain estimates are still required to enable Chaos.
- Original reference loads and the model are fixed at session start. Later loads
  adjust automatically before each hold to aim for its target duration, then stay
  fixed during that pull. The existing fatigue adjustment applies once, if
  selected. Each hold records its own prescribed and actual load.
- Target durations are approximate. Maintain force until failure; predictions
  never end a rep. Existing force tolerance, confirmation, overshoot and
  interruption logic are unchanged. Missing reliable measurements fall back to
  the original reference load with an explanation. See the details below.
- The rest screen shows the next domain and load. Manual mode waits for the
  athlete to start the next hold, allowing equipment changes. Actual rest
  continues to be recorded when measurable.
- This beta is one set. Normal sessions retain their 4–5–6 progression.

## Evidence and history

The first valid hold per hand can enter the fresh-capacity fit under the
existing evidence rules. Later holds remain recorded activity, with valid
failure status preserved, but are excluded from fresh-capacity and recovery
fits. All beta reps are excluded from constant-load recovery fitting, regular
ladder progression, and the previous regular-session comparison. Later holds
do not refresh fresh-domain coverage.

Each rep carries `force_recording.session_protocol` with the protocol ID,
version, domain, opening domain, position and opening/fatigued role. Existing
JSON storage persists this through cloud sync without a migration. CSV exports
also preserve the metadata and evidence flags. History identifies the beta
and its individual domains; the session-wide duration editor and add-rep
control are unavailable for it, so they cannot turn variable holds into an
ordinary constant-load set. Existing recorded reps can still be corrected.

## Validation

Tests cover all opening orders, identical hand sequences and legacy load ordering, missing-data
gating, frozen plans, both-hand execution, actual rest, fatigue adjustment,
manual load changes, interrupted openers, recommendation defaults and manual overrides, serialization, exports,
and unchanged regular ladder behavior. Physical Tindeq testing of this new
sequence is still needed; automated tests do not replace that check.


## Background prediction experiment (version 1)

At session start, each hand gets a frozen model using measured fresh holds
from the preceding 90 days, including legacy measured rows. It requires five
independent sessions and at least a threefold range of observed durations.
Sessions receive equal fitting weight. The fit uses the existing nonnegative
three-exponential envelope and shared timing-basis conversion; its snapshot
records the basis, history date, coverage, coefficients and recovery parameters.
Prescribed loads and manual settings are not substituted for measured force.

This is an empirical candidate to evaluate, not a validated physiology model.
Three mathematical availability states start at 1. Each completed hold reduces
state i by exp(-impulse / fresh maximum force / depletion tau i). Measured rest
restores it as 1 - (1 - state i) * exp(-rest / recovery tau i). The weighted
availability scales the fresh force-duration curve. The predicted hold ends
where this scaled curve meets the next load; a lighter later hold may last
longer than the opener. The curve already describes declining force during a
hold, so the forecast does not apply another within-hold depletion factor.
Actual full-activity impulse includes ramp-up work. Fresh-curve taus and
fatigue-depletion taus remain separate. Historical constant-load recovery fits
supply starting recovery parameters where available, otherwise population
priors are used. Their transfer to mixed loads is itself unvalidated.

Every hold carries `force_recording.mixed_load_prediction`:

- The model and planned-load forecast are frozen before that hold; completed
  earlier holds supply measured work and actual rest. The upcoming rest is
  still the planned rest, explicitly labelled as such.
- At completion, a separate **actual-load-and-rest diagnostic** evaluates the
  frozen model at measured average force and measured rest. This is conditional
  on the observed load/rest, not a prospective forecast. Sustained overshooting
  remains usable here. The current outcome never fits its own model.
- A fresh-only prediction at the same load is saved as a comparison. Above-
  capacity and beyond-600-second outputs are labelled, not forced into a
  plausible-looking duration.
- Interrupted/unmeasured holds or missing rest make the rest of that hand's
  chain unavailable. Zero rest is valid. The other hand and a new workout
  each start their own chain. Manual sessions still save activity and an
  explicit unavailable reason, without inventing measured evidence.

Run `npm run evaluate:mixed -- /path/to/reps.json` on a JSON array of rep rows.
The report separates model versions, domains and hold positions, excludes
openers from fatigue validation, and averages error within each workout before
averaging across workouts. It reports conditional error against the fresh-only
baseline and planned-scenario error only for loads within 10% and rest within
2 seconds of the original scenario. Those tolerances are evaluation filters;
they do not affect rep detection or evidence eligibility. Corrections to a
hold or its prefix invalidate its stored comparison rather than silently
reusing old errors. Duplicate rows do not create extra votes.

No mixed-session parameter tuning or automated promotion is enabled yet.
Adaptive prescription is an explicit experimental opt-in, not a validation of
these parameters. Review independent workouts, coverage and exclusions, and
compare later-hold errors with the fresh-only baseline before changing defaults. Synthetic tests check behavior and recording, not real-world
accuracy. Physical Tindeq validation remains outstanding.


## Loads aimed at target times

Chaos Machine automatically adjusts later loads toward each hold’s target time;
there is no separate adjustment switch. Chaos Machine itself remains optional
and off by default. Selecting another grip keeps this behavior when the beta is
enabled again. The stored protocol ID remains `whole_curve_beta`, so existing
history and exclusions continue to work under the new display name.
Legacy fixed-reference plans and their saved load-mode metadata remain supported.

The opening load and per-hand domain order stay as planned. For each later
hold, the frozen model consumes measured force-time work from completed holds
on that hand and measured rests between them. It then assumes the upcoming
planned 30-second rest. Inverting its available force-duration curve at the
next target duration gives a candidate load. Round to the same 0.1 kg used by
the live prescription, and cap at that domain's original adjusted load. We do
not increase a reference load on this experimental model's advice.

When the user elects a cookedness reduction, the frozen model's amplitudes and
the original-load ceilings each receive that multiplier once. This is recorded
as `readiness_multiplier`; it is an explicit assumption, not measured readiness.
The current session never refits that model. Each new session builds a snapshot
from the accumulated eligible history. There is no automatic parameter tuning.

The rest screen shows the chosen next load and its adjustment/fallback status.
It stays fixed through the next pull, including if the athlete waits longer;
longer-than-planned rest is recorded and evaluated afterward. An interrupted or
unmeasured prefix, missing actual rest, insufficient history, or target outside
the fitted duration coverage falls back to the original load with an explicit
message. Manual overrides remain available. Low/unusable estimates also fall
back rather than displaying zero. Estimates remain approximate, including the
existing legacy elapsed-time versus target-acquired timing distinction.

Before starting, the preview shows original reference loads and a target-based
time budget: 11:55 per hand or 23:50 for both, including four 30-second rests per
hand. Setup/hand changes add time, and actual holds can be shorter or longer.
The timer still runs until failure; target time never ends the hold.

Each saved forecast has `mode: adaptive_targets` and an `adjustment` object
containing target time, original and selected loads, status and fallback reason.
The session protocol stores `load_mode` and `duration_reference`. Original
forecasts and actual-load/rest diagnostics are preserved separately. Evaluation
reports adaptive workouts under `v1|adaptive_targets|...`, apart from fixed-load
shadow forecasts. Later holds remain excluded from fresh-capacity/recovery fits
and ordinary 4–5–6 ladder progression.

Tests cover inverse/forward agreement, rounding, measured work and rest,
readiness scaling, hand isolation, interruptions, unavailable estimates,
within-hold stability despite history refresh, and serialized predictions.
Live Tindeq validation and real-world accuracy assessment remain necessary.
