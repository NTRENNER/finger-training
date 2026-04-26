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
import { Card, Btn } from "../ui/components.js";
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

export function WorkoutHistoryView({
  unit = "lbs", bodyWeight = null,
  defaultWorkouts = {},
  onDeleteWorkoutSession = () => {},
  onDownloadWorkoutCSV = () => {},
}) {
  // Always read fresh from localStorage — no useState wrapper so newly
  // completed sessions appear immediately without needing a remount.
  const [tick,           setTick]           = useState(0); // increment to force re-read
  const [editIdx,        setEditIdx]        = useState(null);
  const [editWorkout,    setEditWorkout]    = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [filterEx,   setFilterEx]   = useState("");  // "" = all, or exercise id
  const [filterDays, setFilterDays] = useState(0);   // 0 = all time, else last N days
  const [relMode,    setRelMode]    = useState(false);

  // Filter out rotation-pin entries — they're synced markers used by
  // WorkoutTab to override the next-up rotation, not real workouts.
  const log      = useMemo(() => (loadLS(LS_WORKOUT_LOG_KEY) || []).filter(s => s.workout !== ROTATION_PIN_KEY), [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const bwLog    = useMemo(() => loadLS(LS_BW_LOG_KEY)       || [], [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const syncedIds = useMemo(() => new Set(loadLS(LS_WORKOUT_SYNCED_KEY) || []), [tick]); // eslint-disable-line react-hooks/exhaustive-deps

  // Flat name lookup across all workout definitions
  const exNames = useMemo(() => {
    const map = {};
    for (const wk of Object.values(defaultWorkouts)) {
      for (const ex of (wk.exercises || [])) {
        if (!map[ex.id]) map[ex.id] = ex.name || ex.id.replace(/_/g, " ");
      }
    }
    return map;
  }, [defaultWorkouts]);

  // Flat exercise-definition lookup, so we can ask isBodyweightAdditive
  // (and any future per-exercise metadata) at render time without
  // re-walking the workout plan tree.
  const exDefs = useMemo(() => {
    const map = {};
    for (const wk of Object.values(defaultWorkouts)) {
      for (const ex of (wk.exercises || [])) {
        if (!map[ex.id]) map[ex.id] = ex;
      }
    }
    return map;
  }, [defaultWorkouts]);

  // Exercises that appear in the log with actual sets (reps + weight) — the measurable ones
  const measurableExIds = useMemo(() => {
    const seen = new Set();
    for (const s of log) {
      for (const [id, data] of Object.entries(s.exercises || {})) {
        if (data.sets && data.sets.length > 0) seen.add(id);
      }
    }
    return [...seen].sort((a, b) => (exNames[a] || a).localeCompare(exNames[b] || b));
  }, [log, exNames]);

  // Apply filters — a session matches if it contains the selected exercise with sets
  const filtered = useMemo(() => {
    const cutoff = filterDays > 0
      ? ymdLocal(new Date(Date.now() - filterDays * 864e5))
      : null;
    return log.filter(s => {
      if (cutoff && s.date < cutoff) return false;
      if (filterEx) {
        const exData = s.exercises?.[filterEx];
        if (!exData?.sets?.length) return false;
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

  const saveEdit = (origIdx) => {
    const updated = log.map((s, i) => i === origIdx ? { ...s, workout: editWorkout } : s);
    saveLS(LS_WORKOUT_LOG_KEY, updated);
    setTick(t => t + 1);
    setEditIdx(null);
    setEditWorkout(null);
  };

  const deleteSession = (sessionId) => {
    // Remove from localStorage
    saveLS(LS_WORKOUT_LOG_KEY, log.filter(s => s.id !== sessionId));
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
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginBottom: 8 }}>
        {bodyWeight != null && (
          <button onClick={() => setRelMode(r => !r)} style={{
            padding: "5px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer", border: "none",
            background: relMode ? C.purple : C.border,
            color: relMode ? "#fff" : C.muted, fontWeight: relMode ? 700 : 400,
          }}>% BW</button>
        )}
        <Btn small onClick={() => onDownloadWorkoutCSV(log)} color={C.muted}>↓ CSV</Btn>
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
        const wkDef = defaultWorkouts[session.workout] || {};

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
                    onClick={() => { setEditIdx(origIdx); setEditWorkout(session.workout); }}
                    style={{ background: "none", border: "none", color: C.muted, fontSize: 13, cursor: "pointer", padding: "0 2px", lineHeight: 1 }}
                    title="Edit workout type"
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

            {/* Edit: reclassify workout type */}
            {isEditing && (
              <div style={{ marginBottom: 12, padding: 10, background: C.bg, borderRadius: 8 }}>
                <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>Change workout type:</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                  {Object.keys(defaultWorkouts).map(key => (
                    <button key={key} onClick={() => setEditWorkout(key)} style={{
                      padding: "6px 12px", borderRadius: 8, border: "none", cursor: "pointer",
                      fontWeight: 700, fontSize: 13, textAlign: "center",
                      background: editWorkout === key ? C.blue : C.border,
                      color: editWorkout === key ? "#fff" : C.muted,
                    }}>
                      <div>{key}</div>
                      <div style={{ fontSize: 9, fontWeight: 400, marginTop: 1, opacity: 0.8 }}>
                        {defaultWorkouts[key]?.name || ""}
                      </div>
                    </button>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => saveEdit(origIdx)} style={{
                    background: C.green, border: "none", borderRadius: 6, color: "#000",
                    fontSize: 12, fontWeight: 700, padding: "5px 14px", cursor: "pointer",
                  }}>Save</button>
                  <button onClick={() => { setEditIdx(null); setEditWorkout(null); }} style={{
                    background: C.border, border: "none", borderRadius: 6, color: C.muted,
                    fontSize: 12, padding: "5px 10px", cursor: "pointer",
                  }}>Cancel</button>
                </div>
              </div>
            )}

            {/* Exercises — render all that have actual data, regardless of workout definition */}
            {Object.entries(session.exercises || {}).map(([id, data]) => {
              const exName = exNames[id] || id.replace(/_/g, " ");
              const exDef  = exDefs[id];

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
                      {data.sets.map((s, si) => (
                        <span key={si} style={{
                          padding: "3px 10px", borderRadius: 7, fontSize: 12,
                          background: s.done ? "#1a2f1a" : C.border,
                          border: `1px solid ${s.done ? C.green : C.border}`,
                          color: s.done ? C.text : C.muted,
                        }}>
                          {(() => {
                            // Pill text: "{reps} × {weight} {unit}". Falls back
                            // gracefully when one half is missing — bodyweight-
                            // only sets show just the rep count, weight-only
                            // sets show just the weight.
                            const reps = parseRepsCount(s.reps);
                            const w = parseFloat(s.weight);
                            const hasReps = reps > 0;
                            const hasW    = isFinite(w) && w > 0;
                            if (!hasReps && !hasW) return "—";

                            if (relMode && hasW && bodyWeight != null && bodyWeight > 0) {
                              const bwDisp = toDisp(bodyWeight, unit);
                              const pct = Math.round((w / bwDisp) * 100);
                              const wStr = `${w >= bwDisp ? "+" : ""}${pct}% BW`;
                              return hasReps ? `${reps} × ${wStr}` : wStr;
                            }
                            if (hasReps && hasW) return `${reps} × ${s.weight} ${unit}`;
                            if (hasReps)         return `${reps} reps`;
                            return `${s.weight} ${unit}`;
                          })()}
                        </span>
                      ))}
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
