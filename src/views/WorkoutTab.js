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
//      sessions + climbing history and proposes one workout for
//      today, with a one-line reason.
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
// LEGACY_WORKOUTS / DEFAULT_WORKOUTS / ALL_WORKOUTS_LOOKUP moved
// to src/views/workout/workoutLegacy.js (May 2026 decomp). The
// History surfaces import the lookup map from there now.
//
// Plan editor and exercise substitutes are gone — the supportTraining
// workouts are opinionated about which exercises do what, and the
// substitute table was keyed by legacy exercise IDs that no longer
// exist. Both can come back if needed; for now the simpler tab is
// the point.

import React, { useMemo, useState } from "react";

import { C } from "../ui/theme.js";
import { Card } from "../ui/components.js";

import {
  loadLS, saveLS,
  LS_WORKOUT_LOG_KEY, LS_WORKOUT_SYNCED_KEY, LS_WORKOUT_DELETED_KEY,
  ROTATION_PIN_KEY,
} from "../lib/storage.js";
import {
  pushWorkoutSession, deleteWorkoutSession,
} from "../lib/sync.js";
import {
  DEFAULT_TRIP, weeksToTrip, tripCountdown,
} from "../lib/trip.js";

import { today, nowISO } from "../util.js";
import { recommendSet } from "../model/workout-progression.js";
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

function genId() { return Math.random().toString(36).slice(2, 10); }


