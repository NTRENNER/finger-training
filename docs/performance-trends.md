# Performance trend charts

Analysis → Fingers shows the measured-progress card visibly beside two linked
performance cards: **Estimated finger capacity over time** and **Session
performance versus expected curve**. These views describe recorded finger
training. They do not establish a change in climbing ability or rested capacity.

## Shared scope and date window

The two-handle date slider changes only the visible window; moving the handles
to the ends restores all dates. The charts, summaries, duration comparison and
opening-hold inspector use the same window. Each grip's summary identifies its
latest available estimate inside that window, which may precede the window's
end date when grips were trained on different dates.

Fits always use history available at each plotted date. Grip and hand changes
reset the window; new history preserves a deliberately selected date window.
Date, duration and session-order filters do not refit or rebase the curves.
Slider counts mean plotted training dates, not repetitions or sessions. Rest
days do not generate points. Single-date windows remain supported.

## Estimated finger capacity over time

The default is the existing context-only established-curve fit: a 90-day
half-life, at most one total weight per training date, and reduced weight for
later sessions after earlier recorded finger work across grips. This weighting
does not numerically correct for climbing or accumulated fatigue.

The whole-curve score is the geometric mean of predicted force at **5, 30, 70,
115, 160 and 220 seconds**. Both-hand capacity takes the geometric mean of the
two hand scores with equal hand weights and requires a curve for each hand.
Each selected hand needs five eligible prior-or-current dates to produce the
first estimate. This availability rule does not establish reliable coverage
across all six durations.

The original starting reference is preserved, separately for each grip:

    change since starting reference = 100 × (current score / starting score − 1)
    change from highest estimate    = 100 × (current score / highest score − 1)

The highest estimate is the highest whole-curve score available **by the
latest shown date**. It can precede the selected window. Future peaks cannot
change an earlier summary. The second percentage is a ratio change, not a
subtraction of chart percentages: a score moving from 100 to 120 and then 115
is 15% above its start and about 4.2% below its high. Both reference dates are
shown explicitly. This reference is separate from the older frozen-baseline
curve-improvement summary.

### Breakdown by hold duration

The six-duration table compares predicted force at the latest shown estimate
with either the highest whole-curve estimate or the first estimate in the shown
range. It uses the same fitted curves and equal hand weights as the main chart.
The comparison dates appear for each grip. The highest whole-curve estimate is
one reference date for all six durations; it is not six independent duration
records. Some durations can therefore improve while the combined score falls.

These are modeled force changes at fixed durations, not six direct performance
tests. A cell is marked **Limited support** if either comparison estimate lacks
repeated nearby measurements for any selected hand.

### Starting-reference quality and coverage

The performanceTrendEvidence module annotates the existing fit without altering
its outputs. The starting reference retains the evidence available when it was
set; later history never silently replaces it or upgrades its historical
coverage. The latest shown estimate has separate coverage information. An early
reference can remain provisional while later duration coverage improves.

Local support is an engineering coverage rule: at least two distinct eligible
training dates **for every selected hand** within ±25% of a reference duration,
or ±3 seconds when that is wider. Repeated holds on one date cannot manufacture
additional supporting dates. These counts include older evidence through the
estimate's date. Expanded details show measured duration ranges, nearby date
counts and last measurement dates so coverage age is inspectable.

The labels are not statistical confidence intervals, a recent-coverage test,
recovery estimates or instructions to collect more workouts. Recording formats,
interval bases and stopping-policy versions are disclosed where recorded;
unknown stopping policies remain unknown. Differences are a comparability
limitation, not a numerical adjustment.

A starting reference is marked provisional when local coverage is incomplete,
recording methods differ, or a leave-one-date stability check is unavailable.
The stability check removes whole training dates and uses only history available
at the starting reference. It never relaxes the existing five-date eligibility
gate. If removing a date would leave a selected hand below that gate, the result
is **Insufficient for stability check**, not zero uncertainty. When available,
the displayed range is sensitivity to those omissions, not a confidence interval.

## Session performance versus expected curve

Each point is one eligible measured opening hold, compared with the established
curve available **strictly before that training day**, evaluated at its observed
comparable duration:

    deviation = 100 × (measured average force / expected force − 1)

A −20% point means 20% less force than that prior curve predicted at that
duration. It does not mean 20% less maximum strength. The prior curve can have
model error and can borrow information from the other hand. That day's results
cannot change their own expected force.

The chart uses unconnected points, with grip colors and symbols for actual
duration groups: short (up to 45 s), medium (over 45 through 120 s), and long
(over 120 s). These groups help compare the points; they do not change the
training-zone definitions. Duration and recorded-session-order filters expose
comparable subsets. Outlined points identify earlier recorded finger training;
a dashed outline identifies unknown session order. First-recorded points do
not imply that the athlete was rested.

Only durations within that hand's prior observed range are scored. Later
fatigued repetitions, interruptions, manual load estimates and duplicate
evidence cannot supply opening performance points. Eligible later **session
openers** can appear, with their recorded earlier-training context. Recording
intervals use the shared conversion rules; incompatible transitions cannot
produce short-term scores. Where acquisition time was added for an older
interval comparison, the inspector says so. Stopping-policy differences remain
a limitation even when intervals can be compared.

Hover details and a keyboard-accessible hold selector show the date, grip,
hand, measured and expected force, comparable duration, session order and
recording limitations. Selecting a point never updates a workout record.
The legacy daily short-term aggregate remains unchanged for other consumers:
within-day deviations are averaged per hand, then available hands are averaged
equally. The chart now exposes the individual evidence behind that aggregate.

## Climbing context, units and interpretation

Orange bars show the existing load estimate from logged climbing on the plotted
date and previous day. They use a separate 0–10 scale; a score of 10 occupies
the bottom quarter of the chart. The bars do not enter either curve or adjust
the plotted force. A date with no climbing log has unknown exposure. Same-day
climbing may have happened before or after the hold. Recorded finger-session
order cannot establish the order of unlogged activity or recovery from it.

Both cards use absolute measured force; force details respect the selected kg
or lbs display unit. A note explains that the bodyweight toggle applies to the
other curve charts. Chart scales include a minimum ±5% range to avoid visually
magnifying tiny changes.

The fitted curves, starting reference, daily aggregates, stored workouts,
prescriptions and 4–5–6 ladder are unchanged. Experimental robust smoothing and
the original fit remain available in Research; their chart annotations use the
selected model. See [contextual-performance-trends.md](contextual-performance-trends.md)
for those alternatives and [measured-progress.md](measured-progress.md) for the
independent measured-session comparisons shown beside these charts.

## Validation

Tests cover unchanged numeric outputs across all chart models, reconstruction
of the daily short-term aggregate from individual observations, causal peak and
starting-reference ratios, equal hand weights, duration decomposition,
independent-date coverage, historical stability after future records are added,
eligibility and recording-basis guards. UI checks cover shared date windows
without refits, date-labelled comparisons, duration/order filters, selectable
measurement details, force units, and missing/single-hand evidence. Responsive
browser checks use synthetic history at phone and desktop widths.
