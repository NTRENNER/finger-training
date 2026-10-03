# Force-duration recording and interrupted reps

Target time determines the prescribed load. The athlete maintains that load until muscular failure; continuing at a substantially reduced force does not extend the rep.

## Target-loss policy

Current targeted training uses [force-loss policy 8](rep-force-loss.md): a 300 ms
smoothed force signal, four seconds to recover from a partial drop, and a 750 ms
steady return to clear it. A sustained hold within tolerance acquires the rep;
exact-target spikes are not required. The tolerance remains the larger of 7% or
1 lb, bounded at 20% for very light targets. A near-zero release confirms after one
second. Timed warmups and peak-test protocols retain their own existing behavior.

Confirmed loss freezes credited time and asks the athlete to release. Recording
continues until release so the weaker tail remains activity and cannot become rest.
Version-4 recording pairs capacity force with credited duration, preserves full
activity separately, and stamps the policy on both target-loss and release endings.
See the policy document for exact thresholds, metadata and continuity exclusions.
Older policy versions and recorded workouts are retained without rewriting them.

Opening overshoot, sustained overshoot, and force variation remain usable for curve fitting. The fitted observation uses actual time-weighted force over its recorded duration, never substitutes the prescription for measured force, and does not reject a valid failure because its force varies. Variability and plateau metrics are descriptive. Incomplete sensor records and interrupted efforts remain excluded. A targeted attempt that never reaches target is not valid failure evidence.

“Rep interrupted” preserves activity and excludes failure learning. Disconnects, sample gaps over one second, and silent streams over 1.5 seconds invalidate the observed effort. A mechanical slip cannot always be distinguished from failure; the interruption action is available for known interruptions. Interrupted efforts cannot establish peak records.

## Actual rest and recovery

New records retain start/end timestamps and actual same-hand rep-end-to-next-start rest separately from prescribed rest. Unknown rest remains unknown. New nominal spring settings and prescription-only loads remain activity rather than measured capacity evidence. Manual nominal loads can anchor an explicitly estimated load recommendation (evidence weight 0.5); they cannot establish measured capacity floors or recovery calibration. Interrupted nominal rows cannot anchor. The manual-only coach keeps the last prescribed duration and labels its estimated recommendation.

Older baselines are not silently compared to the new interval basis. Where a grip spans the change, target-acquired records are expressed on the earlier whole-pull interval by adding their recorded `acquisition_s` back to the capacity duration, which retains the earlier acquisition-inclusive convention. This does not reconstruct work after a force-loss cutoff or erase differences between detector policies; the working-force average is left unchanged. The conversion runs only in that direction — rows predating the change never recorded an acquisition time, so they cannot be moved onto the newer interval. A grip recorded entirely on one basis keeps its native intervals, and a target-acquired row lacking `acquisition_s` is excluded from a spanning grip rather than compared across bases. Stored rows are never rewritten: the conversion is applied when a comparable series is read, and `force_recording.duration_s` continues to hold the native at-target interval. Because every rep stays in one series, a grip keeps its baseline, its curve and its capacity floor across the change, and nothing needs to be chained across a gap.

## Replaying a real history

`npm run replay` runs a rep export through the engine and prints every number that decides training: prescribed load and its governing rule at six durations per grip and hand, the capacity floor, baseline dates and rep counts, recovery constants, deload state, and the evidence labelling mix. `--snapshot` records the current answers and `--check` diffs against them, naming each decision that moved. The export and the snapshot are gitignored; real training history does not belong in the repository. Run it before and after any change to the prescription, evidence or recording layers — the synthetic unit suite has passed through every regression that reached production, because a synthetic fixture tests what its author anticipated and this tests the database.

Recovery learning requires a consecutive opening sequence with valid endings, measured comparable loads (maximum/minimum at most 1.10), consistent setup and load source, and measured rest at every interval. Predictions use each interval individually, including zero rest. An interruption ends the comparable prefix; earlier valid comparisons remain available. Fitting requires at least three eligible reps. Pre-capture legacy measured sets may use planned rest at half fitting weight, labeled as historical estimates. New missing metadata is not promoted to measured evidence.

