# Volume Beta

Volume Beta is an optional personal six-week trial of two ordinary sets per selected grip. It is designed to document whether the extra work coincides with useful progress at an acceptable recovery and time cost. A before/after observation does not establish that extra volume caused an improvement.

## Enrollment and schedule

- The Volume switch opens setup. Nothing starts until the athlete selects grips and presses **Start Volume Beta**.
- The original start date anchors 42 calendar days, including the start date. The target is three sessions per week per grip, or 18 sessions per grip. Two grips therefore target 36 grip sessions, which may occur on the same 18 training dates.
- Each workout uses its normal chosen domain, first-set targets and earned 4–5–6 progression. The experiment adds one set; it does not change the prescription algorithm or escalate again because of set two.
- Complete the first set's planned holds for the selected hands before continuing. Early muscular failure is a valid hold; an interrupted or incomplete measurement is not a completed slot. Finishing after one set remains available and its work stays recorded.
- The second set uses the same targets and hold count. No third set is offered by Volume Beta. Ordinary training outside the beta retains its existing optional-set behavior.
- The Chaos and Volume switches select mutually exclusive workout modes. Choosing Chaos does not pause the six-week plan, but that workout does not count as a completed two-set Volume session. Peak tests and initial boundary measurements also do not receive the Volume prescription.
- Pausing/resuming keeps the original dates. Expired plans stop applying automatically; recorded results remain available. Enrollment requires loaded history and settings for signed-in accounts.

## Rest and measurement

Selected multi-set workouts automatically open a full five-minute break after the last hand finishes each set, when another selected set remains. There is no summary-page Continue tap and no second rest screen at the hand switch within the following set. A one-hand workout starts the break after that hand finishes. Reaching zero never starts a hold automatically. Athletes can start when ready, extend the rest, or finish the day; actual rest is preserved without a compliance penalty.

A confirmed physical release supplies the rest origin, not the earlier credited force-failure endpoint. Manual stop taps are identified as manual timing. If release was not observed, the timer starts conservatively from when the hold was recorded; this estimate is marked separately and never saved as measured rest. Set-two opening holds save planned and actual/estimated rest context in `force_recording.volume_beta.between_set_rest` and the existing `rep_timing` fields.

Every beta rep retains a frozen protocol snapshot and experiment ID in `force_recording.volume_beta`. `set_num` identifies first and second sets. Existing fresh-evidence and progression rules exclude later sets; these holds remain useful for activity dose, fatigue and recovery review. Historical workouts are never retagged.

## Historical comparison

The baseline is frozen at enrollment from the prior six weeks. It uses eligible opening holds from the first session and first set of each grip/hand/date, excluding peak tests, seed artifacts, interrupted holds and incomplete measurements. Load must be measured or explicitly known, not an unverified spring setting.

For each grip/hand, the latest eligible historical force becomes a comparison load. Up to three distinct recent dates within 3% of that force and with the same setup, force source, timing basis, recording version and failure policy form the baseline. Experimental comparisons use the latest three eligible, tagged opening holds matching those same constraints. Original measured forces and durations remain visible; there is no retrospective timing conversion or normalized force substitution. A small load difference can still affect duration, so this remains descriptive.

Fewer than three matches in either period is provisional. Missing historical evidence stays missing; the app does not silently replace a fixed baseline with later measurements. A changed detector or setup can leave a comparison empty even when training continues. Existing Analysis charts remain available for broader curve trends.

## Review and interpretation

The compact training summary shows week and completed sessions per grip. `/research`, available through Settings, retains the detailed review:

- Started dates, completed two-set dates, hand sets and recorded pulling time. Both hands count as one grip session; at most one completed session per grip/date counts toward the 18-session goal.
- Historical training frequency alongside current attendance. Returning to a regular schedule is a confound, not automatically a volume benefit.
- Raw matched opening-hold comparisons, dates and uncertainty labels.
- Rest before second sets and a downloadable report containing the plan, baseline, comparisons, tagged reps and activities during the experiment.
- Six optional weekly reviews of climbing, fatigue, time commitment and notes such as travel or sleep changes.

Review progress together with climbing quality, fatigue and time cost. This pilot has no randomized control, cannot separate all concurrent changes, and does not automatically declare a winning dose or increase volume. Extra sets are not required when ordinary training is producing satisfactory progress.

## Persistence

The existing account-scoped local cache and settings patch queue store plans. Cloud settings use an immutable `volume_beta_plan_<id>` record plus separate lifecycle and per-week review keys, so a stale weekly review cannot overwrite a pause and separate experiments/weeks do not erase each other. Activation requires a durable retry-queue write. No database schema migration is needed, and the trial is not enabled for any user until explicit enrollment.

## Beta access (Chaos Machine and Volume)

Both betas qualify each grip separately: three calendar months of recorded training for that grip and at least two distinct training days in 10 weeks within any historical 13-week period. This is earned experience: lighter training, travel and breaks do not revoke access. The calendar-month anniversary clamps to the last day of shorter months. Today's unfinished day does not affect eligibility until tomorrow. Historical periods use complete rolling seven-day windows; counting is independent of the weekday on which eligibility is checked.

