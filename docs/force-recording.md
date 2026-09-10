# Force-duration recording and interrupted reps

Target time determines the prescribed load. The athlete maintains that load until muscular failure; continuing at a substantially reduced force does not extend the rep.

## Target-loss policy

Once the athlete reaches the prescribed force, the first reading below that force ends the rep. There is no lower percentage allowance or confirmation delay. Initial ramp-up does not arm failure detection until target acquisition. For a 55 lb prescription the boundary is 55 lb. The athlete must release before another rep can start. With no prescribed target, release detection remains the endpoint.

The device sample clock determines elapsed duration, including timestamp rollover. Force is integrated over the same interval as duration. Peak is separate. Recording metadata also retains variability, signal completeness, and the longest contiguous phase above 80% of peak with its own average and duration. That descriptive phase is not substituted for full-rep capacity evidence.

Opening overshoot, sustained overshoot, and force variation remain usable for curve fitting. The fitted observation uses actual time-weighted force over its recorded duration, never substitutes the prescription for measured force, and does not reject a valid failure because its force varies. Variability and plateau metrics are descriptive. Incomplete sensor records and interrupted efforts remain excluded. A targeted attempt that never reaches target is not valid failure evidence.

“Rep interrupted” preserves activity and excludes failure learning. Disconnects, sample gaps over one second, and silent streams over 1.5 seconds invalidate the observed effort. A mechanical slip cannot always be distinguished from failure; the interruption action is available for known interruptions. Interrupted efforts cannot establish peak records.

## Actual rest and recovery

New records retain start/end timestamps and actual same-hand rep-end-to-next-start rest separately from prescribed rest. Unknown rest remains unknown. New nominal spring settings and prescription-only loads remain activity rather than measured capacity evidence. Existing historical records retain their previous capacity semantics and display measurement uncertainty.

Recovery learning requires a consecutive opening sequence with valid endings, measured comparable loads (maximum/minimum at most 1.10), consistent setup and load source, and measured rest at every interval. Predictions use each interval individually, including zero rest. An interruption ends the comparable prefix; earlier valid comparisons remain available. Fitting requires at least three eligible reps. Historical sets without actual rest or force-quality metadata remain descriptive for recovery.

## Release status and verification

The original force-recording migration was applied on September 10, 2026. This follow-up also requires `supabase/migrations/20260911_rep_timing_and_evidence.sql` before its client deployment. It adds timing/provenance fields and extends the existing server learner guard. The follow-up migration was applied and verified on September 10, 2026; this release includes the matching client.

Tests cover steady pulls, normal fluctuations, opening overshoot, gradual decline, sustained target loss, brief dips, abrupt release, batched timestamps, rollover, interruptions, real rest, recovery comparability, and cloud round-trip. Production and offline-shell builds pass. Physical Tindeq validation remains outstanding. Protocol, ladder constants, and zone names remain unchanged.
