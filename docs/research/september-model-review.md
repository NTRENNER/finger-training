# Coverage and prediction research — September 24

## Changes

The raw rep-2 retention display no longer applies a universal 70–90% reference band or good/bad classification. It shows the observed percentage and approximate forecast. Model-relative recovery coaching and deload calculations are unchanged.

Alternate domain tiles now preserve that domain's earned rep ladder, target duration and resolved load. Athletes can still select any available domain or return to the recommendation. Whole Curve continues to use its independent curve-based loads, not ordinary ladder pins. Its later holds remain separate from opening-hold evidence.

Domain history distinguishes planned-domain training exposure from valid opening-hold evidence at the actual achieved duration. Bilateral holds count once per session. Interruptions and optional-set openers cannot refresh first-set evidence. Historical scheduling ignores future-dated records.

New research breakdowns expose errors by position, device, hand, planned domain, actual rest band, recording method and prior training days. Each day receives equal weight inside each group. These are descriptive learning curves, not proof that more sessions cause improved accuracy.

Saved load stages show the experimental established estimate, recent change, bounded candidate and actual planned workout load. The candidate still does not set workout loads.

New ordinary-session snapshots include a before-opener recovery scenario using the frozen capacity estimate and planned rests. This is separate from forecasts updated after the observed opener and conditional checks using measured rest. Scoring the before-opener scenario requires compatible duration basis and all preceding forces/rests to match plan. Old forecasts are not backfilled or relabelled.

## Validation and ongoing review

Schedule simulations cover three-day and weekly spacing, climbing days and a missed week. All five domains are selected during 15 simulated opportunities. Earned 4→5→6→load progression survives visits to other domains. This establishes those cases, not a universal guarantee against starvation with every possible performance history.

Run `npm run evaluate:windows -- /path/to/reps.json` for the prespecified offline comparison: 90-day half-life versus last 30 eligible grip sessions. Both retain both hands, equal day weighting, legacy quality weighting and the same fit/bounds. All outcomes use strictly earlier dates. “Current” in this experiment means the time-weighted established candidate, not the deployed recommendation engine. Reports include matched force, bounded force and planned-load time checks and breakdowns.

Review each ten new comparable training days at `/research`. Inspect domain/hand error, signed bias by hold number, recording basis, coverage and large misses. Keep versions separate and demand prospective benefit before promoting a candidate. No automatic tuning or candidate promotion is added here.

See [evidence-context.md](evidence-context.md) before implementing a modified-training mode.
