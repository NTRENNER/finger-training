# Coaching foundation — first implementation

Decision: 2026-11-23, following `docs/training-philosophy.md`. Implement
descriptive accounting and neutral presentation before building behavioral
effect estimators. This does not activate a new training intervention.

## Training pattern

Analysis → Fingers shows a rolling seven-day training pattern. Frequency is
distinct recorded finger-training dates. Volume is separate: identified blocks,
sets counted separately for each hand, saved reps, attempts, activity time, and
load × time. Climbing entries and shared dates are context; a shared date does
not establish whether climbing preceded the finger work. Empty dates say no
training was logged, not that the athlete rested.

A block is an identified session for one grip. Both hands and optional sets
stay in that block. A saved session start can supply an identity where the ID
is missing; a start matching exactly one known session joins that session.
Ambiguous or absent identities remain unknown. Counts do not invent separate
blocks from rep order, upload order or a new set. Multiple dates spanned by one
identified block count as multiple active dates but only one block in the
period. Grip and protocol breakdowns are descriptive, not equivalent doses.

Stored raw work is distinct from fresh-capacity evidence. Short and disputed
attempts still contribute recorded activity. Redos are expanded using the
existing attempt history and counted once each; the combined activity total is
not added again. Prescribed and nominal loads do not become observed loading
exposure. Recorded sensor integrals (or measured average × time) and estimates
from entered loads are displayed separately; missing loads and incomplete
recordings are stated. Seed artifacts, Peak Tests and potentiation measurements
are excluded from these training counts, matching their separate roles.

The calendar reads the reconciled in-memory history and does not write or
reclassify old records. It does not infer adherence, physiological readiness,
or whether more work would help. Its seven-day range is labeled separately
from the existing calendar-week digest.

## Presentation changes

- Weekly summaries distinguish days from identified blocks; climbing and
  support dates are called days rather than sessions.
- Short sessions are not called accidental starts or suggested for deletion.
- Below-target hold times use neutral styling after the effort. Interruption
  flags and valid-effort completion rules stay intact. No detector, target,
  retry, rest or progression rule changes.
- Cookedness is labeled as exertion in that session. Stored adjustment
  snapshots and rating persistence are unchanged.
- Cadence/volume notes are descriptive, and a lack of flagged data does not
  produce an unsupported assertion of consistency or clean data.

## Coaching evidence boundary

`src/lib/coachingEvidence.js` evaluates candidate support without producing
recommendations. Eligible questions concern frequency, volume, spacing,
distribution, grips or protocols. Target attainment and cookedness cannot be
substituted for longitudinal strength/endurance outcomes.

The initial evidence contract requires a concrete possible action, comparable
observations on independent dates, a meaningful effect relative to a declared
worthwhile difference, an uncertainty interval entirely beyond that difference,
consideration of volume/climbing/grip/protocol/session order, and replication
plus out-of-sample support. The initial confidence requirement is at least 95%;
it is a conservative review contract, not a fitted statistic or proof that a
candidate is causally effective. Causal claims require an appropriate design.
Each withheld candidate has explicit reasons. Counts or elapsed time alone
cannot qualify it.

Current cadence and workload notes supply observations only: they have no
effect estimates, no validated interventions, and cannot pass this contract.
`buildCheckIn().coaching` exposes those assessments for tests/research, with
`mode: observe_only` and an empty recommendations array. It is not shown as a
new coaching card, stored in cloud data, or fed to prescriptions. New import
boundary checks protect this separation transitively.

There is no automatic activation when a date passes. The experiment remains
frozen through 2027-01-24; enabling advice that changes behavior needs an
explicit protocol decision. Existing deload, optional-set, curve, prescription,
and progression algorithms are unchanged. Any conflict between those existing
policies and the new philosophy needs separate review rather than an implicit
change to the frozen experiment.

## Next stage

Specify a longitudinal analysis question (for example, distribution of similar
weekly volume across days), meaningful outcome thresholds and a validation
plan. Develop and evaluate the estimator in Analysis/research before it can
supply evidence to the coaching gate. Do not infer benefit from a prettier
training calendar, higher target attainment, or additional work alone.

## Verification

Synthetic regression cases cover one day with three blocks, separate hands and
sets, partial and ambiguous identity, short/interrupted work, redo totals,
unknown loads, measurement quality, grip/protocol separation, and climbing
context. UI tests cover calendar selection and refresh, neutral short efforts,
and unchanged interruption behavior. Full test/lint/build/offline and isolated
browser checks are required before release. No production data writes are
needed for this implementation.

Release verification on 2026-11-23: 2,299 tests passed with 3 skipped.
Lint, production build and offline verification passed. Isolated browser
checks verified day/block separation, climbing context,
history refresh, and no overflow or undersized day buttons at 320px/375px.
Preview data was fictional; physical BLE and live cloud sync were not exercised.
This release requires no database migration or changes to stored training data.