// ─────────────────────────────────────────────────────────────
// Main WorkoutTab
// ─────────────────────────────────────────────────────────────
export function WorkoutTab({
  unit,
  onSessionSaved,
  onBwSave = () => {},
  trip = DEFAULT_TRIP,
  // Climbing activities log (from App's `activities` state). Used
  // by the recommender for tag staleness (climbing contributes
  // neural/connective load) and for the high-density REST trigger.
  activities = [],
}) {
  // ── State ─────────────────────────────────────────────
  // wLog initial: load, then run the May 2026 D → C migration if
  // any historical sessions still carry workoutId "D". The migration
  // is intentionally schemaless (no version flag) and idempotent —
  // a session can be rewritten 0 or 1 times and that's it. We
  // re-push each rewritten session through pushWorkoutSession; the
  // upsert is keyed on session id, so the cloud row's `workout`
  // column gets updated in-place. If another device has already
  // migrated the same session, the upsert is a harmless no-op.
  const [wLog, setWLog] = useState(() => {
    const raw = loadLS(LS_WORKOUT_LOG_KEY) || [];
    const needsRewrite = raw.some(s => s?.workoutId === "D");
    if (!needsRewrite) return raw;
    const migrated = raw.map(s =>
      s?.workoutId === "D" ? { ...s, workout: "C", workoutId: "C" } : s
    );
    saveLS(LS_WORKOUT_LOG_KEY, migrated);
    // Fire-and-forget the cloud catch-up. Failures are logged by the
    // sync helper and don't block the UI — the local migration
    // already succeeded, so the user's history reads correctly
    // immediately; cloud reconciles whenever sync succeeds next.
    for (let i = 0; i < raw.length; i++) {
      if (raw[i]?.workoutId === "D") {
        pushWorkoutSession(migrated[i]).catch(() => {});
      }
    }
    return migrated;
  });
  // pickedId: null means "follow recommendation"; otherwise an
  // explicit workout selection.
  const [pickedId, setPickedId] = useState(null);
  const [sessionActive, setSessionActive] = useState(false);
  const [sessionData, setSessionData] = useState({}); // exId → { sets:[...] } | { done, notes }
  const [sessionNotes, setSessionNotes] = useState(""); // overall session note

  // Climbing-only filter on activities. The recommender's API takes
  // a `climbingHistory` array of type-tagged entries; pre-filter so
  // future activity types don't accidentally pollute the signal.
  const climbingHistory = useMemo(
    () => (activities || []).filter(a => a?.type === "climb"),
    [activities]
  );

  // ── Recommendation ───────────────────────────────────
  // Drop pin-style rotation sessions (legacy ROTATION_PIN_KEY) so
  // they don't pollute the recommender's daysSinceLastOfType counts.
  // Also drop sessions that don't carry workoutId — those are legacy
  // OLD A/B/C sessions; intentionally invisible to the recommender
  // (per user preference: "keep visible in History, invisible to
  // recommender").
  const recommenderInput = useMemo(() =>
    wLog.filter(s => s && s.workoutId && s.workout !== ROTATION_PIN_KEY),
    [wLog]
  );
  const recommendation = useMemo(
    () => recommendNextWorkout(recommenderInput, {
      climbingHistory,
      refDate: today(),
    }),
    [recommenderInput, climbingHistory]
  );

  // The active workout is either the user's override or the
  // recommender's primary. We then look up the full template from
  // SUPPORT_WORKOUTS.
  const activeId = pickedId || recommendation?.primary?.id || "A";
  const activeWorkout = SUPPORT_WORKOUTS[activeId];

  // ── Daily stretching state ───────────────────────────
  // Read today's STRETCH session (if any) and the most recent
  // STRETCH date from the log. The pill consumes both — today's
  // session drives the done/not-done state for the toggle, the
  // most-recent date drives the soft staleness coloring.
  const stretchState = useMemo(() => {
    const todayStr = today();
    let todaySession = null;
    let mostRecentDate = null;
    for (const s of wLog) {
      if (s?.workoutId !== "STRETCH") continue;
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
      if (ex.loggable) {
        // Three logging modes for loggable exercises:
        //   - circlesOnly: each set is just a done flag.
        //   - logBand: reps + band color (no numeric weight).
        //   - default (logWeight): reps + numeric weight, with
        //     recommendSet seeding the suggested load.
        const sets = Array.from({ length: ex.sets || 1 }, (_, i) => {
          if (ex.circlesOnly) return { done: false };
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
          // Default weight-logged exercise — seed via recommendSet.
          const rec = recommendSet(wLog, ex, activeId, i);
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
        seed[ex.id] = { sets };
      } else {
        seed[ex.id] = { done: false, notes: "" };
      }
    }
    setSessionData(seed);
    setSessionNotes("");
    setSessionActive(true);
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
    setWLog(nextLog);
    saveLS(LS_WORKOUT_LOG_KEY, nextLog);
    onSessionSaved?.(session);
    setSessionActive(false);
    setSessionData({});
    setSessionNotes("");
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
    setWLog(nextLog);
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
    const existing = freshLog.find(
      s => s?.workoutId === "STRETCH" && s.date === todayStr
    );
    if (existing) {
      const nextLog = freshLog.filter(s => s.id !== existing.id);
      setWLog(nextLog);
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
    setWLog(nextLog);
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
            {activeWorkout.exercises.map((ex, i) => {
              const last = i === activeWorkout.exercises.length - 1;
              const exData = sessionData[ex.id] || {};
              if (ex.loggable) {
                // Build per-set recommendations for this exercise.
                // recommendSet is called per set index, same protocol
                // the legacy tab used.
                const recommendations = Array.from(
                  { length: (exData.sets?.length || ex.sets || 1) },
                  (_, idx) => recommendSet(wLog, ex, activeId, idx)
                );
                return (
                  <SessionExRow
                    key={ex.id}
                    ex={ex}
                    unit={unit}
                    prevSets={prevSetsFor(ex.id)}
                    setsData={exData}
                    onSetsChange={(next) => updateExerciseSets(ex.id, next)}
                    recommendations={recommendations}
                    last={last}
                  />
                );
              }
              return (
                <SimpleExRow
                  key={ex.id}
                  ex={ex}
                  done={!!exData.done}
                  notes={exData.notes || ""}
                  onToggle={() => toggleExerciseDone(ex.id)}
                  onNotesChange={(v) => updateExerciseNotes(ex.id, v)}
                  last={last}
                />
              );
            })}
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
        </>
      ) : (
        // ── Today / picker view ──────────────────────────
        <>
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
// Helpers
// ─────────────────────────────────────────────────────────────

// Count non-pin sessions in the log. Used to assign sessionNumber
// on save. Counts both legacy and new sessions — sessionNumber is
// a simple cumulative index, schema-agnostic.
function countSupportSessions(wLog) {
  return (wLog || []).filter(s => s && s.workout !== ROTATION_PIN_KEY).length;
}

// Reduce a stored set object into a compact "prev" display value for
// SessionExRow's prev column. Three shapes:
//   - weight: { reps, weight, done } (or unilateral { leftReps, ... })
//     → returns a string like "5@80" or { L: "5@80", R: "5@80" }.
//   - band:   { reps, band } / { leftReps, leftBand, ... } where band
//     is an array of color keys (or, for older sessions, a single
//     string)
//     → returns { bands: [...], reps } so the prev pill can render
//     a swatch stack.
//   - circles-only: { done } → returns "✓" if done else "".
function setSummary(set) {
  if (set == null) return null;
  const toBandShape = (bands, reps) => {
    const arr = Array.isArray(bands) ? bands : (bands ? [bands] : []);
    if (arr.length === 0 && (reps == null || reps === "")) return "";
    return { bands: arr, reps };
  };
  // Unilateral with band
  if (set.leftBand !== undefined || set.rightBand !== undefined) {
    return {
      L: toBandShape(set.leftBand,  set.leftReps),
      R: toBandShape(set.rightBand, set.rightReps),
    };
  }
  // Unilateral with weight
  if (set.leftReps != null || set.leftWeight != null) {
    const fmt = (r, w) => {
      if ((r == null || r === "") && (w == null || w === "")) return "";
      return `${r ?? ""}${r && w ? "@" : ""}${w ?? ""}`;
    };
    return {
      L: fmt(set.leftReps, set.leftWeight),
      R: fmt(set.rightReps, set.rightWeight),
    };
  }
  // Bilateral with band
  if (set.band !== undefined) {
    return toBandShape(set.band, set.reps);
  }
  // Bilateral with weight
  if (set.reps !== undefined || set.weight !== undefined) {
    const r = set.reps, w = set.weight;
    if ((r == null || r === "") && (w == null || w === "")) return "";
    return `${r ?? ""}${r && w ? "@" : ""}${w ?? ""}`;
  }
  // Circles-only — return a checkmark when done.
  return set.done ? "✓" : "";
}

// Walk wLog backward to find the most recent session that contains
// a sets-shaped entry for the given exercise. Used to seed band-mode
// exercises (recommendSet handles weight-mode seeding internally).
function findLastSessionFor(wLog, workoutId, exId) {
  for (let i = (wLog?.length ?? 0) - 1; i >= 0; i--) {
    const s = wLog[i];
    if (!s || s.workout === ROTATION_PIN_KEY) continue;
    if (s.workoutId !== workoutId && s.workout !== workoutId) continue;
    const exData = s.exercises?.[exId];
    if (exData?.sets?.length) return s;
  }
  return null;
}

