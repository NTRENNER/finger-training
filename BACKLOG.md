# Post-Lockout Backlog

Structural improvements deliberately deferred until the lockout system
ships. Each entry is correct in spirit and worth doing — the timing is
the issue. Current feature work touches files these refactors would
restructure, so doing both at once invites merge pain and silent
regressions.

Ordering inside this file is rough priority, not strict sequencing.
Each item is independently shippable once the lockout is in place.

---

## 1. Extract domain hooks from `App.js`

**Problem.** `App.js` still owns auth, sync, settings, derived model
state (gripEstimates, freshMap, baseline), badge triggers, tab routing,
and the rendering gate machine. The `useAuth` / `useTindeq` /
`useSessionRunner` hooks already prove the codebase responds well to
extraction; pulling more out is good hygiene and makes the file scan-
able again.

**Proposed decomposition** (declined the original "useAppState() does
everything" framing because it just relocates the centralization):

- `useUserSettings()` — bodyWeight, unit, trainingFocus, trip, bwLog.
  All localStorage-backed simple values with the same lifecycle.
  Returns `{settings, updateSetting}`. Easy win, low risk.
- `useCloudSync()` — auth + Supabase pull/push, dirty-flag tracking,
  last-pulled-at, sync status. Takes data setters as deps; doesn't
  own the data itself.
- `useFingerHistory()` — rep history + baseline + gripEstimates +
  threeExpPriors + freshMap, **PLUS the structurally-shared model
  derivations**: `gripBaselines` (≥5-failure per-grip seed window)
  and `perHandGripBaselines` (hand-scoped variant). These are
  currently duplicated between `AnalysisView` (Curve Improvement
  card, Performance vs. Model chart) and `BadgesView` (per-grip
  AUC growth). Lifting them into the hook unifies the computation
  + saves work since both views currently pay the O(N) baseline
  scan independently. Other AnalysisView-specific chart prep
  (gripRecs, gapHistory, aucHistoryByGrip, F-D chart series)
  stays in the view — those have only one consumer.

  Does NOT include a single `useModelSelectors()` mega-hook that
  returns every derived value at once. That just hides the
  dependency graph one layer down and forces views to pay for
  derivations they don't need. Per-concern composition is the
  better pattern.
- `useActivities()` — climbing log + 1RM activities. Small, isolated.

**What stays in `App.js`.** Phase machine, tab routing, top-level
rendering decisions. That's where the rendering decisions belong.

**What we do NOT do.** Spread the entire world via
`<AppShell {...app} />` — that just hides the dependency graph one
layer down. If consumers genuinely need to read multiple hook outputs,
introduce React Context at that specific consumer's layer rather than
at the shell.

**Effort.** Medium. Touches App.js extensively. Regression surface is
the rendering tree, so smoke-test every tab after extraction.

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

**Zero-cost mitigations to consider in the meantime** (don't ship,
just be aware):

- When Tindeq returns a valid `avg_force_kg`, `handleRepDone` could
  write `weight_kg = avg_force_kg` instead of the suggested load.
  Makes the existing field reflect "what happened" for Tindeq sessions
  but loses the prescription signal entirely. Trade-off worth thinking
  about, not worth shipping ad-hoc.
- Document the current dual semantics in the schema comment so future
  readers don't misread the field.

---

## 3. Decompose `AnalysisView`

**Problem.** `AnalysisView.js` is ~2,000 lines and mixes three concerns
(model derivation, chart prep, rendering) in one file. After the
6-zone migration it grew further. Even with the per-section comments
it's hard to navigate — especially for someone returning to the file
after a few weeks. `EnergySystemBreakdownCard` was extracted earlier
as a precedent; the pattern just stopped at one component.

**Proposed component decomposition:**

- `ForceDurationChart` — F-D scatter + curve overlays + zone bands
- `GapTrackerCard` — Performance vs. Model time series (per-grip)
- `CapacityCards` — AUC % vs baseline + AUC absolute + Curve
  Improvement (the headline progress trio)
- `RecommendationCards` — Train cards + per-grip Train + Unexplored

`AnalysisView` shrinks to a top-level layout that wires the cards
together with shared filter state (selGrip, relMode) and shared
model derivations from the hooks below.

**Proposed hook decomposition** (declined the
"useAnalysisModel() returns everything" framing — same anti-pattern
as the spread-everything AppShell, just one layer down):

- `useGripImprovements(...)` — Δ% deltas for Curve Improvement
- `useGapHistory(...)` — Performance vs. Model series, per-grip
- `useAucHistoryByGrip(...)` — AUC % + absolute time series
- `useCoachingRecs(...)` — recommendation + gripRecs

Each consumer pulls only what it needs. No giant model-bag hook.

**Important overlap with item #1.** The two heaviest model derivations
currently in AnalysisView — `gripBaselines` and `perHandGripBaselines`
— are already in scope for `useFingerHistory` (item #1) because
`BadgesView` also computes the same baseline seed window for its
per-grip AUC growth. So those move out of AnalysisView as part of #1,
not as part of this item. The hooks above all consume those baselines
as inputs.

**Sequencing.** Do this AFTER #1, not before. If we decompose
AnalysisView while gripBaselines is still local, we'd extract it into
an Analysis-local hook only to move it again to useFingerHistory.
Wrong order means moving the same code twice. Correct order:

  1. Lockout system ships.
  2. App.js domain hook extraction (item #1) lands. gripBaselines and
     perHandGripBaselines move to useFingerHistory.
  3. AnalysisView decomposition (this item) builds on top — splits
     the remaining view-specific derivations into focused hooks and
     the rendering into focused components.

**Effort.** Medium-large. Each component extraction is mechanical, but
there are 4 of them, and the prop wiring needs care to avoid
regression in the chart filters and the cross-card recommendation echo
(Curve Improvement banner ↔ Train card).

---

## 4. Hedge model-precision language

**Problem.** The three-exp force-duration model
F(T) = a·e^(-T/τ₁) + b·e^(-T/τ₂) + c·e^(-T/τ₃) is phenomenological
— a sum of three exponentials with fixed time constants fitted to
force-duration data. It predicts well (~7% RMSE improvement over
Monod in offline validation) but the math doesn't require the three
terms to map to literal PCr / glycolytic / oxidative compartments.
The amplitudes (a, b, c) are regression coefficients that *behave*
like compartment amplitudes, not strict tissue probes.

The codebase routinely overstates this. Examples:

- Energy System Breakdown card shows fast/medium/slow percentages
  that read as physiology, not as model fit.
- `GOAL_CONFIG` rationale strings include claims like "20s refills
  ~75% of PCr (τ₁≈15s) between hangs" — physiology claim that
  exceeds what the math justifies.
- Per-zone captions ("fast (PCr) / middle (glycolytic) / slow
  (oxidative)" compartments) are named as if read off a tissue
  probe rather than as a fit-mapping convenience.

**Fix.** Mostly a tone pass on captions and rationale strings:

- Reframe compartment language as "fast / medium / slow regression
  components, named for the energy systems they approximately
  align with."
- Soften absolute physiology claims in `GOAL_CONFIG` rationales
  ("aligns with PCr's depletion timeline" rather than "refills 75%
  of PCr").
- Add a one-liner to the Energy System Breakdown card explaining
  that percentages reflect curve fit, not direct measurement.

No math changes. Could ship as a focused polish PR — low risk,
low effort.

**Effort.** Small. Pure copy edits across GOAL_CONFIG comments and
a handful of card captions.

---

## 5. Per-hand limiter diagnostic + audit `fitAdaptiveHandCurve` callers

**Problem.** `fitAdaptiveHandCurve` returns the stronger hand's fit
when L/R CF diverges >20%. For climbing the weaker hand is often the
actual limiter, so an "always-stronger" pooled fit is biased optimistic.

**Impact in current code is smaller than it sounds.** Most modern
code paths are already per-hand:

- `perHandGripBaselines`, `prescribedLoad`, `empiricalPrescription`,
  the coaching engine, and the F-D chart's L-vs-R split all work
  per-hand and aren't affected.
- The bias leaks only into the pooled views: `liveEstimate`,
  `gripEstimates` (when no hand filter), and the Curve Improvement
  card's pooled-fit fallback.

**Three-bucket fix** (matching the audit recommendation):

- *Global ceiling* (e.g., F-D chart with no hand filter, headline
  AUC card) — stronger hand is fine. No change.
- *Prescription / recommendation* — already per-hand. Audit the
  call sites to confirm none accidentally use the pooled fit when
  a per-hand fit was available.
- *Limiter diagnosis* — currently we don't surface "your weaker
  hand is X% behind your stronger hand" anywhere. Adding a
  per-hand asymmetry diagnostic (small banner on Curve Improvement
  or the F-D chart) is the real gap. Not a refactor — a small new
  feature.

**Effort.** Small for the audit pass; small-medium for the new
diagnostic surface.
