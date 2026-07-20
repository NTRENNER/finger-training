# Finger Training

Personal finger-training tracker for climbing. Logs reps from a
[Tindeq Progressor](https://tindeq.com/) over Web Bluetooth, fits a
three-compartment force-duration model to your training history, and
prescribes per-zone loads + a "next session focus" recommendation
based on which energy compartment is your current limiter.

## What's in here

```
src/
  App.js               React shell — auth, top-level state, render switch
  hooks/               Custom hooks lifted out of App.js
    useAuth.js           Supabase auth + 6-digit OTP login
    useRepHistory.js     rep array + cloud reconcile + CRUD + freshMap memos
    useSessionRunner.js  in-workout finite state machine
    useUserSettings.js   unit/BW/trip/focus/pins + user_settings reconcile
    useActivities.js     climbing log + 1RM CRUD + reconcile
    useDailyState.js     per-date cookedness cache + reconcile
    useGripFits.js       per-grip three-exp fits + pinned baselines
  views/               Each top-level tab is one file
    SetupView, AnalysisView, HistoryView, SettingsView,
    ClimbView, WorkoutTab, WarmupView,
    ActiveSessionViews (in-workout flow),
    analysis/ cards/ workout/ (sub-components)
  model/               Pure JS, no React — see __tests__/ for the suite
    threeExp.js          three-compartment exponential force-duration model
    fatigue.js           per-rep fatigue dose + recovery between reps
    fatigueBeta.js       per-grip cookedness β learner (server-trigger fed)
    recoveryFit.js       personal recovery-tau fit with Bayesian shrinkage
    recoveryDynamics.js  observed-vs-predicted recovery gap trend
    prescription.js      empirical-first load prescription + curve fallbacks
    coaching.js          gap × intensity × recency × external × residual scoring
    deload.js            recovery-pressure deload detector
    baselines.js         baseline + level computation (with levels.js)
    warmup.js            adaptive warmup builder
    zones.js             power/strength/capacity/5-zone classifiers
    repCurveData.js      RepCurveChart series assembly
    gradePyramid.js, climbingFatigue.js, peakForce.js,
    supportTraining.js, workout-progression.js, workout-volume.js,
    load.js (effectiveLoad fallback chain), exerciseIds.js
  lib/                 Side-effecting infrastructure
    tindeq.js            Web-Bluetooth wrapper (useTindeq hook)
    sync.js              Supabase round-trips + offline retry queue
    supabase.js          client init
    storage.js           localStorage helpers + LS keys
    csv.js               export helpers
    trip.js              user-configurable target-date
    climbing-grades.js   V/YDS grade tables
  ui/                  Theme + shared components
    theme.js, components.js, format.js
```

## Local dev

Copy `.env.example` to `.env` and fill in your Supabase URL + anon
key. Both values are designed to be public (anon key is the
publishable browser key, gated by Row-Level Security).

```sh
npm install
npm start          # dev server on localhost:3000
npm test           # model + lib + UI test suite (702 tests)
npm run build      # production bundle
```

Web Bluetooth requires Chrome on desktop or Android.

## Model layer

The app's prescription engine is built on three layers, all under
`src/model/`:

1. **Three-compartment exponential** (`threeExp.js`) — force-duration
   curve as a sum of three exponentials with depletion time constants
   τD = [10, 30, 180] s, fitted per-grip with a small ridge prior.
   The tauD basis was chosen over tauR via leak-free LOO-CV against
   pooled history; see `scripts/validate_taur_vs_taud.js` for the
   empirical defense.
2. **Fatigue + recovery** (`fatigue.js`, `recoveryFit.js`,
   `recoveryDynamics.js`, `fatigueBeta.js`) — a per-rep dose model
   with recovery time constants τR = [15, 90, 600] s, personal-tau
   fitting with Bayesian shrinkage toward the population prior, and a
   per-grip cookedness β learned server-side from rep-1 inserts.
3. **Prescription + coaching** (`prescription.js`, `coaching.js`,
   `deload.js`) — an empirical-first prescription chain
   (anchored-curve → unanchored-curve → anchored-linear → historical
   average) used by both the Setup card and the in-workout suggested
   weight, zone scoring for "next session focus", and a
   recovery-pressure deload detector.

## Hardware

Tindeq Progressor over BLE — packet format documented at the top of
`src/lib/tindeq.js`. The hook supports both manual mode (button-tap
per rep) and auto-detect (pull-start + release-end thresholds, for
spring-strap / no-hands setups).