An interrupted pull with complete force/time recording still contributes fatigue dose but cannot be failure-capacity evidence. Missing and null actual rest use the same estimated planned-rest fallback. Missing work or unavailable rest leaves subsequent fatigue unknown; those later rows are excluded from fresh-capacity fitting rather than treated as fresh. A new session resets the sequence.

If sensor duration is unavailable, finalization preserves wall-clock elapsed activity with `duration_basis: elapsed_activity_estimate`, never measured failure data. Partial usable sensor duration is retained without inventing force across the missing interval. Manual-started sensor reps remember that they used a device and remain interrupted after a disconnect or reconnect.

## Release status and verification

The original force-recording migration was applied on September 10, 2026. This follow-up also requires `supabase/migrations/20260911_rep_timing_and_evidence.sql` before its client deployment. It adds timing/provenance fields and extends the existing server learner guard. The follow-up migration was applied and verified on September 10, 2026; this release includes the matching client.

Tests cover steady pulls, normal fluctuations, opening overshoot, gradual decline, sustained target loss, brief dips, abrupt release, batched timestamps, rollover, interruptions, real rest, recovery comparability, and cloud round-trip. Production and offline-shell builds pass. Physical Tindeq validation remains outstanding. Protocol, ladder constants, and zone names remain unchanged.


### Historical capacity floor calibration

Three independent, comparable lower opening efforts within 30 days establish a decline. The first floor reduction is limited to 25%; each additional qualifying session can permit one more reduction, bounded by 25% and the load demonstrated by that comparison. A stronger comparable performance resets confirmation. Replaying unchanged or duplicated history cannot create another reduction. The confirmation window is evaluated at the evidence session date, so established reductions survive that window aging out; the existing 90-day historical-best eligibility remains in effect.

An explicitly valid muscular failure shorter than the requested duration can weaken the floor when its prescribed load matches the replayed floor (within 0.11 kg for storage rounding), the target was acquired, and measured average force remains between 93% and 105% of that load. This uses the recorded prescription to reconstruct floor matching because historical rows do not store whether the floor raised the recommendation. Such a miss does not establish capacity at the requested duration. Interrupted, unacquired, substantially overshot, different-setup, and later-set efforts do not qualify.


### Release between ordinary training reps

After a target-force ending, the automatic workout view disarms rep callbacks
but briefly keeps the force stream running to observe the athlete unloading
the handle during rest. Once release is observed it stops the idle stream.
The watch is bounded to 10 seconds; a new rep stream cancels its pending stop.
Release samples are also recognized while no rep callbacks are installed,
including during an in-flight stream-start command. Rest samples cannot start
or save reps. If release has not been observed, the next workout screen asks
the athlete to fully release rather than silently showing “Pull to begin.”
The release requirement is preserved; it is never cleared merely by time passing.


### Brief signal interruptions

During failure-based training, a force-stream delivery pause shows a waiting message after 1.5 seconds and
allows up to five seconds for samples to return. A Bluetooth disconnect keeps
an active rep through one reconnect attempt and restarts the automatic stream.
The workout screen keeps its current detector instead of re-arming a new rep.
Buffered samples with continuous device timestamps can finish the same valid
rep. The grace period does not add hold time: integration still uses device
samples, and a device-time gap greater than one second or a clock reset ends
the observed effort as interrupted. No missing force is interpolated. Timeout
or failed reconnect saves the observed effort once and requires release before
another rep. This cannot retroactively recover earlier missing samples. Timed warmups retain
the prompt 1.5-second interruption behavior so their wall-clock timer cannot
complete a hold during this longer recovery window.

A bounded `force_recording.transport` receipt records maximum delivery delay,
disconnect count, and (when applicable) device gap, timeout, or failed reconnect.
This distinguishes software delivery stalls from actual missing samples in
future audits; neither alone diagnoses battery failure.

A valid first-set opening hold can recalibrate the next load even if a later
rep was interrupted. Incomplete sets still cannot advance the earned rep count.
A missing, duplicated, invalid, or nominal-load opener cannot lower its hand's
load through this rule. Later sessions and additional sets remain excluded.
