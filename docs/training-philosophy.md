# Grip Lab — Foundational Training Philosophy and Architecture

## Core philosophy

- Finger training typically follows climbing.
- Working efforts are intended to reach RPE 10 or task failure within safe, pain-free loading limits.
- The individualized strength-duration curve drives exercise prescription.
- Missing a target is a normal training outcome and an additional data point, not inherently a problem requiring intervention.
- Cookedness describes session-specific exertion, not general recovery or readiness.

## 1. Prescription engine

The strength-duration curve is the authoritative source for prescribed weight and duration. The prescription engine continuously learns from valid recorded efforts, including those that fall short of predicted targets. Coaching must not override the curve or interpret individual missed targets as evidence of inadequate consistency, strength, or recovery.

## 2. Behavioral coaching engine

Coaching addresses modifiable training behaviors beyond the scope of the prescription engine:

- Training frequency.
- Training volume.
- Distribution of volume across training days.
- Spacing between training days.
- Distribution of training across grips and protocols.

Recommendations require sufficient evidence, meaningful effect sizes, acceptable statistical uncertainty, and appropriate consideration of confounding variables. Evidence sufficiency must not be determined solely by elapsed time or an arbitrary number of sessions.

Never generate a coaching recommendation merely to populate the interface. **Silence is a successful coaching outcome when evidence is insufficient.**

## 3. Analysis and research engine

Maintain clear distinctions between:

- Frequency: distinct training days.
- Volume: training blocks, sets, repetitions, and cumulative loading exposure.
- Loading characteristics: weight, duration, grip, and protocol.
- Outcomes: longitudinal changes in modeled strength and endurance.

Multiple training blocks performed on the same day increase volume but not frequency. Different grips and protocols may produce distinct, overlapping training stimuli. Two Micro blocks and one Crusher block on a single day count as one training day and three blocks, not three independent training days.

The Analysis tab may display emerging relationships with appropriately communicated uncertainty. Findings should graduate to coaching only when sufficiently reliable, meaningful, and actionable. Distinguish adherence from target attainment, and do not infer general readiness from cookedness.

### Research development

The architecture should support:

1. Individual longitudinal analysis.
2. Population-level analysis using appropriately consented data.
3. Randomized controlled trials with informed consent and appropriate ethical oversight.

Observational associations must not be represented as established causal relationships. Where possible, distinguish frequency effects from volume, climbing exposure, grip, and protocol effects.

## Governing principle

**The curve prescribes. Analysis discovers. Coaching communicates. Research validates.**

Grip Lab should continuously learn from every valid training effort without feeling obligated to offer advice after every workout.
