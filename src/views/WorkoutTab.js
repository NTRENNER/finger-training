// ─────────────────────────────────────────────────────────────
// WORKOUT TAB
// ─────────────────────────────────────────────────────────────
// The non-finger-training "Workout" tab — barbell/dumbbell/calisthenic
// session log built around the 3-day rotation plan (A/B/C). Includes
// the live session UI (set tracking, exercise substitution, weight
// progression nudges) and the plan editor (tweak default exercises,
// reorder, reset to defaults).
//
// Coupling to App.js is purely via props: unit, onSessionSaved (called
// when the user saves a completed session — App fans this out into
// localStorage + cloud sync), onBwSave (BwPrompt callback), and trip
// (the user-configurable target date for the countdown badge). All
// other state is local to this module.
//
// DEFAULT_WORKOUTS is also exported because HistoryView and TrendsView
// both want it for their workout-history rendering; App.js imports it
// here and passes it as a `defaultWorkouts` prop to those views.

import React, { useEffect, useMemo, useState } from "react";

import { C } from "../ui/theme.js";
import { Card } from "../ui/components.js";

import {
  loadLS, saveLS,
  LS_WORKOUT_LOG_KEY, ROTATION_PIN_KEY,
} from "../lib/storage.js";
import {
  DEFAULT_TRIP, weeksToTrip, tripCountdown,
} from "../lib/trip.js";

import { today } from "../util.js";
import { recommendSet } from "../model/workout-progression.js";

import { BwPrompt } from "./SetupView.js";

// ─────────────────────────────────────────────────────────────
// WORKOUT-TAB LOCAL STATE KEYS
// ─────────────────────────────────────────────────────────────



// WORKOUT PLAN
// ─────────────────────────────────────────────────────────────
const LS_WORKOUT_PLAN_KEY    = "ft_workout_plan";
// LS_WORKOUT_STATE_KEY ("ft_workout_state") used to store the
// rotation index + sessionCount as local state. It is no longer
// read or written — rotation is now derived from wLog (which
// syncs across devices via fetchWorkoutSessions) so that two
// devices for the same user can't drift on what's "next up".
// Existing values under "ft_workout_state" are orphaned but
// harmless; nothing reads them.
//
// LS_WORKOUT_LOG_KEY now lives in src/lib/storage.js (imported above).
// LS_TRIP_KEY stays in App.js — that's where the trip-load/save lives;
// WorkoutTab receives the resolved `trip` value as a prop.

// nowISO — wall-clock timestamp on the saved session row. Kept inline
// since this is the only consumer.
const nowISO = () => new Date().toISOString();



// ─────────────────────────────────────────────────────────────

// ROTATION + TYPE METADATA

// ─────────────────────────────────────────────────────────────


// 3-day workout rotation: F (Fingers/Power) → S (Strength) → H (Hypertrophy).
const WK_ROTATION = ["A", "B", "C"];

const WTYPE_META = {
  F: { label: "F", bg: "#1a2d4a", color: "#58a6ff" },
  S: { label: "S", bg: "#2d1f00", color: "#e3b341" },
  H: { label: "H", bg: "#2d0000", color: "#f85149" },
  P: { label: "P", bg: "#2d1200", color: "#f0883e" },
  C: { label: "C", bg: "#002d10", color: "#3fb950" },
  X: { label: "↔", bg: "#1e1e2e", color: "#8b949e" },
};



// ─────────────────────────────────────────────────────────────

// EXERCISE SUBSTITUTIONS

// Shown during a live session when the planned exercise's

// equipment is unavailable. Swaps are session-only and do not

// modify the plan template.

// ─────────────────────────────────────────────────────────────

// Exercise substitution options — shown during a live session when equipment is unavailable.
// Keys are exercise IDs from DEFAULT_WORKOUTS; values are arrays of alternatives.
// Swaps are session-only and do not modify the plan template.
const EXERCISE_SUBSTITUTES = {
  bench_press:   [
    { id: "ohp",           name: "Overhead press",         type: "S", reps: "5",       logWeight: true,  unilateral: true, note: "Single-arm — KB or DB" },
    { id: "kb_press",      name: "KB press",               type: "S", reps: "5",       logWeight: true,  note: "Good shoulder stability option" },
    { id: "push_ups",      name: "Push-ups",               type: "S", reps: "8–12",    logWeight: false, note: "Weighted vest if bodyweight is easy" },
  ],
  kb_press:      [
    // Substitutions FOR kb_press (the bilateral two-KB press in
    // Workout B). Single-arm OHP is offered as the unilateral
    // alternative — useful when you only have one KB available.
    { id: "ohp",           name: "Overhead press",         type: "S", reps: "5",       logWeight: true,  unilateral: true, note: "Single-arm — KB or DB" },
    { id: "bench_press",   name: "Bench press",            type: "S", reps: "5",       logWeight: true,  note: "" },
    { id: "push_ups",      name: "Push-ups",               type: "S", reps: "8–12",    logWeight: false, note: "Weighted vest if bodyweight is easy" },
  ],
  pull_ups:      [
    { id: "lat_pulldown",  name: "Lat pulldown",           type: "S", reps: "5",       logWeight: true,  note: "" },
    { id: "ring_rows",     name: "Ring rows",              type: "S", reps: "8–10",    logWeight: false, note: "Elevate feet to increase difficulty" },
    { id: "band_pullups",  name: "Band-assisted pull-ups", type: "S", reps: "5",       logWeight: false, note: "" },
  ],
  landmine_rows: [
    { id: "db_rows",       name: "DB rows",                type: "S", reps: "5",       logWeight: true,  unilateral: true, note: "" },
    { id: "cable_rows",    name: "Cable rows",             type: "S", reps: "5",       logWeight: true,  note: "" },
    { id: "trx_rows",      name: "TRX rows",               type: "S", reps: "8–10",    logWeight: false, note: "Feet elevated for more load" },
  ],
  dips:          [
    { id: "close_bench",   name: "Close-grip bench",       type: "S", reps: "5",       logWeight: true,  note: "" },
    { id: "tricep_ext",    name: "Tricep extension",       type: "S", reps: "8–10",    logWeight: true,  note: "Cable or DB" },
    { id: "kb_press",      name: "KB press",               type: "S", reps: "5",       logWeight: true,  note: "" },
  ],
  rdl:           [
    { id: "good_morning",  name: "Good mornings",          type: "H", reps: "5",       logWeight: true,  note: "" },
    { id: "kb_deadlift",   name: "KB deadlift",            type: "H", reps: "5",       logWeight: true,  note: "" },
    { id: "hip_hinge",     name: "Hip hinge (band)",       type: "H", reps: "8–10",    logWeight: false, note: "Band around hips, hinge toward wall" },
  ],
  trx_ham_curl:  [
    { id: "nordic_curl",   name: "Nordic curl",            type: "H", reps: "3–5",     logWeight: false, note: "Slow lowering; add 1 rep/1–2 wks" },
    { id: "sb_ham_curl",   name: "Stability ball curl",    type: "H", reps: "8–10",    logWeight: false, note: "" },
    { id: "glute_bridge",  name: "Single-leg glute bridge",type: "H", reps: "10",      logWeight: false, unilateral: true, note: "" },
  ],
  goblet_squat:  [
    { id: "step_up",       name: "Step-up",                type: "S", reps: "6–8",     logWeight: true,  unilateral: true, note: "Climbing & hiking strength" },
    { id: "box_squat",     name: "Box squat",              type: "S", reps: "5",       logWeight: true,  note: "" },
    { id: "split_squat",   name: "Bulgarian split squat",  type: "S", reps: "6",       logWeight: true,  unilateral: true, note: "" },
  ],
  step_up:       [
    { id: "goblet_squat",  name: "Goblet squat",           type: "S", reps: "8",       logWeight: true,  note: "Joint health — keep load moderate" },
    { id: "split_squat",   name: "Bulgarian split squat",  type: "S", reps: "6",       logWeight: true,  unilateral: true, note: "" },
    { id: "lunge",         name: "Reverse lunge",          type: "S", reps: "8",       logWeight: true,  unilateral: true, note: "" },
  ],
  bicep_curls:   [
    { id: "hammer_curls",  name: "Curls",                  type: "S", reps: "8",       logWeight: true,  unilateral: true, note: "Brachialis emphasis (hammer grip)" },
    { id: "band_curls",    name: "Band curls",             type: "S", reps: "10–12",   logWeight: false, note: "" },
    { id: "chin_up",       name: "Chin-ups (supinated)",   type: "S", reps: "5",       logWeight: true,  note: "Direct bicep transfer" },
  ],
  slam_balls:    [
    { id: "med_ball",      name: "Medicine ball throw",    type: "P", reps: "8–10",    logWeight: true,  note: "" },
    { id: "broad_jump",    name: "Broad jump",             type: "P", reps: "6–8",     logWeight: false, note: "" },
    { id: "box_jump",      name: "Box jump",               type: "P", reps: "6–8",     logWeight: false, note: "" },
  ],
  kb_snatch:     [
    { id: "kb_swing",      name: "KB swing",               type: "P", reps: "10",      logWeight: true,  note: "" },
    { id: "db_snatch",     name: "DB snatch",              type: "P", reps: "5",       logWeight: true,  unilateral: true, note: "" },
    { id: "power_clean",   name: "Power clean",            type: "P", reps: "5",       logWeight: true,  note: "" },
  ],
};



