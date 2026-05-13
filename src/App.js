// src/App.js  — Finger Training v3
// Rep-based sessions · Three-Compartment Fatigue Model · Tindeq Progressor BLE · Gamification
import React, {
  useCallback, useEffect, useState,
} from "react";
// UI primitives (theme, formatters, shared components). See src/ui/.
import { C, base } from "./ui/theme.js";
import { Card, Btn } from "./ui/components.js";
import { fmtW } from "./ui/format.js";

// Top-level views extracted from this file. See src/views/.
import { HistoryView } from "./views/HistoryView.js";
import { SettingsView } from "./views/SettingsView.js";
// AnalysisView is now imported by AnalysisContainer (see below) rather
// than by App.js directly — the container hosts the Fingers / Lifts
// pill toggle and renders one of two analysis views beneath it.
import { SetupView } from "./views/SetupView.js";
import {
  ActiveSessionView, AutoRepSessionView,
  RestView, SwitchHandsView,
  SessionSummaryView,
} from "./views/ActiveSessionViews.js";
import { WorkoutTab, DEFAULT_WORKOUTS } from "./views/WorkoutTab.js";
import { AnalysisContainer } from "./views/AnalysisContainer.js";

// Shared lib helpers (storage, trip dates, CSV). See src/lib/.
import {
  loadLS, saveLS,
  LS_HISTORY_KEY, LS_REP_DELETED_KEY,
  LS_BW_LOG_KEY, LS_WORKOUT_LOG_KEY,
  LS_WORKOUT_SYNCED_KEY, LS_WORKOUT_DELETED_KEY,
} from "./lib/storage.js";
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
  pushBW, fetchBWLog,
  pushActivity, deleteActivityCloud, fetchActivities,
} from "./lib/sync.js";

// Model layer — pure JS, testable in isolation. See src/model/*.js.
import { today, uid } from "./util.js";

