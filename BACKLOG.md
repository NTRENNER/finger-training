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
  threeExpPriors + freshMap. Natural cohesion: rep saved → curve
  refits → baseline checks → gripEstimates updates.
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
