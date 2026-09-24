# Prospective prediction review

Historical analysis is now available in the same card: choose **Review earlier
workouts**. It runs in a worker on demand, without blocking training or changing
records. History changes invalidate the displayed result. A separate download
contains recorded target attainment and strictly-past model replays. These
results do not count toward the new-forecast checkpoint or mix with its scores.
See `docs/forward-evaluation.md` for eligibility and interpretation.

Analysis → Fingers → Prediction accuracy collects evidence during normal
single-domain sessions. No extra action during a hold is required. The card
uses all grips/hands (explicitly labelled), independently of the chart filter.
The recording begins when a client with this version is used; history is not
backfilled with purported advance forecasts. Older workouts still fit models.

## Fixed experiment: fresh-openers-v1

At session start, freeze both hands' models from the history then available:

- Current: the production prescription curve fit, including fatigue-adjusted
  fitting points, current per-grip prior and most-recent-opening-hold anchor.
- Candidate: same prior, anchor and prescription bounds, with only eligible
  opening holds admitted to the fit. This is the fresh-anchored candidate from
  the September 24 forward evaluation, not an unanchored fresh-only model.
- Recovery: the current personalized recovery model and the same model with
  population recovery constants. Other constants remain identical.

The production function exposes its coefficients only when `captureCurve` is
requested; no duplicate fit implementation and no changed prescription output.
Each usable capacity model requires five prior independent training dates.
Its duration basis and coefficients are saved with the exact unadjusted
bounded load recommendation at the planned target. Actual session loads
(including pins and cooked adjustments) are recorded separately, as before.

Before each first-set hold, save the frozen models, planned load/rest, model
experiment/version, build, preparation timestamp, previous completed hold
fingerprints and advance time estimates. These snapshots live in the existing
`force_recording.prediction_check` JSONB field and use the normal offline/cloud
rep sync. No schema migration or background service is required. No snapshot
influences training loads, rep escalation, ending detection or historical fits.
Peak tests, ordinary warmups, optional extra sets and Whole Curve sessions do
not enter this experiment. Whole Curve retains its separate existing logging.

## What the scores mean

1. **Force at observed duration (kg/lbs):** evaluate the saved, anchored capacity
   curves at the eventual duration and compare with measured force. This is
   conditional calibration, not a prospective duration prediction. It includes
   valid sustained overshoots. The curves are evaluated before prescription
   floors/ceilings/extrapolation guards; those are action safeguards, not
   invertible capacity forecasts. Do not call this score prescription accuracy.
2. **Advance hold time (seconds):** invert each saved curve at the planned load
   before the opener; compare only when observed mean force is within 10%.
   Estimates outside 0–600 seconds are unavailable, never clipped and scored.
   This tolerance is an evaluation convention, not a rep-ending threshold.
3. **Recovery at measured rest (seconds):** compare personal/population fits
   using the same opening time and measured rest intervals. Model constants
   remain frozen. This retrospective conditional check is reported separately
   from the advance next-hold prediction made with planned next rest.
4. **Advance recovery (seconds):** also require next actual rest within 2 seconds
   of plan and actual force within 10% of planned load. Both recovery checks
   require contiguous valid comparable-force holds with measured rest. An
   interruption, missing rest, or load change stops that sequence; it cannot
   manufacture a fresh opener.

Target-acquired durations are converted to the frozen model's earlier interval
only when acquisition metadata exists. Incompatible intervals are unavailable.
Invalid endings, nominal/manual loads and incomplete signals are activity but
not scored measurements. A saved outcome or recovery-prefix edit invalidates
the affected comparisons. Canonical fingerprints survive JSONB key reordering;
duplicate rows do not add votes and conflicting copies are excluded. Later
edits to fitting history do not rewrite what a model believed at session start.

Paired comparisons use identical observations. Errors are averaged within each
training day, then across days, so six reps or two hands are not six or two
independent validations. Typical error = mean absolute error; larger misses =
root mean square error; bias = predicted minus actual. Reported units for
capacity and recovery remain separate. Planned and observed duration domains
are separate in the download. Reported cookedness comes from the immutable
session adjustment, not a retrospective rating edit.

## Review cycle

After 10 days with paired opening-hold comparisons, the card says **Ready for a
model review**. Further checkpoints occur at 20, 30, etc.; the latest ten days
are also shown. This is a reminder in Analysis, not a background notification
or a statistical claim. Recovery-only days do not advance the capacity counter.

Download the review and ask for a prediction review. Preserve that download as
the dated review record. Each review should:

1. Check exclusions, measurement integrity, duration coverage and load/rest
   matching before interpreting errors.
2. Compare typical error, larger misses and bias overall and by grip, hand,
   planned domain, observed duration and recent versus earlier days. Inspect
   individual large misses and stated fatigue from the included observations.
3. Use days as clusters for uncertainty estimates; ten days alone do not prove
   a winner. Never promote on aggregate improvement that masks a material
   regression in a grip or duration. Compare the forward backtest as well.
4. If evidence supports a change, propose a small separately tested model
   change for explicit review. Keep its previous version available for rollback
   and continue prospective validation. Otherwise collect more normal workouts.

Changing either candidate or scoring semantics requires a new experiment ID.
Unsupported experiment versions are excluded, not pooled. Reports include the
build and frozen models for replay. The UI does not promote or tune anything
automatically, and does not claim an accuracy improvement until one is measured.

## Audit follow-up: research isolation

Prospective comparison version `fresh-openers-v2-shared-history` rebuilds all
competitors and derived inputs from the same strict prior-day history. Each model
records `history_before`. Same-day data still informs live workout recommendations;
research force comparisons use the shared cutoff. Prior experiment records remain
exportable but are excluded from this version's scores.

A dedicated worker builds prospective models while the plan is idle. Start only
uses an already-completed result matching history identity, grip, target and day.
If unavailable, research scoring is skipped for that session. Training never waits
for the worker, and there is no synchronous fallback. Late replies, changed inputs
and unmounting cannot attach stale results to a new session.

Opening holds retain the full model snapshot. Completed later-hold scores retain
only required diagnostics and a reference to their opener. Local persistence
budgets optional prediction metadata at 512 KiB, keeping complete recent sessions.
This is a local cache budget, not deletion of cloud records or recorded activity.
Research exports can archive the full records currently in memory.

If writing history fails, persistence retries without optional research metadata.
If essential activity still cannot be saved, an explicit alert offers retry and a
complete JSON backup. No workout is deleted to satisfy the research budget. The
backup preserves measurement/protocol fields as well as the basic workout values.
