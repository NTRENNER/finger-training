# Forward evaluation of force and recovery estimates

Run `npm run evaluate:forward -- scripts/data/reps.json`. Add `--details` for the
individual scored observations. Input is an array of ordinary database rep rows,
including nullable provenance, force-recording and timing metadata. Keep exports
and generated reports in the gitignored `scripts/data/` directory. The command is
read-only and does not contact a service or change recommendations.

## What it checks

For each training date, every fit uses only earlier dates. This includes the
pooled curve prior, fatigue dose, personal recovery, load floors and ceilings.
Other sessions or the opposite hand on the test date cannot enter those fits.
Five earlier training days of relevant evidence are required. Dates, rather than
individual reps, receive equal weight in reported errors; both hands and all
reps within a date are averaged. This avoids treating six reps as six independent
workouts. Duplicate copies of a row are removed; conflicting copies of one ID
are excluded rather than arbitrarily choosing one.

**Force calibration:** compare the measured force of a valid first-set opener
with the current prescription model evaluated at that hold's observed duration.
Compare against (a) a curve fitted only to earlier fresh openers, with the same
pooled prior and shrinkage, and (b) the last measured opener of similar duration
(within a ratio of 1.10, at most 90 days old). The second benchmark abstains when
no comparable hold exists. Pairwise results use precisely the same observations.
Errors are in kg, with signed bias and relative errors also reported.

This is conditional force-duration calibration. The eventual duration is an
outcome, not information available before the rep. It is **not** an exact replay
of the live 4–6 ladder, its load choices, or the target-time recommender. The
evaluation never changes that ladder. Nominal manual loads are valid prescription
anchors in the app but cannot serve as measured-force ground truth here.

The historical fit chooses the scoring interval. When that fit includes older
recordings, a target-acquired test hold is converted using its stored acquisition
duration. Missing acquisition metadata causes exclusion. The held-out row never
chooses the historical fit's basis. New and older recording types are reported
separately; this alignment does not prove that all recording changes are neutral.

**Recovery:** use the production recovery-evidence gate. Only the contiguous,
comparable opening prefix counts; interruptions, missing timing or changed force
can terminate that prefix. Only first sets are used. Fit personal recovery from
earlier dates and compare it with the population model on later holds. Both use
the observed opener, making this a forecast conditional on that first hold.

Two scenarios are reported separately:

- Actual-rest diagnostic: use measured rest intervals where available. For old
  eligible rows, planned rest is an explicit lower-confidence substitute.
- Planned-rest scenario: use the opener's recorded rest setting for every break.
  This tests a constant-rest scenario, not a reconstruction of any later changes
  to the plan. Missing rest settings are not imputed as zero.

Personal and population forecasts evolve through their own predicted durations;
later observed times are used only for scoring. Reports separate measured evidence
from historical estimates. A better diagnostic with actual rest is not, by itself,
evidence of a better advance forecast.

**Whole Curve:** include the existing evaluation of saved, versioned predictions.
That evaluator rejects edited observations or altered/missing prefix records and
keeps actual-load/rest diagnostics separate from matched planned scenarios. An
empty result means there are no eligible saved predictions, not zero error.

## Interpreting a report

Inspect coverage and excluded reasons before comparing scores. Read matched
comparisons, grip, hand, domain and recording-type breakdowns; a favorable pooled
average can conceal a weak domain. Positive bias means the forecast was too high.
Relative timing error becomes large when a late rep lasts only a few seconds, so
read seconds of error alongside it. Prime or another sparse grip may not qualify.

This is retrospective evaluation of the **current** algorithm. Historical rows
can have been edited, and the algorithm was developed using parts of this same
history. Past-only fitting prevents row leakage but does not remove that research
history. One athlete's results do not validate performance for other users. Use
future saved predictions and more independent workouts before making strong
accuracy claims or increasing model influence. Do not tune on a reported test
slice and then describe improvement on that slice as independent confirmation.

The synthetic test suite checks leakage, database-shaped legacy/manual/interrupted
rows, interval changes, rest scenarios, duplicate handling and day weighting.
It deliberately does not require the complex model to win: a loss is a finding,
not a failing test that should be optimized away.
