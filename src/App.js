// src/App.js  — Finger Training v3
// Rep-based sessions · Three-Compartment Fatigue Model · Tindeq Progressor BLE · Gamification
import React, {
  useCallback, useEffect, useMemo, useState,
} from "react";
// UI primitives (theme, formatters, shared components). See src/ui/.
import { C, base } from "./ui/theme.js";
import { Card, Btn } from "./ui/components.js";
import { fmtW } from "./ui/format.js";

// Top-level views extracted from this file. See src/views/.
import { BadgesView } from "./views/BadgesView.js";
import { TrendsView } from "./views/TrendsView.js";
import { ClimbingTab } from "./views/ClimbingTab.js";
import { HistoryView } from "./views/HistoryView.js";
import { SettingsView } from "./views/SettingsView.js";
import { AnalysisView } from "./views/AnalysisView.js";
import { SetupView } from "./views/SetupView.js";
import {
  ActiveSessionView, AutoRepSessionView,
  RestView, SwitchHandsView, AltSwitchView,
  BetweenSetsView, SessionSummaryView,
} from "./views/ActiveSessionViews.js";
import { WorkoutTab, DEFAULT_WORKOUTS } from "./views/WorkoutTab.js";
import { WorkoutAnalysisView } from "./views/WorkoutAnalysisView.js";

// Shared lib helpers (storage, trip dates, CSV). See src/lib/.
import {
  loadLS, saveLS,
  LS_HISTORY_KEY, LS_REP_DELETED_KEY,
  LS_BW_LOG_KEY, LS_WORKOUT_LOG_KEY,
  LS_WORKOUT_SYNCED_KEY, LS_WORKOUT_DELETED_KEY,
  LS_TRAINING_FOCUS_KEY,
} from "./lib/storage.js";
import { DEFAULT_TRAINING_FOCUS } from "./model/training-focus.js";
import { DEFAULT_TRIP } from "./lib/trip.js";
import { downloadCSV, downloadWorkoutCSV } from "./lib/csv.js";
import { useTindeq } from "./lib/tindeq.js";

// App-level hooks (see src/hooks/).
import { useAuth } from "./hooks/useAuth.js";
import { useRepHistory } from "./hooks/useRepHistory.js";
import { useSessionRunner } from "./hooks/useSessionRunner.js";
import {
  pushRep, fetchReps, enqueueReps, flushQueue,
  fetchWorkoutSessions, deleteWorkoutSession,
} from "./lib/sync.js";

// Model layer — pure JS, testable in isolation. See src/model/*.js.
import { today, uid } from "./util.js";
import { zoneOf } from "./model/zones.js";
import {
  fitCF,
  computeAUC, fitAdaptiveHandCurve,
} from "./model/monod.js";

// ─────────────────────────────────────────────────────────────
// CONSTANTS / UTILITIES
// ─────────────────────────────────────────────────────────────
// Most code that App.js used to inline now lives in extracted
// modules — see the imports above:
//   src/model/  pure JS math (Monod, three-exp, fatigue, prescription,
//               coaching, zones, levels, personal-response, limiter,
//               training-focus)
//   src/views/  React tabs + the active-session flow (BadgesView,
//               TrendsView, HistoryView, ClimbingTab, SetupView,
//               AnalysisView, SettingsView, WorkoutTab,
//               ActiveSessionViews, etc.)
//   src/lib/    side-effecting infrastructure (storage, csv, supabase,
//               sync, tindeq, trip, climbing-grades)
//   src/ui/     theme, formatters, shared components
//
// What stays here in App.js: the React shell — auth, top-level
// state (history, activities, bodyWeight, trip, trainingFocus),
// the reconcile/sync orchestration that owns those pieces, and
// the tab-switch render gate. Plus GOAL_CONFIG (passed to
// SetupView + AnalysisView), RM_GRIPS (passed to AnalysisView
// for the 1RM tracker), and the TABS array used by the top-nav
// router.

// LS_HISTORY_KEY (formerly LS_KEY = "ft_v3") now lives in src/lib/storage.js;
// useRepHistory below owns reads/writes to it. App still touches it inside
// pullFromCloud's "reconcile local-only reps before overwriting" pre-flight.
// LS_QUEUE_KEY now lives in src/lib/sync.js (imported above) — single
// source of truth for the offline-rep retry queue's localStorage key.

