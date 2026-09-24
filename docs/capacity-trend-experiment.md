# Established capacity and recent performance: offline experiment v1

Plan fixed before running the real-history comparison, 2026-09-24. This is an
experiment, not a change to the training model, ladder, recovery, or charts.

Compare four models on exactly the same held-out opening efforts:

1. **Current**: the present fatigue-adjusted curve and latest-opening-rep anchor.
2. **Averaged anchor**: the same curve, replacing that anchor with the geometric
   mean of prior opening-rep force/curve ratios. Give each training day one vote,
   with a 42-day half-life. This isolates smoothing the anchor from changing
   which reps fit the underlying curve.
3. **Established**: fit fresh opening efforts with a 90-day half-life, one total
   weight per grip/hand/day, and half weight for legacy evidence. Use the existing
   nonnegative three-exponential family. A similarly day-weighted pooled grip
   fit supplies the prior; shrinkage is 100 / effective weighted days.
4. **Established + recent**: fit the same openers with a 14-day half-life, using
   established amplitudes as the prior with ridge strength 3. Blend 25% of this
   recent fit with 75% established. The small fixed blend tests whether recent
   performance adds predictive value without allowing one rep to set the curve.

These are engineering hypotheses, not validated biological time constants.
No parameter sweep or tuning after inspecting this report. All curves remain
positive and decreasing. Aging is relative to the latest available training day
for that grip/hand: absence alone does not lower an established curve. This
experiment does not estimate readiness after a layoff or a confidence interval
for underlying fitness.

Each training date uses strictly earlier dates for every dependency. Same-day
hands and sessions cannot train each other. Use the existing eligibility and
interval harmonization; report legacy and newly recorded outcomes separately.
Exclude manual and interrupted holds from measured ground truth. Actual sustained
overshoots remain eligible. Five prior grip/hand days are required.

Primary diagnostic: force error in kg at the observed hold duration, comparing
raw curves separately from values passed through identical current load bounds
and extrapolation safeguards. This is conditional calibration, not an exact
replay of the 4–5–6 ladder. Main standard-workout results exclude planned targets
under 12 s because historical peak-test release times may not be failure times.
Also show all openers, grip, hand, planned/actual duration domain, evidence type,
early/later halves, error by prior day count, RMSE, relative error, and large
overpredictions. A secondary time comparison inverts the frozen curves at saved
planned load, only scoring ordinary holds within 5% of that load. Out-of-range
inversions are reported, never silently clamped to an exact duration.

Use paired day-cluster bootstrap intervals for differences in force MAE. They
describe uncertainty within this one athlete's history, not independent external
validation. Report every candidate, including losses. Stress-check isolated dips,
persistent gains/declines, duplicates, basis changes and future/same-day leakage.
Historical success only justifies a future shadow test; no automatic promotion.

Run `npm run evaluate:trends -- scripts/data/forward-evaluation-reps.json`.
Keep private input/output under gitignored `scripts/data/`.

## First run: do not promote

The primary slice contained 96 ordinary openers on 33 dates. Raw force MAE was
3.301 kg current, 3.162 averaged anchor, 3.057 established, and 3.018 established
plus recent. All paired primary uncertainty intervals included zero. Applying
unchanged recommendation bounds reversed the overall advantage: MAE was 2.473,
2.538, 2.565, and 2.563 kg respectively; candidate RMSE also worsened.

Planned-load time MAE on 61 matched-force holds / 28 days improved from 36.8 s
to 25.2 s with the averaged anchor (28.6 established; 29.1 established + recent).
Micro benefited more than Crusher; prescribed Endurance worsened. The newer
recording slice has only ten ordinary openers on four dates.

`node --no-warnings scripts/stress-capacity-trends.mjs` reproduces controlled
stable, isolated-dip, sustained-decline and sustained-growth scenarios. A single
35% endurance dip barely changed established capacity at short duration, unlike
the global latest anchor. However, after six genuinely lower mixed-duration
workouts, the established + recent raw estimate remained about 40% above true
160-second capacity. Existing historical floors could keep *all* bounded models
at the old capacity in that scenario. Next research must test evidence-responsive
updates and the final bounds together; this fixed smoothing experiment is not
ready to drive training loads.