Attendance is per user and per grip (Micro, Crusher or Prime): hands, extra sets and multiple sessions on the same date count once for that grip. Training another grip cannot unlock it. Positive recorded training work counts even when an interruption prevents use in the predictive curve. Peak-only measurements, seed artifacts, invalid dates, future entries and empty records do not count. This is an access rule, not evidence that added volume is beneficial or that the curve is accurate.

Before eligibility, setup shows the rule and best historical qualifying-week count. Once eligible, the two switches appear with short descriptions of their intended use. Existing domain-measurement requirements still apply. Access is recalculated from the current account's history and checked again when starting a beta workout and enrolling/resuming Volume. Volume enrollment and resume require eligibility for every included grip, and workout start rechecks the selected grip. Plateau invitations use the same per-grip rule. Ordinary set selection remains available regardless of eligibility. Switching accounts or deleting qualifying records can remove eligibility; inactivity alone cannot. Recent attendance, fatigue and plateau evidence still govern invitations, separately from access. An ongoing workout is not interrupted when eligibility changes. Existing experiment dates, recorded workouts and research reports are preserved; pausing and ending a plan remain available in Research. No schema migration or automatic enrollment is required.


## Plateau invitations

Eligibility unlocks voluntary access; a plateau is not required to use either beta. A separate research screen can suggest an optional Volume experiment after persistent comparable performance stalls. It does not automatically enable a beta or change loads, holds, rest, or the curve. Chaos remains a different session-structure experiment and is not recommended simultaneously with Volume.

The version-1 screening policy compares native fresh opening failure holds at force within 1% of the latest benchmark, separately by grip, hand and intended duration domain. Timing basis, recording version, failure policy, setup, measurement source, protocol and recorded starting hand must match. Later sessions (including work after another grip), additional sets, non-opening Chaos holds, interrupted/incomplete capacity measurements, reported cookedness of 6 or above, and unknown daily order are excluded. Session ordering is determined before filtering conflicting measurements. Missing fatigue ratings are not treated as reported freshness.

A comparison needs at least three distinct dates in each of two adjacent 28-day periods. Median duration change within ±5% is considered a possible flat result only if each period's full duration range is at most 15% of its median. The same force/method comparison must also be flat in a window ending 14 days earlier, and its most recent measurement must be within 14 days. These are deliberately conservative, unvalidated screening thresholds—not confidence intervals or proof of physiological stagnation. Sparse evidence stays insufficient. A longer hold at higher force is not penalized by converting through the curve; it simply cannot establish a same-force plateau until comparable observations accumulate.

An invitation requires a persistent plateau in the same domain on both hands, beta eligibility, and steady recent attendance for that grip: at least four training dates per 28-day period, recent/earlier frequency between 0.75 and 1.33, activity in six of eight weeks, and no gap over 14 days. Measured improvement or decline elsewhere in the grip, increased/high reported fatigue, recent extra sets/Chaos, an existing active or paused Volume experiment, or a substantial increase in logged climbing attempts block the invitation. Missing climbing/fatigue context is disclosed; it does not imply recovery. The prompt asks users to consider climbing quality and fatigue before explicitly reviewing/enrolling. “Not now” dismisses it for the current grip view.

At explicit enrollment, a bounded screening receipt (date, version, thresholds, reasons, per-domain comparisons and limited observation IDs) is frozen alongside the existing historical baseline. The receipt records whether setup was opened from the plateau prompt or voluntarily. Research and downloaded Volume reviews retain it through sync, reviews, and lifecycle changes. Future history cannot rewrite the enrollment receipt. Personal before/after changes remain observational and cannot prove that extra volume caused improvement.

Validation: synthetic tests cover genuine flat patterns, growth, decline, noise, short flat patches, unilateral differences, travel, changed measurement methods, altered force, interrupted/later work, confounders, duplicate records and future-data exclusion. Replaying the saved 953-rep personal export at July 1, August 1, September 1 and October 1, 2026 produced no beta invitations: training gaps and/or sparse comparable fresh measurements prevent a plateau conclusion. This validates conservative handling of the known travel periods; it does not establish detector sensitivity on real plateaus.


## Independent workout set selection

Users can choose one to five sets per hand before an ordinary workout, without meeting beta eligibility or enrolling in research. Eligible Chaos users have the same selector. One remains the default. Selected multi-set workouts automatically show a full five-minute break between completed sets, with explicit readiness to start the next set and the ability to stop early. Normal load targets and the earned 4–5–6 holds remain unchanged.

An active Volume Beta applies its fixed two-set plan. Changing the set selector opts this workout out of the study without pausing or ending enrollment. Merely choosing two sets never enrolls a user. Independent workouts carry `force_recording.workout_plan` (selected sets, selection source, and later-set opening rest), not `volume_beta`; the latter is reserved for enrolled protocol workouts. Later sets remain excluded from fresh fitting and ladder advancement.


### Rest-policy provenance

New selected multi-set records carry `rest_policy: full_set_break` in
`workout_plan` (and `volume_beta` when enrolled). Earlier recordings used a
same-hand countdown that credited the opposite hand's training time. The
existing actual/estimated rest fields still measure each hand's own release
to next pull, including opposite-hand work, so researchers retain the real
recovery interval across this protocol change. Invalid or incomplete Volume
Beta sets still stop for review rather than automatically proceeding.