// ─────────────────────────────────────────────────────────────

// DEFAULT WORKOUT PLANS

// 3-day rotation: A (Push+Pull) → B (Push+Pull variant) → C (Power).

// ─────────────────────────────────────────────────────────────

export const DEFAULT_WORKOUTS = {
  A: {
    name: "Lift Day 1 (Push + Pull)",
    exercises: [
      { id: "pull_ups",      name: "Weighted pull-ups",     type: "S", sets: 2,    reps: "5",      logWeight: true,  bodyweightAdditive: true, note: "Add weight when all reps clean" },
      { id: "landmine_rows", name: "One-arm landmine rows", type: "S", sets: 2,    reps: "5",      logWeight: true,  unilateral: true, note: "Alternate sides" },
      { id: "bench_press",   name: "Bench press",           type: "S", sets: 2,    reps: "5",      logWeight: true,  note: "" },
      { id: "dips",          name: "Dips",                  type: "S", sets: 2,    reps: "5",      logWeight: true,  bodyweightAdditive: true, note: "Weighted when bodyweight is easy" },
      { id: "bicep_curls",   name: "Bicep curls",           type: "S", sets: 2,    reps: "8",      logWeight: true,  unilateral: true, note: "Undercling strength" },
      { id: "rdl",           name: "RDL",                   type: "H", sets: 2,    reps: "3–5",    logWeight: true,  note: "Heavy — load in lengthened position" },
      { id: "trx_ham_curl",  name: "TRX hamstring curl",    type: "H", sets: 2,    reps: "6–8",    logWeight: false, note: "Slow eccentric; single-leg when ready" },
      { id: "goblet_squat",  name: "Goblet squat",          type: "S", sets: 1,    reps: "8",      logWeight: true,  note: "Joint health — keep load moderate" },
      { id: "stretch",       name: "Stretching",            type: "X", sets: null, reps: null,     logWeight: false, note: "Couch · Splits machine · Hamstring lockout · Forearms · Lat" },
    ],
  },
  B: {
    name: "Lift Day 2 (Push + Pull)",
    exercises: [
      { id: "pull_ups",      name: "Weighted pull-ups",     type: "S", sets: 2,    reps: "5",      logWeight: true,  bodyweightAdditive: true, note: "Add weight when all reps clean" },
      { id: "landmine_rows", name: "One-arm landmine rows", type: "S", sets: 2,    reps: "5",      logWeight: true,  unilateral: true, note: "Alternate sides" },
      { id: "kb_press",      name: "KB press",              type: "S", sets: 2,    reps: "5",      logWeight: true,  availableLoads: [35, 50, 55, 62, 70], note: "Two KBs simultaneously" },
      { id: "dips",          name: "Dips",                  type: "S", sets: 2,    reps: "5",      logWeight: true,  bodyweightAdditive: true, note: "Weighted when bodyweight is easy" },
      { id: "bicep_curls",   name: "Bicep curls",           type: "S", sets: 2,    reps: "8",      logWeight: true,  unilateral: true, note: "Undercling strength" },
      { id: "rdl",           name: "RDL",                   type: "H", sets: 2,    reps: "3–5",    logWeight: true,  note: "Heavy — load in lengthened position" },
      { id: "trx_ham_curl",  name: "TRX hamstring curl",    type: "H", sets: 2,    reps: "6–8",    logWeight: false, note: "Slow eccentric; single-leg when ready" },
      { id: "step_up",       name: "Step-up",               type: "S", sets: 1,    reps: "6–8",     logWeight: true, unilateral: true, note: "Climbing & hiking strength — load when bodyweight easy" },
      { id: "stretch",       name: "Stretching",            type: "X", sets: null, reps: null,     logWeight: false, note: "Couch · Splits machine · Hamstring lockout · Forearms · Lat" },
    ],
  },
  C: {
    name: "Power",
    exercises: [
      { id: "slam_balls",  name: "Slam balls", type: "P", sets: 2,    reps: "8–10",   logWeight: true,  note: "Advance weight when 10 reps hold full speed" },
      { id: "kb_snatch",   name: "KB snatch",  type: "P", sets: 2,    reps: "5",      logWeight: true,  unilateral: true, note: "Full hip snap, crisp catch" },
      { id: "stretch",     name: "Stretching", type: "X", sets: null, reps: null,     logWeight: false, note: "Couch · Splits machine · Hamstring lockout · Forearms · Lat" },
    ],
  },
};



// ─────────────────────────────────────────────────────────────

// EXERCISE / SESSION ROW PRIMITIVES

// ─────────────────────────────────────────────────────────────

