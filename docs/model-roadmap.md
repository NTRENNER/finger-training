# Model roadmap: how the recommender learns

Agreed November 2026 (Nathan, with reviews by Claude and ChatGPT). This
governs every change to how the app measures, models and recommends finger
training. Change this document, with a version note, before changing the
rules it sets.

## Goal

Recommend the session with the largest expected gain in the **balanced curve
score** per day of recovery, inside fixed safety rules, and fall back to the
safe default when the evidence is thin.

- The balanced score is the geometric mean of predicted force at the six
  reference durations (5, 30, 70, 115, 160, 220 s), so an equal % gain in any
  domain counts equally. Literal force-time area is rejected: on real fits
  95–97% of it is the slow component (see `computeBalancedCurveScore`).
- The three curve components are regression timescales, not measured
  alactic, glycolytic and aerobic capacities.
- Benefits the curve cannot see (rate of force development, climbing
  transfer) are protected by guardrails, not optimized.

## Layers

Change one layer at a time and judge it with the others held fixed.

| Layer | Decides | Evidence |
|---|---|---|
| Measurement | What counts as a valid rep or fresh opener | Stored records match what happened |
| Curve | The athlete's current force-duration curve | Held-out prediction error by duration |
| Response | How training changes the whole curve | Prediction of later curve change |
| Policy | Which session to recommend | Recommendation audit, then prospective comparison |
| Progression | Load and reps inside the session (density ladder) | Rep 1 within 0.8–1.25× target |
| Display | One checkable "why" line | Less is more (CLAUDE.md) |

## Evidence gates

Every change to a model layer passes all of these:

1. **Hypothesis first.** Write the change, the metric, and the result that
   would reject it before running the test.
2. **Leak-free.** Evaluate with strictly earlier data only, per athlete and
   pooled. Commit the evaluation script; report aggregates only.
3. **Do no harm.** No athlete with at least 20 scored training days may get
   worse by more than 1 percentage point in any duration band.
4. **Mixed evidence means no change.** (Example: the anchor rule, 2026-10-24.)
5. **Prospective confirmation.** A change chosen on past data is exploratory
   until it also holds on data logged after the decision (at least 4 weeks or
   20 fresh openers per athlete, whichever is later).
6. **Versioned and reversible.** Every model, policy and progression change
   bumps a version that is stored with each decision, and the previous
   behavior stays selectable.

Personal parameters shrink toward a population value until data supports
them, and need observations across at least three duration bands (a slow
time constant also needs at least two long-hold sessions).

Population values change only when a predefined evidence threshold is met,
as a versioned update, not on a fixed schedule: two athletes are not enough
to retune them continually.

## Measurement

- Only fresh opening holds (rep 1, set 1, first session for that grip and
  hand that day) update the curve or a learned response.
- **Outcome windows** after a session or block:
  - acute, days 2–7: fatigue, not adaptation; recorded but not learned from;
  - adaptation, days 8–21: fresh openers scored against the curve frozen
    before the session;
  - block response: change against the curve frozen at the start of the
    block, from standardized tests or fresh session openers.
- **Curve-evidence coverage** (the rings) asks whether there is current
  evidence across the curve. **Training exposure** asks whether a domain got
  enough stimulus, and counts qualifying later reps and sets. They are
  separate rules; the policy never schedules an opener only to refresh a
  ring.

## Decision log

Before any further model change, every prescribed session stores the frozen
decision, so audits read it instead of reconstructing it:

- recommended grip, domain, duration, hand, load, reps and rest, and whether
  the ladder or the curve engine set them;
- the leading alternatives with their score terms;
- constraints that changed the result (caps, ladder rules, coverage);
- curve snapshot (time constants, amplitudes, anchor) and evidence cutoff;
- what the athlete selected and whether it overrode the recommendation;
- engine, policy and progression versions.

The completed workout and its measurements are already stored with the reps.

## Stages

Each stage is unlocked by evidence, not by date.

| Stage | Policy | Unlocked when |
|---|---|---|
| 0 (2026-11) | Coverage rotation, weakness signal as tiebreaker, density ladder | — |
| 1 | Coverage becomes a minimum-exposure guardrail; personal slow time constant | Decision log live; personal constant passes the gates above |
| 2 | Duration-to-duration carry-over estimated, with uncertainty | Emphasis-block protocol completed by at least two athletes |
| 3 | Maximize expected balanced gain per recovery day, with bounded exploration | Beats Stage 1 prospectively (below) |

The weakness signal ("below your curve") gains weight only after it predicts
a response: flagged gaps must close more when trained than when not.

**Stage 3 evaluation.** Alternating blocks still mix in carry-over and time
effects. When two candidate sessions are both safe and both satisfy the
minimum-exposure rules, choose between them at random and compare outcomes.
Athletes agree to this explicitly before it starts.

## Emphasis blocks

The protocol is written and fixed before anyone starts (pre-registration):

- within an athlete, A-B-B-A order where possible; across athletes,
  counterbalanced starting order;
- matched total workload between blocks as closely as practical;
- a defined maintenance dose for every domain outside the emphasis;
- measurements defined in advance and taken the same way in every block;
- 3–4 weeks as a pilot, 4–6 weeks per block once the protocol is proven;
- success and failure criteria stated in advance.

## Guardrails (never optimized away)

Minimum exposure in every domain including max strength; peak-force and
long-hold load caps; progression limits (+5% ladder steps, at most +20% after
an overshoot); recovery spacing; deloads.

## Scorecard

- **Outcome:** balanced-score growth per month, per athlete.
- **Instruments:** rep 1 within 0.8–1.25× target; held-out force error by
  duration; the recommendation audit (`npm run audit:recommendations`).
- **Guardrails:** whether athletes keep training.

Review monthly: rerun the scorecard against the last snapshot, adopt or
retire changes through the gates, and invite outside review of proposals.
Audit tooling, roadmap changes and production behavior go in separate
commits, because they carry different risk.

## Data

Accounts pool for model work with consent (CLAUDE.md, Supabase); analysis
keeps athletes separate and reports aggregates only; exports stay out of git.
A formal data policy follows as the user base grows.
