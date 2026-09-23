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
  are unchanged. There is no mixed-load fatigue forecast in this beta.
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