// ── Type badge ────────────────────────────────────────────────
function WTypeBadge({ type }) {
  const m = WTYPE_META[type] || WTYPE_META.X;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      width: 30, height: 30, borderRadius: "50%", flexShrink: 0,
      background: m.bg, color: m.color, fontSize: 11, fontWeight: 700,
    }}>{m.label}</span>
  );
}

// ── Exercise row (read-only) ──────────────────────────────────
function ExerciseRow({ ex, last }) {
  const setsReps = [ex.sets && `${ex.sets}×`, ex.reps].filter(Boolean).join(" ");
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12,
      padding: "11px 0",
      borderBottom: last ? "none" : `1px solid ${C.border}`,
    }}>
      <WTypeBadge type={ex.type} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, color: C.text }}>{ex.name}</div>
        {ex.note ? <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{ex.note}</div> : null}
      </div>
      {setsReps && (
        <div style={{ fontSize: 13, color: C.muted, whiteSpace: "nowrap" }}>{setsReps}</div>
      )}
    </div>
  );
}

// ── Session logging row ───────────────────────────────────────
function SessionExRow({ ex, unit, prevSets, setsData, onSetsChange, done, onToggle, last, recommendations = [] }) {
  const allSetsDone = ex.logWeight && setsData?.sets
    ? setsData.sets.every(s => s.done)
    : !!done;
  const inputStyle = {
    width: 72, background: C.bg, border: `1px solid ${C.border}`,
    color: C.text, borderRadius: 6, padding: "4px 7px", fontSize: 14,
    textAlign: "center",
  };
  const doneBtn = (isDone, onPress) => (
    <button onClick={onPress} style={{
      width: 28, height: 28, borderRadius: "50%", flexShrink: 0,
      background: isDone ? C.green : "transparent",
      border: `2px solid ${isDone ? C.green : C.border}`,
      color: isDone ? "#000" : C.muted,
      cursor: "pointer", fontSize: 12, display: "flex",
      alignItems: "center", justifyContent: "center",
    }}>{isDone ? "✓" : ""}</button>
  );
  return (
    <div style={{
      padding: "12px 0",
      borderBottom: last ? "none" : `1px solid ${C.border}`,
      opacity: allSetsDone ? 0.55 : 1,
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <WTypeBadge type={ex.type} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, color: C.text }}>{ex.name}</div>
          {ex.note ? <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{ex.note}</div> : null}

          {ex.logWeight && setsData?.sets ? (
            // ── Per-set rows ──
            // Unilateral exercises render TWO short rows per set (L
            // on top, R below) so each side gets its own reps + weight
            // input. The pair shares one done button — a "set" of
            // unilateral work is one logical unit even though the two
            // sides happen sequentially. Bilateral exercises keep the
            // original single-row layout.
            <div style={{ marginTop: 10 }}>
              {/* Column headers */}
              <div style={{ display: "flex", gap: 8, marginBottom: 6, alignItems: "center" }}>
                <span style={{ fontSize: 11, color: C.muted, width: 36, flexShrink: 0 }}></span>
                <span style={{ fontSize: 11, color: C.muted, width: 48, textAlign: "center" }}>reps</span>
                <span style={{ fontSize: 11, color: C.muted, width: 72, textAlign: "center" }}>weight</span>
                {prevSets?.length > 0 && (
                  <span style={{ fontSize: 11, color: C.muted, width: 44, textAlign: "center" }}>prev</span>
                )}
              </div>

              {setsData.sets.map((s, i) => {
                const isExtra = i >= (ex.sets || 0);

                // Renders one side's row of inputs. For unilateral
                // sets, we call this twice per set with side="L"/"R";
                // for bilateral, once with side=null.
                const renderSideRow = (side, sLabel, sideKey) => {
                  const repsKey   = side ? `${side.toLowerCase()}Reps`   : "reps";
                  const weightKey = side ? `${side.toLowerCase()}Weight` : "weight";
                  const repsVal   = s[repsKey] ?? (side ? "" : ex.reps) ?? "";
                  const weightVal = s[weightKey] ?? "";
                  const prev      = prevSets?.[i];
                  const prevShown = side
                    ? (prev && typeof prev === "object" ? prev[side] : null)
                    : prev;
                  return (
                    <div key={sideKey} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: side === "L" ? 4 : 6 }}>
                      <span style={{ fontSize: 12, color: isExtra ? C.orange : C.muted, width: 36, flexShrink: 0 }}>
                        {sLabel}
                      </span>
                      <input
                        type="text" inputMode="text"
                        value={repsVal}
                        onChange={e => {
                          const next = [...setsData.sets];
                          next[i] = { ...next[i], [repsKey]: e.target.value };
                          onSetsChange({ sets: next });
                        }}
                        style={{ ...inputStyle, width: 48, fontSize: 13 }}
                        placeholder={ex.reps || ""}
                      />
                      <input
                        type="number" inputMode="decimal"
                        value={weightVal}
                        onChange={e => {
                          const next = [...setsData.sets];
                          next[i] = { ...next[i], [weightKey]: e.target.value };
                          onSetsChange({ sets: next });
                        }}
                        style={inputStyle}
                      />
                      <span style={{ fontSize: 12, color: C.muted }}>{unit}</span>
                      {prevShown ? (
                        <span style={{ fontSize: 12, color: C.muted, width: 44 }}>{prevShown}</span>
                      ) : prevSets?.length > 0 ? (
                        <span style={{ width: 44 }} />
                      ) : null}
                      {/* Done button — render only on the last (or
                          only) side row so it sits at the visual
                          end of the set. */}
                      {(side === null || side === "R") && doneBtn(s.done, () => {
                        const next = [...setsData.sets];
                        next[i] = { ...next[i], done: !next[i].done };
                        onSetsChange({ sets: next });
                      })}
                      {/* Remove extra set — only on last side row */}
                      {(side === null || side === "R") && isExtra && (
                        <button
                          onClick={() => onSetsChange({ sets: setsData.sets.filter((_, j) => j !== i) })}
                          style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 14, padding: "0 2px", lineHeight: 1 }}
                          title="Remove this set"
                        >−</button>
                      )}
                    </div>
                  );
                };

                // Per-set progression hint(s) from the recommender.
                // Bilateral exercises get a single hint line under
                // the set; unilateral get one per side.
                const rec = recommendations[i];
                const hintStyle = { fontSize: 10, color: C.muted, marginLeft: 44, marginTop: -2, marginBottom: 4, fontStyle: "italic" };

                if (ex.unilateral) {
                  return (
                    <div key={i} style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: 11, color: isExtra ? C.orange : C.muted, marginBottom: 2 }}>
                        S{i + 1}
                      </div>
                      {renderSideRow("L", "L", `${i}-L`)}
                      {rec?.leftReasoning && (
                        <div style={hintStyle}>{rec.leftReasoning}</div>
                      )}
                      {renderSideRow("R", "R", `${i}-R`)}
                      {rec?.rightReasoning && (
                        <div style={hintStyle}>{rec.rightReasoning}</div>
                      )}
                    </div>
                  );
                }
                return (
                  <div key={i}>
                    {renderSideRow(null, `S${i + 1}`, `${i}`)}
                    {rec?.reasoning && (
                      <div style={hintStyle}>{rec.reasoning}</div>
                    )}
                  </div>
                );
              })}

              {/* Add set button — initialize new set with the right
                  schema so users don't end up mixing bilateral fields
                  on a unilateral exercise (which the volume math
                  would happily skip). */}
              <button
                onClick={() => onSetsChange({
                  sets: [...setsData.sets, ex.unilateral
                    ? { leftReps: ex.reps || "", leftWeight: "", rightReps: ex.reps || "", rightWeight: "", done: false }
                    : { weight: "", reps: ex.reps || "", done: false }
                  ]
                })}
                style={{
                  marginTop: 4, width: "100%", padding: "5px 0",
                  background: "none", border: `1px dashed ${C.border}`,
                  color: C.muted, borderRadius: 6, fontSize: 12, cursor: "pointer",
                }}
              >+ Set</button>
            </div>
          ) : (
            // ── No weight, just reps label ──
            <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>
              {[ex.sets && `${ex.sets}×`, ex.reps].filter(Boolean).join(" ")}
            </div>
          )}
        </div>
        {/* Single done button for non-weight exercises */}
        {!ex.logWeight && doneBtn(!!done, onToggle)}
      </div>
    </div>
  );
}



