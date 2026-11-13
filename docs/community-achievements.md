# Community achievements — first version

## Purpose

Make improvement feel possible by showing achievements from people with
relatable starting points. Nathan approved ranked improvement boards and then
requested a moment-by-moment leaderboard. The default view ranks balanced
improvement and all six subdomains; peak force has its own leaderboard. The
automatic achievement feed remains available. None changes training advice.
No streaks, volume rewards, or posts about plateaus. The app generates cards;
members do not write posts.

## Agreed experience

- Community and automatic achievement sharing are on by default for signed-in
  members. A visible notice explains this; Settings and Community both provide
  the off switch. Turning sharing off hides that member's existing cards and
  peak ranking entries and blocks new ones. Turning it on makes their unhidden
  cards visible again. Offline opt-out stops new publication on that device
  immediately; the UI says cloud visibility is pending until acknowledged.
- Cards are visible only to signed-in, non-anonymous members. Use an editable
  display name with a generated alias as the default, never an email address.
- Only achievements earned after community enrollment are published. Historical
  milestones can appear privately in Your stars; there is no historical feed
  backfill. No raw reps, health ratings, body weight, or training notes are shared.
  Rankings are a separate summary: existing eligible progress and peak records
  can be included at enrollment. The sharing notice explicitly discloses this.
- A card shows grip, domain, star milestone, estimated change, baseline/current
  comparison, and the time period. Members can celebrate a card or hide their
  own card. Hidden cards are not republished by retries.
- Discovery supports grip filters and similar starting points. Similar means
  the same grip, metric and supported domains, with baseline force within 25%.
  This is a navigation heuristic, not an elite/beginner classification.
- Your stars breaks progress down into balanced curve improvement, Max Strength,
  Power, Power/Strength, Strength, Strength/Endurance, and Endurance. Unsupported
  domains say Building evidence. Historical earned stars remain private; only
  the highest new milestone per domain/date becomes a community card.

## Live improvement ranking

Use each domain's existing original baseline and latest eligible model estimate.
The user requested live updates after seeing the sample ranking; there is no
weekly cutoff or eight-week scoring window. The original-baseline basis was
stated as the working assumption while the optional baseline/window question
remained unanswered. Every row shows baseline and latest measurement dates;
members' comparison periods can differ, and percentages are not annualized.

Rank by the latest unrounded estimated percentage gain. To appear, a member
must have at least a 1% milestone supported on the latest two eligible session
dates against the same metric baseline. The star badge is the highest milestone
confirmed on both dates; the live percentage may exceed that badge. Unsupported
domains, invalid evidence, and gains below that threshold do not generate rows.
Later-supported domains retain their existing later baselines. No new fit,
baseline pin, failure gate, progression rule, or prescription is introduced.

Starting groups use 10 kg bands of original balanced baseline capacity, with
identical balanced duration coverage kept separate. These bands are presentation
groups, not validated fitness classes. Display-unit changes do not change group
membership. This categorization does not guarantee equal headroom, physiology,
or training exposure. Each domain shows up to 100 members; exact ties share rank.

Updates publish after completed sessions (including the summary screen) and
after idle reconciles. Model computation stays out of active training. A private
Supabase broadcast invalidates open leaderboards; its payload is empty and
contains no user identifiers, measurements, or old records. Clients refetch
through the normal owned-request boundary and RLS. A 15-second visible-page
fallback and foreground refresh recover missed events. The UI shows Live only
after subscription succeeds; it shows Offline or automatic refresh otherwise.
Existing rows stay visible during background refresh, without flashing empty.

The only SECURITY DEFINER function is a trigger in the non-exposed
`community_private` schema. It has an empty search path, no public execution
grant, and emits only the empty invalidation. This is needed to send a signal
after opt-out makes a member's rows unreadable. Topic-specific restrictive RLS
keeps anonymous authenticated sessions out even if broader existing realtime
policies exist, and prevents client broadcasts on this topic. Client invalidation
refreshes do not reset publication signatures, preventing feedback loops.

