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
  views/               Each top-level tab is one file
    SetupView, AnalysisView, BadgesView, HistoryView,
    TrendsView, SettingsView, ClimbingTab, WorkoutTab,
    ActiveSessionViews (in-workout flow)
  model/               Pure JS, no React — see __tests__/ for the suite
    monod.js             Critical Force fits (F = CF + W'/T)
    threeExp.js          three-compartment exponential force-duration model
    fatigue.js           per-rep fatigue dose + recovery between reps
    prescription.js      empirical-first load prescription + curve fallbacks
    coaching.js          gap × intensity × recency × external × residual scoring
    limiter.js           Monod cross-zone residual: which compartment is short
    personal-response.js per-zone CF/W' response priors with Bayesian shrinkage
    levels.js            baseline + level computation
    readiness.js         24h-half-life decay model from training history
    zones.js             power/strength/capacity/5-zone classifiers
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
npm test           # 135 model-layer tests
npm run build      # production bundle
```

Web Bluetooth requires Chrome on desktop or Android.

## Model layer

The app's prescription engine is built on three layers, all under
`src/model/`:

1. **Monod-Scherrer** (`monod.js`) — fits Critical Force `CF` and
   anaerobic reserve `W'` from rep-1-to-failure data using
   `F = CF + W'/T`. Cheap, stable, the classical model.
2. **Three-compartment exponential** (`threeExp.js`) — extends Monod
   with three depletion time constants τD = [10, 30, 180] s, fitted
   per-grip with a small ridge prior. The tauD basis was chosen over
   tauR via leak-free LOO-CV against pooled history; see
   `scripts/validate_taur_vs_taud.js` for the empirical defense.
3. **Fatigue + prescription** (`fatigue.js`, `prescription.js`) — a
   per-rep dose model that produces a fatigue-adjusted "fresh load"
   lookup, plus an empirical-first prescription chain
   (most-recent-rep → per-grip Monod → cross-grip Monod → historical
   average) used by both the Setup card and the in-workout suggested
   weight.

Coaching picks the next zone via gap (curve potential − empirical
load) × intensity × recency × external load × residual fit error;
see `coaching.js`.

## Hardware

Tindeq Progressor over BLE — packet format documented at the top of
`src/lib/tindeq.js`. The hook supports both manual mode (button-tap
per rep) and auto-detect (pull-start + release-end thresholds, for
spring-strap / no-hands setups).
