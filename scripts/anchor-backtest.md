# Amplitude-anchor backtest — cross-zone vs zone-scoped

`prescription()` builds a load as `curve_shape(T) × amplitude_anchor`. The
curve SHAPE is fit cross-zone (good). The **amplitude anchor** pins that
shape to a recent rep. Two options:

- **cross-zone (current default):** the single most-recent rep 1 at ANY T.
  A recent overshoot anywhere lifts the whole curve, and the prescription
  always lies ON the displayed F-D curve (one global amplitude).
- **zone-scoped (`opts.zoneAnchor`):** prefer the most-recent rep 1 in the
  requested zone, falling back to cross-zone when there's no same-zone
  history. Stops a light endurance rep from rescaling a max-strength
  prescription — the audit's concern.

## Method

Time-separated forward-chained holdout over ~5 months of real fresh rep-1s
(179 across Micro/Crusher/Prime). For each session, both strategies run
through the exact `prescription()` on prior-only history (`referenceDate` =
the session date); the target is the load the user actually used at rep 1.
Reproduced by `src/model/__tests__/anchorAnchor.backtest.test.js`
(self-skips in CI; set `ANCHOR_BACKTEST_JSON`). Relative abs error
`|prescribed − actual| / actual`.

## Result — mixed

| subset | n | median err (cross → zone) | mean err (cross → zone) | zone better/worse |
|--------|---|---------------------------|--------------------------|-------------------|
| all testable | 158 | 0.147 → 0.156 | 0.536 → 0.490 | 36 / 37 |
| hit-target (\|t−td\|≤30%) | 110 | 0.136 → 0.144 | 0.466 → 0.396 | 31 / 30 |
| anchor differs | 73 | 0.136 → 0.155 | 0.510 → 0.410 | 36 / 37 |
| hit-target & anchor differs | 61 | 0.136 → 0.146 | **0.46 → 0.33** | 31 / 30 |

The anchor differs in **46%** of sessions (the newest rep is usually from a
different zone — the user rotates zones). Zone-scoping:

- is **flat-to-slightly-worse on the median** (~1pp), and a **tie
  head-to-head** (roughly equal sessions better vs worse),
- but **cuts the mean / tail error ~28%** on the discriminating hit-target
  subset (0.46 → 0.33) — i.e. it prevents the occasional *bad* mis-prescription
  where an off-zone rep rescales a distant zone (exactly the audit's failure
  mode). The benefit is entirely tail-risk reduction, not typical-case.

## Cost discovered while implementing

Zone-scoping makes the engine's amplitude **zone-local**, so the prescription
no longer sits on the single displayed F-D curve at distant zones (it broke
the coaching engine/chart consistency test — ~7% divergence at one zone).
"What you see is what you get" is a property worth keeping.

## Decision

Net-mixed: flat median + tie head-to-head + a real consistency cost, against
a tail-risk reduction. So the **default stays cross-zone**, and zone-scoping
ships as an **opt-in flag** (`prescription(..., { zoneAnchor: true })`) for a
caller that wants the tail-risk reduction where curve consistency matters
less. Revisit if more data (or a user report of an off-zone rep tanking a
prescription) shifts the median.