Implementation follows the official [database broadcast guide](https://supabase.com/docs/guides/realtime/subscribing-to-database-changes)
and [broadcast API](https://supabase.com/docs/guides/realtime/broadcast), checked
against the current changelog on 2026-11-11. Socket delivery still needs a hosted
check after migration approval; local tests validate handlers and DB triggers.

## Peak force ranking

Separate lists for Crusher, Micro and Prime, ranked by **percentage improvement**.
The starting value is the best measured peak on the first eligible max-intent
training date for that grip and hand **on or after the member's community join
date**; compare it with the best later max-intent peak. Earlier history never
sets the baseline, so long-time users are not ranked on their first weeks of
learning a device or on equipment changed before they joined. The ranking RPC
also rejects a baseline dated before the join date (one day of time-zone slack,
as for achievements), whichever path wrote the row. This uses the existing peak trend's definition: target duration at most
12 seconds, including legacy measurements without a usable target. Long-hold
workouts cannot establish an artificially low improvement baseline. A positive
gain needs two distinct eligible dates. No new model fit or baseline pin is made.

Most improved hand gives one entry per member, chosen by percentage gain;
Left/Right filters retain separate same-hand comparisons. Rows show both forces,
both dates and percentage gain. For example, 40 → 50 kg (+25%) outranks
100 → 110 kg (+10%). This is improvement in a recorded best, not current fitness.
No body-weight normalization or cross-grip aggregation. Exact percentage ties
share rank; display rounding never changes rank. Top 100 are shown. Existing
peak evidence gates (including Peak Test) exclude non-measured loads,
invalid/disputed attempts and seed artifacts.

The additive `20261112122110_community_peak_improvement.sql` migration stores
paired comparison summaries and calculates percentages in a new invoker RPC.
Existing absolute snapshots and the original RPC remain compatible with old
clients. Missing baselines never become invented gains: members appear after
their updated app next publishes eligible summaries. A still-open old client
can replace its owner's summaries without comparison fields; that member then
temporarily leaves the new ranking until an updated client republishes.

Unlike achievement cards, the separate absolute peak snapshot may still carry
an existing record. The default-sharing notice names best measured peaks and
peak gains since joining.
Edited/deleted source evidence is reconciled when that member's app next syncs.

## Stars and evidence

The existing Analysis comparison is balanced curve improvement: a geometric
mean of supported force ratios. It is NOT a literal area-under-the-curve
integral. Use the frozen comparison helpers, with no changes to the model,
baseline pins, evidence eligibility, progression or prescriptions.

Personal milestone steps are 1%, 2%, 5%, 10%, 20%, 35%, 50%, 75%, and 100%.
These are product milestones, not validated fitness categories. A 1% star is
available at every starting level, including well-trained members. There are
no arbitrary multipliers or presumed personal ceilings.

A milestone must appear on two consecutive eligible session dates after its
baseline; compare unrounded ratios. Each date must contain measured opening
evidence accepted by the existing comparison helpers. Both comparisons must
use the same baseline and support set. This persistence requirement is NOT a
statistical significance test: label cards as estimated progress, never as
proof of physiological change. One star identity per grip/domain/baseline/
support/milestone prevents repeated rewards for crossing the same threshold.

Stars already earned remain in the personal timeline when the current estimate
falls back. A card captures the estimate when earned. If source evidence is
edited/deleted and no longer supports a card, retract it from the community;
sharing never changes the training record. No automated claims of causation.

## Architecture and rollout

- New community adapters read useContinuousProgress and forceComparison. Model
  modules remain untouched. Computation and publishing run only after history
  and settings reconcile, outside an active finger session.
- Five isolated tables: community_profiles, community_achievements,
  community_peaks, community_progress, and community_celebrations. No changes to reps, baseline, experiment or training
  tables. RLS plus column grants constrain reads and ownership of writes.
- Auto-publishing is idempotent by member and achievement key. Network failures
  retry from locally derivable achievements on the next online/foreground sync;
  no unacknowledged card is labeled shared. Profile updates are acknowledged
  before reporting success. Auth changes invalidate in-flight UI responses.
- Snapshot updates run in one PostgreSQL transaction, serialized on the member's
  profile row. An opt-out arriving before a publication prevents that write;
  one arriving afterward hides the results. A failed snapshot rolls back both
  withdrawals and replacement records. User-hidden cards stay hidden on retry.
- Server creation time establishes the publication cutoff. Missing/ambiguous
  historical timestamps do not qualify for automatic sharing.
- Existing members' raw training records are never read across accounts. The
  feed contains only the minimal, app-generated achievement snapshots.
- Build and verify the SQL against an isolated local database, including two
  users, anonymous access, opt-out, hidden cards, duplicate publication, and
  forged ownership. Applying the migration to the hosted database requires
  Nathan's approval under CLAUDE.md. No deployment or real posts during testing.
- Record the activation date: a social feature may change training behavior
  even though the measurement/model freeze remains intact. Do not imply that
  social exposure and the focused-training intervention have been separated.

## Deferred

Validated fitness divisions/headroom estimates, statistical confirmation of a
1% gain, literal AUC scoring, photos, comments, messaging, follower counts,
notifications, invitation groups, server-side recomputation/anti-cheat, and
publication from devices that never open the app. First-version cards use the
existing client-generated estimates and are not certified measurements.
Peak rankings likewise are not an anti-cheat system: they use client-supplied
summaries of eligible measurements. RLS protects ownership and privacy, not the
truth of an athlete's own submitted data. No prizes or verified-athlete claims.

## Local verification and activation

The implementation lives in `src/lib/communityProgress.js`,
`src/lib/communityRankings.js`, `src/lib/communityLive.js`,
`src/lib/communityApi.js`, `src/hooks/useCommunity.js`, and the Community views.
The migration is `supabase/migrations/20261111215512_community_achievements.sql`.
`scripts/verify-community-db.mjs` applies that exact migration to an isolated
in-memory PostgreSQL and tests RLS, ties, precision, opt-out, idempotence, hidden
cards, retractions and transaction rollback. It never contacts the hosted DB.

Do not deploy ahead of migration approval. After approval, apply the migration,
deploy, record the activation date, and verify with designated test accounts.
Physical BLE, live multi-device sync, and actual community participation are
outside the local checks. No production records were created for development.

The ranked/live extension passed 2,258 Jest tests (3 skipped), lint, production
build and offline checks. The exact migration passed 53 isolated database
checks, including private empty-payload broadcasts, opt-out invalidation,
anonymous exclusion and denial of client-forged community broadcasts.

Isolated browser checks using fictional summaries verified live reordering,
starting-group switching, a 1% milestone, stale-row clearing on grip changes,
peak hand filters and opt-out controls. At 320px and 375px there was no page or
table-cell overflow and visible buttons met the 44px height check. These
checks simulated incoming updates; they did not exercise hosted Realtime.
The working tree is based on 84bb68f6b77658765b0cf12e0a492d57147e2df9. No
changes were made to `src/model` or `src/lib/tindeq.js`; the experiment's
measurement and training rules remain frozen.

Production was inspected with a read-only schema query: no community tables
existed, and the required Realtime `send` and `topic` functions were present.
Existing bundle-size warnings remain. Local tests are not a live-cloud or
physical-device test.

## Activation

Activated 2026-11-12, during the frozen focused-training pilot. The owner
applied the migration to the hosted database and deployed the same day. A
schema check afterwards found five tables with row-level security, 15 table
policies, three Realtime policies, seven functions and five triggers, with no
access for signed-out users. Hosted Realtime delivery and a signed-in session
were not exercised.

Decisions made at activation:

- Sharing is on by default and members opt out. Every current member is part
  of the owner's immediate community.
- Community sits under the Fingers dashboard, not on its own tab. It is hidden
  while a session or workout is running.
- The sharing switch and display name are in Settings only.
- Other members' updates are fetched only while the dashboard shows the
  section. A member's own results are published after each workout.

## Peak improvement correction — 2026-11-12

Read-only verification found remote main and production at
`fc770c7fd2450f039e9e47bade6366ab4f7e07ad`. The deployed UI said “All-time
observed peak”; hosted `community_ranking` ordered by absolute `peak_kg`.
Hosted `community_improvement_ranking` already ordered by `improvement_pct`.
Nathan requested that the peak board reward who improved most. On review he
chose the community join date as the baseline (first max-effort day since
joining), so earlier history and earlier equipment cannot inflate a gain. The
correction described above is local and awaits approval for its additive hosted
migration; it has not been committed, pushed or applied to production.

Validation: 2,269 Jest tests passed (3 skipped), lint, production build/offline
checks, and 78 isolated PostgreSQL checks including the join-date baseline, upgrade of populated tables,
old-client compatibility, gain ordering, exact ties, full precision, ownership,
opt-out, invalid comparison rollback and evidence retraction. Browser checks
with fictional data verified percentage-first display, hand filtering, and no
page or cell overflow at 320px/375px. No hosted data writes or physical BLE tests
were performed. `src/model` and `src/lib/tindeq.js` remain unchanged.

