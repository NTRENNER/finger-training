# Rep force loss and physical release (policy 8)

A brief partial adjustment can recover. A sustained loss ends the credited hold.
A near-zero release finishes the recording and advances to rest. These are separate
endpoints: weaker pulling after a loss is work, never rest.

## Live behavior

- Acquire a working hold after 300 ms continuously within tolerance. Exact-target
  acquisition is no longer required: 13.5 lb counts against a 14 lb prescription.
- The tolerance remains the larger of 7% and 1 lb, capped at 20% for very light
  targets. Unit selection does not affect it.
- Use a 300 ms time-weighted trailing mean, integrated with device timestamps.
- Allow four seconds after that mean crosses below tolerance. Clearing a pending
  loss requires 750 ms continuously back within tolerance. One good sample cannot
  reset it. A 1–2 second partial dip followed by a steady return continues the rep.
- Confirmed loss freezes credited time at the smoothed crossing and shows
  “Rep complete — release the handle.” Further recovery cannot reopen that hold.
- Recording continues until a full second below min(0.5 kg, 10% of target).
  Backdate physical release to the first sample in that sustained near-zero run.
  Near-zero releases use this shorter confirmation, not the partial-dip grace.
- Rest starts after confirmed physical release. Its measured start is the release
  onset, not the earlier force-loss cutoff. The visible countdown also credits
  release-confirmation and render delay; a 20-second rest normally opens at 19
  seconds after one-second release confirmation. Unknown or interrupted endings
  start the countdown at completion instead. Both manual-start and automatic sensor
  training use this rule. Timed warmups and peak-test protocols retain their
  existing detection; manual stopwatch training is unchanged.
- Even a sub-1.5-second attempt completes the UI, with invalid failure evidence,
  rather than silently discarding it and leaving the timer running.

These timings are engineering choices to test with real use, not physiological
claims. An unload lasting one second cannot be distinguished online from an
intended release; it ends the rep. The athlete can always mark a rep interrupted.

## Stored measurements

New targeted recordings use force-recording version 4 and failure-policy version 8.
Existing records are not rewritten.

- `actual_time_s` and average force cover acquisition through credited end.
- `activity` covers the full force-time integral from initial pull through physical
  release, including acquisition and the weaker tail. This feeds activity/fatigue.
- `credited_end_at_ms` explicitly preserves the capacity endpoint.
- `rep_timing.ended_at_ms` uses the physical activity endpoint for measured rest.
- `target_band_time_s` and `target_band_fraction` describe actual time above the
  prescribed tolerance boundary, unlike the older average-relative `in_band_fraction`.
- `force_loss` retains smoothed above/below runs and confirmed recovered excursions.
  These audit this policy; they are not a raw trace for arbitrary threshold replay.
- `recording_stop_reason` distinguishes release, manual stop and equipment loss.
  `capacity_end_reason` distinguishes release from sustained force loss.
- A cumulative 300 ms or more of recovered near-zero unloading marks the credited
  interval intermittent and excludes continuous-capacity learning. It stays visible
  as activity, without prematurely ending the live rep.
- Stream gaps, disconnects and manual interruption remain invalid failure evidence,
  including when loss had already been confirmed but release was not observed.

The historical `target_acquired` basis identifier remains for compatibility;
`acquisition_basis: sustained_tolerance_band` identifies the new acquisition rule.
Legacy interval conversion still adds only acquisition time, never the weaker tail.
Policy changes can alter credited duration; past and current records are not claimed
byte-for-byte equivalent.

A new policy-8 confirmed target loss can weaken a demonstrated-capacity floor under
exactly the same existing load/duration/session requirements as a release failure,
but only with measured release and eligible capacity. Older target-loss rows retain
their conservative treatment. The 4–5–6 progression itself is unchanged.

## Missing-release backstop and unloaded zero check