// TARGET_OPTIONS (Power / Strength / Endurance picker rows for the
// Setup form, History "add session" / rep editor, and Trends filter
// pills) lives in src/model/zones.js next to ZONE_REF_T so its
// seconds stay tied to the canonical zone reference times. Views
// import it directly — no need to thread it through App as a prop.

const GRIP_PRESETS = ["Crusher", "Micro", "Prime"];

// localStorage keys for App-level state. The workout-plan / state /
// trip keys live in their respective view modules (WorkoutTab, etc.).
const LS_NOTES_KEY     = "ft_notes";     // { [session_id]: string }
const LS_BW_KEY        = "ft_bw";        // body weight in kg (number)
// LS_READINESS_KEY ("ft_readiness") was the subjective daily check-in
// emoji. Both that widget AND the computed-from-history readiness
// score that briefly replaced it have been removed — coaching now
// uses a constant neutral readiness=5. Old stored ratings under
// "ft_readiness" are orphaned but harmless; nothing reads them.
const LS_BASELINE_KEY  = "ft_baseline";  // { date, CF, W } — permanent first-calibration snapshot
const LS_ACTIVITY_KEY  = "ft_activity";  // [{ id, date, type: "climbing", discipline, grade, ascent }]
const LS_GENESIS_KEY   = "ft_genesis";   // { date, CF, W, auc } — snapshot when first all-zone coverage earned
const LS_TRIP_KEY      = "ft_trip";      // { date: "YYYY-MM-DD", name } — user-configurable target date

// Small App-local helpers.
// uid + nowISO now live in src/util.js (uid is used by addActivity
// below and by the session-runner hook; nowISO only by the hook).

// ─────────────────────────────────────────────────────────────
// SESSION PROTOCOL CONFIG
// ─────────────────────────────────────────────────────────────
// Per-zone defaults the SessionPlanner card surfaces (rep count,
// rest, target time, intensity copy). Set counts are tuned so per-
// hang hold-time converges to its asymptote for that protocol —
// power needs ~6 hangs (PCr-only drain, ~75% refill in 20s),
// capacity ~4 (all three pools drained, 20s only refills the fast
// one), strength sits in between.
// 6-zone scheme (May 2026) — Grip Gains community time domains plus
// an added Max Strength zone for near-MVC work. ZONE_REF_T in
// src/model/zones.js is the source of truth for refTime values; this
// table just adds UI metadata (emoji, color, copy text) on top.
//
// Defaults below for repsDefault / restDefault / setsDefault are
// best-guess starting points for the new hybrid zones — tune as the
// protocols get used in practice. The text rationales for the new
// zones are intentionally shorter than the original three until we
// have empirical observations to write detailed compartment-physiology
// commentary the way the old strings did for power/strength/endurance.
const GOAL_CONFIG = {
  max_strength: {
    label: "Max Strength", emoji: "💥", color: "#c83838",
    refTime: 5, restDefault: 180, repsDefault: 5, setsDefault: 1, setRestDefault: 0,
    intensity: "5 × 5s near-max · 3min rest",
    setsRationale: "Max Strength protocol: 5 hangs of ~5s at near-MVC load with full 3-minute rest between. Long rest fully refills PCr (τ₁≈15s reaches ~99% recovery in 3min) so each hang is a fresh max-effort attempt. Trains neural drive, motor unit recruitment, and intramuscular coordination — adaptations that the longer-duration zones don't touch. Use sparingly: high CNS cost, ~1 session per week tops. Best done warm and well-rested.",
  },
  power: {
    label: "Power", emoji: "⚡", color: "#e05560",
    refTime: 30, restDefault: 60, repsDefault: 5, setsDefault: 1, setRestDefault: 0,
    intensity: "5 × 30s · 60s rest",
    setsRationale: "Power protocol: 5 hangs of ~30s at the load that takes you to failure around that duration, with 60s rest between. The 30s mark is the PCr-glycolytic crossover — fast pool drained, glycolytic ramping. 60s rest refills PCr but only partially restores glycolytic capacity (τ₂≈90s), so successive hangs drift shorter and the rep-time curve becomes a personal glycolytic-recovery probe.",
  },
  power_strength: {
    label: "Power/Strength", emoji: "🔶", color: "#e68a48",
    refTime: 70, restDefault: 90, repsDefault: 4, setsDefault: 1, setRestDefault: 0,
    intensity: "4 × 70s · 90s rest",
    setsRationale: "Power/Strength protocol: 4 hangs of ~70s with 90s rest. Mid-glycolytic time domain — lactate accumulation, buffering capacity. Bridges the gap between Power and Strength so you're not skipping the 50–90s window where many hard route cruxes actually live.",
  },
  strength: {
    label: "Strength", emoji: "💪", color: "#e07a30",
    refTime: 115, restDefault: 120, repsDefault: 4, setsDefault: 1, setRestDefault: 0,
    intensity: "4 × ~115s · 2min rest",
    setsRationale: "Strength protocol: 4 hangs targeting ~115s with 2-minute rest between. Glycolytic-aerobic crossover — heavily lactate-driven but with rising oxidative contribution. Trains lactate tolerance and clearance. Watch hold-time decay across hangs as a personal recovery probe.",
  },
  strength_endurance: {
    label: "Strength/Endurance", emoji: "🟦", color: "#7aa0d8",
    refTime: 160, restDefault: 120, repsDefault: 3, setsDefault: 1, setRestDefault: 0,
    intensity: "3 × ~160s · 2min rest",
    setsRationale: "Strength/Endurance protocol: 3 hangs of ~160s with 2-minute rest. Aerobic-glycolytic blend, dominated by lactate clearance and rising oxidative engagement. Catches the 140–180s window between pure strength and aerobic-dominant endurance.",
  },
  endurance: {
    label: "Endurance", emoji: "🏔️", color: "#3b82f6",
    refTime: 220, restDefault: 60, repsDefault: 3, setsDefault: 1, setRestDefault: 0,
    intensity: "3 × ~220s · 60s rest · near CF",
    setsRationale: "Endurance protocol at load ≈ CF (just above Critical Force). 3 hangs targeting ~220s with 60s rest. Aerobic-dominant — trains capillarity, mitochondrial density, fat oxidation. Hold-time drops fast across hangs as the slow compartment depletes; trust the curve, the load is calibrated to fail you on the tail.",
  },
};

