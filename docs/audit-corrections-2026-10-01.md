# Training evidence corrections — October 1, 2026

This work implements the correctness stage of the September 30 review and
prepares the next prospective research stage. It does not establish an optimal
training dose or promote an experimental model to the live recommender.

## Correctness release

- Freeze an ordinary session's intended rep count, target, load, base load,
  hand mode and planned rest in its existing recording metadata. An interrupted
  attempt retains its rung and known plan instead of falling through to a new
  domain's defaults.
- Require the original opener, complete planned slots and comparable force
  before awarding progression. Optional sets cannot conceal an incomplete
  first set. Users can still select another domain and retain its progression.
- Use measured release-to-pull rest for recovery comparisons. Starting a
  20-second-rest rep after 22 seconds is normal human variation, not failed
  adherence. Time spent acquiring target force remains recorded activity;
  it does not become credited time at that target. Legacy planned-rest
  estimates retain their stated uncertainty.
- Base persistent recovery messages on comparable first-session, first-set
  evidence across independent dates. Later work remains descriptive activity.
  A single depleted day cannot masquerade as multiple recovery days. Stale
  observations become unknown; a green gauge is not a requirement to resume.
- Finalize active work when ending a session or navigating away. Preserve
  interrupted activity and independently valid sustained force records without
  converting an interruption into valid failure evidence.
- Show credited device time on the main hold clock. Acquisition begins the
  interval, a pending force dip pauses its provisional endpoint, and recovery
  restores the interval. The saved capacity duration follows the same rule.
- Keep pending writes with their original local account. Check the final
  request token as well as the page owner, and do not acknowledge or clear
  another account's pending work after asynchronous account changes.
- Retire the duplicate fresh-opener research competitor. Version new
  predictions as `measured-capacity-v4`; retain the distinct established-capacity
  plus recent-performance challenger and historical experiment records.

Choosing a cookedness load reduction also no longer divides measured force by
that reduction to invent fresh capacity. An explicitly saved base prescription
can be restored as a plan, separately from what the athlete demonstrated.

## Research sequence

1. Collect frozen, versioned prospective predictions. Keep conditional force,
   advance duration, later-rep recovery and target-attainment outcomes separate.
   Use independent training dates and inspect large misses and relevant context.
2. Before starting a dose comparison, choose the actual blocks and primary
   measurements in [the proposed dose experiment](research/training-dose-experiment.md).
   Compare Chaos as a replacement for ordinary work initially, preserving the
   ordinary 4–5–6 ladder as the reference.
3. Review new evidence without silently changing policy. A challenger or dose
   must show a repeatable practical benefit without unacceptable recovery or
   climbing cost. Tied or insufficient evidence supports keeping the simpler
   incumbent. Historical replay remains a development diagnostic.

See [progression evidence](progression-evidence.md),
[recording and force loss](rep-force-loss.md),
[account ownership](sync-ownership.md), and
[prediction review](prediction-review.md) for implementation contracts.

Automated regression coverage includes ordinary human rest delays, interrupted
rungs, changed loads, missing slots, same-day depletion, session navigation,
clock/recording agreement and asynchronous ownership races. Repository CI runs
the complete test suite and production build for pull requests and main pushes.

Validation: 1,645 tests passed, 3 skipped; 169 suites passed, 3 skipped.
The production build and offline app-shell verification passed. Sensor lifecycle
checks use simulated device packets, including React StrictMode; no physical
Tindeq session was performed for this release. No historical workouts were
rewritten, production database changed, or dose experiment activated.
