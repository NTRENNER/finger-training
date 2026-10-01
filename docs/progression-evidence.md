# Evidence for finger progression

The 4–5–6 ladder and manual choice of another domain remain available. A new
domain uses its existing initial prescription. A recorded attempt is different
from no history: interruption, missing rep slots, changed loads, or unknown rest
retain the attempted rung and target instead of returning to initial defaults.
Repeating an interrupted attempt does not award the preceding success twice.

New ordinary sessions freeze a per-hand `force_recording.session_prescription`
snapshot: version 1, target duration, planned reps per set, planned rest, original
target load, hand mode, and the known base target before any elected reduction.
The existing JSON field carries this metadata. Optional sets retain the same
session plan. Old workouts are not rewritten. Without a saved plan, the previous
earned rung and the available recorded target provide a qualified fallback.

`progressionSetEvidence` checks the complete original sequence, including rep 1,
all planned slots, unchanged setup and domain target, usable measurements, and
comparable loads (the existing 10% recovery-comparison tolerance). Easier later
pulls cannot demonstrate that an extra rep is earned at the opening load. The
same evidence check qualifies optional-set advice. A later optional set cannot
substitute for an incomplete first set. Modern records must retain explicit rep
slot numbers; positional numbering is only a legacy, untimed compatibility path.

Measured rest runs from the previous release to the next pull starting. Acquisition
time stays separate. If the plan says 20 seconds, beginning to pull at 22 seconds
and reaching the target at 24 seconds is ordinary execution. It does not fail an
adherence check. Recovery forecasts use the measured 22 seconds; the existing
coarse conformance thresholds judge performance. An extra 30 seconds of rest is
also represented honestly rather than treated as 20 seconds of recovery.

Untimed legacy rows can retain an explicit planned-rest estimate. Modern rows
with an explicitly unknown rest, or an unobserved release, do not justify a new
recovery-based progression decision. Plateau comparisons allow five seconds or
25% difference between measured rest intervals, whichever is larger, rather than
requiring identical human timing. These are comparison tolerances, not athlete
deadlines or physiological recovery laws.

An elected load reduction does not measure how much capacity was lost to fatigue.
Its observed forces are not divided by the reduction. A reduced-load session
repeats the same rung; if the original base plan was saved, that plan can be
restored without awarding extra reps or load. With no known base plan, the actual
recorded load remains the reference. A future ordinary session at the base target
can earn the next rung normally.

Regression tests cover interrupted attempts, missing/deleted/duplicate slots,
changed loads, the frozen planned count, measured versus planned rest, ordinary
reaction/acquisition delay, unknown release, base-plan restoration, and earned
4–5–6 progression.