// ─────────────────────────────────────────────────────────────

// WORKOUT EDITOR

// ─────────────────────────────────────────────────────────────

// ── Plan editor for one workout ───────────────────────────────
function WorkoutEditor({ wKey, workout, onSave, onClose, onReset }) {
  const [exercises, setExercises] = useState(() => workout.exercises.map(e => ({ ...e })));
  const [name, setName] = useState(workout.name);

  const updateEx = (idx, field, val) => {
    setExercises(prev => prev.map((e, i) => i === idx ? { ...e, [field]: val } : e));
  };
  const addEx = () => setExercises(prev => [...prev, {
    id: `ex_${Date.now()}`, name: "New exercise", type: "S",
    sets: 3, reps: "5", logWeight: true, note: "",
  }]);
  const removeEx = (idx) => setExercises(prev => prev.filter((_, i) => i !== idx));
  const moveEx = (idx, dir) => {
    const next = [...exercises];
    const swapIdx = idx + dir;
    if (swapIdx < 0 || swapIdx >= next.length) return;
    [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
    setExercises(next);
  };

  const inputStyle = {
    background: C.bg, border: `1px solid ${C.border}`,
    color: C.text, borderRadius: 6, padding: "4px 8px", fontSize: 13,
  };

  return (
    <div style={{ padding: "0 16px 32px" }}>
      {/* Workout name */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 4 }}>Workout name</div>
        <input
          value={name} onChange={e => setName(e.target.value)}
          style={{ ...inputStyle, width: "100%", fontSize: 15 }}
        />
      </div>

      {/* Exercise rows */}
      {exercises.map((ex, idx) => (
        <div key={ex.id} style={{
          background: C.card, border: `1px solid ${C.border}`,
          borderRadius: 8, padding: 12, marginBottom: 8,
        }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
            {/* Type selector */}
            <select
              value={ex.type}
              onChange={e => updateEx(idx, "type", e.target.value)}
              style={{ ...inputStyle, width: 52 }}
            >
              {Object.keys(WTYPE_META).map(t => (
                <option key={t} value={t}>{WTYPE_META[t].label}</option>
              ))}
            </select>
            {/* Name */}
            <input
              value={ex.name}
              onChange={e => updateEx(idx, "name", e.target.value)}
              style={{ ...inputStyle, flex: 1 }}
            />
            {/* Move up/down */}
            <button onClick={() => moveEx(idx, -1)} style={{ ...inputStyle, padding: "4px 7px", cursor: "pointer" }}>↑</button>
            <button onClick={() => moveEx(idx, 1)}  style={{ ...inputStyle, padding: "4px 7px", cursor: "pointer" }}>↓</button>
            {/* Delete */}
            <button onClick={() => removeEx(idx)} style={{ ...inputStyle, padding: "4px 7px", color: C.red, cursor: "pointer" }}>✕</button>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 12, color: C.muted }}>Sets</span>
              <input
                type="number" value={ex.sets ?? ""}
                onChange={e => updateEx(idx, "sets", e.target.value ? Number(e.target.value) : null)}
                style={{ ...inputStyle, width: 48 }}
              />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 12, color: C.muted }}>Reps</span>
              <input
                value={ex.reps ?? ""}
                onChange={e => updateEx(idx, "reps", e.target.value || null)}
                style={{ ...inputStyle, width: 72 }}
              />
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.muted, cursor: "pointer" }}>
              <input
                type="checkbox" checked={!!ex.logWeight}
                onChange={e => updateEx(idx, "logWeight", e.target.checked)}
              />
              Log weight
            </label>
          </div>
          <div style={{ marginTop: 8 }}>
            <input
              value={ex.note || ""}
              onChange={e => updateEx(idx, "note", e.target.value)}
              placeholder="Note (optional)"
              style={{ ...inputStyle, width: "100%", fontSize: 12 }}
            />
          </div>
        </div>
      ))}

      <button onClick={addEx} style={{
        width: "100%", padding: "10px", marginBottom: 8,
        background: "transparent", border: `1px dashed ${C.border}`,
        color: C.muted, borderRadius: 8, cursor: "pointer", fontSize: 14,
      }}>+ Add exercise</button>

      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button onClick={() => onSave(name, exercises)} style={{
          flex: 1, padding: "11px", background: C.blue, color: "#000",
          border: "none", borderRadius: 8, fontWeight: 700, cursor: "pointer", fontSize: 14,
        }}>Save</button>
        <button onClick={onClose} style={{
          flex: 1, padding: "11px", background: C.bg, color: C.text,
          border: `1px solid ${C.border}`, borderRadius: 8, cursor: "pointer", fontSize: 14,
        }}>Cancel</button>
        <button onClick={onReset} style={{
          padding: "11px 14px", background: C.bg, color: C.red,
          border: `1px solid ${C.red}`, borderRadius: 8, cursor: "pointer", fontSize: 13,
        }}>Reset</button>
      </div>
    </div>
  );
}



// ─────────────────────────────────────────────────────────────

// WORKOUT TAB

// ─────────────────────────────────────────────────────────────

