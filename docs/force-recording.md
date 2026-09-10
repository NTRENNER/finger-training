# Force-duration recording and interrupted reps

The recording uses device sample timestamps (including counter rollover), not Bluetooth packet arrival time. It integrates every force interval from the first pull sample to the first release sample. Weaker work stays in the measurement. The release-confirmation delay is excluded from both duration and average. Peak remains a separate metric. The average describes variable effort; it does not claim the force was constant throughout the hold.

For example, 5 seconds at 30 kg plus 25 seconds at 15 kg records a 17.5 kg time-weighted average over 30 seconds, with a 30 kg peak. The saved recording metadata includes observed duration and force-time integral.

Target time determines the prescribed load. The athlete continues to muscular failure. During a rep, “Rep interrupted” saves the effort with `failure_valid: false`. Sensor disconnects, device sample gaps over one second, and a silent stream over 1.5 seconds automatically invalidate the observed effort. Automatic release detection cannot distinguish muscular failure from a mechanical slip; the athlete uses the interruption action for a known interruption.

The recorded effort remains visible in activity/history. Invalid efforts are excluded from force-duration fitting, prescription anchors, endurance fitting, performance levels and server fatigue learning. Recovery comparisons reject a set containing an interrupted rep instead of joining the remaining reps across a missing effort. The latest interrupted session cannot advance the density ladder.

Existing protocol, ladder constants, and zone names are unchanged. Historical rows retain their previous failure-protocol semantics. New measured steady pulls are not mistaken for legacy seeded rows just because rounded average equals peak. Old recordings cannot be corrected without their original sample traces.

## Rollout

Apply `supabase/migrations/20260910_rep_force_recording.sql` before deploying this client. It adds nullable recording fields and gates the existing server fatigue trigger. Applied to the production Grip Lab database on September 10, 2026; all three fields and the learner guard were verified. Deploy the client only after the migration succeeds; an older schema will reject the new payload columns and leave writes queued locally.

Automated checks exercise steady/fluctuating/declining pulls, abrupt release, unequal sample spacing, batched Bluetooth packets, interruption and release gating, disconnection, silent equipment failure, manual recording, model exclusions, and cloud payload round-trip. Physical Tindeq validation remains a rollout check.
