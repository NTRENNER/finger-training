# Training flow and workout progression release candidate

Prepared locally on `codex/workout-progression-modifiers`, based on
`bb3710ecd4bd1b110122baa0cb23aea44fd5e8a4`. No push, PR publication,
merge, deployment, migration or historical-data correction is included.

## Review description

Finger training could freeze a detected failure endpoint while force recording
continued, with no post-completion retry. Prime, Crusher and Micro now share an
optional redo action that restores the same hand/set/rep and exact target.
It replaces the same saved ID, retains disputed work, and excludes that work
from clean recovery/opening-capacity evidence. Normal reps proceed automatically.
An active original trace can explicitly Continue an adjustment while force
remains elevated. Observed sample time and the detected endpoint stay distinct;
release, stale samples, disconnects and interrupted transport block continuation.
The existing release confirmation and missing-release safety timeout remain.

Hold-time charts appear throughout rest, preserving rep numbers and missing
slots. Interrupted/disputed activity is labelled and cannot seed estimates or
previous comparisons. Same-day comparisons use session timestamps; ambiguous
order yields no comparison. Missing previous or mixed-duration comparisons are
shown honestly. RFD warm-up pulls are grouped by hand with ten-second rests;
the separate maximal Peak Test protocol is unchanged.

Support workouts display A/B/C while retaining existing storage IDs. In Strength
block mode, qualifying weight-tracked strength exercises progress from three
sets to four at the same load, then reset to three with a five-pound upper-body
or ten-pound larger lower-body increment (converted for kg). Existing discrete
equipment, return-to-training and non-strength policies remain applicable.
Today-only edits are the default; saving template changes requires an explicit
checkbox. Flexible whole-set or scoped rep/side modifiers are recorded without
silently becoming unmodified progression evidence. Matching modified setups can
progress independently. Modified work contributes volume, not unmodified 1RM.

Analysis and recovery copy describe recorded comparisons and the actual selected
protocol. They no longer guarantee automatic stale-domain coverage or infer
broad recovery coaching from limited hold comparisons. The pilot schedule is
not changed to manufacture that promise.

## Compatibility and evidence

- No SQL/schema migration or auth/config change. Existing JSON metadata and
  settings persistence paths carry additive retry/modifier/template information.
- Existing workout IDs and records remain intact. No history backfill or repair.
- Mixed finger sessions keep their separate runner; Peak Test keeps its own retry.
- Automated coverage includes shared finger flows, sensor packet/release/drop/
  disconnect behavior, persistence callbacks and IDs, exact fractional kg/lb retry
  targets, modified/raw progression isolation, saved equipment bridging, charts,
  standard/pilot wording, and grouped warm-ups.
- Verified before packaging: 2,094 tests passed, three skipped; zero-warning lint,
  production bundle, generated offline manifest/service worker and offline route
  verification passed. Final packaging checks are recorded alongside the artifact.

## Release workflow (not executed)

The repository's `CLAUDE.md` says pushing `main` deploys through Vercel.
`.github/workflows/ci.yml` runs Node 22, `npm ci`, lint, Jest and the build for
PRs and pushes to main. `vercel.json` builds with `npm run build`, serves
`build/` and preserves `/research` and `/hands` rewrites.

1. Review the local candidate commit or accompanying patch. Check the destination
   checkout is at the baseline above and preserve unrelated work. Apply the patch
   on a review branch (the patch is suitable for `git am`). If main has advanced,
   integrate on that branch and rerun all checks; do not reset or overwrite it.
2. Use Node 22.19+ (22.x), run `npm ci`, `npm run lint`,
   `CI=true npm test -- --watchAll=false --runInBand`, and `npm run build`.
   The npm postbuild hook verifies the offline cache. Normal CI uses a real local
   dependency directory; this sandbox used Vite's `--configLoader runner` because
   its dependency directory is a symlink to the source checkout.
3. Perform the physical/sync checks below in an explicitly authorized test
   environment/account. Do not use production history to manufacture test reps.
4. Obtain explicit approval before pushing/publishing a branch, opening a PR,
   merging, deploying or modifying live records. Then publish the reviewed branch
   to `https://github.com/NTRENNER/finger-training`, confirm CI passes, and follow
   the approved merge/deployment route. A push to main triggers production.
5. Verify Vercel used the intended commit and its existing public Supabase build
   settings. Check Settings build SHA, app shell, `/research`, `/hands`, cache
   upgrade, workout names/templates and authorized account access.

## Remaining verification limits

No physical Tindeq/Chrome BLE session or live Supabase write/sync has been tested
for this candidate. Automated packet replay and mocked persistence do not prove
device ergonomics, reconnection timing or real server reconciliation.

Before deployment approval, use a test account/device to check each grip: normal
completion without prompts; an elevated-force dip with Continue retaining the
trace/clock; release ending once; disconnect blocking Continue; optional redo
retaining its exact load and same slot; interrupted retry left pending; offline
queue and later sync without duplicate IDs; rest charts; both-hand RFD ten-second
rests; and unchanged Peak Test. Verify workout modifiers and explicit template
saving round-trip after reload and synchronization. Avoid adding test work to
Nathan's live training history.

The local bundle is a build-verification output, not a configured deployment
artifact: this isolated checkout has no `.env` file. Production must rebuild from
the reviewed source using the existing authorized Vercel public settings.

If rollback is needed after a separately approved release, Vercel can restore the
prior deployment or a reviewed revert can go through CI. That rolls back code,
not training records. Do not delete additive metadata or undo recorded workouts.
