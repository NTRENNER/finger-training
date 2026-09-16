# Cookedness: what the slider is for, and what it is not

This records why the per-grip fatigue β learner was deleted in September 2026, why the cookedness slider was kept, and what the climb log had to change for its fatigue number to mean anything. The conclusion is that perceived fatigue is worth listening to when the athlete states it and not worth estimating when they do not.

## The learner was not estimating anything

`fatigueBeta.js` maintained a per-grip scalar β and scaled prescriptions by `exp(−β·cooked)`, updating β by online SGD after every session — in the client, and again in a `SECURITY DEFINER` Postgres trigger on rep insert. Its output was disconnected from load in July 2026 after it ran away to β ≈ 0.46, producing up-to-3× load corrections and a distorted curve fit. The learner and the trigger were left running on the theory that the numbers were a harmless readiness diagnostic.

They were not harmless. At deletion the stored values had railed to both clamp boundaries across users and grips: 0.5, the hard maximum, on two grips, one of them with 62 observations; and 0.0034, effectively the minimum, on three others. An estimator that ends at both ends of its own clamp is not measuring a quantity, and had anything reconnected that output to load, `exp(−0.5 × 7)` would have prescribed three percent of capacity.

Three independent problems make the quantity unrecoverable, and any one of them is sufficient.

It is not identified. The app scales the prescription by the cooked value before the pull happens, so the treatment is a deterministic function of the covariate and the residual cannot separate "he was tired" from "we already made it lighter." Cleaner input does not help; only randomising the scaling would, and nobody wants their training randomised to settle a modelling question.

The regressor had almost no variance. 74% of sessions were unrated or zero. The climb-derived suggestion that filled much of the rest saturated: 49 of 69 logged climbing days scored exactly 10.

What variance remained was partly sign-flipped. Session fatigue counted logged rows, and a projecting session — eight burns on one boulder, sent on the eighth — is one row. The most fatiguing sessions therefore scored *below* a twenty-climb lap day, so the measurement error was correlated with the truth in the wrong direction rather than merely noisy. Over 159 rated openers the observed correlation between cookedness and capacity was r = −0.025, and at a residual noise of sd 0.816 roughly 1150 sessions per group would be needed to resolve a real effect of the expected size. That null is uninformative, not evidence of absence.

## What replaced it

Closed-loop correction. The next prescription learns from the measured outcome of the last one, and a measured pull already contains whatever fatigue, sleep or a cold garage did to the athlete that day. Predicting the disturbance is open-loop control; measuring the output is not, and this app has the sensor. The governing design principle is to bound error rather than minimise it: a missed target is free until it crosses a zone boundary, and tolerance is +145% at 5 s against ±15% at 160–220 s, so effort belongs at the long end of the curve and not in modelling how tired someone felt.

`replay --policy` scores this directly, one step ahead over every pair of consecutive same-target sessions in the real history. The shipped engine reaches a median |ln err| of 0.202 and puts 59% of sessions in the planned zone; holding the previous load gives 0.746 and 39%, and the best proportional-correction rule tested gives 0.511 and 43%. A proposed replacement for the engine's damping was rejected on this evidence.

The slider stays, reframed. Someone who knows they are wrecked should be able to say so and be listened to, at a rate the interface states outright: 2.5% per point, floored at −25%. It is a published constant, so it cannot drift, and Settings shows the whole table rather than an inspector for a learned parameter.

## Provenance

A number the app inferred is not a self-report, and storing one as the other destroys the only field that could ever carry real information. Until September 2026 two paths did exactly that: an untouched slider defaulted to 0 and was written to `reps.session_cooked` as "I was fresh", and the climb-derived suggestion pre-filled the slider on mount and was saved the same way. Both are gone. `config.cooked` defaults to null, the suggestion is offered beside the slider with a one-tap apply, and nothing reaches storage that the athlete did not enter.

Rows written before this change cannot be repaired — a stored 0 is indistinguishable after the fact from a real one — so pre-September cookedness should be treated as unreliable rather than cleaned. There is deliberately no `cooked_source` column: every remaining writer is the user, so the field needs no qualifier.

## The climb log

Two defects, either of which flattens the scale on its own.

The score saturated. `clamp(1, 10, round(Σ·0.12 + max·0.4))` reaches its ceiling at a weighted RPE sum near 50, so a 15-climb day and a 45-climb day were the same number. The linear sum now passes through `10 × (1 − exp(−raw/6))`, which is strictly increasing everywhere; the constant 6 reproduces the old "one RPE 9 effort → 5" calibration point and moves "eight RPE 7 climbs" from 10 to 8, reserving the top of the scale for days carrying several times that work. Re-scored against the real log, days reading 10 fall from 71% to 20% and 65 of 69 days take distinct values.

Volume counted rows rather than efforts. `activities.attempts` now records how many times a climb was tried, so one row says "V7, eight attempts, sent" instead of demanding eight near-identical entries that nobody was going to write. Null means one, which is what every earlier row already meant, so no backfill is implied and history keeps its meaning. The consequence is that the inversion is fixed prospectively only: on the existing log the projecting days move little, because the attempt counts were never recorded. Logging one hard climb over eight burns moves 2026-09-13 from 7 to 9, 2026-09-04 from 7 to 9, and 2026-08-24 from 6 to 9.

This number feeds the climb log's own display, the slider's suggestion and the deload detector. It is deliberately not an input to load prescription, and fixing its calibration is not an argument for reconnecting it — the identification problem above survives any amount of recalibration.
