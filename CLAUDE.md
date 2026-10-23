# Working on finger-training

The README covers architecture. Commands: `npm test` (Jest), `npm run lint`
(zero warnings allowed), `npm run build`, `npm start` (dev server). Pushing to
`main` deploys to production through Vercel.

## Find the cause before fixing

When something misbehaves (a rep ended early, a number looks wrong):

1. Pull the specific failing record from Supabase and read what was stored:
   `end_reason`, `failure_valid`, `force_recording.transport`,
   `force_recording.recording_stop_reason`, and so on.
2. Trace every code path that can produce that outcome. For example, find
   every place a rep can end in `src/lib/tindeq.js`, not just the one you
   expect.
3. Look for the fact that contradicts the obvious story. State the cause,
   with that evidence, before proposing a fix.
4. Write a regression test that replays the real case, then fix it.
5. If a computed result disagrees with what the user sees on screen, stop and
   resolve the disagreement before recommending anything.

Say what you verified and what you assumed. A UI prompt or a threshold tweak
is not a fix for a cause you haven't found.

Why: interrupted reps were "fixed" several times from symptom descriptions.
All along, the stored record showed the real cause. The device clock jumped
37 minutes while packets kept arriving every 0.3 s, and the hook ended the
rep before any prompt could appear.

## Supabase

- Access is read-only: SELECT only. Never write, delete, or migrate without
  asking first.
- Several user accounts share the tables. Always filter to the owner's account
  (the email is in `CLAUDE.local.md`), for example
  `with me as (select id from auth.users where email = '…') … where r.user_id = me.id`.
  Unfiltered queries have already produced a wrong diagnosis. Never surface
  other users' data.

## Rep history

`useRepHistory` stores training reps and non-training measurements (warm-up
Potentiation Pulls, tagged by `force_recording.session_protocol`) in one
array, because they share the sync path. Its `history` and every curve input
are training-only. Use `potentiationHistory` for the speed card, and
`allHistory` only for persistence and backups. Add any new measurement type
to that split rather than filtering it in views.

## Tindeq

- The Progressor's sample timestamp can restart mid-stream while packets
  arrive on time. Only treat data as missing when wall-clock arrival shows the
  gap too (see the packet handler in `src/lib/tindeq.js`).
- Its battery reply is unreliable. Nothing about the battery is shown to users.

## Product rules

- Less is more. Don't add diagnostics, battery readings, or explanatory notes
  to the UI. The system should recover on its own. The one acceptable prompt is
  Continue / Mark interrupted / Redo, when a rep's integrity is genuinely in
  doubt.
- The active-rep screen shows live weight, average weight, time, target weight
  and target time. Nothing else, and the layout must not jump.
- Sessions always start with the same hand.
- Warm-up rests protect finger recovery, so the timer stays. The next step
  starts on the user's pull. Never gate progress on a "done" tap.
- The unused tendon code and the baseline-maturation calculation
  (`maturation` in `src/model/performanceTrendEvidence.js`, no longer
  displayed) are kept on purpose. Don't delete them.

## Git

Commit and push only when asked. Don't commit `.claude/` or `CLAUDE.local.md`.
Leave the existing git stashes alone.
