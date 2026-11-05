# Emphasis-block pilot protocol

**Status:** v0.4, 2026-11-02. Phase 1 starts with one athlete (Nathan, A1)
on 2026-11-02; other athletes may join in 2027 if phase 1 looks promising.
Pre-registered for A1 when committed with the calendar below; after that,
changes need a dated note here (see `docs/model-roadmap.md`, "Emphasis
blocks").

v0.4 (per Nathan): no separate test weeks, because every session goes to
failure and so measures (see "Measurement"); blocks are 28 days of the
athlete's usual routine, and any grip may be trained on consecutive days.

2026-11-02, before any pilot session: the start moved from Tue Nov 3 to
Mon Nov 2 (the first calendar mislabeled Nov 3 as a Monday), so blocks run
Monday to Sunday, and the yardstick cutoff moved with it.

## Question

For each athlete, how do four weeks emphasizing the **short end** of the
force-duration curve and four weeks emphasizing the **long end** change peak
force, force at short, middle and long durations, and the balanced score?
How much of each emphasis carries over to the durations it did not train?
This is the duration-to-duration carry-over the recommender needs (roadmap,
Stage 2). And how do these changes compare with growth under the coverage
rotation the app used before the pilot?

**What is compared:** two realistic programs over **the same 28 days of the
athlete's usual routine**, with the pre-pilot coverage rotation as a
reference. They differ naturally in force, duration and fatigue; time under
tension and load × duration are recorded, not matched.

This round is a **pilot**: it estimates effect sizes and tests whether the
routine is workable. It does not need to confirm any physiological
hypothesis.

## What we estimate (stated before data)

1. **Specificity:** the change at each duration in each block.
2. **Carry-over:** how the short-end change relates to the long-end change
   in each block, reported as both changes with uncertainty, not as a ratio
   (a ratio is unstable when one change is near zero).
3. **Max carry-over:** peak-force change in each block, as its own outcome.
4. **Whole curve:** balanced-score change in each block. No direction is
   predicted.

## Design

- **Blocks.** A = short end (max strength, power, power-strength: targets
  under 90 s). B = long end (strength, strength-endurance, endurance:
  targets of 90 s and up). Each block lasts 28 days; block 2 follows
  block 1 directly.
- **Order.** Two blocks per athlete, order drawn at random, roughly half
  starting each way. An athlete may later run the reverse pair for a
  within-person A-B-B-A answer.
- **Phase 1 (one athlete).** With no one to balance across, the reverse
  pair matters more: A1 plans B-A-A-B and decides at the end of block 2
  whether to continue. Athletes joining later get their own start and a
  balanced random order.
- **Grips.** All of the athlete's grips follow the block emphasis, and each
  is analyzed separately, so a grip that falls short of its dose yields less
  data, not a biased comparison. A1: Micro (primary, about two sessions a
  week), Crusher and Prime (target about one a week each; A1 is building
  consistency on both). Including every grip also keeps an unchanged grip
  from feeding the other end of the curve into shared forearm muscles. All
  grips switch emphasis on the same date.

## Block dose

Finger training follows every climbing session, and any grip may be trained
on consecutive days. Every session on a grip takes that grip's **next step
in its cycle**, repeating the cycle as needed. How many sessions a block
holds is whatever the athlete's routine produces; counts are recorded, and a
difference of more than 25% between blocks is flagged.

**Micro (A1's primary grip, about two sessions a week):**

| # | Block A (short end) | Block B (long end) |
|---|---|---|
| 1 | Max strength | Strength (~115 s) |
| 2 | Power (~30 s) | Strength-endurance (~160 s) |
| 3 | Power-strength (~70 s) | Endurance (~220 s) |
| 4 | Maintenance: strength (~115 s) | Maintenance: power (~30 s) |
| 5 | Max strength | Strength |
| 6 | Power | Strength-endurance |
| 7 | Power-strength | Endurance |
| 8 | Maintenance: endurance (~220 s) | Maintenance: power-strength (~70 s) |

**Crusher and Prime (target about one session a week each):**

| # | Block A (short end) | Block B (long end) |
|---|---|---|
| 1 | Max strength | Strength (~115 s) |
| 2 | Power (~30 s) | Strength-endurance (~160 s) |
| 3 | Power-strength (~70 s) | Endurance (~220 s) |
| 4 | Maintenance: strength (~115 s) | Maintenance: power (~30 s) |

- Block A's max-strength sessions run at the 5 s reference duration with
  the curve's load; their reps and rest are confirmed in a dated note
  before block A starts.
- One set per session; no optional extra sets. Loads and reps come from
  the app's normal prescription for that domain (density ladder).
- **Warm-up Peak Tests** continue unchanged (A1 runs them on Crusher and
  Micro at essentially every warm-up, before climbing), so max exposure is
  identical across blocks; their frequency is recorded. Block A adds
  max-strength *training sessions* on top of that routine.
- **No unchanged reference.** With every grip in the blocks, nothing stays
  on the normal rotation to show general or seasonal improvement; the
  reverse pair (B-A-A-B) handles time trends instead.
- **Low dose:** a block with fewer than 6 Micro sessions is flagged; blocks
  are never extended. Crusher or Prime sessions below target are recorded as
  reduced dose for that grip.

## Measurement

Every session is to failure, so the blocks measure themselves:

- **Session openers.** Each session's first rep (set 1, rep 1) is a fresh,
  to-failure measurement at a known load and duration. The days since that
  grip's previous session are recorded with it, because a session the day
  after another may carry residual fatigue.
- **Peak force.** The warm-up Peak Tests, before climbing, on almost every
  climbing day.
- **Yardstick.** Each grip and hand is scored against its curve **frozen at
  the start of the pilot**: fit on all fresh openers before 2026-11-02 at
  curve model version 1, so it is reproducible from the data. Each opener is
  read as a percentage above or below the yardstick at its duration. The
  yardstick's own shape errors stay constant through the pilot, so they
  largely cancel when the same duration is compared over time.
- **Fixed-load checks.** The ladder repeats the same load across sessions
  in a domain within a block (for Micro, cycle steps 1 and 5, 2 and 6, 3 and
  7), giving direct changes in time to failure at an unchanged load.
- **Both ends in every block.** The maintenance sessions cover the other
  end of the curve, and the Peak Tests cover max.
- **Trade-off accepted:** there is no fixed-load before-and-after across
  blocks; comparisons across blocks go through the frozen yardstick.

## Background load

Recorded weekly and compared between blocks: finger-training sessions and
their time under tension and load × duration on every grip, climbing
sessions with duration, RPE and main style (endurance or bouldering), trips
and unusual workload. If weekly
background load differs by more than 25% between blocks, the pair is flagged
as contextually mismatched.

## Outcomes and analysis

Per athlete (pseudonymous) and pooled; descriptive; aggregates only.

- **Primary:**
  - peak-force change across each block, from the warm-up Peak Tests;
  - change at each duration against the frozen yardstick, from the
    session openers (emphasized and maintenance durations);
  - balanced-score change: the curve refit on each block's openers and Peak
    Tests (with the yardstick's shape as prior), compared with the curve at
    the start of that block.
- **Model-free check:** the fixed-load changes in time to failure from the
  ladder's repeated sessions.
- **Coverage reference:** the same measurements (openers against the same
  frozen yardstick, fixed-load repeats, Peak Tests) over the coverage
  training before the pilot, in two windows of about four weeks since
  2026-09-10, when force-based failure began (earlier holds ended on release
  and are not comparable). Each block's change at each duration is set
  beside the change at that duration in those windows. Growth slows as an
  athlete gets stronger, so this reference probably favors the past; it also
  shows how much a four-week window moves without an emphasis.
- **Secondary:** shape-specific change after subtracting the athlete's
  overall balanced-score change.
- Hands weigh equally; each grip is reported separately.
- **Days since the grip's last session** is a covariate for each opener.
- **Same-day climbing** is a covariate. Nathan's history cannot estimate it
  yet: climbing was logged on only 24 of 51 training days, the logged days
  were all hard (scores 5.0–9.6 of 10), and within them no dose-response was
  detectable (−0.4% per point, 90% range −3.1% to +4.0%; 2026-11-01). So
  every climbing session is logged during the pilot, and the adjustment is
  estimated from pilot data.
- **Noise.** Historical variation of comparable fresh openers is reported as
  context. Individual effect sizes carry uncertainty; pooled results are
  descriptive, not confirmatory.

## Model freeze

From the start of block 1 to the end of block 2, the production curve,
recommender and progression versions stay fixed (urgent fixes excepted and
logged). The decision log's version stamps verify this.

2026-11-05, rep recording (curve, recommender and progression unchanged):
an optional Redo replaces the last rep in its slot and keeps the disputed
attempt as recorded work, excluded from capacity and recovery evidence.
When the app confirms a failure while the Tindeq still reads load, it asks
"Still holding?" at once, and Continue keeps the original clock. Prompted by
Prime L rep 3 on 2026-11-04: early settling dips confirmed a failure at
5.9 s, credited 1.3 s, while the hold continued above target for about 15 s.

## Missed training

Sessions missed for any reason (illness, schedule, or anything unexpected)
are recorded with the workload change, and the block is marked modified or
incomplete under the low-dose rule. Missed work is never made up with extra
volume later. These devices have a 2.5-year injury-free record for A1, so
injury is not expected; if anything does come up, the athlete's judgment
overrides the protocol and the event is recorded.

## Participant information (to share before anyone starts)

- This is an experimental training protocol among friends, not medical care.
- Data analyzed: your reps (force, duration, load), climbing and workout
  logs, and the app's decision records.
- Results are pseudonymous; your data may also be pooled to improve the
  app's model for everyone.
- You never have to follow a recommendation that feels wrong to you.
- You can withdraw at any time; tell Nathan, and your data stops being used
  for the pilot.
- Connect the Tindeq for every finger session, on every grip, and log your
  climbing sessions in the app.

## Pilot success

**Phase 1 (A1):** two interpretable blocks with Micro trained at its usual
frequency in both; estimates at both ends of the curve and for peak force;
documented background load and deviations; and enough signal to decide
whether to continue to B-A-A-B and to invite others.

**Full pilot:**

- At least three athletes complete two interpretable blocks.
- The primary grip is trained at its usual frequency in both blocks.
- Peak-force and per-duration effect estimates can be calculated.
- Background workload and deviations are documented.
- The data suffice to design a better-powered confirmation round.

## App and analysis work

- **Pilot mode** (joined on the Research page): the plan card shows each
  grip's next cycle step with a small "Pilot · Long end · day 5 of 28"
  label. Steps count the grip's earlier training days in the block, so a
  step holds for the whole day. The density ladder still sets load and reps
  for domains trained before; a new domain starts from the curve at its
  reference duration.
- **Decision log (v2):** the recommender's own pick stays the logged
  recommendation, with every domain's best alternative; the pilot step is
  recorded beside it, and choosing another session is logged as an
  override of the step. Peak Tests are identified by their protocol tag and
  date, so they need no decision record.
- **Offline:** the frozen yardstick, the coverage reference,
  training-exposure accounting (all qualifying holds, including later reps),
  the end-of-block curve fits, and a weekly background-load export.

## Calendar

**A1 (Nathan).** All grips in the blocks: Micro (primary), Crusher and
Prime. No travel planned.

- Random draw, 2026-11-02T03:00:38Z (node:crypto randomInt(2), one draw
  each): block order **B-A** (long end first). The same draw set a test
  order (peak, 30 s, 115 s, 220 s) that v0.4 no longer uses.
- Block 1 (B, long end): Mon 2026-11-02 to Sun 2026-11-29. Includes
  Thanksgiving. It falls in A1's endurance climbing season (noted
  2026-11-02, after the draw), which adds long-end stimulus to block B,
  and to block A if the season continues. Climbing style is part of the
  background record, and the reverse pair separates season from emphasis.
- Block 2 (A, short end): Mon 2026-11-30 to Sun 2026-12-27. Includes
  Christmas.
- Decision point, about Dec 28: continue to B-A-A-B, invite other athletes
  in the new year, and ship model changes held by the freeze.

Other athletes: to be added with their own start, draw and dates.
