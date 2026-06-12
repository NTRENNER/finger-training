// ─────────────────────────────────────────────────────────────
// WORKOUT HISTORY VIEW
// ─────────────────────────────────────────────────────────────
// Workout-session history sub-view rendered inside HistoryView's
// "workout" domain. Shows one Card per logged strength-training
// session with exercise-level sets, supports reclassifying the
// workout type, deleting sessions, and toggling between absolute
// and %-bodyweight load display.
//
// Reads the workout log, body-weight log, and synced-id set directly
// from localStorage on mount (and on every `tick` bump triggered by
// edits/deletes). Takes configuration and side-effect callbacks as
// props so App.js retains control over the Supabase sync path and
// the CSV export.

import React, { useMemo, useState } from "react";
import { C } from "../ui/theme.js";
import { Card } from "../ui/components.js";
import { fmt1, toDisp, fmtClock, bwOnDate } from "../ui/format.js";
import { ymdLocal } from "../util.js";
import {
  loadLS, saveLS,
  LS_WORKOUT_LOG_KEY, LS_BW_LOG_KEY,
  LS_WORKOUT_SYNCED_KEY, LS_WORKOUT_DELETED_KEY,
  ROTATION_PIN_KEY,
} from "../lib/storage.js";
import {
  sessionExerciseVolume, sessionExerciseEst1RM,
  isBodyweightAdditive, parseRepsCount,
} from "../model/workout-volume.js";
import {
  migrateExerciseId, buildExerciseDefIndex,
} from "../model/exerciseIds.js";
import { BAND_COLOR_LOOKUP, normalizeBands } from "./workout/workoutConstants.js";
import { SessionExRow } from "./workout/SessionExRow.js";
import { SimpleExRow } from "./workout/SimpleExRow.js";
import { ExercisePicker } from "./workout/ExercisePicker.js";

// Build an empty seed for an exercise added to an existing logged
// session. Unlike WorkoutTab's seedExercise (which calls recommendSet
// to populate suggested loads for a NEW session), retroactive edits
// should start blank so the user types in what they actually did —
// no recommender hint that might mislead the retrospective log.
function seedExerciseEmpty(ex) {
  if (!ex.loggable) return { done: false, notes: "" };
  const sets = Array.from({ length: ex.sets || 1 }, () => {
    if (ex.circlesOnly) return ex.reps ? { reps: "", done: false } : { done: false };
    if (ex.logBand) {
      if (ex.unilateral) {
        return { leftReps: "", leftBand: "", rightReps: "", rightBand: "", done: false };
      }
      return { reps: "", band: "", done: false };
    }
    if (ex.unilateral) {
      return { leftReps: "", leftWeight: "", rightReps: "", rightWeight: "", done: false };
    }
    // Variant exercises (June 2026, e.g. TRX Row) start with a blank
    // variant too — same blank-start philosophy as reps/weight, so the
    // user records which leverage rung they actually used rather than
    // accepting a defaulted one. SessionExRow's select shows a
    // placeholder option while variant is empty.
    if (ex.logVariant) {
      return { variant: "", reps: "", weight: "", done: false };
    }
    return { reps: "", weight: "", done: false };
  });
  return { sets };
}

