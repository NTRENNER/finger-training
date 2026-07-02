// ─────────────────────────────────────────────────────────────
// WORKOUT TAB
// ─────────────────────────────────────────────────────────────
// Strength / power / mobility training that supports climbing.
// Rebuilt May 2026 around the supportTraining schema (see
// src/model/supportTraining.js) — one BIG workout per week (A)
// plus two frequent low-friction sessions (B / C), with a daily
// stretching pill rendered below the picker for mobility (it's
// a daily habit, not a weekly slot). The previous 3-day rotation
// (legacy A/B/C, "Lift Day 1" / "Lift Day 2" / "Power") was prone
// to skipped sessions because the high-volume days took too long;
// the new shape addresses that directly.
//
// Flow:
//   1. recommendNextWorkout() looks at the user's recent support
//      sessions and proposes one workout for today, with a one-line
//      reason.
//   2. The user can accept the recommendation or override via the
//      A/B/C picker. The StretchPill below the picker is an
//      independent daily toggle, not a recommender output. CLIMB
//      and REST are never recommended either — climbing is logged
//      via the climbing activities flow, REST is just "don't open
//      the app today."
//   3. Active session: loggable exercises (per-set weight tracking)
//      render with SessionExRow (preserved from the previous
//      WorkoutTab — recommendSet drives weight suggestions); non-
//      loggable exercises (mobility, explosive, bodyweight)
//      render as compact SimpleExRow tiles with done + notes.
//   4. Saving stamps `workoutId: A|B|C|STRETCH` alongside the
//      legacy `workout` field for back-compat with the existing
//      log shape. HistoryView reads `workout` first, so legacy
//      sessions render unchanged.
//
// LEGACY_WORKOUTS / DEFAULT_WORKOUTS / ALL_WORKOUTS_LOOKUP live in
// src/data/legacyWorkouts.js (extracted May 2026, relocated from
// src/views/workout/workoutLegacy.js to src/data/ in late May 2026
// since it's pure data, not a view component). App.js imports
// ALL_WORKOUTS_LOOKUP from there and threads it through to the
// History / Analysis surfaces that need it.
//
// Plan editor and exercise substitutes are gone — the supportTraining
// workouts are opinionated about which exercises do what, and the
// substitute table was keyed by legacy exercise IDs that no longer
// exist. Both can come back if needed; for now the simpler tab is
// the point.

import React, { useEffect, useMemo, useRef, useState } from "react";

import { C } from "../ui/theme.js";
import { Card } from "../ui/components.js";

import {
  loadLS, saveLS,
  LS_WORKOUT_LOG_KEY, LS_WORKOUT_SYNCED_KEY, LS_WORKOUT_DELETED_KEY,
  LS_DELOAD_WEEK_KEY, ROTATION_PIN_KEY,
} from "../lib/storage.js";
import { DELOAD_WEEK_DAYS } from "../model/deload.js";
import {
  pushWorkoutSession, deleteWorkoutSession,
} from "../lib/sync.js";
import {
  DEFAULT_TRIP, weeksToTrip, tripCountdown,
} from "../lib/trip.js";

import { today, nowISO } from "../util.js";
import { useLSValue } from "../hooks/useLSValue.js";
import { recommendSet, recommendSetCount } from "../model/workout-progression.js";
import { shortBuildLabel } from "../lib/buildInfo.js";

import {
  workouts as SUPPORT_WORKOUTS,
  recommendNextWorkout,
} from "../model/supportTraining.js";

import { BwPrompt } from "./SetupView.js";

import { WORKOUT_COLORS } from "./workout/workoutConstants.js";
import { WTypeBadge } from "./workout/WTypeBadge.js";
import { VideoLink } from "./workout/VideoLink.js";
import { SessionExRow } from "./workout/SessionExRow.js";
import { SimpleExRow } from "./workout/SimpleExRow.js";
import { RecommendationCard } from "./workout/RecommendationCard.js";
import { WorkoutPicker } from "./workout/WorkoutPicker.js";
import { StretchPill } from "./workout/StretchPill.js";
import { ExercisePicker } from "./workout/ExercisePicker.js";
import {
  countSupportSessions, setSummary, findLastSessionFor,
} from "./workout/workoutHelpers.js";

