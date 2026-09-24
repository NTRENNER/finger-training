# Whole curve beta

An optional mixed-load session inspired by the Whole HoG format. This is an
experimental format, not a reproduction or validation of Grip Goblins' model.
Enable **Whole curve · Beta** in the Fingers session planner. It is off by
default and requires an available load estimate for every selected hand in
all five domains.

## Session

- Five holds per hand: Power, Power/Strength, Strength, Strength/Endurance,
  and Endurance. The regular six-domain system remains unchanged.
- The selected opening domain goes first. The remaining holds run from
  highest to lowest planned load for each hand, with 30 seconds of rest.
- The next beta session rotates the opening domain after a valid completed
  opener. The user can also choose it. Interrupted openers do not advance it.
- Loads are fixed at session start. The existing fatigue adjustment applies
  once, if selected. Each hold records its own prescribed and actual load.
- Reference durations choose fresh loads; they do not predict the time an
  athlete will manage after earlier holds. Maintain force until failure.
  Existing force tolerance, confirmation, overshoot and interruption logic
  are unchanged. Experimental mixed-load predictions are recorded in the background only;
  they never change the displayed load or end a rep.
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

Tests cover all opening orders, hand-specific load ordering, missing-data
gating, frozen plans, both-hand execution, actual rest, fatigue adjustment,
manual load changes, interrupted openers, rotation, serialization, exports,
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
Review several independent workouts, coverage and exclusions, and compare
later-hold errors with the fresh-only baseline before exposing time ranges or
changing loads. Synthetic tests check behavior and recording, not real-world
accuracy. Physical Tindeq validation remains outstanding.