// ─────────────────────────────────────────────────────────────
// CONSTANTS / UTILITIES
// ─────────────────────────────────────────────────────────────
// Most code that App.js used to inline now lives in extracted
// modules — see the imports above:
//   src/model/  pure JS math (three-exp, fatigue, prescription,
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
// state (history, activities, bodyWeight, trip),
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
// (LS_BASELINE_KEY removed — was a Monod CF/W' snapshot, now obsolete.
// The localStorage entry "ft_baseline" is orphaned but harmless.)
const LS_ACTIVITY_KEY  = "ft_activity";  // [{ id, date, type: "climbing", discipline, grade, ascent }]
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
// Defaults below for repsDefault / restDefault are best-guess starting
// points for the new hybrid zones — tune as the protocols get used in
// practice. The text rationales for the new zones are intentionally
// shorter than the original three until we have empirical observations
// to write detailed compartment-physiology commentary the way the old
// strings did for power/strength/endurance.
//
// Multi-set fields (setsDefault, setRestDefault) were dropped May 2026
// when the workout runner moved to single-set sessions only. The
// `setsRationale` + `intensity` text fields followed shortly after:
// no consumer rendered them. The continuous engine derives reps/rest
// from T_star directly, so the protocol-description strings were dead
// text. Reference times, labels, colors, and emojis are still consumed
// across SetupView, AnalysisView's PrescribedLoadCard, and elsewhere.
const GOAL_CONFIG = {
  max_strength: {
    label: "Max Strength", emoji: "💥", color: "#c83838",
    refTime: 5, restDefault: 180, repsDefault: 5,
  },
  power: {
    label: "Power", emoji: "⚡", color: "#e05560",
    refTime: 30, restDefault: 60, repsDefault: 5,
  },
  power_strength: {
    label: "Power/Strength", emoji: "🔶", color: "#e68a48",
    refTime: 70, restDefault: 90, repsDefault: 4,
  },
  strength: {
    label: "Strength", emoji: "💪", color: "#e07a30",
    refTime: 115, restDefault: 120, repsDefault: 4,
  },
  strength_endurance: {
    label: "Strength/Endurance", emoji: "🟦", color: "#7aa0d8",
    refTime: 160, restDefault: 120, repsDefault: 3,
  },
  endurance: {
    label: "Endurance", emoji: "🏔️", color: "#3b82f6",
    refTime: 220, restDefault: 60, repsDefault: 3,
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

// Tab order. Fingers + Workout are the two "doing the work" tabs and
// sit next to each other at the front. Analysis is the unified "look
// back" tab — it hosts a Fingers / Lifts pill toggle internally so
// per-exercise lift progression and Tindeq finger analysis live in
// one place. History stays before Settings as the "everything that
// ever happened" log. (Lifts as a top-level tab was retired May 2026
// and folded into Analysis via AnalysisContainer.)
const TABS = ["Fingers", "Workout", "Analysis", "History", "Settings"];

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
  // Two storage keys: LS_BW_KEY is the scalar current weight that
  // every consumer reads, LS_BW_LOG_KEY is the per-date history that
  // the trends + per-session-date normalization paths consume. saveBW
  // writes to both. On boot we hydrate the scalar from the latest log
  // entry when it's missing — handles the case where cloud sync only
  // restored the log (or the scalar got cleared independently). Without
  // this guard the F-D chart's BW-relative toggle and any future BW
  // normalization stay silently hidden even though the data is present.
  const [bodyWeight, setBodyWeight] = useState(() => {
    const scalar = loadLS(LS_BW_KEY);
    if (scalar != null) return scalar;
    const log = loadLS(LS_BW_LOG_KEY) || [];
    if (log.length === 0) return null;
    const latest = [...log].sort((a, b) => a.date < b.date ? -1 : 1).at(-1);
    const kg = latest?.kg ?? null;
    if (kg != null) saveLS(LS_BW_KEY, kg);  // hydrate so subsequent loads are O(1)
    return kg;
  });
  const saveBW = (kg) => {
    setBodyWeight(kg);
    saveLS(LS_BW_KEY, kg);
    if (kg != null) {
      const log = loadLS(LS_BW_LOG_KEY) || [];
      const d = today();
      // Replace existing entry for today if present, otherwise append
      const updated = log.filter(e => e.date !== d);
      saveLS(LS_BW_LOG_KEY, [...updated, { date: d, kg }].sort((a, b) => a.date < b.date ? -1 : 1));
      // Best-effort cloud push (fire-and-forget). Failures are
      // logged but otherwise silent — the local write is already
      // durable, and the next sign-in reconcile will catch any
      // entries that didn't make it to the server.
      pushBW(d, kg);
    }
  };

  // ── BW cloud reconcile ───────────────────────────────────
  // Runs when `user` flips from null → signed-in. Mirrors the
  // useRepHistory reconcile pattern: fetch cloud log, union with
  // local log on date-key (later-write wins for same-day collisions —
  // we trust local since the user just opened the app there), save
  // the merged set back to LS, and re-derive the scalar from the
  // latest entry. Also fires a push for any local-only entries the
  // cloud doesn't yet know about, so a previously-offline device's
  // BW history gets backfilled on first sign-in.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      const cloud = await fetchBWLog();
      if (cancelled || !cloud) return;
      const local = loadLS(LS_BW_LOG_KEY) || [];
      // Merge: same-date local wins (assumption: local is the device
      // the user is actively using, so its writes are most recent).
      const byDate = new Map();
      for (const e of cloud) byDate.set(e.date, e);
      for (const e of local) byDate.set(e.date, e);
      const merged = [...byDate.values()].sort((a, b) => a.date < b.date ? -1 : 1);
      saveLS(LS_BW_LOG_KEY, merged);
      // Hydrate the scalar from the latest merged entry.
      const latest = merged.at(-1);
      if (latest?.kg > 0) {
        setBodyWeight(latest.kg);
        saveLS(LS_BW_KEY, latest.kg);
      }
      // Backfill any local-only entries to the cloud (one push per
      // missing date). Fire-and-forget; same as saveBW's push path.
      const cloudDates = new Set(cloud.map(e => e.date));
      for (const e of local) {
        if (!cloudDates.has(e.date) && e.kg > 0) pushBW(e.date, e.kg);
      }
    })();
    return () => { cancelled = true; };
  }, [user]);

  // ── Activities cloud reconcile ───────────────────────────
  // Same shape as the BW reconcile above. Activities are id-keyed
  // (the local uid()), so the merge dedupes on id rather than date —
  // a user can log multiple climbs in one day and each gets its own
  // record. Cloud-only entries get added to the local set; local-only
  // entries get pushed up. No tombstone tracking yet, so a deleted-
  // on-phone climb might come back on next sign-in if the cloud delete
  // hadn't reached the server before the device went offline; rare
  // enough to not be worth the LS_ACTIVITY_DELETED_KEY plumbing yet.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      const cloud = await fetchActivities();
      if (cancelled || !cloud) return;
      const local = loadLS(LS_ACTIVITY_KEY) || [];
      const byId = new Map();
      for (const a of cloud) byId.set(a.id, a);
      // Local writes are most recent on this device — same convention
      // as the BW reconcile. If the user edited a climb on this device
      // between sign-ins, the local copy wins.
      for (const a of local) byId.set(a.id, a);
      const merged = [...byId.values()];
      saveLS(LS_ACTIVITY_KEY, merged);
      setActivities(merged);
      // Backfill any local-only entries to the cloud.
      const cloudIds = new Set(cloud.map(a => a.id));
      for (const a of local) {
        if (a?.id && !cloudIds.has(a.id)) pushActivity(a);
      }
    })();
    return () => { cancelled = true; };
  }, [user]);

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

  // (Training Focus removed May 2026 — under the curve-trust model the
  // curve is the single source of truth; no user-configurable bias
  // overrides it. Old localStorage entries under LS_TRAINING_FOCUS_KEY
  // are orphaned but harmless. See coaching.js for the unweighted
  // score function.)

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
    freshMap, threeExpPriors,
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

  // (liveEstimate / gripEstimates Monod useMemos removed in the
  // Monod-removal pass — App.js no longer imports any Monod code.
  // The three-exp curve is the only F-D model now; per-grip fits
  // happen on-demand inside AnalysisView via fitThreeExpAmps.)

  // (Baseline-snapshot Monod CF/W' state + auto-baseline effect removed
  // in the same pass. The snapshot was stored to LS_BASELINE_KEY but
  // never read by anything downstream — pure dead code under the
  // three-exp model. Per-grip baselines for the Curve Improvement card
  // are derived live in AnalysisView from the three-exp fit.)
  const [activities, setActivities] = useState(() => loadLS(LS_ACTIVITY_KEY) || []);

  // (Genesis badge snapshot + detection effect removed — the Journey /
  // BadgesView surface that consumed it was deleted in commit caf7d2a.
  // The localStorage entry under LS_GENESIS_KEY is orphaned but
  // harmless; nothing reads it. The constant is also deleted below.)

  const addActivity = useCallback((act) => {
    const stamped = { ...act, id: uid() };
    setActivities(prev => {
      const next = [...prev, stamped];
      saveLS(LS_ACTIVITY_KEY, next);
      return next;
    });
    // Best-effort cloud push (fire-and-forget). Failures are silent —
    // local write is durable and the next sign-in reconcile backfills
    // anything that didn't make it. Mirrors the saveBW pattern.
    pushActivity(stamped);
  }, []);

  const deleteActivity = useCallback((id) => {
    setActivities(prev => {
      const next = prev.filter(a => a.id !== id);
      saveLS(LS_ACTIVITY_KEY, next);
      return next;
    });
    // Cloud delete by id. If it fails, the next reconcile will resurrect
    // the entry from the cloud — that's acceptable for now (no tombstone
    // tracking yet for activities; rep deletes use LS_REP_DELETED_KEY,
    // and we can add the same pattern here if delete-resurrection
    // becomes a real problem).
    deleteActivityCloud(id);
  }, []);

  // Edit an existing activity. Same id → same Supabase row → upsert
  // replaces the cloud copy on conflict. Used by the History tab's
  // climb editor so you can fix a mis-typed grade or wrong date
  // without deleting + re-logging.
  const updateActivity = useCallback((id, updates) => {
    let updated = null;
    setActivities(prev => {
      const next = prev.map(a => {
        if (a.id !== id) return a;
        const merged = { ...a, ...updates, id: a.id };
        updated = merged;
        return merged;
      });
      saveLS(LS_ACTIVITY_KEY, next);
      return next;
    });
    if (updated) pushActivity(updated);
  }, []);

  // Set the session-RPE override for an entire climbing session (date).
  // Writes the same session_rpe to every climb row on that date so the
  // engine's computeSessionFatigue picks it up regardless of which row
  // gets read. Phase B of the climbing-fatigue system; see
  // src/model/climbingFatigue.js for the consumer.
  const setSessionRPE = useCallback((date, rpe) => {
    if (!date) return;
    const v = Number(rpe);
    const value = Number.isFinite(v) && v >= 1 && v <= 10 ? Math.round(v) : null;
    const toPush = [];
    setActivities(prev => {
      const next = prev.map(a => {
        if (a.type !== "climbing" || a.date !== date) return a;
        const merged = { ...a, session_rpe: value };
        toPush.push(merged);
        return merged;
      });
      saveLS(LS_ACTIVITY_KEY, next);
      return next;
    });
    for (const a of toPush) pushActivity(a);
  }, []);


  // ── Tindeq ────────────────────────────────────────────────
  const tindeq = useTindeq();

  // ── In-workout state machine ──────────────────────────────
  // (see src/hooks/useSessionRunner.js)
  const {
    config, setConfig,
    phase, setPhase,
    currentRep,
    sessionId, refWeights,
    sessionReps, lastRepResult,
    leveledUp, newLevel,
    activeHand,
    nextWeight,
    startSession, handleRepDone,
    handleRestDone, handleAbort,
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
      {/* Top nav — horizontally scrollable. With 9 tabs the row
          overflows the viewport on phones; rather than hide tabs in
          a hamburger or wrap to two rows (which loses the sticky-
          single-line shape), let the row scroll horizontally and
          hide the scrollbar. flexShrink: 0 on each button keeps
          tabs from compressing into illegibility when the container
          narrows. The .no-scrollbar class hides the WebKit scrollbar
          (Chrome/Safari) since that pseudo-element can't be set
          inline; scrollbarWidth/msOverflowStyle handle Firefox + IE. */}
      <div
        className="no-scrollbar"
        style={{
          background: C.card, borderBottom: `1px solid ${C.border}`,
          display: "flex", alignItems: "center", padding: "0 16px",
          position: "sticky", top: 0, zIndex: 100,
          overflowX: "auto",
          WebkitOverflowScrolling: "touch",
          scrollbarWidth: "none",   // Firefox
          msOverflowStyle: "none",  // IE/Edge legacy
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 800, color: C.blue, marginRight: 16, padding: "14px 0", flexShrink: 0 }}>
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
              flexShrink: 0,
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
              activities={activities}
              onLogActivity={addActivity}
              onSetSessionRPE={setSessionRPE}
              connectSlot={tindeqConnectCard}
              GOAL_CONFIG={GOAL_CONFIG}
              GRIP_PRESETS={GRIP_PRESETS}
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
                key={`auto-${activeHand}-${currentRep}`}
                session={{ config, currentRep, sessionId, refWeights, activeHand }}
                onRepDone={handleRepDone}
                onAbort={handleAbort}
                tindeq={tindeq}
                unit={unit}
              />
            );
          }
          return (
            <ActiveSessionView
              key={`${activeHand}-${currentRep}-${phase}`}
              session={{ config, currentRep, sessionId, refWeights, activeHand }}
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

        // (alt_switch phase removed — alternating-hand mode is gone with
        // the flat 20s rest; Both-mode now does all hangs on one hand
        // then switches to the other.)

        if (phase === "resting") {
          return (
            <RestView
              lastRep={lastRepResult}
              nextWeight={nextWeight}
              restSeconds={config.restTime}
              onRestDone={handleRestDone}
              repNum={currentRep}
              repsPerSet={config.repsPerSet}
              unit={unit}
            />
          );
        }

        // (between_sets phase removed — single-set only under curve-trust commit C)

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

      {tab === 1 && <WorkoutTab unit={unit} onSessionSaved={handleWorkoutSessionSaved} onBwSave={saveBW} trip={trip} />}
      {tab === 2 && (
        <AnalysisContainer
          history={history}
          unit={unit}
          bodyWeight={bodyWeight}
          activities={activities}
          freshMap={freshMap}
          GOAL_CONFIG={GOAL_CONFIG}
          RM_GRIPS={RM_GRIPS}
          defaultWorkouts={DEFAULT_WORKOUTS}
        />
      )}
      {/* (Journey / BadgesView tab removed May 2026 — the badge ladder
          was gamification on top of AUC % growth, which Curve
          Improvement on Analysis already shows directly. Lifts
          retired as a top-level tab in May 2026 and folded into
          Analysis via AnalysisContainer's Fingers / Lifts pill.
          Climbing tab removed in the same wave — full climb logger
          merged into Fingers; climbing history viewed in History tab.) */}
      {tab === 3 && (
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
          onUpdateActivity={updateActivity}
          defaultWorkouts={DEFAULT_WORKOUTS}
          onDeleteWorkoutSession={deleteWorkoutSession}
          onDownloadWorkoutCSV={downloadWorkoutCSV}
          gripPresets={GRIP_PRESETS}
        />
      )}
      {/* (Trends tab removed May 2026 — finger trends shown on
          Analysis as Total Capacity AUC over time; body weight and
          lifts have their own homes too. Climbing trends were also
          dropped when the Climbing tab was retired.) */}
      {tab === 4 && (
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
          onPullFromCloud={pullFromCloud}
          pullStatus={pullStatus}
          lastPulledAt={lastPulledAt}
        />
      )}
    </div>
  );
}
