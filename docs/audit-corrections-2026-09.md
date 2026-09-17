# September audit corrections

## Session fatigue adjustments

New reps contain `session_adjustment: {version: 1, reported_cooked, applied_multiplier}`. The runner freezes this at session start and saves the same snapshot on every rep. A null rating remains distinct from an explicit zero. Both apply a multiplier of 1. The fixed rated-session multiplier remains bounded at 0.75.

Fresh-equivalent loads use that saved multiplier, even if diary ratings change later. Cloud serialization and fit invalidation include the snapshot. Existing clients can continue writing reps because the database column is nullable. The additive migration has been applied and its column and existing RLS verified; it does not backfill any records.

Legacy explicit session ratings keep the previous calculation with `adjustmentBasis: legacy_session_estimate`, rather than pretending to know which multiplier the old client used. Day-only ratings no longer compensate individual sessions: those rows are marked `unknown_legacy_adjustment`. Other unrated rows are `unrecorded_adjustment`. Corrupt/unsupported snapshots use no external adjustment and are marked unknown. Raw measurements are never rewritten.

A read-only database check found 50 reps across six sessions with a null session rating and positive same-day diary rating (May 24–September 16). These are potentially ambiguous, not proof that every session was recorded incorrectly.

## Deload calibration

The recent n-session average is compared with overlapping n-session averages scored out of sample. Earlier training dates fit the recovery model; later dates supply the baseline; the judged window is excluded from both. Complete dates stay together at every boundary. Both halves need at least six training dates, verified after selection. Overlapping windows are counted separately from sessions and training dates.

Baseline center is the mean of window averages. The sample spread is computed around that same mean, with a 0.05 denominator floor. The personalized decision also requires a minimum 0.10 decline in recovery ratio: this is an explicit conservative policy guard, not a measured standard deviation or a clinically validated cutoff. It protects nearly constant baselines from tiny fluctuations. The current gauge does not describe guarded thresholds as statistical significance.

At six baseline dates the existing absolute threshold still applies. Personalization increases by 1/6 per additional baseline date and is complete at twelve. This avoids a discrete algorithm change at first eligibility; genuine new data can still change the baseline. Provisional assessments are labeled. Gauge pressure and the decision use one shared threshold, including equality. The 14-day recency rule and cross-grip requirements remain.

An anonymized, scoped replay used 825 Crusher/Micro reps from the one history matching the audit's sustained training coverage. It covered 43 dates: before, 4 unknown / 34 green / 5 yellow; after, 4 unknown / 35 green / 4 yellow. Neither produced red; maximum pressure changed from 0.64 to 0.58. September 14 and 16 move from green to yellow with a local Micro concern, while three earlier provisional checkpoints move to green. No invalid numbers occurred. The 0.05 SD floor bound on 1 of 52 eligible baseline evaluations; the 0.10 meaningful-decline guard bound on 23. This is a behavior check, not clinical validation or a reason to tune until alarms appear. No raw replay data is committed.

## Climbing and UI

Attempts can be corrected in History, including clearing a mistaken multi-attempt value back to one. Both create and edit normalize a multi-attempt Flash/Onsight to Send and explain the change. Those first-try selections are disabled while attempts exceed one. Attempt and Completed with rest remain available. Existing contradictory records are not mass-rewritten; editing and saving corrects them.

A session-level effort override changes the fatigue score without erasing climb or attempt counts. Daily climbing aggregation groups each date once, eliminating repeated whole-log scans.

The unused PrescribedLoadCard is removed. Its load-floor caption and regression coverage now live on SessionPlanCard. Retrospective day/session rating controls describe ratings rather than claiming that a day edit changes every session's applied load.

## Verification

Regression coverage includes session-start snapshots, same-day differences, explicit zero versus null, later edits, legacy/corrupt metadata, cloud round-trips, matched baseline statistics, complete-date splitting, constant baselines, small and sustained dips, exact thresholds, progressive calibration, repeated calls, future-data exclusion, consecutive climb entry, attempts correction, and session rating scope.

Validation completed: full suite 1,080 passed (three pre-existing skipped tests); subsequent targeted checks 21 passed, including an additional numeric baseline regression. Final production build and offline verification passed. Mobile create/edit flows were checked with sample data. Frontend deployment remains pending.