// ── Main WorkoutTab ───────────────────────────────────────────
export function WorkoutTab({ unit, onSessionSaved, onBwSave = () => {}, trip = DEFAULT_TRIP }) {
  const [subTab, setSubTab]         = useState("today");
  const [plan,   setPlan]           = useState(() => loadLS(LS_WORKOUT_PLAN_KEY)  || DEFAULT_WORKOUTS);
  const [wLog,   setWLog]           = useState(() => loadLS(LS_WORKOUT_LOG_KEY)   || []);
  const [sessionActive,  setSessionActive]  = useState(false);
  const [sessionData,    setSessionData]    = useState({});    // exId → {sets, done}
  const [swaps,          setSwaps]          = useState({});    // originalExId → substituteEx
  const [swapPickerFor,  setSwapPickerFor]  = useState(null);  // originalExId showing picker
  const [editingKey, setEditingKey] = useState(null);          // "A"|"B"|"C"|null

  const savePlan  = (p) => { setPlan(p);  saveLS(LS_WORKOUT_PLAN_KEY,  p); };
  const saveLog   = (l) => { setWLog(l);  saveLS(LS_WORKOUT_LOG_KEY,   l); };

  // ── Derive rotation state from the synced workout log ─────
  // Previously this lived in LS_WORKOUT_STATE_KEY (`ft_workout_state`)
  // as { rotationIndex, sessionCount } that was only ever written to
  // localStorage — never synced to Supabase. The result was that two
  // devices for the same user disagreed on "what's next" because each
  // tracked its own counter. Computing the rotation from wLog (which
  // IS synced via fetchWorkoutSessions) makes both devices see the
  // same recommendation.
  //
  // Sessions tagged `wasRecommended: true` advance the rotation;
  // off-rotation picks (user chose B when rotKey was A) DON'T, so
  // the queue persists across one-off deviations — same UX as the
  // old local-state code. Legacy sessions (logged before this flag
  // existed) are treated as recommended; this matches what the old
  // code actually did, since it ALWAYS advanced on completion in the
  // common case where the user followed the recommendation.
  //
  // Rotation pins (workout === ROTATION_PIN_KEY) are synthetic
  // entries the user can write via the "Make X the next-up" action.
  // The MOST RECENT pin establishes a new baseline: rotation index
  // resets to the position of pin.exercises.__pinTo, and only
  // sessions logged AFTER that pin contribute to further advances.
  // Pins are themselves wasRecommended:false so they don't double-
  // count as advances. This is the cross-device recovery valve when
  // sync gaps drift the rotation, and also the "start a fresh cycle"
  // gesture going forward.
  //
  // The old LS_WORKOUT_STATE_KEY is left in place (orphaned, harmless)
  // — nothing reads it anymore.
  const { rotationIndex, sessionCount } = useMemo(() => {
    // Sort by date+completedAt so out-of-order arrivals from the
    // cloud reconcile (legacy sessions without completedAt) still
    // produce a stable derivation.
    const sorted = [...wLog].sort((a, b) => {
      const ta = `${a.date || ""}|${a.completedAt || ""}`;
      const tb = `${b.date || ""}|${b.completedAt || ""}`;
      return ta.localeCompare(tb);
    });

    // Most recent pin establishes a baseline.
    let pinIdx = -1;
    let pinTo = null;
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (sorted[i].workout === ROTATION_PIN_KEY) {
        pinIdx = i;
        pinTo = sorted[i].exercises?.__pinTo ?? null;
        break;
      }
    }

    let baseIdx = 0;
    let countFrom = 0;
    if (pinIdx >= 0 && WK_ROTATION.includes(pinTo)) {
      baseIdx = WK_ROTATION.indexOf(pinTo);
      countFrom = pinIdx + 1;     // count only sessions AFTER the pin
    }

    let advanced = 0;
    for (let i = countFrom; i < sorted.length; i++) {
      const s = sorted[i];
      if (s.workout === ROTATION_PIN_KEY) continue;
      if (s.wasRecommended !== false) advanced++;
    }

    return {
      // Visible session count excludes pin entries — pins aren't
      // workouts, just rotation markers.
      sessionCount: sorted.filter(s => s.workout !== ROTATION_PIN_KEY).length,
      rotationIndex: (baseIdx + advanced) % WK_ROTATION.length,
    };
  }, [wLog]);

  const rotKey    = WK_ROTATION[rotationIndex % WK_ROTATION.length];
  // displayKey: the workout currently being previewed / logged. Defaults to the
  // recommendation (rotKey) but the user can override via the picker below.
  // If the user picks something other than rotKey and completes it, we log the
  // session but do NOT advance the rotation — so the "next up" queue persists.
  const [displayKey, setDisplayKey] = useState(rotKey);
  // If the recommendation changes (after a normal completion), reset the
  // displayed workout back to the new recommendation.
  useEffect(() => { setDisplayKey(rotKey); }, [rotKey]);
  const workout   = plan[displayKey] || plan[rotKey];
  const sessionN  = sessionCount + 1;
  const wtr       = weeksToTrip(trip.date);

  // Switch the previewed workout. Clear any in-flight swaps since they
  // reference exercise IDs from the previous workout.
  const pickWorkout = (k) => {
    if (k === displayKey) return;
    setDisplayKey(k);
    setSwaps({});
    setSwapPickerFor(null);
  };

  // Manual rotation override. Writes a synthetic "pin" entry into
  // wLog and pushes it through onSessionSaved so it syncs across
  // devices (other devices then derive the same rotation from the
  // same pin). Use cases:
  //   * Recovery from cross-device sync drift ("Set next to B" on
  //     each phone gets them back in lockstep).
  //   * Starting a fresh training cycle.
  //   * Skipping a workout you'd already done elsewhere.
  // The pin itself is filtered out of all display surfaces — it's
  // a rotation marker, not a workout.
  const setRotationTo = (key) => {
    if (!WK_ROTATION.includes(key)) return;
    const pinSession = {
      id: genId(),
      date: today(),
      completedAt: nowISO(),
      workout: ROTATION_PIN_KEY,
      sessionNumber: 0,
      wasRecommended: false,
      exercises: { __pinTo: key },
    };
    const freshLog = loadLS(LS_WORKOUT_LOG_KEY) || [];
    saveLog([...freshLog, pinSession]);
    if (onSessionSaved) onSessionSaved(pinSession);
    setDisplayKey(key);
  };

  // Previous best set weights for an exercise in this workout slot.
  // Returns one entry per set. Bilateral exercises get a string
  // weight per set; unilateral exercises get { L, R } per set so the
  // session UI can show the previous left/right weights side-by-side.
  // Falls back to mirroring the bilateral weight on both L+R when the
  // historical session was logged before unilateral split existed.
  const prevBestSets = (exId, exDef) => {
    for (let i = wLog.length - 1; i >= 0; i--) {
      const e = wLog[i];
      if (e.workout === displayKey && e.exercises?.[exId]?.sets) {
        const sets = e.exercises[exId].sets;
        if (exDef?.unilateral) {
          return sets.map(s => {
            const left  = s.leftWeight  ?? s.weight ?? "";
            const right = s.rightWeight ?? s.weight ?? "";
            if (!left && !right) return null;
            return { L: left, R: right };
          }).filter(Boolean);
        }
        return sets.map(s => s.weight ?? s.leftWeight ?? "").filter(Boolean);
      }
    }
    return [];
  };

  const startSession = () => {
    // Pre-populate inputs using the progression recommender — see
    // src/model/workout-progression.js. The recommender does smart
    // things based on history: a clean session bumps weight (or
    // reps for KB-style discrete-load exercises); a missed-reps
    // session holds weight; a catastrophic miss backs off. The
    // returned reasoning is also rendered under each input by
    // SessionExRow so the user knows why the suggestion is what
    // it is.
    const init = {};
    workout.exercises.forEach(ex => {
      if (ex.logWeight && ex.sets) {
        init[ex.id] = {
          sets: Array.from({ length: ex.sets }, (_, i) => {
            const rec = recommendSet(wLog, ex, displayKey, i);
            if (ex.unilateral) {
              return {
                leftReps:    rec.leftReps    ?? "",
                leftWeight:  rec.leftWeight  ?? "",
                rightReps:   rec.rightReps   ?? "",
                rightWeight: rec.rightWeight ?? "",
                done: false,
              };
            }
            return {
              weight: rec.weight ?? "",
              reps:   rec.reps   ?? "",
              done: false,
            };
          })
        };
      } else {
        init[ex.id] = { done: false };
      }
    });
    setSessionData(init);
    setSwaps({});
    setSwapPickerFor(null);
    setSessionActive(true);
  };

  // Swap an exercise for the current session only
  const doSwap = (originalEx, substituteEx) => {
    const numSets = originalEx.sets || 2;
    setSessionData(prev => {
      const next = { ...prev };
      delete next[originalEx.id];
      next[substituteEx.id] = substituteEx.logWeight
        ? { sets: Array.from({ length: numSets }, () => ({ weight: "", reps: substituteEx.reps || "", done: false })) }
        : { done: false };
      return next;
    });
    setSwaps(prev => ({ ...prev, [originalEx.id]: { ...substituteEx, sets: numSets } }));
    setSwapPickerFor(null);
  };

  const revertSwap = (originalEx) => {
    const numSets = originalEx.sets || 2;
    const swapped = swaps[originalEx.id];
    setSessionData(prev => {
      const next = { ...prev };
      if (swapped) delete next[swapped.id];
      next[originalEx.id] = originalEx.logWeight
        ? { sets: Array.from({ length: numSets }, () => ({ weight: "", reps: originalEx.reps || "", done: false })) }
        : { done: false };
      return next;
    });
    setSwaps(prev => { const s = { ...prev }; delete s[originalEx.id]; return s; });
    setSwapPickerFor(null);
  };

  const genId = () => {
    try { return crypto.randomUUID(); } catch { return `ws_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`; }
  };

  const completeSession = () => {
    // wasRecommended flag is what the rotation derivation reads to
    // decide whether this session should advance the queue. True
    // when the user completed the workout the rotation was offering;
    // false when they picked a different one (off-rotation deviation).
    // Persisted on the session record so it syncs to other devices.
    const wasRecommended = displayKey === rotKey && WK_ROTATION.includes(displayKey);
    const session = { id: genId(), date: today(), completedAt: nowISO(), workout: displayKey, sessionNumber: sessionN, wasRecommended, exercises: sessionData };
    // Read fresh from localStorage rather than the React state snapshot, which may
    // be stale if the migration effect rewrote the log after this component mounted.
    const freshLog = loadLS(LS_WORKOUT_LOG_KEY) || [];
    saveLog([...freshLog, session]);
    if (onSessionSaved) onSessionSaved(session);
    // No separate rotation state to bump — rotationIndex is derived
    // from wLog by the useMemo above, so the next render automatically
    // reflects the new completion (and other devices will recompute
    // the same answer when they sync wLog from Supabase).
    setSessionActive(false);
    setSessionData({});
    setSwaps({});
    setSwapPickerFor(null);
  };

  const allDone = workout && workout.exercises.every(ex => {
    const activeId = swaps[ex.id]?.id ?? ex.id;
    const d = sessionData[activeId];
    if (!d) return false;
    if (ex.logWeight && d.sets) return d.sets.every(s => s.done);
    return !!d.done;
  });

  // ── Sub-tab pill bar ──
  const tabPill = (label, key) => (
    <button
      key={key}
      onClick={() => { setSubTab(key); setEditingKey(null); }}
      style={{
        flex: 1, padding: "9px 0", fontSize: 13, fontWeight: subTab === key ? 700 : 400,
        color: subTab === key ? C.blue : C.muted,
        background: "none", border: "none",
        borderBottom: subTab === key ? `2px solid ${C.blue}` : "2px solid transparent",
        cursor: "pointer",
      }}
    >{label}</button>
  );

  // ── Week calendar ──
  const WEEK_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  const WEEK_ROLES  = ["Climb", "Train", "Rest", "Climb+Train", "Rest", "Climb+Train", "Sabbath"];
  const todayDow    = new Date().getDay(); // 0=Sun

  // ── Render ──
  return (
    <div style={{ padding: "16px 16px 80px" }}>
      {/* Sub-tab nav */}
      <div style={{ display: "flex", borderBottom: `1px solid ${C.border}`, marginBottom: 20 }}>
        {tabPill("Today", "today")}
        {tabPill("Plan", "plan")}
      </div>

      {/* ─── TODAY view ─────────────────────────────────────── */}
      {subTab === "today" && !sessionActive && (
        <>
          {/* Workout card */}
          <Card style={{ marginBottom: 12 }}>
            {/* Workout picker — recommended is highlighted; pick any for this session */}
            <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
              {Object.keys(plan).map(k => {
                const isPicked = k === displayKey;
                const isRec    = k === rotKey;
                return (
                  <button key={k} onClick={() => pickWorkout(k)} style={{
                    flex: 1, padding: "10px 4px", borderRadius: 10, cursor: "pointer",
                    background: isPicked ? C.blue : C.border,
                    color:      isPicked ? "#000" : C.muted,
                    fontWeight: 700, fontSize: 14,
                    border: isRec ? `2px solid ${C.blue}` : "2px solid transparent",
                    position: "relative", transition: "all 0.15s",
                  }}>
                    {isRec && (
                      <div style={{
                        position: "absolute", top: -8, left: "50%", transform: "translateX(-50%)",
                        fontSize: 9, fontWeight: 700, background: C.blue, color: "#000",
                        padding: "1px 6px", borderRadius: 6, whiteSpace: "nowrap",
                        letterSpacing: "0.06em",
                      }}>
                        NEXT UP
                      </div>
                    )}
                    {k}
                  </button>
                );
              })}
            </div>

            <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 14 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: C.muted, marginBottom: 2 }}>
                  WORKOUT {displayKey}
                  {displayKey === rotKey
                    ? "  ·  NEXT UP"
                    : (
                      <span style={{ color: C.orange }}>
                        {"  ·  OUT OF ORDER — queue still starts with "}{rotKey}
                        {" · "}
                        <button
                          onClick={() => setRotationTo(displayKey)}
                          title="Reset the rotation so the cycle starts here. Useful if devices have drifted out of sync, or to start a fresh training cycle."
                          style={{
                            background: "none", border: "none", color: C.blue,
                            fontSize: 11, fontWeight: 700, padding: 0,
                            textDecoration: "underline", cursor: "pointer",
                          }}
                        >
                          Make {displayKey} the next-up
                        </button>
                      </span>
                    )
                  }
                </div>
                <div style={{ fontSize: 20, fontWeight: 700, color: C.text }}>{workout.name}</div>
                <div style={{ fontSize: 12, color: C.muted, marginTop: 3 }}>
                  {workout.exercises.filter(e => e.type !== "X").map(e => e.name).join(" · ")}
                </div>
              </div>
            </div>

            {/* Metrics row */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
              {[["Session #", sessionN], ["Weeks to trip", wtr]].map(([label, val]) => (
                <div key={label} style={{
                  background: C.bg, borderRadius: 8, padding: "10px 14px",
                  border: `1px solid ${C.border}`,
                }}>
                  <div style={{ fontSize: 11, color: C.muted }}>{label}</div>
                  <div style={{ fontSize: 24, fontWeight: 700, color: C.text }}>{val}</div>
                </div>
              ))}
            </div>

            {/* Exercise list — with swap UI on the preview card, so equipment
                substitutions can be set before starting the session. */}
            <div>
              {workout.exercises.map((ex, i) => {
                const isSwapped  = !!swaps[ex.id];
                const activeEx   = isSwapped ? { ...swaps[ex.id] } : ex;
                const subs       = EXERCISE_SUBSTITUTES[ex.id] || [];
                const pickerOpen = swapPickerFor === ex.id;
                const isLast     = i === workout.exercises.length - 1;
                return (
                  <div key={ex.id}>
                    {subs.length > 0 && (
                      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 2 }}>
                        <button
                          onClick={() => setSwapPickerFor(pickerOpen ? null : ex.id)}
                          style={{
                            fontSize: 11, padding: "2px 8px", borderRadius: 4, cursor: "pointer",
                            background: "none", border: `1px solid ${isSwapped ? C.orange : C.border}`,
                            color: isSwapped ? C.orange : C.muted,
                          }}
                        >
                          {isSwapped ? `⇄ ${activeEx.name} (swapped)` : "⇄ swap"}
                        </button>
                      </div>
                    )}
                    {pickerOpen && (
                      <div style={{
                        background: C.bg, border: `1px solid ${C.border}`,
                        borderRadius: 8, padding: "10px 12px", marginBottom: 8,
                      }}>
                        <div style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>
                          Substitute for <strong style={{ color: C.text }}>{ex.name}</strong>:
                        </div>
                        {isSwapped && (
                          <button
                            onClick={() => revertSwap(ex)}
                            style={{
                              display: "block", width: "100%", textAlign: "left",
                              padding: "8px 10px", marginBottom: 4, borderRadius: 6,
                              background: C.border, border: "none", cursor: "pointer",
                              fontSize: 13, color: C.text, fontWeight: 600,
                            }}
                          >
                            ↩ {ex.name} <span style={{ color: C.muted, fontWeight: 400 }}>(revert to original)</span>
                          </button>
                        )}
                        {subs.map(sub => (
                          <button
                            key={sub.id}
                            onClick={() => doSwap(ex, sub)}
                            style={{
                              display: "block", width: "100%", textAlign: "left",
                              padding: "8px 10px", marginBottom: 4, borderRadius: 6,
                              background: activeEx.id === sub.id ? C.orange + "22" : C.card,
                              border: `1px solid ${activeEx.id === sub.id ? C.orange : C.border}`,
                              cursor: "pointer", fontSize: 13, color: C.text,
                            }}
                          >
                            <span style={{ fontWeight: 600 }}>{sub.name}</span>
                            <span style={{ color: C.muted }}> · {sub.reps}</span>
                            {sub.note && <span style={{ color: C.muted, fontSize: 11 }}> — {sub.note}</span>}
                          </button>
                        ))}
                      </div>
                    )}
                    <ExerciseRow ex={activeEx} last={isLast} />
                  </div>
                );
              })}
            </div>

            <div style={{ marginTop: 16 }}>
              <BwPrompt unit={unit} onSave={onBwSave} />
            </div>
            <button
              onClick={startSession}
              style={{
                width: "100%", padding: "14px",
                background: C.blue, color: "#000",
                border: "none", borderRadius: 10, fontWeight: 700,
                fontSize: 16, cursor: "pointer",
              }}
            >Start session</button>
          </Card>

          {/* Week calendar */}
          <Card>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, marginBottom: 12, letterSpacing: 1 }}>THIS WEEK</div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              {WEEK_LABELS.map((lbl, i) => {
                const isToday = i === todayDow;
                const role = WEEK_ROLES[i];
                const abbr = role === "Climb+Train" ? "CT" : role === "Sabbath" ? "S" : role[0];
                return (
                  <div key={lbl} style={{ textAlign: "center", flex: 1 }}>
                    <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>{lbl}</div>
                    <div style={{
                      width: 34, height: 34, borderRadius: "50%", margin: "0 auto",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      border: isToday ? `2px solid ${C.blue}` : `1px solid ${C.border}`,
                      background: isToday ? "#1a2d4a" : C.bg,
                      fontSize: 11, fontWeight: isToday ? 700 : 400,
                      color: isToday ? C.blue : C.muted,
                    }}>{abbr}</div>
                  </div>
                );
              })}
            </div>
          </Card>
        </>
      )}

      {/* ─── SESSION ACTIVE view ────────────────────────────── */}
      {subTab === "today" && sessionActive && (
        <Card>
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: C.muted }}>WORKOUT {rotKey}  ·  SESSION #{sessionN}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: C.text }}>{workout.name}</div>
          </div>

          {workout.exercises.map((ex, i) => {
            const isSwapped  = !!swaps[ex.id];
            const activeEx   = isSwapped ? { ...swaps[ex.id] } : ex;
            const sKey       = activeEx.id;
            const subs       = EXERCISE_SUBSTITUTES[ex.id] || [];
            const pickerOpen = swapPickerFor === ex.id;
            const isLast     = i === workout.exercises.length - 1;

            return (
              <div key={ex.id}>
                {/* Swap button row */}
                {subs.length > 0 && (
                  <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 2 }}>
                    <button
                      onClick={() => setSwapPickerFor(pickerOpen ? null : ex.id)}
                      style={{
                        fontSize: 11, padding: "2px 8px", borderRadius: 4, cursor: "pointer",
                        background: "none", border: `1px solid ${isSwapped ? C.orange : C.border}`,
                        color: isSwapped ? C.orange : C.muted,
                      }}
                    >
                      {isSwapped ? `⇄ ${activeEx.name} (swapped)` : "⇄ swap"}
                    </button>
                  </div>
                )}

                {/* Inline swap picker */}
                {pickerOpen && (
                  <div style={{
                    background: C.bg, border: `1px solid ${C.border}`,
                    borderRadius: 8, padding: "10px 12px", marginBottom: 8,
                  }}>
                    <div style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>
                      Substitute for <strong style={{ color: C.text }}>{ex.name}</strong>:
                    </div>
                    {isSwapped && (
                      <button
                        onClick={() => revertSwap(ex)}
                        style={{
                          display: "block", width: "100%", textAlign: "left",
                          padding: "8px 10px", marginBottom: 4, borderRadius: 6,
                          background: C.border, border: "none", cursor: "pointer",
                          fontSize: 13, color: C.text, fontWeight: 600,
                        }}
                      >
                        ↩ {ex.name} <span style={{ color: C.muted, fontWeight: 400 }}>(revert to original)</span>
                      </button>
                    )}
                    {subs.map(sub => (
                      <button
                        key={sub.id}
                        onClick={() => doSwap(ex, sub)}
                        style={{
                          display: "block", width: "100%", textAlign: "left",
                          padding: "8px 10px", marginBottom: 4, borderRadius: 6,
                          background: activeEx.id === sub.id ? C.orange + "22" : C.card,
                          border: `1px solid ${activeEx.id === sub.id ? C.orange : C.border}`,
                          cursor: "pointer", fontSize: 13, color: C.text,
                        }}
                      >
                        <span style={{ fontWeight: 600 }}>{sub.name}</span>
                        <span style={{ color: C.muted }}> · {sub.reps}</span>
                        {sub.note && <span style={{ color: C.muted, fontSize: 11 }}> — {sub.note}</span>}
                      </button>
                    ))}
                  </div>
                )}

                <SessionExRow
                  ex={activeEx}
                  unit={unit}
                  prevSets={prevBestSets(sKey, activeEx)}
                  setsData={sessionData[sKey]}
                  onSetsChange={(val) => setSessionData(prev => ({ ...prev, [sKey]: val }))}
                  done={!!sessionData[sKey]?.done}
                  onToggle={() => setSessionData(prev => ({
                    ...prev,
                    [sKey]: { ...prev[sKey], done: !prev[sKey]?.done },
                  }))}
                  last={isLast && !pickerOpen}
                  // Per-set progression suggestions — same recommender
                  // that startSession used to pre-fill the inputs.
                  // Computed here per render so the reasoning text
                  // stays in sync with whatever set count the user
                  // has after add/remove.
                  recommendations={(activeEx.sets ? Array.from({ length: Math.max(activeEx.sets, sessionData[sKey]?.sets?.length || 0) }, (_, i) => recommendSet(wLog, activeEx, displayKey, i)) : [])}
                />
              </div>
            );
          })}

          <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
            <button
              onClick={() => {
                if (allDone) {
                  completeSession();
                } else if (window.confirm("Some exercises aren't fully checked off — finish session anyway?")) {
                  completeSession();
                }
              }}
              style={{
                flex: 1, padding: "13px",
                background: allDone ? C.green : C.blue,
                color: "#000",
                border: "none", borderRadius: 10, fontWeight: 700,
                fontSize: 15, cursor: "pointer",
              }}
            >{allDone ? "Complete session ✓" : "Finish session →"}</button>
            <button
              onClick={() => { setSessionActive(false); setSessionData({}); setSwaps({}); setSwapPickerFor(null); }}
              style={{
                padding: "13px 16px", background: "transparent",
                border: `1px solid ${C.border}`, color: C.muted,
                borderRadius: 10, cursor: "pointer", fontSize: 14,
              }}
            >Abandon</button>
          </div>
        </Card>
      )}

      {/* ─── PLAN view ──────────────────────────────────────── */}
      {subTab === "plan" && (
        <>
          {editingKey ? (
            <WorkoutEditor
              wKey={editingKey}
              workout={plan[editingKey]}
              onSave={(name, exercises) => {
                savePlan({ ...plan, [editingKey]: { name, exercises } });
                setEditingKey(null);
              }}
              onClose={() => setEditingKey(null)}
              onReset={() => {
                if (window.confirm(`Reset Workout ${editingKey} to defaults?`)) {
                  savePlan({ ...plan, [editingKey]: DEFAULT_WORKOUTS[editingKey] });
                  setEditingKey(null);
                }
              }}
            />
          ) : (
            <>
              {/* Sequence rule callout */}
              <div style={{
                background: "#1a2d1a", border: `1px solid ${C.green}`,
                borderRadius: 8, padding: "10px 14px", marginBottom: 16,
                fontSize: 13, color: C.green,
              }}>
                <strong>A → B → C</strong>
                <span style={{ color: C.muted, fontWeight: 400 }}> · session-sequenced, not day-specific · C requires a rest day before climbing</span>
              </div>

              {/* Workout cards */}
              {["A", "B", "C"].map(key => {
                const wk = plan[key];
                const isNext = key === rotKey;
                return (
                  <Card key={key} style={{ marginBottom: 10, borderColor: isNext ? C.blue : C.border }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
                      <div style={{
                        width: 36, height: 36, borderRadius: 8, flexShrink: 0,
                        background: isNext ? "#1a2d4a" : C.bg,
                        border: `1px solid ${isNext ? C.blue : C.border}`,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 16, fontWeight: 800, color: isNext ? C.blue : C.muted,
                      }}>{key}</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{wk.name}</div>
                        <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
                          {wk.exercises.filter(e => e.type !== "X").map(e => e.name).join(" · ")}
                        </div>
                      </div>
                      <button
                        onClick={() => setEditingKey(key)}
                        style={{
                          padding: "6px 12px", background: "transparent",
                          border: `1px solid ${C.border}`, color: C.muted,
                          borderRadius: 6, cursor: "pointer", fontSize: 12,
                        }}
                      >Edit</button>
                    </div>
                    {wk.exercises.map((ex, i) => (
                      <ExerciseRow key={ex.id} ex={ex} last={i === wk.exercises.length - 1} />
                    ))}
                  </Card>
                );
              })}

              {/* Trip countdown — conjugate-friendly: countdown + taper window only */}
              {(() => {
                const cd = tripCountdown(trip.date);
                if (!cd) return null;
                const tripName = trip.name || "Trip";
                return (
                  <Card style={{ marginTop: 4 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, marginBottom: 10, letterSpacing: 1 }}>
                      {tripName.toUpperCase()} COUNTDOWN
                    </div>
                    {cd.past ? (
                      <div style={{ fontSize: 13, color: C.muted }}>
                        {cd.tripLabel} — trip date is in the past. Edit in Settings.
                      </div>
                    ) : (
                      <>
                        <div style={{ display: "flex", gap: 10, padding: "7px 0", borderBottom: `1px solid ${C.border}` }}>
                          <div style={{ fontSize: 13, color: C.yellow, fontWeight: 600, minWidth: 90 }}>
                            {cd.weeks}wk · {cd.days}d
                          </div>
                          <div style={{ fontSize: 13, color: C.muted }}>
                            Until {tripName} ({cd.tripLabel})
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 10, padding: "7px 0" }}>
                          <div style={{
                            fontSize: 13,
                            color: cd.inTaper ? C.red : C.yellow,
                            fontWeight: 600, minWidth: 90,
                          }}>
                            {cd.inTaper ? "TAPER" : cd.taperLabel}
                          </div>
                          <div style={{ fontSize: 13, color: C.muted }}>
                            {cd.inTaper
                              ? "Cut volume 40%, hold intensity"
                              : "Taper window starts (T−7d)"}
                          </div>
                        </div>
                      </>
                    )}
                  </Card>
                );
              })()}
            </>
          )}
        </>
      )}
    </div>
  );
}

