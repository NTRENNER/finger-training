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

## 1. Extract domain hooks from `App.js` ✓ SHIPPED (commits 7315b0b, f2c2e13)

Delivered: `useUserSettings` (unit + bodyWeight + bwLog + trip +
climbingFocus + pyramid pin maps + fatigueModel, with the combined
user_settings cloud reconcile and the BW reconcile) and
`useActivities` (climbing log + 1RM CRUD + reconcile). App.js
dropped from 1062 → 812 lines.

**Not done, with reasoning:**

- `useCloudSync()` was originally proposed but isn't a coherent
  boundary in this codebase. Cloud sync logic is intrinsically
  tied to each state slice — BW reconcile is in `useUserSettings`,
  activities reconcile is in `useActivities`, reps reconcile is in
  `useRepHistory`. There isn't a generic "sync orchestrator" to
  extract because each domain owns its own reconcile loop. Pull
  status + manual pull button remain in App.js where they belong
  (they orchestrate cross-hook refresh).

- `useFingerHistory()` was originally proposed to dedupe
  `gripBaselines` between AnalysisView and BadgesView. BadgesView
  is gone (caf7d2a), so the dedup justification is moot. Lifting
  the baselines to a shared hook now is pure code-organization
  work without a forcing function; skip unless AnalysisView grows
  back the second consumer.

---

## 2. Split `weight_kg` into separate prescribed / actual / manual fields ✓ SHIPPED (commit 83d8e1c)

Delivered: Supabase schema gained `prescribed_load_kg` + `manual_load_kg`
(backfilled from `weight_kg` for 321 historical rows). `weight_kg`
stays as a vestigial safety net for unsynced offline rows; drop in
a follow-up commit after a confidence period. All model layer
readers go through the central `effectiveLoad()` fallback chain:
`avg_force_kg ?? manual_load_kg ?? prescribed_load_kg ?? weight_kg`.
A new `prescribedLoad(r)` helper names "what the program suggested"
distinctly for callers that don't want Tindeq effort variance
swinging the displayed value (e.g. the session summary "Top weight"
row). Sync layer round-trips all three columns with fallbacks on
both push and pull. History rep editor writes `manual_load_kg` for
non-Tindeq reps (was overwriting `weight_kg`). Manual rep/session
add flows leave `avg_force_kg` null (no Tindeq measurement happened
— don't fabricate one). Tests 318 (313 → 318 with 5 new for the
extended fallback chain). Build clean.

Deferred to a separate task: surface the prescribed-vs-actual gap
as a coaching signal. Need a few weeks of manual_load_kg entries
before the diagnostic is meaningful.

**Problem.** `weight_kg` was doing double duty in the schema:

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

## 3. Decompose `AnalysisView` ✓ SHIPPED (commits 7de60e3, da73203, e71e700, 7bec2b5, 6751b50, 499db81)

Originally a ~2,000-line file that mixed model derivation, chart
prep, and rendering. Late May 2026 second pass shipped in six
commits:

- `7de60e3` — extract `useAucHistoryByGrip` (per-grip AUC trajectory
  hook; first pass).
- `da73203` — extract `useGripFits` bundling six per-grip three-exp
  derivations (gripBaselines, grip3xEstimates, gripHandFits,
  perHandGripBaselines, gripImprovement, handAsymmetry).
- `e71e700` — extract `useHistoryOverlay` bundling historyOverlay +
  balanceHistory (per-hand cumulative fits feeding the Force Curves
  overlay and Strength Balance card).
- `7bec2b5` — extract `ForceDurationCard` component (F-D scatter,
  3-exp curve, per-grip split-mode render, Hand Asymmetry rows);
  `HAND_COLORS` lifted to `src/ui/grip-colors.js` along the way.
- `6751b50` — extract `CurveImprovementCard` component (six-tile
  Δ% grid with perGripMode / selGrip / pooled branches plus
  baseline-unlock progress placeholders).
- `499db81` — extract `ForceCurvesOverlayCard` component (pooled /
  per-hand toggle, grip selector, Now slider, baseline-vs-current
  LineChart, per-T delta tile strip); overlayActiveGrip/Dates/Last/
  NowI derivations moved into the component since only it consumed
  them.

End state: AnalysisView 1846 → 813 lines (~56% reduction). No charts
render directly in AnalysisView anymore — every chart lives in a
child component. What remains is the orchestration layer (props,
view-state, click-to-expand session-detail modal, filter card, and
the wire-up of all extracted child cards) — which is what the view
file should be.

Pre-decomposition deletions still apply:
- gripRecs / per-grip Train cards: deleted (commit 74f18ea)
- Per-Compartment Dose AUC chart: deleted (commit c246834)
- EnergySystemBreakdownCard: deleted (commit c246834)
- recommendation / personalResponse / zones memos: deleted (74f18ea)

**Deliberately NOT extracted:**

- `SelectionDetailModal` (the click-a-dot session-detail modal).
  ~70 lines of one-off modal markup that doesn't recur. Extracting
  it would require passing 7-8 props for a single-call-site
  component; the savings don't justify the indirection.
- The filter card. ~50 lines that bundles grip pills + the
  Absolute/×BW toggle. Same one-off shape; the page-level filter
  state lives in AnalysisView, so the markup naturally lives with it.

---

## 4. Hedge model-precision language ✓ SHIPPED (commit 6243d3f)

Delivered: `GOAL_CONFIG` rationales softened, Energy System
Breakdown card hedging caption (now removed entirely with the
card), `coachingRationale` + SetupView callouts use "-aligned"
suffix, AnalysisView system labels updated, SettingsView About
panel reframes the model as phenomenological, `threeExp.js`
header states the phenomenological-not-mechanistic caveat.

---

## 5. Per-hand limiter diagnostic + audit `fitAdaptiveHandCurve` callers ✓ SHIPPED (effectively done)

Audited late May 2026 (post-`useGripFits` work). Both halves of this
item are already covered:

- *Audit.* `fitAdaptiveHandCurve` no longer exists in the source
  (`grep -r 'fitAdaptiveHandCurve' src/` returns nothing). The
  always-stronger-when-divergent behavior was a Monod-era quirk that
  got retired during the three-exp migration (Phases A–D). The pooled
  three-exp fit weighs L and R together rather than picking the
  stronger hand on divergence, so the "biased optimistic" failure
  mode the item flagged is structurally gone. `liveEstimate` is also
  retired; the only remaining `gripEstimates` consumers are
  `buildGripImprovement` and `computeHandAsymmetry`, both well-behaved
  per-grip helpers in `src/model/baselines.js`.
- *Diagnostic surface.* The "weaker hand is X% behind stronger" copy
  ships in the Hand Asymmetry section of the F-D card
  (`ForceDurationCard.jsx` → handAsymmetry rows). Per-grip rather than
  pooled, with symmetric / asymmetric / limiter pills and auto-hide
  when every grip is symmetric (commit #234).

No code change needed. Closing the item out so it stops anchoring the
post-lockout backlog.