export function WorkoutHistoryView({
  unit = "lbs", bodyWeight = null,
  defaultWorkouts = {},
  onDeleteWorkoutSession = () => {},
  onUpdateWorkoutSession = () => {},
  onDownloadWorkoutCSV = () => {},
}) {
  // Always read fresh from localStorage — no useState wrapper so newly
  // completed sessions appear immediately without needing a remount.
  const [tick,           setTick]           = useState(0); // increment to force re-read
  // Edit mode holds a deep-copy of the session being edited. Save
  // writes it back into the log; cancel discards. editIdx tracks the
  // original index in the log so saveEdit knows where to splice.
  // (Workout-type-only edits used to live in a separate editWorkout
  // string here; the unified mode now holds the whole session shape
  // so set-data edits, add/remove exercises, date and notes edits all
  // share one buffer.)
  const [editIdx,        setEditIdx]        = useState(null);
  const [editSession,    setEditSession]    = useState(null);
  // Mid-edit exercise picker. null = closed; otherwise { mode: 'add' }
  // (the existing rows have their own × remove button rather than
  // routing through the picker for the "swap" case — retroactive
  // edits are usually "I forgot to log dips" not "swap A for B").
  const [editPickerOpen, setEditPickerOpen] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [filterEx,   setFilterEx]   = useState("");  // "" = all, or exercise id
  const [filterDays, setFilterDays] = useState(0);   // 0 = all time, else last N days
  const [relMode,    setRelMode]    = useState(false);

  // Filter out rotation-pin entries — they're synced markers used by
  // WorkoutTab to override the next-up rotation, not real workouts.
  const log      = useMemo(() => (loadLS(LS_WORKOUT_LOG_KEY) || []).filter(s => s.workout !== ROTATION_PIN_KEY), [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const bwLog    = useMemo(() => loadLS(LS_BW_LOG_KEY)       || [], [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const syncedIds = useMemo(() => new Set(loadLS(LS_WORKOUT_SYNCED_KEY) || []), [tick]); // eslint-disable-line react-hooks/exhaustive-deps

  // Flat exercise-definition lookup, keyed by CURRENT (post-migration)
  // id. Walking the merged ALL_WORKOUTS_LOOKUP yields both legacy and
  // current definitions; buildExerciseDefIndex applies id migration so
  // a legacy `kb_snatch` exercise lands at the same key as the current
  // `kbSnatch`. Last-wins on collision so the current name takes
  // precedence over the legacy one (e.g. "Med Ball Slams" over the
  // legacy "Slam balls"). Used for rendering names and querying
  // metadata like isBodyweightAdditive at row-render time.
  const exDefs = useMemo(
    () => buildExerciseDefIndex(defaultWorkouts),
    [defaultWorkouts],
  );

  // Convenience name-only view derived from exDefs. Keyed by current id
  // so every lookup site needs to migrate the logged id first.
  const exNames = useMemo(() => {
    const map = {};
    for (const [id, def] of Object.entries(exDefs)) {
      map[id] = def?.name || id.replace(/_/g, " ");
    }
    return map;
  }, [exDefs]);

  // Resolve a logged exercise id (which may be a legacy snake_case id
  // like `slam_balls`) to its display name via the migration map.
  // Falls back to a snake-to-space rendering when no def exists.
  const nameFor = (loggedId) => {
    const cur = migrateExerciseId(loggedId);
    return exNames[cur] || (loggedId || "").replace(/_/g, " ");
  };

  // Exercises that appear in the log with actual sets (reps + weight) —
  // dedupe by current id so a user with sessions under both `slam_balls`
  // and `medBallThrows` sees ONE filter option, not two.
  const measurableExIds = useMemo(() => {
    const seen = new Set();
    for (const s of log) {
      for (const [id, data] of Object.entries(s.exercises || {})) {
        if (data.sets && data.sets.length > 0) seen.add(migrateExerciseId(id));
      }
    }
    return [...seen].sort((a, b) => (exNames[a] || a).localeCompare(exNames[b] || b));
  }, [log, exNames]);

  // Apply filters — a session matches if any of its exercises (after
  // id migration) equals the selected current id. Must check ALL keys
  // because a legacy and current id may both appear in different
  // sessions but resolve to the same canonical id.
  const filtered = useMemo(() => {
    const cutoff = filterDays > 0
      ? ymdLocal(new Date(Date.now() - filterDays * 864e5))
      : null;
    return log.filter(s => {
      if (cutoff && s.date < cutoff) return false;
      if (filterEx) {
        const match = Object.entries(s.exercises || {}).some(
          ([id, data]) => migrateExerciseId(id) === filterEx && data?.sets?.length > 0,
        );
        if (!match) return false;
      }
      return true;
    });
  }, [log, filterEx, filterDays]);

  // Sorted newest-first for display; track original index for saves
  const sorted = useMemo(() =>
    filtered.map((s) => ({ ...s, origIdx: log.indexOf(s) }))
            .sort((a, b) => a.date < b.date ? 1 : -1),
    [filtered, log]
  );

  // Open the unified editor for a session. Deep-clones the exercises
  // map (and per-exercise sets arrays) so the user's in-flight edits
  // don't mutate the live log entry until Save commits.
  const beginEdit = (origIdx, session) => {
    const cloneEx = (data) => {
      if (!data || typeof data !== "object") return { done: false, notes: "" };
      if (Array.isArray(data.sets)) {
        return { ...data, sets: data.sets.map(s => ({ ...s })) };
      }
      return { ...data };
    };
    const exercisesClone = {};
    for (const [id, data] of Object.entries(session.exercises || {})) {
      exercisesClone[id] = cloneEx(data);
    }
    setEditIdx(origIdx);
    setEditSession({
      ...session,
      exercises: exercisesClone,
      notes: session.notes || "",
    });
  };

  const cancelEdit = () => {
    setEditIdx(null);
    setEditSession(null);
    setEditPickerOpen(false);
  };

  // Save the in-flight edit back to LS and push to the cloud.
  // workoutId mirrors the workout label so the recommender's
  // workout-history lookup keeps pointing at the canonical key
  // (legacy sessions may only have `workout`; we set both so a
  // re-classification works for both old and new readers).
  const saveEdit = (origIdx) => {
    if (!editSession) return;
    const session = {
      ...editSession,
      workout:   editSession.workout,
      workoutId: editSession.workout,
      notes:     editSession.notes || "",
    };
    // Write against the UNFILTERED log, not the display `log` memo.
    // `log` has rotation-pin entries filtered out, so saving it back
    // silently stripped every ROTATION_PIN_KEY marker from LS on any
    // edit (rotation overrides then drifted until the next cloud
    // pull). Map the display index back to the full array by id.
    const full = loadLS(LS_WORKOUT_LOG_KEY) || [];
    const targetId = log[origIdx]?.id;
    const updated = full.map(s =>
      (targetId != null && s.id === targetId) ? session : s
    );
    saveLS(LS_WORKOUT_LOG_KEY, updated);
    setTick(t => t + 1);
    // Best-effort cloud push. Fires through the same callback the
    // initial save uses (App.js's handleWorkoutSessionSaved), so an
    // upsert by id replaces the existing row and marks it synced.
    onUpdateWorkoutSession(session);
    cancelEdit();
  };

  // ── Edit-mode mutation helpers ─────────────────────────────
  // Each one takes a state-shape transform and applies it to
  // editSession.exercises so the render binds to fresh refs.
  const editUpdateExerciseSets = (exId, next) => {
    setEditSession(prev => ({
      ...prev,
      exercises: { ...prev.exercises, [exId]: next },
    }));
  };
  const editToggleExerciseDone = (exId) => {
    setEditSession(prev => ({
      ...prev,
      exercises: {
        ...prev.exercises,
        [exId]: { ...prev.exercises[exId], done: !prev.exercises[exId]?.done },
      },
    }));
  };
  const editUpdateExerciseNotes = (exId, notes) => {
    setEditSession(prev => ({
      ...prev,
      exercises: {
        ...prev.exercises,
        [exId]: { ...prev.exercises[exId], notes },
      },
    }));
  };
  const editRemoveExercise = (exId) => {
    setEditSession(prev => {
      const next = { ...prev.exercises };
      delete next[exId];
      return { ...prev, exercises: next };
    });
  };
  const editAddExercise = (newEx) => {
    setEditPickerOpen(false);
    if (!newEx) return;
    setEditSession(prev => {
      // Avoid stomping an existing row with the same id; if the
      // exercise is already present, no-op rather than wiping its
      // logged sets.
      if (prev.exercises[newEx.id]) return prev;
      return {
        ...prev,
        exercises: { ...prev.exercises, [newEx.id]: seedExerciseEmpty(newEx) },
      };
    });
  };

  const deleteSession = (sessionId) => {
    // Remove from localStorage — filter the UNFILTERED log, not the
    // display memo (which has rotation pins stripped; see saveEdit).
    const full = loadLS(LS_WORKOUT_LOG_KEY) || [];
    saveLS(LS_WORKOUT_LOG_KEY, full.filter(s => s.id !== sessionId));
    // Remove from synced set
    const synced = new Set(loadLS(LS_WORKOUT_SYNCED_KEY) || []);
    synced.delete(sessionId);
    saveLS(LS_WORKOUT_SYNCED_KEY, [...synced]);
    // Add to tombstone set so the merge never re-adds it from Supabase
    const deleted = new Set(loadLS(LS_WORKOUT_DELETED_KEY) || []);
    deleted.add(sessionId);
    saveLS(LS_WORKOUT_DELETED_KEY, [...deleted]);
    // Best-effort delete from Supabase (provided by parent)
    onDeleteWorkoutSession(sessionId);
    setConfirmDeleteId(null);
    setTick(t => t + 1);
  };

  if (!log.length) return (
    <div style={{ textAlign: "center", color: C.muted, marginTop: 60, fontSize: 15 }}>
      No workout sessions yet — start a workout!
    </div>
  );

  return (
    <div>
      {/* CSV download moved to the unified header in HistoryView so
          all three tabs (Fingers / Workout / Climbing) share one
          location and one visual treatment. The %-BW toggle stays
          here since it's specific to the Workout view. */}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginBottom: 8 }}>
        {bodyWeight != null && (
          <button onClick={() => setRelMode(r => !r)} style={{
            padding: "5px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer", border: "none",
            background: relMode ? C.purple : C.border,
            color: relMode ? "#fff" : C.muted, fontWeight: relMode ? 700 : 400,
          }}>% BW</button>
        )}
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        {measurableExIds.map(id => (
          <button key={id} onClick={() => setFilterEx(filterEx === id ? "" : id)} style={{
            padding: "4px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer",
            background: filterEx === id ? C.orange : C.border,
            color: filterEx === id ? "#fff" : C.muted, border: "none",
          }}>{exNames[id] || id}</button>
        ))}
        {[30, 60, 90].map(days => (
          <button key={days} onClick={() => setFilterDays(filterDays === days ? 0 : days)} style={{
            padding: "4px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer",
            background: filterDays === days ? C.blue : C.border,
            color: filterDays === days ? "#fff" : C.muted, border: "none",
          }}>{days}d</button>
        ))}
      </div>

      {sorted.length === 0 && (
        <div style={{ textAlign: "center", color: C.muted, marginTop: 40, fontSize: 15 }}>
          No sessions match these filters.
        </div>
      )}

      {sorted.map((session) => {
        const { origIdx } = session;
        const isEditing = editIdx === origIdx;
        // Resolve the workout definition. New sessions (post-May
        // 2026 cutover) carry a `workoutId` field stamped against
        // the supportTraining schema — prefer that. Legacy sessions
        // (pre-cutover) only have `workout`, which now lives under
        // a `legacy_` prefix in the merged ALL_WORKOUTS_LOOKUP to
        // avoid colliding with the new A/B/C/STRETCH. Last fallback is
        // the raw key, for any session that doesn't match either
        // (shouldn't happen, but doesn't crash if it does).
        const wkDef = (session.workoutId && defaultWorkouts[session.workoutId])
          || defaultWorkouts[`legacy_${session.workout}`]
          || defaultWorkouts[session.workout]
          || {};

        return (
          <Card key={origIdx} style={{ marginBottom: 10 }}>
            {/* Session header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div>
                <span style={{ fontWeight: 700, fontSize: 15 }}>Workout {session.workout}</span>
                {wkDef.name && !isEditing && (
                  <span style={{ marginLeft: 8, fontSize: 12, color: C.muted }}>{wkDef.name}</span>
                )}
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {session.sessionNumber && !isEditing && (
                  <span style={{ fontSize: 11, color: C.muted }}>#{session.sessionNumber}</span>
                )}
                <span style={{ fontSize: 12, color: C.muted }}>
                  {session.date}{session.completedAt ? " · " + fmtClock(session.completedAt) : ""}
                  {(() => { const e = bwOnDate(bwLog, session.date); return e ? " · " + fmt1(toDisp(e.kg, unit)) + " " + unit : ""; })()}
                </span>
                <span
                  title={session.id && syncedIds.has(session.id) ? "Synced to cloud" : "Local only — not yet synced"}
                  style={{ fontSize: 13, opacity: 0.7 }}
                >
                  {session.id && syncedIds.has(session.id) ? "☁️" : "📱"}
                </span>
                {!isEditing && confirmDeleteId !== session.id && (
                  <button
                    onClick={() => beginEdit(origIdx, session)}
                    style={{ background: "none", border: "none", color: C.muted, fontSize: 13, cursor: "pointer", padding: "0 2px", lineHeight: 1 }}
                    title="Edit session"
                  >✏️</button>
                )}
                {!isEditing && confirmDeleteId !== session.id && (
                  <button
                    onClick={() => setConfirmDeleteId(session.id)}
                    style={{ background: "none", border: "none", color: C.muted, fontSize: 13, cursor: "pointer", padding: "0 2px", lineHeight: 1 }}
                    title="Delete session"
                  >🗑</button>
                )}
                {confirmDeleteId === session.id && (
                  <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span style={{ fontSize: 12, color: C.red }}>Delete?</span>
                    <button onClick={() => deleteSession(session.id)} style={{
                      background: C.red, border: "none", borderRadius: 6, color: "#fff",
                      fontSize: 12, fontWeight: 700, padding: "3px 10px", cursor: "pointer",
                    }}>Yes</button>
                    <button onClick={() => setConfirmDeleteId(null)} style={{
                      background: C.border, border: "none", borderRadius: 6, color: C.muted,
                      fontSize: 12, padding: "3px 8px", cursor: "pointer",
                    }}>No</button>
                  </span>
                )}
              </div>
            </div>

            {/* Unified edit mode — workout type pills, date input,
                per-exercise editable rows with remove buttons, add
                button, and session notes. All edits buffered in
                editSession and committed on Save (which also pushes
                to the cloud via onUpdateWorkoutSession). */}
            {isEditing && editSession && (
              <div style={{ marginBottom: 12, padding: 10, background: C.bg, borderRadius: 8 }}>
                <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>Workout type</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
                  {Object.keys(defaultWorkouts).filter(k => !k.startsWith("legacy_")).map(key => (
                    <button key={key}
                      onClick={() => setEditSession(prev => ({ ...prev, workout: key }))}
                      style={{
                        padding: "6px 12px", borderRadius: 8, border: "none", cursor: "pointer",
                        fontWeight: 700, fontSize: 13, textAlign: "center",
                        background: editSession.workout === key ? C.blue : C.border,
                        color: editSession.workout === key ? "#fff" : C.muted,
                      }}>
                      <div>{key}</div>
                      <div style={{ fontSize: 9, fontWeight: 400, marginTop: 1, opacity: 0.8 }}>
                        {defaultWorkouts[key]?.name || ""}
                      </div>
                    </button>
                  ))}
                </div>

                {/* Date editor — useful when you forgot to log on the
                    actual training day and want to attribute the
                    session to yesterday. */}
                <div style={{ fontSize: 12, color: C.muted, marginBottom: 4 }}>Date</div>
                <input
                  type="date"
                  value={editSession.date || ""}
                  onChange={e => setEditSession(prev => ({ ...prev, date: e.target.value }))}
                  style={{
                    padding: "6px 8px", borderRadius: 6, marginBottom: 12,
                    background: C.card, color: C.text,
                    border: `1px solid ${C.border}`, fontSize: 12,
                  }}
                />

                {/* Exercises — reuse SessionExRow / SimpleExRow from
                    the in-progress workout view. Each row gets a
                    small × remove button. Per-set recommendations
                    are passed as empty since retroactive edits
                    shouldn't surface "next time" suggestions. */}
                <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>Exercises</div>
                <div style={{ background: C.card, borderRadius: 8, padding: "0 10px" }}>
                  {Object.entries(editSession.exercises || {}).length === 0 && (
                    <div style={{ padding: "16px 0", fontSize: 12, color: C.muted, textAlign: "center" }}>
                      No exercises — add one below.
                    </div>
                  )}
                  {Object.entries(editSession.exercises || {}).map(([id, data], i, arr) => {
                    const curId = migrateExerciseId(id);
                    const ex = exDefs[curId] || { id, name: nameFor(id), loggable: data.sets != null };
                    const last = i === arr.length - 1;
                    // Tiny × in the top-right of each row. Doesn't
                    // confirm — paired with the broader Save/Cancel,
                    // the user can still bail out without committing.
                    const removeBar = (
                      <div style={{ display: "flex", justifyContent: "flex-end", paddingTop: 4 }}>
                        <button
                          onClick={() => editRemoveExercise(id)}
                          title="Remove this exercise from the session"
                          style={{
                            background: "none", border: `1px solid ${C.border}`,
                            color: C.muted, fontSize: 10, fontWeight: 600,
                            letterSpacing: 0.4, padding: "2px 8px",
                            borderRadius: 4, cursor: "pointer",
                          }}
                        >× Remove</button>
                      </div>
                    );
                    if (data.sets) {
                      return (
                        <div key={id}>
                          {removeBar}
                          <SessionExRow
                            ex={ex}
                            unit={unit}
                            prevSets={[]}
                            setsData={data}
                            onSetsChange={(next) => editUpdateExerciseSets(id, next)}
                            recommendations={[]}
                            last={last}
                          />
                        </div>
                      );
                    }
                    return (
                      <div key={id}>
                        {removeBar}
                        <SimpleExRow
                          ex={ex}
                          done={!!data.done}
                          notes={data.notes || ""}
                          onToggle={() => editToggleExerciseDone(id)}
                          onNotesChange={(v) => editUpdateExerciseNotes(id, v)}
                          last={last}
                        />
                      </div>
                    );
                  })}
                  <button
                    onClick={() => setEditPickerOpen(true)}
                    style={{
                      marginTop: 12, marginBottom: 12,
                      width: "100%", padding: "8px 0",
                      background: "none", border: `1px dashed ${C.border}`,
                      color: C.muted, borderRadius: 8, fontSize: 12,
                      fontWeight: 600, cursor: "pointer",
                    }}
                  >+ Add exercise</button>
                </div>

                {/* Session notes — round-trips via the
                    workout_sessions_add_notes migration. */}
                <div style={{ fontSize: 12, color: C.muted, marginTop: 12, marginBottom: 4 }}>
                  Session notes
                </div>
                <textarea
                  value={editSession.notes || ""}
                  onChange={e => setEditSession(prev => ({ ...prev, notes: e.target.value }))}
                  placeholder="Notes (optional)"
                  rows={2}
                  style={{
                    width: "100%", padding: "8px 10px", marginBottom: 12,
                    background: C.card, color: C.text,
                    border: `1px solid ${C.border}`, borderRadius: 8,
                    fontSize: 13, fontFamily: "inherit", resize: "vertical",
                    boxSizing: "border-box",
                  }}
                />

                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => saveEdit(origIdx)} style={{
                    background: C.green, border: "none", borderRadius: 6, color: "#000",
                    fontSize: 12, fontWeight: 700, padding: "6px 14px", cursor: "pointer",
                  }}>Save</button>
                  <button onClick={cancelEdit} style={{
                    background: C.border, border: "none", borderRadius: 6, color: C.muted,
                    fontSize: 12, padding: "6px 10px", cursor: "pointer",
                  }}>Cancel</button>
                </div>

                {editPickerOpen && (
                  <ExercisePicker
                    title="Add exercise"
                    excludeIds={Object.keys(editSession.exercises || {})}
                    onPick={editAddExercise}
                    onCancel={() => setEditPickerOpen(false)}
                  />
                )}
              </div>
            )}

            {/* Exercises — render all that have actual data, regardless
                of workout definition. When an exercise filter pill is
                active, narrow each session card to JUST that exercise so
                the history reads as "every bench press I've done" rather
                than "every session that contained a bench press, with
                all the other lifts still in view." */}
            {Object.entries(session.exercises || {})
              .filter(([id]) => !filterEx || migrateExerciseId(id) === filterEx)
              .map(([id, data]) => {
              const curId  = migrateExerciseId(id);
              const exName = nameFor(id);
              const exDef  = exDefs[curId];

              if (data.sets && data.sets.length) {
                const anyDone = data.sets.some(s => s.done);
                if (!anyDone) return null;

                // Per-exercise volume + est 1RM. Bodyweight from the
                // session's date (in display unit, since per-set
                // weights are stored in display unit too — see the
                // pill render below). Compare against the most
                // recent earlier session of the same workout-type
                // that contained this exercise; show "+X% vs last"
                // if a comparable predecessor exists.
                const bwAtSessionKg = bwOnDate(bwLog, session.date)?.kg ?? null;
                const bwAtSessionDisp = bwAtSessionKg != null ? toDisp(bwAtSessionKg, unit) : null;
                const additive = isBodyweightAdditive(exDef);
                const vol  = sessionExerciseVolume(data.sets, bwAtSessionDisp, exDef);
                const e1rm = sessionExerciseEst1RM(data.sets, bwAtSessionDisp, exDef);

                let prevVol = null;
                for (const prior of sorted) {
                  if (prior.workout !== session.workout) continue;
                  if (prior.date >= session.date && prior !== session) continue;
                  if (prior === session) continue;
                  const priorEx = prior.exercises?.[id];
                  if (!priorEx?.sets?.length) continue;
                  const priorBwKg = bwOnDate(bwLog, prior.date)?.kg ?? bwAtSessionKg;
                  const priorBwDisp = priorBwKg != null ? toDisp(priorBwKg, unit) : null;
                  const v = sessionExerciseVolume(priorEx.sets, priorBwDisp, exDef);
                  if (v > 0) { prevVol = v; break; }
                }
                const deltaPct = (prevVol && vol) ? Math.round((vol / prevVol - 1) * 100) : null;

                return (
                  <div key={id} style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 12, color: C.muted, marginBottom: 4 }}>{exName}</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {data.sets.map((s, si) => {
                        // Detect schema by which fields are present.
                        // isUni: any L/R field present (weight OR band).
                        // isBand: any *band field present.
                        // isCircles: no reps, no weight, no band, no L/R
                        //   — only the done flag. Render a simple dot.
                        const isUni = s.leftReps != null || s.leftWeight != null
                                   || s.rightReps != null || s.rightWeight != null
                                   || s.leftBand != null || s.rightBand != null;
                        const isBand = s.band != null
                                    || s.leftBand != null || s.rightBand != null;
                        const isCircles = !isUni
                                       && s.reps == null && s.weight == null
                                       && s.band == null;
                        const bandSwatch = (key, sz = 9) => {
                          const meta = BAND_COLOR_LOOKUP[key];
                          if (!meta) return null;
                          return (
                            <span key={key} style={{
                              display: "inline-block", width: sz, height: sz, borderRadius: "50%",
                              background: meta.swatch, border: "1px solid rgba(255,255,255,0.2)",
                              flexShrink: 0, marginRight: 2, verticalAlign: "middle",
                            }} />
                          );
                        };
                        const formatBandSide = (reps, bandValue) => {
                          const bands = normalizeBands(bandValue);
                          const r = parseRepsCount(reps);
                          const hasReps = r > 0;
                          if (bands.length === 0 && !hasReps) return "—";
                          const label = bands.map(k => BAND_COLOR_LOOKUP[k]?.label || k).join("+");
                          return (
                            <>
                              {bands.map(k => bandSwatch(k))}
                              {hasReps ? `${r} ` : ""}
                              {label}
                            </>
                          );
                        };
                        const formatSide = (reps, weight) => {
                          const r = parseRepsCount(reps);
                          const w = parseFloat(weight);
                          const hasReps = r > 0;
                          const hasW    = isFinite(w) && w > 0;
                          if (!hasReps && !hasW) return "—";
                          if (relMode && hasW && bodyWeight != null && bodyWeight > 0) {
                            const bwDisp = toDisp(bodyWeight, unit);
                            const pct = Math.round((w / bwDisp) * 100);
                            const wStr = `${w >= bwDisp ? "+" : ""}${pct}% BW`;
                            return hasReps ? `${r} × ${wStr}` : wStr;
                          }
                          if (hasReps && hasW) return `${r} × ${weight} ${unit}`;
                          if (hasReps)         return `${r} reps`;
                          return `${weight} ${unit}`;
                        };
                        return (
                          <span key={si} style={{
                            padding: "3px 10px", borderRadius: 7, fontSize: 12,
                            background: s.done ? "#1a2f1a" : C.border,
                            border: `1px solid ${s.done ? C.green : C.border}`,
                            color: s.done ? C.text : C.muted,
                            display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 1,
                          }}>
                            {isCircles ? (
                              <span style={{ fontSize: 12 }}>{s.done ? "✓" : "—"}</span>
                            ) : isUni && isBand ? (
                              <>
                                <span style={{ fontSize: 11 }}>
                                  <span style={{ color: C.muted }}>L </span>{formatBandSide(s.leftReps, s.leftBand)}
                                </span>
                                <span style={{ fontSize: 11 }}>
                                  <span style={{ color: C.muted }}>R </span>{formatBandSide(s.rightReps, s.rightBand)}
                                </span>
                              </>
                            ) : isUni ? (
                              <>
                                <span style={{ fontSize: 11 }}>
                                  <span style={{ color: C.muted }}>L </span>{formatSide(s.leftReps, s.leftWeight)}
                                </span>
                                <span style={{ fontSize: 11 }}>
                                  <span style={{ color: C.muted }}>R </span>{formatSide(s.rightReps, s.rightWeight)}
                                </span>
                              </>
                            ) : isBand ? (
                              <span>{formatBandSide(s.reps, s.band)}</span>
                            ) : (
                              // Variant sets (June 2026, e.g. TRX Row)
                              // prepend the leverage rung — "Archer ·
                              // 10 reps" — but only when the set has
                              // real reps/weight data, so a variant
                              // with nothing logged still reads as the
                              // bare "—" dash like every other set.
                              (() => {
                                const body = formatSide(s.reps, s.weight);
                                return s.variant && body !== "—"
                                  ? `${s.variant} · ${body}`
                                  : body;
                              })()
                            )}
                          </span>
                        );
                      })}
                    </div>
                    {/* Per-exercise tonnage + est 1RM annotation. The
                        "+X% vs last" delta only renders when there's
                        a comparable predecessor session (same workout
                        type, same exercise, an earlier date, with a
                        non-zero volume). For bodyweight-additive
                        exercises (pull-ups, dips) the load includes
                        bodyweight at the time of the session, not
                        current bodyweight, so cycle-long bodyweight
                        changes don't pollute the comparison. */}
                    {(vol > 0 || e1rm > 0) && (
                      <div style={{ fontSize: 10, color: C.muted, marginTop: 4, display: "flex", flexWrap: "wrap", gap: 8 }}>
                        {vol > 0 && (
                          <span>vol <b style={{ color: C.text }}>{vol} {unit}</b></span>
                        )}
                        {e1rm > 0 && (
                          <span>1RM ~<b style={{ color: C.text }}>{fmt1(e1rm)} {unit}</b></span>
                        )}
                        {deltaPct != null && (
                          <span style={{ color: deltaPct >= 0 ? C.green : C.orange }}>
                            {deltaPct >= 0 ? "+" : ""}{deltaPct}% vs last
                          </span>
                        )}
                        {additive && (
                          <span title="Bodyweight added to recorded weight for volume + 1RM" style={{ opacity: 0.7 }}>
                            +BW
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                );
              }

              if (data.done) {
                return (
                  <div key={id} style={{ fontSize: 12, color: C.muted, marginBottom: 3 }}>
                    <span style={{ color: C.green, marginRight: 5 }}>✓</span>{exName}
                  </div>
                );
              }
              return null;
            })}
          </Card>
        );
      })}
    </div>
  );
}
