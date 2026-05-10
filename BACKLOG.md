# Backlog

Structural work tracked across sessions. Items shipped under the
curve-trust direction are marked SHIPPED with the commit hash;
remaining items are sized + scoped against the post-curve-trust
codebase, which is materially leaner than when most of these were
first written (Journey/BadgesView gone, TrendsView gone, ClimbingTab
merged into Fingers, Per-Compartment Dose / Energy System Breakdown
gone, Next Session Focus per-grip cards gone, AnalysisView shrunk
~40%).

Ordering is rough priority, not strict sequencing.

---

## 1. Extract domain hooks from `App.js` (RE-SCOPED)

**Status before curve-trust.** Originally proposed splitting App.js
state into `useUserSettings`, `useCloudSync`, `useFingerHistory`,
`useActivities`. The `useFingerHistory` hook was the centerpiece
because it would dedupe `gripBaselines` + `perHandGripBaselines`
between AnalysisView and BadgesView.

**What changed.** BadgesView is gone (commit caf7d2a). The duplicate
consumer of those baselines no longer exists; lifting them into a
shared hook is now pure code-organization work, not dedup work.

**What's still real.**

- `useUserSettings()` — bodyWeight, unit, trip, bwLog. Still
  cleanly carve-able. Easy win.
- `useCloudSync()` — auth + Supabase pull/push, dirty-flag
  tracking, last-pulled-at, sync status. Still self-contained.
- `useActivities()` — climbing log + 1RM activities. Small.

`useFingerHistory()` becomes optional cleanup, not dedup work.

**Effort.** Small-medium. Pure code organization at this point.

---

## 2. Split `weight_kg` into separate prescribed / actual / manual fields

**Problem.** `weight_kg` is doing double duty in the schema:

- *On writes* — `handleRepDone()` records what the program **suggested**
  the athlete lift.
- *On reads* — `prescription.js` and `fatigue.js` treat `weight_kg` as
  what was **actually applied**, falling back to it when `avg_force_kg`
  is unavailable.

For Tindeq sessions, `avg_force_kg` is preferentially used so the field
ambiguity is mostly papered over. For manual / non-Tindeq sessions,
the field downstream code reads as "what happened" is actually "what
was recommended" — the model never sees the gap when the athlete
loaded more or less than suggested.

**Proposed split.**

- `prescribed_load_kg` — what the app suggested (= today's `weight_kg`
  semantics on writes).
- `avg_force_kg` — Tindeq-measured actual average (already exists).
- `peak_force_kg` — Tindeq-measured actual peak (already exists).
- `manual_load_kg` — user-entered actual load for non-Tindeq sessions.

Model code's "what actually happened" reads become a clean fallback
chain: `avg_force_kg ?? manual_load_kg ?? prescribed_load_kg`. The
coaching engine also gains a new signal — the *gap* between prescribed
and actual ("user routinely loads less than recommended" / "user pushes
harder than asked") which is real coaching information today's schema
discards.

**Why this needs a quiet week.**

1. **Schema migration in Supabase.** `reps` table gains new columns,
   existing `weight_kg` data copies to `prescribed_load_kg`, old
   clients still writing `weight_kg` need backward-compat handling
   during the rollout window.
2. **Read-site sweep.** `weight_kg` is referenced across
   `prescription.js`, `fatigue.js`, and the curve-fit paths. Each
   needs the new fallback chain. One missed read = silent regression.
3. **Write-site sweep.** `handleRepDone`, manual rep entry in
   `HistoryView`'s editor, the rep editor in History, and the
   offline-queue payload shape — all need consistent updates.
4. **UI surface.** History rep editor needs to expose `manual_load_kg`
   as a separate field for non-Tindeq sessions, with labels that
   distinguish "told to lift" from "actually lifted." Design work,
   not just code.
5. **Backward compat.** Existing localStorage + Supabase reps have
   only `weight_kg`. Model code needs to gracefully treat that as
   `prescribed_load_kg ?? manual_load_kg` for legacy data.

**Effort.** Medium-large. Touches the data model, sync, prescription,
fatigue, and UI. The schema migration is the linchpin — most of the
risk concentrates there.

---

## 3. ~~Decompose `AnalysisView`~~ (OBSOLETE)

Originally a ~2,000-line file that mixed model derivation, chart
prep, and rendering. Post curve-trust the file is ~1,400 lines:
- gripRecs / per-grip Train cards: deleted (commit 74f18ea)
- Per-Compartment Dose AUC chart: deleted (commit c246834)
- EnergySystemBreakdownCard: deleted (commit c246834)
- recommendation / personalResponse / zones memos: deleted (74f18ea)

What remains is mostly view code with a few useMemos. Decomposition
no longer earns its complexity. Drop from backlog unless
AnalysisView grows again.

---

## 4. Hedge model-precision language ✓ SHIPPED (commit 6243d3f)

Delivered: `GOAL_CONFIG` rationales softened, Energy System
Breakdown card hedging caption (now removed entirely with the
card), `coachingRationale` + SetupView callouts use "-aligned"
suffix, AnalysisView system labels updated, SettingsView About
panel reframes the model as phenomenological, `threeExp.js`
header states the phenomenological-not-mechanistic caveat.

---

## 5. Per-hand limiter diagnostic + audit `fitAdaptiveHandCurve` callers

**Problem.** `fitAdaptiveHandCurve` returns the stronger hand's fit
when L/R CF diverges >20%. For climbing the weaker hand is often the
actual limiter, so an "always-stronger" pooled fit is biased optimistic.

**Impact in current code.** Most modern code paths are already
per-hand: `perHandGripBaselines`, `prescribedLoad`,
`empiricalPrescription`, the coaching engine, and the F-D chart's
L-vs-R split all work per-hand. The bias leaks only into pooled
views (`liveEstimate`, `gripEstimates` no-filter, Curve Improvement
pooled-fit fallback).

**Three-bucket fix.**

- *Global ceiling* (F-D chart no-hand-filter, headline AUC card):
  stronger hand is fine. No change.
- *Prescription / recommendation*: already per-hand. Audit the call
  sites to confirm none accidentally use the pooled fit when a
  per-hand fit was available.
- *Limiter diagnosis*: surface "your weaker hand is X% behind your
  stronger hand" — currently absent. Small banner on the F-D chart
  or as a row in Curve Coverage.

**Effort.** Small for the audit pass; small-medium for the new
diagnostic surface.
