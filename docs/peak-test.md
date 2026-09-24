# Peak Test and the five-domain rotation

Peak Test is the single planner option for short-duration strength work. Normal
recommendations and coverage reminders use Power, Power/Strength, Strength,
Strength/Endurance and Endurance. Max remains in the six-domain analysis and
all historical records remain intact. A Max observation has no automatic
14-day coverage deadline or score boost.

Peak Test uses three attempts per hand with 150 seconds of rest. The load is
selected for approximately five seconds; maintain that force until muscular
failure. It is not a five-second countdown, and exceeding the target force
never ends the attempt. Existing force tolerance and confirmation settings
continue to apply. The runner enforces this protocol even if an old caller
supplies a different duration, repetition count or ladder pin.

Each attempt saves its measured average force with its actual measured hold
duration, separately from its instantaneous peak. Only evidence accepted by
the existing fresh-capacity rules enters the curve (normally the first valid
attempt in the first set). A later attempt is not automatically declared fresh
because it had a long rest. An interrupted opener is not replaced by a later
attempt as fresh evidence. Peak measurements and historical sustained-force
measurements are never interchanged or rewritten.

New records carry force_recording.session_protocol.id = peak_test. This uses
the existing JSON storage and export path; no migration is required. History
labels these sessions Peak Test. They cannot advance a density ladder and do
not offer extra sets. Regular 4–5–6 progression is unchanged.

For sparse grips, the initial upper-curve check uses this same Peak Test
instead of the former four short-rest pulls. The lower-bound check still uses
four conservative long holds. Established grips are not assigned recurring
Max workouts through coverage scoring. Manual-only short history is identified
as a Peak Test estimate rather than a sixth routine workout choice.

The existing optional 28-day peak-measurement reminder remains separate from
routine training coverage; its planner badge says check-in, not due. It is a
measurement-age prompt, not a claim of lost strength. Interrupted attempts do
not refresh it. No precise optimal testing frequency is asserted.
