# The deload detector: why it never fired, and what fixed it

This records why the recovery gauge sat on green for five months, why that was a property of the threshold rather than of the training, and what it now reads. It is the companion to `cookedness.md`: that document is about a signal worth deleting, and this one is about a signal worth repairing. The difference between them is the whole argument.

## Why this one is worth keeping

The cookedness slider asked the athlete to predict a disturbance before the pull. This reads between-rep recovery out of the measured force trace — an output, observed on the athlete rather than inferred about them. That puts it on the closed-loop side of the design, which is the side that survives scrutiny. So the verdict here is repair, not deletion, even though the symptom was similar: an indicator with no working range.

## What it was doing

Replaying all 51 checkpoints across the real history: 48 green, 3 yellow on a single grip, and the deload recommendation **never fired once**.

Not because nothing happened. The gate compared each grip's recent recovery gap to an absolute −0.15, and that is not where the statistic lives. The per-grip mean sits at a median of **+0.187** (Crusher) and **+0.157** (Micro), because the recovery model under-predicts this athlete. Against each grip's own spread, −0.15 is **1.85 and 2.02 standard deviations** below typical — and the cross-grip gate then requires both grips to be there simultaneously, on the order of a 0.07% event per checkpoint. Expected firings over five months: about 0.04. It behaved exactly as that arithmetic predicts.

The bias was known. The constant's own comment recorded the statistic as "centered POSITIVE at +0.09 / +0.14" and the absolute threshold was kept anyway. Noticing a miscalibration is not the same as propagating it.

## Reading each grip against itself

The gate now asks whether recovery is down *for this athlete, on this grip*, which is what the card always claimed to say. One standard deviation below the grip's own median, cross-grip, is the trigger; the absolute threshold survives only as a fallback for a grip without enough history to have a baseline yet (13 of 51 checkpoints here, all early).

The baseline has to be scored the same way the judged window is — out of sample — or the comparison is between two different quantities. Reusing the already-scored earlier sessions will not do: those are in-sample for the tau fit, and on this history that shifts the Crusher baseline median by 0.062, a quarter of a standard deviation, in the direction that makes the recent window look healthier than it is. Micro shifts by 0.001, so the bias is per-grip and cannot be corrected with a constant. Instead the pre-window sessions are split in half: taus fit on the older half, the newer half scored against them as the baseline distribution. A floor on the baseline spread stops a metronomically consistent athlete from generating a six-sigma alarm out of an ordinary wobble.

What changed on the real history: yellow went from 3 to 5, and the gauge acquired a working range — pressure now spans 0 to 0.64 with a median of 0.02, where before it was pinned at 0 at nearly every checkpoint. Two of the yellows are genuine cross-grip softening (2026-06-05 and 2026-07-11) that the absolute gauge had no way to express at all.

Red still does not fire. Both grips a full standard deviation below their own medians at once did not happen in five months. The threshold was deliberately not tuned down to produce a firing: after recentering, "it did not happen" is a finding about the training, where before it was an artifact of an operating point two standard deviations outside the data.

## A correction worth recording

An earlier pass claimed the recentered gate fires on 2026-07-06 and 2026-07-11. It does not. That estimate z-scored each window against the full history *including its own future*; with honest out-of-sample baselines those days come out at −0.44 and −0.66 standard deviations, well short of the trigger. Lookahead flatters a detector, and the first version of the analysis was flattering this one. It is why the baseline is split-half rather than global.

## The evidence it reads something real

**2026-06-05.** Between-rep recovery down on both grips (−0.62 and −0.67 sd). Climbing acute:chronic at **1.77×**. Nineteen climbs logged that day. And the athlete rated themselves **cooked = 0**.

Three measurements agreeing against one self-report is the case for this detector in a sentence, and it is the same finding as `cookedness.md` approached from the other direction.

More generally, the recovery statistic correlates with climbing load in the preceding three days at **rho = −0.33** (n = 51, p < 0.05), with the correct sign: more climbing, slower between-rep recovery. Honest caveats — that is one of four windows tested, the 7-day version (−0.229) does not clear, and restricting to climbing days only drops it to −0.200, so part of the effect is "climbed recently versus did not" rather than a dose-response within climbing days.

## Climbing as context, not as a gate

That correlation is also the reason the detector can now see the climb log at all; before, it read finger sessions and lifting only, and was blind to the largest systemic load in the week. Climbing enters exactly as lifting does: an acute-versus-chronic spike that escalates a mild deload to strong, never something that can recommend one on its own. On real climbing history the acute:chronic ratio is 1.05 at the median and 1.99 at p90, so the 1.5 threshold marks roughly the top eighth of days.

The decision stays with the measured recovery. Load history says how hard to take the finding, not whether to have it — which is the same rule that keeps the cookedness slider out of the prescription path.

## The card

A gauge that reads green for five months does not deserve the top of the Session Setup tab and a full-width gradient bar. Prominence should track information content.

It collapses to a single line carrying the state and its colour, and opens on yellow or red, on a tap, or while the history scrubber is in use. The first cut put the reopen affordance on the collapsed row but the close affordance in a muted eleven-pixel word beside the title; the first person to use it reported there was no way to close the card. The whole header row is the control now, with a chevron and keyboard access, and collapsing also returns the scrubber to "Now" — otherwise an active scrub holds the card open and the toggle looks broken.

The card itself has moved to Analysis → Fingers. It is read from between-rep recovery across grips, which makes it a finger diagnostic, and it belongs with the other diagnostics rather than on the first screen of the app — where, for someone with no history yet, it is furniture. It opens by default there, since arriving on that tab is already the decision to look.

Nothing actionable was lost by moving it. The deload banner already lived on Session Setup and renders only when the detector actually fires, so the gauge was redundant exactly when it mattered. The banner now also carries a single quiet line for the softening state, which is short of the cross-grip bar a deload needs but is still worth knowing before a session; it appears only once a grip has enough history to be judged against itself, so a new user will not see it.