// ─────────────────────────────────────────────────────────────
// 1RM PR TRACKER (legacy)
// ─────────────────────────────────────────────────────────────
// The standalone OneRMWidget was retired now that the power
// protocol (6 × 5–7s max hangs at 20s rest) doubles as a 1RM-
// equivalent warm-up. RM_GRIPS stays so the 1RM PR tracker on
// the Analysis tab can still render historical data, and so
// computeZoneCoverage credits any legacy `type: "oneRM"`
// activity entries to Power.
const RM_GRIPS = ["Micro", "Crusher", "Prime"];

const TABS = ["Fingers", "Analysis", "Journey", "Workout", "Lifts", "Climbing", "History", "Trends", "Settings"];

export default function App() {
  // ── Auth + OTP login (see src/hooks/useAuth.js) ──────────
  const {
    user,
    loginEmail, setLoginEmail,
    otpSent, otpCode, setOtpCode, otpBusy, otpError,
    sendOtp, verifyOtp, cancelOtp, signOut,
  } = useAuth();

  // ── Unit preference ───────────────────────────────────────
  const [unit, setUnit] = useState(() => loadLS("unit_pref") || "lbs");
  const saveUnit = (u) => { setUnit(u); saveLS("unit_pref", u); };

  // ── Body weight ───────────────────────────────────────────
  const [bodyWeight, setBodyWeight] = useState(() => loadLS(LS_BW_KEY) ?? null);
  const saveBW = (kg) => {
    setBodyWeight(kg);
    saveLS(LS_BW_KEY, kg);
    if (kg != null) {
      const log = loadLS(LS_BW_LOG_KEY) || [];
      const d = today();
      // Replace existing entry for today if present, otherwise append
      const updated = log.filter(e => e.date !== d);
      saveLS(LS_BW_LOG_KEY, [...updated, { date: d, kg }].sort((a, b) => a.date < b.date ? -1 : 1));
    }
  };

  // ── Trip (user-editable target trip) ──────────────────────
  const [trip, setTrip] = useState(() => {
    const stored = loadLS(LS_TRIP_KEY);
    return (stored && typeof stored === "object" && stored.date) ? stored : DEFAULT_TRIP;
  });
  const saveTrip = (next) => {
    const merged = { ...trip, ...next };
    setTrip(merged);
    saveLS(LS_TRIP_KEY, merged);
  };

  // ── Training focus (mild periodization bias) ──────────────
  // Set once per training cycle (Settings tab). Defaults to
  // "balanced" so existing users see no behavior change until
  // they pick. See src/model/training-focus.js for the bias map
  // and src/model/coaching.js for how it's applied.
  const [trainingFocus, setTrainingFocusState] = useState(
    () => loadLS(LS_TRAINING_FOCUS_KEY) || DEFAULT_TRAINING_FOCUS
  );
  const setTrainingFocus = (key) => {
    setTrainingFocusState(key);
    saveLS(LS_TRAINING_FOCUS_KEY, key);
  };

  // ── Session notes ─────────────────────────────────────────
  const [notes, setNotes] = useState(() => loadLS(LS_NOTES_KEY) || {});
  const handleNoteChange = useCallback((sessKey, text) => {
    setNotes(prev => {
      const updated = text ? { ...prev, [sessKey]: text } : Object.fromEntries(
        Object.entries(prev).filter(([k]) => k !== sessKey)
      );
      saveLS(LS_NOTES_KEY, updated);
      return updated;
    });
  }, []);

  // Auth subscription + setUser are owned by useAuth() above.

  // ── Rep history + freshMap + cloud reconcile + CRUD ──────
  // (see src/hooks/useRepHistory.js)
  const {
    history,
    freshMap, freshMapFp, threeExpPriors,
    pendingCount, refreshPending,
    addReps, updateRep, deleteRep, updateSession, deleteSession,
    replaceHistory,
    handleWorkoutSessionSaved,
  } = useRepHistory({ user });

  // ── Tab ───────────────────────────────────────────────────
  const [tab, setTab] = useState(0);

  // Readiness score was previously displayed as a 1-10 number computed
  // from training history (24h-decay model in src/model/readiness.js)
  // and fed into the coaching engine. It was removed from the UI and
  // from the coaching pipeline because (a) the displayed number was
  // hard to act on, and (b) the multiplier it produced ([0.5, 1.0])
  // was small relative to the gap/residual/focus factors that
  // actually drive recommendations. The earlier subjective check-in
  // widget — emoji picker on the Setup tab — is also gone. Coaching
  // now uses the engine's default readiness=5 (neutral). Old subjective
  // ratings under LS_READINESS_KEY are orphaned but harmless.

  // ── Live CF/W′ estimate (all failure reps, both hands, all grips) ─────────────
  // Used by SessionPlannerCard and AnalysisView. Updates as training data grows.
  // All-grip adaptive fit — used as the overall curve when no single
  // grip is in focus (e.g. Badges view, fallback when user hasn't yet
  // picked a grip in Setup).
  //
  // Depends on freshMapFp (length+lastId+lastDate) instead of [history]
  // directly, same as freshMap, so unrelated state churn (cloud syncs
  // that touch the array reference without changing data) doesn't
  // re-fire the O(N) fit.
  const liveEstimate = useMemo(() => {
    const allFails = history.filter(r => r.failed && r.avg_force_kg > 0 && r.actual_time_s > 0);
    return fitAdaptiveHandCurve(allFails);
  }, [freshMapFp]); // eslint-disable-line react-hooks/exhaustive-deps

  // Per-grip adaptive fits. FDP and FDS are different muscles (pinch /
  // open-hand roller vs crush roller) with separate force-duration
  // curves; pooling them hides per-muscle training decisions. Each
  // grip gets its own Monod fit so the recommendation engine can pick
  // the right zone for the specific muscle being trained. Same
  // freshMapFp memoization rationale as liveEstimate above.
  const gripEstimates = useMemo(() => {
    const fails = history.filter(r => r.failed && r.grip && r.avg_force_kg > 0 && r.actual_time_s > 0);
    const byGrip = {};
    for (const r of fails) {
      if (!byGrip[r.grip]) byGrip[r.grip] = [];
      byGrip[r.grip].push(r);
    }
    const out = {};
    for (const [grip, rows] of Object.entries(byGrip)) {
      const fit = fitAdaptiveHandCurve(rows);
      if (fit) out[grip] = fit;
    }
    return out;
  }, [freshMapFp]); // eslint-disable-line react-hooks/exhaustive-deps

  // Permanent baseline snapshot — set once from the earliest training data,
  // never overwritten. Seeded automatically (below) from the first few
  // failure reps spanning ≥2 zones.
  const [baseline, setBaseline] = useState(() => loadLS(LS_BASELINE_KEY));
  const [activities, setActivities] = useState(() => loadLS(LS_ACTIVITY_KEY) || []);

  // ── Auto-baseline ─────────────────────────────────────────
  // Seed the CF/W′ reference point from real training data instead of
  // requiring a formal calibration session. Fires once we have ≥3 failure
  // reps spanning ≥2 distinct target durations (so the Monod-Scherrer fit
  // has some spread to work with). The snapshot is dated to the earliest
  // rep in the seed set so "improvement" counts from when you started.
  useEffect(() => {
    if (baseline) return;
    const failures = history
      .filter(r =>
        r.failed &&
        r.avg_force_kg > 0 && r.avg_force_kg < 500 &&
        r.actual_time_s > 0
      )
      .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    const acc = [];
    const durs = new Set();
    for (const r of failures) {
      acc.push(r);
      durs.add(r.target_duration);
      if (acc.length >= 3 && durs.size >= 2) {
        const pts = acc.map(x => ({ x: 1 / x.actual_time_s, y: x.avg_force_kg }));
        const fit = fitCF(pts);
        if (fit) {
          const snap = { date: acc[0].date, CF: fit.CF, W: fit.W };
          saveLS(LS_BASELINE_KEY, snap);
          setBaseline(snap);
        }
        return;
      }
    }
  }, [history, baseline]);

  // Genesis badge snapshot — saved the first time all 3 zones have a session.
  // Must be declared BEFORE the detection useEffect below.
  const [genesisSnap, setGenesisSnap] = useState(() => loadLS(LS_GENESIS_KEY));

  // ── Genesis badge detection ───────────────────────────────
  // Snapshot CF/W′ the first time the user has logged at least one session
  // in each of the three major energy-system FAMILIES:
  //   PCr        : max_strength OR power
  //   Glycolytic : power_strength OR strength
  //   Aerobic    : strength_endurance OR endurance
  //
  // Family-level (not zone-level) gate after the 6-zone migration so users
  // with historical 7s reps (now classified as max_strength under the new
  // boundaries) still register as having trained the PCr family — instead
  // of failing the gate because nothing happened to land in the exact
  // "power" bucket. Same idea for the other two families.
  //
  // The snapshot is the immutable baseline for all subsequent badge
  // progress calculations, so we want the trigger to behave the same way
  // it did in the 3-zone era from the user's perspective: "you've trained
  // all three energy systems at least once."
  useEffect(() => {
    if (genesisSnap) return;           // already earned
    if (!liveEstimate) return;         // no curve yet
    const hasPCr        = history.some(r => ["max_strength", "power"].includes(zoneOf(r.target_duration)));
    const hasGlycolytic = history.some(r => ["power_strength", "strength"].includes(zoneOf(r.target_duration)));
    const hasAerobic    = history.some(r => ["strength_endurance", "endurance"].includes(zoneOf(r.target_duration)));
    if (hasPCr && hasGlycolytic && hasAerobic) {
      const auc  = computeAUC(liveEstimate.CF, liveEstimate.W);
      const snap = { date: today(), CF: liveEstimate.CF, W: liveEstimate.W, auc };
      saveLS(LS_GENESIS_KEY, snap);
      setGenesisSnap(snap);
    }
  }, [history, liveEstimate, genesisSnap]);

  const addActivity = useCallback((act) => {
    setActivities(prev => {
      const next = [...prev, { ...act, id: uid() }];
      saveLS(LS_ACTIVITY_KEY, next);
      return next;
    });
  }, []);

  const deleteActivity = useCallback((id) => {
    setActivities(prev => {
      const next = prev.filter(a => a.id !== id);
      saveLS(LS_ACTIVITY_KEY, next);
      return next;
    });
  }, []);


  // ── Tindeq ────────────────────────────────────────────────
  const tindeq = useTindeq();

  // ── In-workout state machine ──────────────────────────────
  // (see src/hooks/useSessionRunner.js)
  const {
    config, setConfig,
    phase, setPhase,
    currentSet, currentRep, fatigue,
    sessionId, refWeights,
    sessionReps, lastRepResult,
    leveledUp, newLevel,
    activeHand, altRestTime,
    nextWeight,
    startSession, handleRepDone,
    handleRestDone, handleNextSet, handleAbort,
  } = useSessionRunner({
    history, freshMap, threeExpPriors, addReps,
    tindeqConnected: tindeq.connected,
    onSessionStart: () => setTab(0),
  });

  // ── Manual cloud pull ─────────────────────────────────────
  // User-triggered refresh. Flushes any queued local reps first, then
  // refetches reps + workout_sessions from Supabase and merges into state.
  // Without this, devices only fetch once at auth; a workout pushed from
  // device A is invisible on device B until B is reloaded.
  const [pullStatus, setPullStatus] = useState("idle"); // 'idle' | 'pulling' | 'ok' | 'err'
  const [lastPulledAt, setLastPulledAt] = useState(null);
  const pullFromCloud = useCallback(async () => {
    if (!user) return;
    setPullStatus("pulling");
    try {
      const flushed = await flushQueue();
      if (flushed > 0) refreshPending();

      // Reps — reconcile any local-only reps before overwriting state.
      // Tombstone filter (LS_REP_DELETED_KEY) prevents re-uploading
      // reps that were explicitly deleted on this device — see the
      // matching logic + comment in src/hooks/useRepHistory.js's
      // auth-driven reconcile.
      const remoteReps = await fetchReps();
      if (remoteReps) {
        const localReps = loadLS(LS_HISTORY_KEY) || [];
        const keyFor = r => `${r.session_id || r.date}|${r.set_num}|${r.rep_num}|${r.hand}`;
        const remoteKeys = new Set(remoteReps.map(keyFor));
        const tombstoned = new Set(loadLS(LS_REP_DELETED_KEY) || []);
        const toSync = localReps.filter(r =>
          !remoteKeys.has(keyFor(r)) &&
          !(r.id && tombstoned.has(r.id))
        );
        let pushedAny = false;
        for (const rep of toSync) {
          const ok = await pushRep(rep);
          if (ok) pushedAny = true;
          else enqueueReps([rep]);
        }
        const finalReps = pushedAny ? (await fetchReps()) : remoteReps;
        replaceHistory(finalReps);
      }

      // Workout sessions — merge into localStorage (skipping tombstoned ids).
      // WorkoutView re-reads LS on mount, so new workouts appear once the
      // user next navigates there; we trigger a reload below to make them
      // visible immediately across all tabs that use those memos.
      let workoutChanged = false;
      const remote = await fetchWorkoutSessions();
      if (remote) {
        const local      = loadLS(LS_WORKOUT_LOG_KEY) || [];
        const localIds   = new Set(local.map(s => s.id).filter(Boolean));
        const deletedIds = new Set(loadLS(LS_WORKOUT_DELETED_KEY) || []);
        const additions  = remote.filter(s => !localIds.has(s.id) && !deletedIds.has(s.id));
        if (additions.length > 0) {
          saveLS(LS_WORKOUT_LOG_KEY, [...local, ...additions]);
          workoutChanged = true;
        }
        const synced = new Set(loadLS(LS_WORKOUT_SYNCED_KEY) || []);
        remote.forEach(s => s.id && synced.add(s.id));
        saveLS(LS_WORKOUT_SYNCED_KEY, [...synced]);
      }

      refreshPending();
      setLastPulledAt(Date.now());
      setPullStatus("ok");

      // If we merged in new workout_sessions from the cloud, reload so the
      // WorkoutView (which reads LS on mount) picks them up immediately.
      // Reps/history live in App state so they appear without reload.
      if (workoutChanged) {
        setTimeout(() => window.location.reload(), 400);
      }
    } catch (e) {
      console.warn("pullFromCloud failed:", e?.message);
      setPullStatus("err");
    }
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  // OTP send/verify/cancel + signOut are owned by useAuth() above.

  // ── Render ────────────────────────────────────────────────
  return (
    <div style={base}>
      {/* Top nav */}
      <div style={{
        background: C.card, borderBottom: `1px solid ${C.border}`,
        display: "flex", alignItems: "center", padding: "0 16px",
        position: "sticky", top: 0, zIndex: 100,
      }}>
        <div style={{ fontSize: 16, fontWeight: 800, color: C.blue, marginRight: 16, padding: "14px 0" }}>
          🧗 Finger
        </div>
        {TABS.map((t, i) => (
          <button
            key={t}
            onClick={() => { setTab(i); if (i === 0 && phase !== "idle") {/* stay in session */} }}
            style={{
              padding: "14px 12px", fontSize: 13, fontWeight: tab === i ? 700 : 400,
              color: tab === i ? C.blue : C.muted, background: "none", border: "none",
              borderBottom: tab === i ? `2px solid ${C.blue}` : "2px solid transparent",
              cursor: "pointer", whiteSpace: "nowrap",
            }}
          >
            {t}
            {t === "Fingers" && phase !== "idle" && (
              <span style={{ marginLeft: 4, background: C.red, color: "#fff", borderRadius: 10, fontSize: 10, padding: "1px 5px" }}>●</span>
            )}
          </button>
        ))}
        {tindeq.connected && (
          <div style={{ marginLeft: "auto", fontSize: 11, color: C.green }}>⚡ Tindeq</div>
        )}
      </div>

      {/* Unsaved reps warning banner */}
      {pendingCount > 0 && (
        <div style={{
          background: "#3a1f00", borderBottom: `1px solid ${C.orange}`,
          padding: "8px 16px", display: "flex", alignItems: "center", gap: 10,
          fontSize: 13, color: C.orange,
        }}>
          <span>⚠️</span>
          <span>
            {pendingCount} rep{pendingCount !== 1 ? "s" : ""} couldn't sync to the cloud.
            {user ? " Retrying…" : " Sign in to retry."}
          </span>
          {user && (
            <button onClick={() => flushQueue().then(refreshPending)} style={{
              marginLeft: "auto", background: "none", border: `1px solid ${C.orange}`,
              color: C.orange, borderRadius: 6, padding: "2px 10px", cursor: "pointer", fontSize: 12,
            }}>Retry now</button>
          )}
        </div>
      )}

      {/* Train tab */}
      {tab === 0 && (() => {
        if (phase === "idle") {
          const tindeqConnectCard = (
            <div style={{ marginBottom: 12 }}>
              <Card>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>Tindeq Progressor</div>
                    <div style={{ fontSize: 12, color: C.muted }}>
                      {tindeq.connected ? "Connected ✓" : tindeq.reconnecting ? "Reconnecting…" : tindeq.bleError || "Not connected"}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    {tindeq.connected && (
                      <Btn small onClick={tindeq.tare} color={C.muted}>Tare</Btn>
                    )}
                    <Btn
                      small
                      onClick={tindeq.connect}
                      disabled={tindeq.connected || tindeq.reconnecting}
                      color={tindeq.connected ? C.green : tindeq.reconnecting ? C.orange : C.blue}
                    >
                      {tindeq.connected ? "Connected" : tindeq.reconnecting ? "Reconnecting…" : "Connect BLE"}
                    </Btn>
                  </div>
                </div>
                {tindeq.connected && (
                  <div style={{ marginTop: 8, fontSize: 13, color: C.text }}>
                    Live force: <b style={{ color: C.blue }}>{fmtW(tindeq.force, unit)} {unit}</b>
                    <span style={{ marginLeft: 12, color: C.muted, fontSize: 12 }}>
                      (tap Tare to zero before your session)
                    </span>
                  </div>
                )}
                {tindeq.bleError && (
                  <div style={{ marginTop: 8, fontSize: 12, color: C.red }}>{tindeq.bleError}</div>
                )}
              </Card>
            </div>
          );
          return (
            <SetupView
              config={config}
              setConfig={setConfig}
              onStart={startSession}
              history={history}
              freshMap={freshMap}
              unit={unit}
              onBwSave={saveBW}
              liveEstimate={liveEstimate}
              gripEstimates={gripEstimates}
              activities={activities}
              onLogActivity={addActivity}
              connectSlot={tindeqConnectCard}
              GOAL_CONFIG={GOAL_CONFIG}
              GRIP_PRESETS={GRIP_PRESETS}
              trainingFocus={trainingFocus}
              onTrainingFocusChange={setTrainingFocus}
              bodyWeight={bodyWeight}
              tindeq={tindeq}
            />
          );
        }

        if (phase === "rep_ready" || phase === "rep_active") {
          // When Tindeq is connected, use touchless auto-detect mode:
          // reps start and end automatically from force threshold crossings.
          // When not connected, fall back to the manual tap flow.
          if (tindeq.connected && phase === "rep_ready") {
            return (
              <AutoRepSessionView
                key={`auto-${activeHand}-${currentSet}-${currentRep}`}
                session={{ config, currentSet, currentRep, fatigue, sessionId, refWeights, activeHand }}
                onRepDone={handleRepDone}
                onAbort={handleAbort}
                tindeq={tindeq}
                unit={unit}
              />
            );
          }
          return (
            <ActiveSessionView
              key={`${activeHand}-${currentSet}-${currentRep}-${phase}`}
              session={{ config, currentSet, currentRep, fatigue, sessionId, refWeights, activeHand }}
              onRepDone={handleRepDone}
              onAbort={handleAbort}
              tindeq={tindeq}
              autoStart={phase === "rep_active"}
              unit={unit}
            />
          );
        }

        if (phase === "switch_hands") {
          return <SwitchHandsView onReady={() => setPhase("rep_ready")} />;
        }

        if (phase === "alt_switch") {
          // Brief 3-second countdown before the interleaved alt-hand rep
          return (
            <AltSwitchView
              toHand={activeHand}
              onReady={() => setPhase(tindeq.connected ? "rep_ready" : "rep_active")}
            />
          );
        }

        if (phase === "resting") {
          const restSecs = config.altMode && config.hand === "Both" ? altRestTime : config.restTime;
          return (
            <RestView
              lastRep={lastRepResult}
              nextWeight={nextWeight}
              restSeconds={restSecs}
              onRestDone={handleRestDone}
              setNum={currentSet + 1}
              numSets={config.numSets}
              repNum={currentRep}
              repsPerSet={config.repsPerSet}
              unit={unit}
            />
          );
        }

        if (phase === "between_sets") {
          return (
            <BetweenSetsView
              completedSet={currentSet}
              totalSets={config.numSets}
              onNextSet={handleNextSet}
              setRestTime={config.setRestTime}
            />
          );
        }

        if (phase === "done") {
          return (
            <SessionSummaryView
              reps={sessionReps}
              config={config}
              leveledUp={leveledUp}
              newLevel={newLevel}
              onDone={() => setPhase("idle")}
              unit={unit}
            />
          );
        }

        return null;
      })()}

      {tab === 1 && (
        <AnalysisView
          history={history}
          unit={unit}
          bodyWeight={bodyWeight}
          activities={activities}
          liveEstimate={liveEstimate}
          gripEstimates={gripEstimates}
          freshMap={freshMap}
          GOAL_CONFIG={GOAL_CONFIG}
          RM_GRIPS={RM_GRIPS}
          trainingFocus={trainingFocus}
        />
      )}
      {tab === 2 && <BadgesView history={history} threeExpPriors={threeExpPriors} />}
      {tab === 3 && <WorkoutTab unit={unit} onSessionSaved={handleWorkoutSessionSaved} onBwSave={saveBW} trip={trip} />}
      {tab === 4 && <WorkoutAnalysisView unit={unit} bodyWeight={bodyWeight} defaultWorkouts={DEFAULT_WORKOUTS} />}
      {tab === 5 && <ClimbingTab activities={activities} onLogActivity={addActivity} onDeleteActivity={deleteActivity} />}
      {tab === 6 && (
        <HistoryView
          history={history}
          onDownload={() => downloadCSV(history)}
          unit={unit}
          bodyWeight={bodyWeight}
          onDeleteSession={deleteSession}
          onUpdateSession={updateSession}
          onDeleteRep={deleteRep}
          onUpdateRep={updateRep}
          onAddRep={(rep) => addReps(Array.isArray(rep) ? rep : [rep])}
          notes={notes}
          onNoteChange={handleNoteChange}
          activities={activities}
          onDeleteActivity={deleteActivity}
          defaultWorkouts={DEFAULT_WORKOUTS}
          onDeleteWorkoutSession={deleteWorkoutSession}
          onDownloadWorkoutCSV={downloadWorkoutCSV}
          gripPresets={GRIP_PRESETS}
        />
      )}
      {tab === 7 && <TrendsView history={history} unit={unit} activities={activities} defaultWorkouts={DEFAULT_WORKOUTS} />}
      {tab === 8 && (
        <SettingsView
          user={user}
          loginEmail={loginEmail}
          setLoginEmail={setLoginEmail}
          onSendOtp={sendOtp}
          onVerifyOtp={verifyOtp}
          onCancelOtp={cancelOtp}
          otpSent={otpSent}
          otpCode={otpCode}
          setOtpCode={setOtpCode}
          otpBusy={otpBusy}
          otpError={otpError}
          onSignOut={signOut}
          unit={unit}
          onUnitChange={saveUnit}
          bodyWeight={bodyWeight}
          onBWChange={saveBW}
          trip={trip}
          onTripChange={saveTrip}
          trainingFocus={trainingFocus}
          onTrainingFocusChange={setTrainingFocus}
          onPullFromCloud={pullFromCloud}
          pullStatus={pullStatus}
          lastPulledAt={lastPulledAt}
        />
      )}
    </div>
  );
}
