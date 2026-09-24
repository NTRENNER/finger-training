# Adaptive capacity experiment v2

Frozen plan, before running v2 against the saved history. Initially offline;
after verification, enabled only for frozen background forecasts. Do not
replace live recommendations on the strength of a retrospective result.

Keep v1's established fit unchanged. The new adjustment reads up to six recent
independent days within a 42-day evidence window. Compare actual opener force with the
established curve at its actual duration. Require at least three consecutive
days with deviations of the same sign, each beyond 5%. Neutral or opposite days
break confirmation. Influence grows from one third at three days to full at
five. Legacy observations halve their share of that influence.

Use nearby-duration evidence (within a factor of two), or broadly consistent
evidence spanning at least a factor of three and three separated duration bands.
Broad evidence acts fully inside its observed duration range and fades to zero
one octave outside it. Nearby evidence fades with log-duration distance. Never
apply an endurance-only signal indiscriminately to short pulls. Keep curves
positive and monotonically decreasing using isotonic projection of log-force.
These thresholds are hypotheses, not physiological constants or confidence
intervals. No parameter sweep on this run.

Test two candidates: adaptive curve with unchanged bounds, and the same curve
with an evidence-responsive floor. The latter replays confirmations in date
order after the historical floor's source rep. Only explicitly valid, complete
measured failure openers on at least three independent days can relax the floor.
Legacy data remains useful to the curve but cannot alone authorize this extra
floor relaxation. Include both muscular_failure and target_force_failure.

Each new supporting day permits at most one 25% reduction, never below the
adaptive estimate at that historical checkpoint. Reductions persist when their
confirmation window passes. New demonstrated full-duration ability can lift
the revised floor. Repeated reads cannot compound reductions. Peak ceilings
and endurance ceilings remain in place. No changes to live 4–5–6 progression.

Compare on v1's same historical observations and report both raw and final
bounded errors, tails, duration/grip/measurement groups, planned-load time and
chronological halves. Future and same-day evidence is excluded everywhere,
including every floor replay checkpoint. This history is exploratory, not an
untouched test set. Keep failures in the report. Require the synthetic isolated
dip and sustained shift scenarios to improve before considering a shadow trial.

## Prospective collection

The synthetic checks passed, but the historical bounded MAE did not improve
overall. Therefore only background collection is enabled in the local build.
`established-recent-v2` is a separate frozen experiment alongside the existing
`fresh-openers-v1`; neither changes the athlete's loads or the 4–5–6 ladder.

At session start the model saves its curve grid, established coefficients,
duration basis, prior-day cutoff, planned-target policy value and floor events.
Before the opening hold it freezes a time estimate at the actual planned load.
It saves the extra snapshot only on the opener, using the existing prediction
metadata. There is no migration or retroactive forecast backfill.

Analysis → Prediction accuracy → See the comparison → Established ability +
recent performance shows its own new-day count and curve/time scores. It starts
at zero even when the older experiment has accumulated days. The review download
contains both experiments, their frozen forecasts and grip/duration breakdowns.
Ten new comparable days is a review checkpoint, not a maturity threshold or an
automatic switch. Edited outcomes, interruptions, uncertain measurements and
incompatible recording intervals do not count; valid overshoots remain force
evidence. Planned-load time checks require force within 5% of plan.

The curve scores are conditional on eventual duration. The saved planned-target
policy and floor events remain separate: a good raw curve score must not be
mistaken for proof that its final bounded recommendation is better. Peak tests,
optional sets and mixed-domain sessions do not enter this experiment. The
background calculation catches failures so it cannot block normal recording.

A lifecycle check after the first v2 run found that aging confirmations out of
the window could manufacture a rebound after inactivity. The final version
anchors that window to the last available ordinary workout, preserving the
last evidenced curve, and records evidence age separately. No numeric forecast
improves merely because the user stopped training. This correction was made
for the no-new-data invariant, not to optimize historical scores; the full
historical comparison was rerun afterward.

## Results and release decision

The standard historical slice stayed at 96 holds / 33 days. Raw force MAE:
3.301 kg current vs 3.007 adaptive. Bounded force MAE: 2.473 vs 2.583 kg;
bounded RMSE: 3.545 vs 4.012 kg. Micro's bounded MAE improved (1.675 to 1.315),
Crusher's worsened (3.686 to 4.093). Planned-load time MAE on 61 matched-force
holds / 28 days improved from 36.8 to 28.7 seconds. The simpler v1 averaged
anchor retained the best time MAE at 25.2 seconds. No universal winner.

Twelve ordinary held-out efforts received an adjustment; zero received the
new floor relaxation. The floor's benefit is still synthetic-only evidence.
In the controlled decline case after six lower workouts, true 160s capacity
was 14.05 kg, adaptive capacity 14.15 kg, and the revised bounded load 14.10 kg.
The unchanged floor would have held it at 21.62 kg. Isolated-dip, sustained-gain,
no-new-data and idempotency checks passed. This justifies collecting prospective
forecasts, not changing the user's loads. Full suite: 1,307 passed / 3 skipped;
production build, offline verification and phone/desktop browser checks passed.