Release-backstop policy 1 stops a targeted sensor recording 15 seconds **after
confirmed force loss** if near-zero release has not been observed. It does not
shorten the four-second partial-dip window. A normal confirmed release wins if it
arrives at the deadline. No acquired/confirmed loss means no backstop; warmup and
peak protocols that opt out of target-drop detection keep their existing behavior.
Signal gaps or disconnects still produce invalid failure evidence, not a valid
timeout result.

The saved result uses `recording_stop_reason: release_not_observed`. The already
frozen credited endpoint and eligible capacity remain intact. `release_uncertain`
and `recovery_eligible: false` describe the missing physical endpoint. Activity
keeps its observed duration/integral and `observed_until_at_ms`, but its
`ended_at_ms` is null and `endpoint_quality` is `release_not_observed`. Neither
that activity tail nor an invented rest interval can feed recovery fitting or
Chaos Machine adjustments. Existing measured force is not retrospectively tare
corrected. The next rep's measured rest remains unknown.

The visible rest countdown pauses and rep arming stays blocked until the athlete
explicitly selects **Handle unloaded — zero Tindeq** with the handle and attachments
hanging freely. This issues tare, then requires 500 ms of fresh readings within
min(0.25 kg, the release threshold) of zero. Failed verification times out after
five seconds, leaves the gate blocked, and offers retry. Disconnect cancels the
verification; reconnect alone cannot clear it. Tare is never automatically issued
by auto-detect or during a detected pull. On successful verification, a full rest
countdown starts from the check, without claiming the uncertain earlier interval
was measured rest. The same optional zero action is available before a pull.

Four seconds is intentionally unchanged: shortening confirmation can convert a
recoverable dip into a permanently completed rep. This is not purely a UI timer.
The small smoothing delay in the credited cutoff also remains unchanged.

## Bounded force-loss provenance

Detailed `force_loss` version 2 uses millisecond offsets from acquisition
(`time_basis: acquisition_offset_ms`), retaining first eight and last eight runs
and recovered excursions. Arrays are bounded while recording, not just at save.
`run_count`, `excursion_count`, truncation flags, `below_boundary_ms`, and
`recovered_excursion_ms` retain totals across omitted entries. Runs stop at loss
confirmation; their summaries are not a raw trace for threshold replay. The live
UI snapshot retains device-clock timestamps and excludes arrays. Historical
version-1 details are left unchanged; this provenance is not research cache data.

## Live hold clock, interrupted exits and planned dose

The targeted hold clock now uses the same device timestamps as the credited
measurement. It stays at zero while acquiring the target and pauses at the
provisional cutoff while checking a force dip. Sustained recovery restores the
whole interval and resumes the clock; confirmed loss freezes it at that cutoff.
A near-zero release also pauses immediately, before its confirmation delay. It does not count the
initial force ramp as hold time or keep advancing during a stalled sensor stream.
Untargeted peak/warmup protocols and manually timed pulls keep their own clocks.

Planned rest, measured unloaded rest, and acquisition are separate. For example,
with 20 seconds planned rest, beginning to pull at 22 seconds and acquiring target
at 24 seconds records 22 seconds of rest plus 2 seconds of acquisition. The ramp is
activity, not rest; taking those normal extra seconds is not itself a failure.

Ending a session during a pull saves that attempt before completing the session.
Leaving the training tab saves it as interrupted activity and stops its recorder.
Returning cannot silently resume the old pull. These exits do not establish a
capacity failure, but their measured activity and independently valid two-second
maximum remain recorded. StrictMode effect replay does not create an interruption.

A pull that never acquires the target can be ended with **Finish attempt — target
not reached**, even if an unloaded attachment keeps measured force above the normal
release threshold. It saves activity-only evidence and requires an unloaded zero
check before another pull. Neither a timeout nor this explicit action invents a
muscular-failure endpoint.

Ordinary sessions preserve their initial dose in
`force_recording.session_prescription` (version 1): target duration, planned pulls,
planned rest, per-hand prescribed load, hand mode, and the unadjusted base load when
known. Each saved row carries a copy; interrupted attempts and optional sets retain
the plan. Measured overpulls or later changes to a fatigue rating cannot rewrite it.