function genId() { return Math.random().toString(36).slice(2, 10); }


// ─────────────────────────────────────────────────────────────
// Main WorkoutTab
// ─────────────────────────────────────────────────────────────
export function WorkoutTab({
  unit,
  onSessionSaved,
  onBwSave = () => {},
  trip = DEFAULT_TRIP,
}) {
  // ── State ─────────────────────────────────────────────
  // wLog — live LS read. This view used to hold the log in useState
  // (seeded at mount) and mirror every save into that shadow copy;
  // now saveLS's subscriber notification IS the state update, and
  // sessions merged by the cloud reconcile / manual pull show up in
  // the recommender + stretch pill without a remount.
  const wLogRaw = useLSValue(LS_WORKOUT_LOG_KEY);
  const wLog = useMemo(() => wLogRaw || [], [wLogRaw]);

  // May 2026 D → C migration for historical sessions still carrying
  // workoutId "D". Moved out of the old useState initializer into a
  // mount effect: the initializer ran during RENDER, so its saveLS +
  // cloud pushes double-fired under StrictMode's double-invoke (and
  // writing storage from render is illegal now that saveLS notifies
  // subscribers). Idempotency is layered: the ref stops a re-run
  // within this component instance, and the fresh loadLS means a
  // second run (remount) finds no "D" sessions left and no-ops before
  // touching the cloud. The re-push goes through pushWorkoutSession's
  // id-keyed upsert, so a device that already migrated makes it a
  // harmless no-op. Failures are logged by the sync helper and don't
  // block the UI — the local rewrite already landed, so history reads
  // correctly immediately; cloud reconciles whenever sync next succeeds.
  const dToCMigrationRan = useRef(false);
  useEffect(() => {
    if (dToCMigrationRan.current) return;
    dToCMigrationRan.current = true;
    const raw = loadLS(LS_WORKOUT_LOG_KEY) || [];
    if (!raw.some(s => s?.workoutId === "D")) return;
    const migrated = raw.map(s =>
      s?.workoutId === "D" ? { ...s, workout: "C", workoutId: "C" } : s
    );
    saveLS(LS_WORKOUT_LOG_KEY, migrated);
    for (let i = 0; i < raw.length; i++) {
      if (raw[i]?.workoutId === "D") {
        pushWorkoutSession(migrated[i]).catch(() => {});
      }
    }
  }, []);
  // pickedId: null means "follow recommendation"; otherwise an
  // explicit workout selection.
  const [pickedId, setPickedId] = useState(null);
  const [sessionActive, setSessionActive] = useState(false);
  const [sessionData, setSessionData] = useState({}); // exId → { sets:[...] } | { done, notes }
  const [sessionNotes, setSessionNotes] = useState(""); // overall session note
  // Session-local exercise list. Seeded from activeWorkout.exercises
  // at startSession; mutated by the per-row swap picker so a user can
  // substitute one exercise for another mid-workout without editing
  // the template. Rendering walks liveExercises (not activeWorkout)
  // once a session is active. Cleared when the session ends.
  const [liveExercises, setLiveExercises] = useState([]);
  // Swap picker state. null = closed; otherwise { index: number } —
  // the position in liveExercises being replaced. Add-at-end is
  // signaled by index === liveExercises.length.
  const [pickerState, setPickerState] = useState(null);

  // ── Recommendation ───────────────────────────────────
  // Drop pin-style rotation sessions (legacy ROTATION_PIN_KEY) so
  // they don't pollute the recommender's daysSinceLastOfType counts.
  // Accept either workoutId (modern stamp) OR the legacy `workout`
  // field — a session saved by an older client version, or one
  // cloud-pulled before sync.js's mirror caught up in local LS,
  // would otherwise be invisible to the recommender even though
  // it's clearly an A/B/C session. Sessions that lack BOTH keys
  // (truly unclassified historical entries) stay invisible.
  const recommenderInput = useMemo(() =>
    wLog.filter(s => s && (s.workoutId || s.workout) && s.workout !== ROTATION_PIN_KEY),
    [wLog]
  );
  const recommendation = useMemo(
    () => recommendNextWorkout(recommenderInput, {
      refDate: today(),
    }),
    [recommenderInput]
  );

  // The active workout is either the user's override or the
  // recommender's primary. We then look up the full template from
  // SUPPORT_WORKOUTS.
  const activeId = pickedId || recommendation?.primary?.id || "A";
  const activeWorkout = SUPPORT_WORKOUTS[activeId];

  // Deload-week nudge — set on the Setup tab when the user accepts a
  // deload. During the week, suggest skipping the heavy day (A) and
  // keeping any session light. Read-only here; ending the week happens
  // on the banner that started it.
  // Live read (was a per-render loadLS parse) — SetupView's banner
  // writes this key, so accepting/ending a deload updates the nudge
  // here through the same subscription path as everything else.
  const deloadWeek = useLSValue(LS_DELOAD_WEEK_KEY);
  const deloadDay = deloadWeek?.start
    ? Math.round((new Date(today()) - new Date(deloadWeek.start)) / 86400000) + 1
    : 0;
  const deloadActive = !!deloadWeek?.start && deloadDay >= 1 && deloadDay <= DELOAD_WEEK_DAYS
    && deloadWeek.severity === "strong";

  // ── Daily stretching state ───────────────────────────
  // Read today's STRETCH session (if any) and the most recent
  // STRETCH date from the log. The pill consumes both — today's
  // session drives the done/not-done state for the toggle, the
  // most-recent date drives the soft staleness coloring.
  const stretchState = useMemo(() => {
    const todayStr = today();
    let todaySession = null;
    let mostRecentDate = null;
    // Accept either workoutId or the legacy `workout` field. The sync
    // layer now mirrors one into the other on fetch, but older LS
    // entries or future schema drift could still leave only one set,
    // so check both rather than break the pill silently.
    const isStretch = (s) => s && (s.workoutId === "STRETCH" || s.workout === "STRETCH");
    for (const s of wLog) {
      if (!isStretch(s)) continue;
      if (s.date === todayStr) todaySession = s;
      if (!mostRecentDate || s.date > mostRecentDate) mostRecentDate = s.date;
    }
    let daysSince = null;
    if (mostRecentDate) {
      const a = new Date(mostRecentDate + "T00:00:00").getTime();
      const b = new Date(todayStr        + "T00:00:00").getTime();
      if (Number.isFinite(a) && Number.isFinite(b)) {
        daysSince = Math.max(0, Math.floor((b - a) / (24 * 60 * 60 * 1000)));
      }
    }
    return { todaySession, daysSince, done: !!todaySession };
  }, [wLog]);

  // Per-exercise seed builder. Pulled out of startSession so the
  // mid-session swap/add picker can reuse it for a single exercise
  // without duplicating the three-logging-mode branching.
  const seedExercise = (ex) => {
    if (!ex.loggable) return { done: false, notes: "" };
    // Set ladder (June 2026): weight-logged exercises earn sets at
    // constant load — see recommendSetCount. circles/band exercises
    // keep their template counts (no load to ladder against), and
    // variant-ladder exercises (logVariant, June 2026) are excluded
    // too — their progression variable is leverage, not load, and
    // they're maintenance-dosed by design (no set accumulation).
    const isWeightLogged = !ex.circlesOnly && !ex.logBand && !ex.logVariant;
    const ladder = isWeightLogged
      ? recommendSetCount(wLog, ex, ex.sets || 1)
      : null;
    const setCount = ladder ? ladder.sets : (ex.sets || 1);
    const sets = Array.from({ length: setCount }, (_, i) => {
      if (ex.circlesOnly) {
        // Seed reps from the prior session when the exercise tracks
        // reps too; otherwise just a bare done flag.
        if (ex.reps) {
          const lastSession = findLastSessionFor(wLog, activeId, ex.id);
          const lastSet = lastSession?.exercises?.[ex.id]?.sets?.[i];
          return { reps: lastSet?.reps ?? "", done: false };
        }
        return { done: false };
      }
      if (ex.logBand) {
        // Seed band from last session if available — no progression
        // logic (band selection is qualitative; let user step up
        // manually when they're ready). Lookup the most-recent
        // session containing this exercise to pull the prior band.
        const lastSession = findLastSessionFor(wLog, activeId, ex.id);
        const lastSet = lastSession?.exercises?.[ex.id]?.sets?.[i];
        if (ex.unilateral) {
          return {
            leftReps:  lastSet?.leftReps  ?? ex.reps ?? "",
            leftBand:  lastSet?.leftBand  ?? "",
            rightReps: lastSet?.rightReps ?? ex.reps ?? "",
            rightBand: lastSet?.rightBand ?? "",
            done: false,
          };
        }
        return {
          reps: lastSet?.reps ?? ex.reps ?? "",
          band: lastSet?.band ?? "",
          done: false,
        };
      }
      if (ex.logVariant) {
        // Variant-ladder exercises (June 2026, e.g. TRX Row): each set
        // logs which leverage variant was used alongside reps and an
        // OPTIONAL weight (vest). Same seeding precedent as logBand —
        // inherit variant/reps/weight from the most recent session
        // containing this exercise, no progression math (stepping to
        // the next rung is a user judgment call, like band color).
        // Default variant = the easiest rung (first in `variants`);
        // weight stays blank until the user actually adds a vest.
        const lastSession = findLastSessionFor(wLog, activeId, ex.id);
        const lastSet = lastSession?.exercises?.[ex.id]?.sets?.[i];
        return {
          variant: lastSet?.variant ?? (ex.variants?.[0] ?? ""),
          reps:    lastSet?.reps    ?? ex.reps ?? "",
          weight:  lastSet?.weight  ?? "",
          done: false,
        };
      }
      // Default weight-logged exercise — seed via recommendSet, with
      // the ladder plan steering the load policy (hold during set
      // accumulation; step/jump/bridge only at top-out).
      const rec = recommendSet(wLog, ex, activeId, i, null, ladder);
      if (ex.unilateral) {
        return {
          leftReps:    rec?.leftReps    ?? ex.reps ?? "",
          leftWeight:  rec?.leftWeight  ?? "",
          rightReps:   rec?.rightReps   ?? ex.reps ?? "",
          rightWeight: rec?.rightWeight ?? "",
          done: false,
        };
      }
      return {
        reps:   rec?.reps   ?? ex.reps ?? "",
        weight: rec?.weight ?? "",
        done: false,
      };
    });
    return { sets };
  };

  // ── Session start ────────────────────────────────────
  const startSession = () => {
    if (!activeWorkout || activeWorkout.exercises.length === 0) {
      // CLIMB / REST have no exercises — saving doesn't apply.
      // Just save a marker session for the log.
      saveMarkerSession(activeId);
      return;
    }
    const seed = {};
    for (const ex of activeWorkout.exercises) {
      seed[ex.id] = seedExercise(ex);
    }
    setSessionData(seed);
    setLiveExercises(activeWorkout.exercises);
    setSessionNotes("");
    setSessionActive(true);
  };

  // ── Mid-session exercise swap / add ──────────────────
  // The picker dispatches here. `index === liveExercises.length` means
  // "append a new exercise" (the add-at-end affordance); anything
  // smaller is a swap of the row at that index. The old exercise's
  // sessionData entry is dropped on swap so we don't carry stale data
  // for a row that's no longer visible.
  const handlePickerPick = (newEx) => {
    const idx = pickerState?.index ?? liveExercises.length;
    setPickerState(null);
    if (!newEx) return;
    // Guard against duplicate IDs (the picker already excludes them
    // but a stale click could race the close).
    if (liveExercises.some((ex, i) => i !== idx && ex.id === newEx.id)) return;
    setLiveExercises(prev => {
      const next = [...prev];
      if (idx >= next.length) next.push(newEx);
      else next[idx] = newEx;
      return next;
    });
    setSessionData(prev => {
      const next = { ...prev };
      // Swap path: drop the data entry for the exercise we're
      // replacing so the saved session reflects what was actually
      // performed (not a phantom dips entry left behind by a swap
      // to push-ups).
      if (idx < liveExercises.length) {
        const replacedId = liveExercises[idx]?.id;
        if (replacedId && replacedId !== newEx.id) delete next[replacedId];
      }
      next[newEx.id] = seedExercise(newEx);
      return next;
    });
  };

  // ── Save a session ───────────────────────────────────
  // Stamps `workoutId` (new schema, recommender-readable) AND
  // `workout` (legacy field, HistoryView reads this for display).
  // Same shape as the previous WorkoutTab's session record so the
  // existing cloud sync and History rendering keep working.
  const saveSession = () => {
    if (!activeWorkout) return;
    const wasRecommended = activeId === recommendation?.primary?.id;
    const session = {
      id: genId(),
      date: today(),
      completedAt: nowISO(),
      workout: activeId,
      workoutId: activeId,
      sessionNumber: countSupportSessions(wLog) + 1,
      wasRecommended,
      exercises: sessionData,
      notes: sessionNotes || "",
    };
    const freshLog = loadLS(LS_WORKOUT_LOG_KEY) || [];
    const nextLog = [...freshLog, session];
    saveLS(LS_WORKOUT_LOG_KEY, nextLog);
    onSessionSaved?.(session);
    setSessionActive(false);
    setSessionData({});
    setSessionNotes("");
    setLiveExercises([]);
    setPickedId(null); // back to "follow recommendation"
  };

  // CLIMB / REST save path — no exercise data, just a marker so
  // the recommender sees the session date.
  const saveMarkerSession = (workoutId) => {
    const session = {
      id: genId(),
      date: today(),
      completedAt: nowISO(),
      workout: workoutId,
      workoutId,
      sessionNumber: countSupportSessions(wLog) + 1,
      wasRecommended: workoutId === recommendation?.primary?.id,
      exercises: {},
      notes: "",
    };
    const freshLog = loadLS(LS_WORKOUT_LOG_KEY) || [];
    const nextLog = [...freshLog, session];
    saveLS(LS_WORKOUT_LOG_KEY, nextLog);
    onSessionSaved?.(session);
    setPickedId(null);
  };

  // Toggle today's STRETCH marker. If a session for today already
  // exists, remove it (LS + synced set + tombstone, mirroring the
  // WorkoutHistoryView delete path); otherwise log a fresh marker.
  // Tombstoning is what stops a deleted-today stretch from
  // resurrecting on the next cloud pull — same defense the rest
  // of the workout-delete flow relies on.
  const toggleTodaysStretch = () => {
    const todayStr = today();
    const freshLog = loadLS(LS_WORKOUT_LOG_KEY) || [];
    // Match by either workoutId or workout for the same reason
     // stretchState does — cloud-synced rows or older LS entries may
     // only have one of the two fields set.
    const existing = freshLog.find(
      s => s && (s.workoutId === "STRETCH" || s.workout === "STRETCH") && s.date === todayStr
    );
    if (existing) {
      const nextLog = freshLog.filter(s => s.id !== existing.id);
      saveLS(LS_WORKOUT_LOG_KEY, nextLog);
      const synced = new Set(loadLS(LS_WORKOUT_SYNCED_KEY) || []);
      synced.delete(existing.id);
      saveLS(LS_WORKOUT_SYNCED_KEY, [...synced]);
      const deleted = new Set(loadLS(LS_WORKOUT_DELETED_KEY) || []);
      deleted.add(existing.id);
      saveLS(LS_WORKOUT_DELETED_KEY, [...deleted]);
      deleteWorkoutSession(existing.id).catch(() => {});
      return;
    }
    const session = {
      id: genId(),
      date: todayStr,
      completedAt: nowISO(),
      workout: "STRETCH",
      workoutId: "STRETCH",
      sessionNumber: countSupportSessions(freshLog) + 1,
      wasRecommended: false,
      exercises: {},
      notes: "",
    };
    const nextLog = [...freshLog, session];
    saveLS(LS_WORKOUT_LOG_KEY, nextLog);
    onSessionSaved?.(session);
  };

  // ── Per-exercise update helpers ──────────────────────
  const updateExerciseSets = (exId, next) => {
    setSessionData(prev => ({ ...prev, [exId]: next }));
  };
  const toggleExerciseDone = (exId) => {
    setSessionData(prev => ({
      ...prev,
      [exId]: { ...prev[exId], done: !prev[exId]?.done },
    }));
  };
  const updateExerciseNotes = (exId, notes) => {
    setSessionData(prev => ({
      ...prev,
      [exId]: { ...prev[exId], notes },
    }));
  };

  // Surface previous session's reps/weights for each exercise so
  // SessionExRow's "prev" column populates. Walks back through wLog
  // for the most recent session containing this exercise id.
  const prevSetsFor = (exId) => {
    for (let i = wLog.length - 1; i >= 0; i--) {
      const s = wLog[i];
      const exData = s?.exercises?.[exId];
      if (!exData?.sets?.length) continue;
      return exData.sets.map(setSummary);
    }
    return [];
  };

  const abortSession = () => {
    setSessionActive(false);
    setSessionData({});
    setSessionNotes("");
    setLiveExercises([]);
    setPickerState(null);
  };

  // ── Render ──────────────────────────────────────────
  // Both helpers parse a YYYY-MM-DD string, not the {date, name} object
  // — pull .date off the trip prop. (Bug pre-May 2026: passing the whole
  // object string-concatenated to "[object Object]T00:00:00" and parsed
  // as Invalid Date, so weeks always read 0 and the countdown prefix
  // rendered blank.)
  const wtr = weeksToTrip(trip?.date);
  const countdownData = tripCountdown(trip?.date);
  // Compose the prefix shown before "· Nw to trip": "{Trip name} {Mon D}"
  // when both are available, else whichever is available, else empty.
  const countdownLabel = countdownData
    ? `${trip?.name ? trip.name + " " : ""}${countdownData.tripLabel}`
    : "";

  return (
    <div style={{ padding: "16px 16px 80px", position: "relative" }}>
      {/* Build version stamp — auto-bumped per commit via the
          build script (see src/lib/buildInfo.js). Confirms which
          bundle a device is running without opening DevTools. */}
      <div style={{
        position: "absolute", top: 6, right: 8,
        fontSize: 9, color: C.muted, opacity: 0.5,
        fontFamily: "monospace", pointerEvents: "none",
      }}>{shortBuildLabel()}</div>

      {sessionActive && activeWorkout ? (
        // ── Active session view ───────────────────────────
        <>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>
              <span style={{
                fontSize: 12, fontWeight: 700, color: WORKOUT_COLORS[activeId] || C.blue,
                background: `${WORKOUT_COLORS[activeId] || C.blue}1a`,
                padding: "2px 8px", borderRadius: 4, marginRight: 8, letterSpacing: 0.5,
              }}>{activeWorkout.shortName}</span>
              {activeWorkout.name.replace(/^Workout [A-D] — /, "")}
            </h2>
            <button
              onClick={abortSession}
              style={{
                background: "none", border: "none", color: C.muted,
                fontSize: 12, cursor: "pointer", padding: "2px 8px",
              }}
            >Cancel</button>
          </div>

          <Card>
            {liveExercises.map((ex, i) => {
              const last = i === liveExercises.length - 1;
              const exData = sessionData[ex.id] || {};
              // Per-row swap affordance. Tiny chip in the top-right
              // corner of the row so it doesn't compete with the
              // exercise title for attention; opens the picker scoped
              // to this row's index.
              const swapBar = (
                <div style={{
                  display: "flex", justifyContent: "flex-end",
                  paddingTop: 4,
                }}>
                  <button
                    onClick={() => setPickerState({ index: i })}
                    title="Swap this exercise"
                    style={{
                      background: "none", border: `1px solid ${C.border}`,
                      color: C.muted, fontSize: 10, fontWeight: 600,
                      letterSpacing: 0.4, padding: "2px 8px",
                      borderRadius: 4, cursor: "pointer",
                    }}
                  >↔ Swap</button>
                </div>
              );
              if (ex.loggable) {
                // Build per-set recommendations for this exercise.
                // recommendSet is called per set index, same protocol
                // the legacy tab used. Pass the same ladder plan that
                // seeded the session (June 2026) so the reasoning
                // hints agree with the seeded values — without it, a
                // maintain/double-policy exercise would seed a held
                // load but still display the legacy "+5% clean
                // session" hint underneath. Variant-ladder exercises
                // get no hints at all: they're maintenance-dosed and
                // their progression variable (leverage) isn't
                // something recommendSet can reason about.
                const plan = (!ex.circlesOnly && !ex.logBand && !ex.logVariant)
                  ? recommendSetCount(wLog, ex, ex.sets || 1)
                  : null;
                const recommendations = ex.logVariant ? [] : Array.from(
                  { length: (exData.sets?.length || ex.sets || 1) },
                  (_, idx) => recommendSet(wLog, ex, activeId, idx, null, plan)
                );
                return (
                  <div key={ex.id}>
                    {swapBar}
                    <SessionExRow
                      ex={ex}
                      unit={unit}
                      prevSets={prevSetsFor(ex.id)}
                      setsData={exData}
                      onSetsChange={(next) => updateExerciseSets(ex.id, next)}
                      recommendations={recommendations}
                      last={last}
                    />
                  </div>
                );
              }
              return (
                <div key={ex.id}>
                  {swapBar}
                  <SimpleExRow
                    ex={ex}
                    done={!!exData.done}
                    notes={exData.notes || ""}
                    onToggle={() => toggleExerciseDone(ex.id)}
                    onNotesChange={(v) => updateExerciseNotes(ex.id, v)}
                    last={last}
                  />
                </div>
              );
            })}
            {/* Add-exercise affordance — appends a new row to the
                session via the picker, scoped to "index === length"
                so handlePickerPick treats it as an add rather than
                a swap. Stays inside the Card so it visually attaches
                to the exercise list. */}
            <button
              onClick={() => setPickerState({ index: liveExercises.length })}
              style={{
                marginTop: 12, width: "100%", padding: "8px 0",
                background: "none", border: `1px dashed ${C.border}`,
                color: C.muted, borderRadius: 8, fontSize: 12,
                fontWeight: 600, cursor: "pointer",
              }}
            >+ Add exercise</button>
          </Card>

          <textarea
            value={sessionNotes}
            onChange={e => setSessionNotes(e.target.value)}
            placeholder="Session notes (optional)"
            rows={2}
            style={{
              width: "100%", marginTop: 12, padding: "8px 10px",
              background: C.bg, border: `1px solid ${C.border}`,
              color: C.text, borderRadius: 8, fontSize: 13, fontFamily: "inherit",
              resize: "vertical",
            }}
          />

          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button
              onClick={saveSession}
              style={{
                flex: 1, padding: "12px", background: C.green, color: "#000",
                border: "none", borderRadius: 8, fontWeight: 700, fontSize: 15,
                cursor: "pointer",
              }}
            >Save Session</button>
          </div>

          {/* Mid-session exercise picker. Mounted at the end of the
              active-session branch so it overlays the workout view.
              Excludes IDs already present so swaps + adds can't
              produce duplicate rows. handlePickerPick handles both
              swap (index < length) and add (index === length). */}
          {pickerState && (
            <ExercisePicker
              title={pickerState.index >= liveExercises.length ? "Add exercise" : "Swap exercise"}
              excludeIds={liveExercises
                .filter((_, i) => i !== pickerState.index)
                .map(ex => ex.id)}
              onPick={handlePickerPick}
              onCancel={() => setPickerState(null)}
            />
          )}
        </>
      ) : (
        // ── Today / picker view ──────────────────────────
        <>
          {deloadActive && (
            <div style={{
              border: `1px solid ${C.orange}`, background: `${C.orange}14`,
              borderRadius: 10, padding: "10px 12px", marginBottom: 12,
              fontSize: 12.5, color: C.text, lineHeight: 1.5,
            }}>
              <span style={{ color: C.orange, fontWeight: 700, letterSpacing: 0.4 }}>DELOAD WEEK</span>
              {` · skip Workout A this week — take a rest day or keep the session light. Cut volume, not the loads you do hit.`}
            </div>
          )}
          <RecommendationCard
            recommendation={recommendation}
            onPickWorkout={(id) => setPickedId(id)}
            pickedId={pickedId || recommendation?.primary?.id}
          />

          <WorkoutPicker
            pickedId={pickedId || recommendation?.primary?.id}
            onPick={(id) => setPickedId(id)}
          />

          {/* StretchPill sits below the picker, intentionally on its
              own row at full width — width is the visual cue that this
              is a daily habit, not another picker option competing
              with A/B/C for today's slot. Tap = select STRETCH so the
              card below renders the stretch exercises; the marker log
              lives on the green button inside that card. */}
          <StretchPill
            done={stretchState.done}
            daysSince={stretchState.daysSince}
            selected={activeId === "STRETCH"}
            onSelect={() => setPickedId("STRETCH")}
          />

          {activeWorkout && (
            <Card>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>
                  {activeWorkout.name.replace(/^Workout [A-D] — /, "")}
                </div>
                <div style={{ fontSize: 11, color: C.muted }}>
                  {countdownLabel}{wtr != null ? ` · ${wtr}w to trip` : ""}
                </div>
              </div>
              <div style={{ fontSize: 12, color: C.muted, marginBottom: 12, lineHeight: 1.5 }}>
                {activeWorkout.purpose}
              </div>
              {activeWorkout.exercises.length === 0 ? (
                <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5, marginBottom: 12 }}>
                  {activeId === "REST"
                    ? "Rest is what absorbs the training. Save the marker so the recommender knows you took the day."
                    : "Climbing has no logged exercises here — log climbs in the climbing log instead. Save the marker if you want it to count toward recommender staleness."}
                </div>
              ) : (
                <div style={{ marginBottom: 12 }}>
                  {activeWorkout.exercises.map((ex, i) => (
                    <div key={ex.id} style={{
                      display: "flex", alignItems: "center", gap: 10,
                      padding: "6px 0",
                      borderBottom: i < activeWorkout.exercises.length - 1 ? `1px solid ${C.border}` : "none",
                    }}>
                      <WTypeBadge type={ex.type} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                          <div style={{ fontSize: 13, color: C.text }}>{ex.name}</div>
                          {ex.videoUrl && <VideoLink href={ex.videoUrl} />}
                        </div>
                        <div style={{ fontSize: 11, color: C.muted, marginTop: 1 }}>
                          {ex.prescription}{ex.loggable ? "" : " · done/notes"}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {activeWorkout.coachingNotes && activeWorkout.coachingNotes.length > 0 && (
                <div style={{
                  background: C.bg, borderRadius: 8, padding: "8px 10px",
                  marginBottom: 12, border: `1px solid ${C.border}`,
                  fontSize: 11, color: C.muted, lineHeight: 1.6,
                }}>
                  {activeWorkout.coachingNotes.map((n, i) => (
                    <div key={i}>· {n}</div>
                  ))}
                </div>
              )}
              <button
                onClick={
                  // STRETCH is a daily habit, not a tracked session — the
                  // green button toggles today's marker directly instead
                  // of dropping into the active-session per-exercise UI.
                  activeId === "STRETCH" ? toggleTodaysStretch : startSession
                }
                style={{
                  width: "100%", padding: "12px",
                  background: activeId === "STRETCH" && stretchState.done
                    ? C.muted
                    : (WORKOUT_COLORS[activeId] || C.blue),
                  color: "#000", border: "none", borderRadius: 8,
                  fontSize: 15, fontWeight: 700, cursor: "pointer",
                }}
              >
                {activeId === "STRETCH"
                  ? (stretchState.done ? "Un-log Today's Stretch" : "Log Today's Stretch")
                  : activeWorkout.exercises.length === 0
                    ? `Log ${activeWorkout.shortName} marker`
                    : `Start ${activeWorkout.shortName}`}
              </button>
            </Card>
          )}

          <BwPrompt unit={unit} onSave={onBwSave} />
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Helpers (countSupportSessions, setSummary, findLastSessionFor) moved
// to src/views/workout/workoutHelpers.js in late May 2026 — pure data
// transforms with no React deps, easier to test in isolation and use
// from sibling row components without circular-import gymnastics.

