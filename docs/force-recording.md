# Force-duration recording and interrupted reps

Target time determines the prescribed load. The athlete maintains that load until muscular failure; continuing at a substantially reduced force does not extend the rep.

## Target-loss policy

Once the athlete reaches the prescribed force, a continuous drop below 93% of target for 600 ms confirms failure. Both settings are read from the policy object. Recovery to the boundary cancels confirmation. Overshooting never ends a rep. The recorded endpoint is the onset of the confirmed drop. Warmups opt out and retain their timed-hold/release behavior. With no prescribed target, release detection remains the endpoint.

The device sample clock determines elapsed duration, including timestamp rollover. Targeted sensor reps now use recording version 3, basis `target_acquired`: capacity force and duration start at the first sample reaching target and end at failure onset. Force is integrated over exactly that interval. The nested `activity` metadata preserves the full captured duration, average, impulse, and timestamps, including the ramp. Recorded rest starts from the physical activity start, not the later target-acquisition point. Peak is separate. Recording metadata also retains variability, signal completeness, and the longest contiguous phase above 80% of peak with its own average and duration. That descriptive phase is not substituted for full-rep capacity evidence.

Opening overshoot, sustained overshoot, and force variation remain usable for curve fitting. The fitted observation uses actual time-weighted force over its recorded duration, never substitutes the prescription for measured force, and does not reject a valid failure because its force varies. Variability and plateau metrics are descriptive. Incomplete sensor records and interrupted efforts remain excluded. A targeted attempt that never reaches target is not valid failure evidence.

“Rep interrupted” preserves activity and excludes failure learning. Disconnects, sample gaps over one second, and silent streams over 1.5 seconds invalidate the observed effort. A mechanical slip cannot always be distinguished from failure; the interruption action is available for known interruptions. Interrupted efforts cannot establish peak records.

## Actual rest and recovery

New records retain start/end timestamps and actual same-hand rep-end-to-next-start rest separately from prescribed rest. Unknown rest remains unknown. New nominal spring settings and prescription-only loads remain activity rather than measured capacity evidence. Manual nominal loads can anchor an explicitly estimated load recommendation (evidence weight 0.5); they cannot establish measured capacity floors or recovery calibration. Interrupted nominal rows cannot anchor. The manual-only coach keeps the last prescribed duration and labels its estimated recommendation.

New target-acquired records start a separate capacity series per grip. Older baselines are not silently compared to the new interval basis; a new baseline develops under the existing baseline criteria. Original rows and their chart dots remain available. No historical force or duration is rewritten.

Recovery learning requires a consecutive opening sequence with valid endings, measured comparable loads (maximum/minimum at most 1.10), consistent setup and load source, and measured rest at every interval. Predictions use each interval individually, including zero rest. An interruption ends the comparable prefix; earlier valid comparisons remain available. Fitting requires at least three eligible reps. Pre-capture legacy measured sets may use planned rest at half fitting weight, labeled as historical estimates. New missing metadata is not promoted to measured evidence.

An interrupted pull with complete force/time recording still contributes fatigue dose but cannot be failure-capacity evidence. Missing and null actual rest use the same estimated planned-rest fallback. Missing work or unavailable rest leaves subsequent fatigue unknown; those later rows are excluded from fresh-capacity fitting rather than treated as fresh. A new session resets the sequence.

If sensor duration is unavailable, finalization preserves wall-clock elapsed activity with `duration_basis: elapsed_activity_estimate`, never measured failure data. Partial usable sensor duration is retained without inventing force across the missing interval. Manual-started sensor reps remember that they used a device and remain interrupted after a disconnect or reconnect.

## Release status and verification

The original force-recording migration was applied on September 10, 2026. This follow-up also requires `supabase/migrations/20260911_rep_timing_and_evidence.sql` before its client deployment. It adds timing/provenance fields and extends the existing server learner guard. The follow-up migration was applied and verified on September 10, 2026; this release includes the matching client.

Tests cover steady pulls, normal fluctuations, opening overshoot, gradual decline, sustained target loss, brief dips, abrupt release, batched timestamps, rollover, interruptions, real rest, recovery comparability, and cloud round-trip. Production and offline-shell builds pass. Physical Tindeq validation remains outstanding. Protocol, ladder constants, and zone names remain unchanged.
