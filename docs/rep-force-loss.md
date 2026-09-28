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
