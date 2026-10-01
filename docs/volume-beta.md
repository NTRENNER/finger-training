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

The between-set rest target is five minutes **per hand**, measured from that hand's last activity release to its next pull. Other-hand training counts toward this interval. Both hands get their own rest check before their second set. Reaching zero never starts a hold automatically. Athletes can start when ready, extend the rest, or finish the day; actual rest is preserved without a compliance penalty.

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

Both betas require three calendar months of recorded finger-training history and at least two distinct training days in 10 of the most recent 13 complete rolling seven-day windows, ending yesterday. This permits three lighter/missed weeks and does not impose a streak. The calendar-month anniversary clamps to the last day of shorter months. Today's unfinished day does not affect eligibility until tomorrow.

Attendance is per user across Micro, Crusher and Prime: hands, extra sets and multiple sessions/grips on the same date count once. Positive recorded training work counts even when an interruption prevents use in the predictive curve. Peak-only measurements, seed artifacts, invalid dates, future entries and empty records do not count. This is an access rule, not evidence that added volume is beneficial or that the curve is accurate.

The setup shows locked switches with the rule and qualifying-week count. Existing domain-measurement requirements still apply. Access is recalculated from the current account's history, including after inactivity, and checked again when starting a beta workout and enrolling/resuming Volume. An ongoing workout is not interrupted when eligibility changes. Existing experiment dates, recorded workouts and research reports are preserved; pausing and ending a plan remain available in Research. No schema migration or automatic enrollment is required.
