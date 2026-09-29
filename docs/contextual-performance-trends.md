# Training order and long-term performance: research candidate

Status (September 29): context-only weighting is the default descriptive
performance chart, at the user's request. The stronger robust fit remains a
Research preview. Frozen forecast versions, workout recommendations, the 4–5–6
ladder and saved workout records are unchanged.
Analysis now identifies how many plotted opening holds followed earlier recorded
finger training that day. That is context, not a diagnosis of fatigue.

## September 28, 2026 investigation

Read-only replay of 943 current Supabase rep records. The three matching sessions
are stored under the app date September 26; their UTC start timestamps fall on
September 27. There are no September 27 app-date reps in this export.

Sequence: Micro Chaos (10 reps, 450.4 seconds of recorded holds), another Micro
session (8 reps, 485.7 seconds), then Crusher Chaos (10 reps, 482.1 seconds).
These totals describe recorded activity, not exact physiological depletion.
The right opening hold of the first Micro session has failure_valid=false and
was correctly excluded from capacity fitting.

Using the current chart, Micro's baseline-relative index went from +20.58% to
+20.91% with just the first session, then +19.37% after the second. Crusher went
from +19.25% to +16.60% after the last session. These are chart index percentage
points, not direct changes in measured strength. The replay confirms that the
later opening holds drive the dip; it cannot establish fatigue as the sole cause.

## Candidate definitions (fixed before accuracy replay)

Both retain the original 90-day recency half-life and minimum five eligible
training dates per hand. Context uses all recorded finger work before filtering
for capacity evidence, across grips. Thus later or interrupted Chaos holds can
establish earlier work without becoming fresh-capacity observations themselves.
Peak-test-only sessions do not establish an earlier training workout.

Order requires an explicit session-start timestamp or a recorded rep/activity
start. Upload/created_at times are never used. Unordered sessions remain unknown,
not presumed rested. Context is limited to the recorded training date; no claim
of overnight recovery or a learned recovery time is made.

- **Context only:** later sessions collectively receive a 0.25 evidence budget
  for each date/grip/hand fit. If the date also has first/unknown-session openers,
  the combined budget is normalized to one (0.8 first/unknown, 0.2 later).
  Additional later sessions share that budget rather than increasing it. A grip
  trained only later receives 0.25 total, not a renormalized full day. Existing
  legacy-quality weights still apply. The 0.25 is a research confidence choice,
  not a measured fatigue correction or force multiplier.
- **Context plus robust weighting:** additionally performs three reweighting
  iterations, reducing leverage for absolute log force residuals above log(1.15).
  Both unusually high and low results are treated symmetrically in log space.
  No observed force or duration is changed. Repeated evidence on separate days
  can still move the curve down or up. This is robust fitting, not extra cosmetic
  smoothing of the rendered line.

Fits only see strictly earlier dates for prediction evaluation. Chart estimates
include their displayed date. Filtering the chart window does not refit it.

## Results and decision

101 standard opening holds across 34 dates; error is force at the observed
hold duration, with equal weight per test date. All models use identical scored
observations. These are retrospective comparisons, not independent validation
and not a test of unobserved rested strength after a fatigued workout.

| Trend | Overall MAE (kg) | Micro MAE | Crusher MAE | Later chronological half MAE |
| --- | ---: | ---: | ---: | ---: |
| Original | 3.051 | 1.787 | 4.354 | 1.853 |
| Context only | 3.114 | 1.779 | 4.494 | 1.766 |
| Context + robust | 3.177 | 1.763 | 4.646 | 1.857 |

Paired-day bootstrap 95% intervals for MAE difference from original:
context only +0.0624 kg [-0.0724, +0.2026]; robust +0.1251 kg
[-0.0173, +0.2791]. Neither establishes an overall improvement.
The later chronological half begins June 28 (17 test days per half); it is not
an untouched holdout. All historical data are development evidence.

Relative to each model's own pre-sequence capacity estimate, the Micro/Crusher
changes were -1.01%/-2.23% originally, -0.18%/-1.24% for context only and
-0.08%/-1.36% for robust. The smaller dip alone is not grounds for promotion.

Initial September 28 decision: keep both candidates in Research. The September
29 chart release adopts context-only weighting for descriptive capacity, without
claiming improved predictive accuracy. Research retains the previous fit and
robust alternative for ongoing comparisons. Settings → Research → Review earlier workouts
→ Does earlier training explain trend changes? shows error tables by grip and
session context and an optional chart preview. The downloaded report includes
all observations, paired intervals and chronological splits. Rerun after new
workouts; do not select constants to explain one episode or promote a candidate
solely because it makes the chart smoother.

CLI: `node --no-warnings scripts/evaluate-contextual-trends.mjs /path/to/reps.json`.
Do not commit private exports. Tests cover session chronology, cross-grip prior
work, unknown/tied times, bounded day weighting, future-data isolation, duplicate
handling, monotone positive curves, isolated outliers, sustained changes, and
chart default selection and opt-in robust previews.
