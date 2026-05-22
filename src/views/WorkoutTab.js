// ─────────────────────────────────────────────────────────────
// WORKOUT TAB
// ─────────────────────────────────────────────────────────────
// Strength / power / mobility training that supports climbing.
// Rebuilt May 2026 around the supportTraining schema (see
// src/model/supportTraining.js) — one BIG workout per week (A) plus
// frequent low-friction sessions (B / C / D). The previous 3-day
// rotation (legacy A/B/C, "Lift Day 1" / "Lift Day 2" / "Power")
// was prone to skipped sessions because the high-volume days took
// too long; the new shape addresses that directly.
//
// Flow:
//   1. recommendNextWorkout() looks at the user's recent support
//      sessions + climbing history + an `energyLow` toggle and
//      proposes one workout for today, with a one-line reason.
//   2. The user can accept the recommendation, override via the
//      A/B/C/D/CLIMB/REST picker, or skip with REST.
//   3. Active session: loggable exercises (per-set weight tracking)
//      render with SessionExRow (preserved from the previous
//      WorkoutTab — recommendSet drives weight suggestions); non-
//      loggable exercises (mobility, explosive, bodyweight)
//      render as compact SimpleExRow tiles with done + notes.
//   4. Saving stamps `workoutId: A|B|C|D` alongside the legacy
//      `workout` field for back-compat with the existing log
//      shape. HistoryView reads `workout` first, so legacy
//      sessions render unchanged.
//
// LEGACY_WORKOUTS is exported (was DEFAULT_WORKOUTS, content
// preserved) so HistoryView, WorkoutHistoryView, and
// WorkoutAnalysisView can resolve historical sessions' exercise
// names. The current tab no longer reads it.
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

// ─────────────────────────────────────────────────────────────
// Legacy data export — preserves the OLD DEFAULT_WORKOUTS content
// so HistoryView / WorkoutHistoryView / WorkoutAnalysisView can
// resolve historical session exercise names. The new tab does NOT
// consume this; it lives here only as a stable export for views
// that show historical data.
//
// Renamed from DEFAULT_WORKOUTS (no internal use any more); kept
// the original export name DEFAULT_WORKOUTS pointing to it so
// App.js's existing import doesn't break.
// ─────────────────────────────────────────────────────────────
export const LEGACY_WORKOUTS = {
  A: {
    name: "Lift Day 1 (Push + Pull)",
    exercises: [
      { id: "pull_ups",      name: "Weighted pull-ups",     type: "S", sets: 2,    reps: "5",      logWeight: true,  bodyweightAdditive: true, note: "Add weight when all reps clean" },
      { id: "landmine_rows", name: "One-arm landmine rows", type: "S", sets: 2,    reps: "5",      logWeight: true,  unilateral: true, note: "Alternate sides" },
      { id: "bench_press",   name: "Bench press",           type: "S", sets: 2,    reps: "5",      logWeight: true,  note: "" },
      { id: "dips",          name: "Dips",                  type: "S", sets: 2,    reps: "5",      logWeight: true,  bodyweightAdditive: true, note: "Weighted when bodyweight is easy" },
      { id: "bicep_curls",   name: "Bicep curls",           type: "S", sets: 2,    reps: "8",      logWeight: true,  unilateral: true, availableLoads: [20, 25, 40], note: "Undercling strength — rep up at current DB, jump when at top" },
      { id: "rdl",           name: "RDL",                   type: "S", sets: 2,    reps: "3–5",    logWeight: true,  note: "Heavy — load in lengthened position" },
      { id: "trx_ham_curl",  name: "TRX hamstring curl",    type: "S", sets: 2,    reps: "6–8",    logWeight: false, note: "Slow eccentric; single-leg when ready" },
      { id: "goblet_squat",  name: "Goblet squat",          type: "S", sets: 1,    reps: "8",      logWeight: true,  note: "Joint health — keep load moderate" },
      { id: "stretch",       name: "Stretching",            type: "X", sets: null, reps: null,     logWeight: false, note: "Couch · Splits machine · Hamstring lockout · Forearms · Lat" },
    ],
  },
  B: {
    name: "Lift Day 2 (Push + Pull)",
    exercises: [
      { id: "pull_ups",      name: "Weighted pull-ups",     type: "S", sets: 2,    reps: "5",      logWeight: true,  bodyweightAdditive: true, note: "Add weight when all reps clean" },
      { id: "landmine_rows", name: "One-arm landmine rows", type: "S", sets: 2,    reps: "5",      logWeight: true,  unilateral: true, note: "Alternate sides" },
      { id: "kb_press",      name: "KB press",              type: "S", sets: 2,    reps: "5",      logWeight: true,  unilateral: true, availableLoads: [35, 50, 55, 62, 70], note: "Single-arm — alternating sides" },
      { id: "dips",          name: "Dips",                  type: "S", sets: 2,    reps: "5",      logWeight: true,  bodyweightAdditive: true, note: "Weighted when bodyweight is easy" },
      { id: "bicep_curls",   name: "Bicep curls",           type: "S", sets: 2,    reps: "8",      logWeight: true,  unilateral: true, availableLoads: [20, 25, 40], note: "Undercling strength — rep up at current DB, jump when at top" },
      { id: "rdl",           name: "RDL",                   type: "S", sets: 2,    reps: "3–5",    logWeight: true,  note: "Heavy — load in lengthened position" },
      { id: "trx_ham_curl",  name: "TRX hamstring curl",    type: "S", sets: 2,    reps: "6–8",    logWeight: false, note: "Slow eccentric; single-leg when ready" },
      { id: "step_up",       name: "Step-up",               type: "S", sets: 1,    reps: "6–8",    logWeight: true,  unilateral: true, note: "Climbing & hiking strength — load when bodyweight easy" },
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

// Back-compat alias — App.js, HistoryView, WorkoutAnalysisView, and
// WorkoutHistoryView all import DEFAULT_WORKOUTS for legacy-session
// name resolution. Keep the export name; the content is the legacy
// data.
export const DEFAULT_WORKOUTS = LEGACY_WORKOUTS;

// ─────────────────────────────────────────────────────────────
// History-view lookup dictionary
// ─────────────────────────────────────────────────────────────
// Merged dictionary of legacy + current workouts, with legacy keys
// prefixed `legacy_` to avoid collision with the new schema's
// A / B / C / D. Used by HistoryView / WorkoutHistoryView /
// WorkoutAnalysisView to resolve exercise names regardless of
// which schema a session was logged under.
//
// Consumers that need to render a "current workouts" picker (e.g.
// the reclassify dropdown on a History session edit) should filter
// to non-legacy keys via `key => !key.startsWith("legacy_")`.
export const ALL_WORKOUTS_LOOKUP = {
  ...Object.fromEntries(
    Object.entries(LEGACY_WORKOUTS).map(([k, v]) => [`legacy_${k}`, v])
  ),
  ...SUPPORT_WORKOUTS,
};

// ─────────────────────────────────────────────────────────────
// LocalStorage keys
// ─────────────────────────────────────────────────────────────
// Energy toggle is stored as { date, value } so an "I'm wiped"
// state set on Monday night doesn't bleed into Tuesday morning's
// recommendation. Auto-clears at midnight without any explicit
// cleanup logic — the read helper compares date against today().
const LS_ENERGY_LOW_KEY = "ft_support_energy_low";

function loadEnergyLow() {
  const stored = loadLS(LS_ENERGY_LOW_KEY);
  if (stored?.date === today() && stored?.value === true) return true;
  return false;
}
function saveEnergyLow(value) {
  saveLS(LS_ENERGY_LOW_KEY, { date: today(), value: !!value });
}

// ─────────────────────────────────────────────────────────────
// Type badge metadata
// ─────────────────────────────────────────────────────────────
// S = Strength, H = Hypertrophy / mobility, P = Power, X = Stretch.
// Matches the legacy palette so the badge color is consistent if
// you compare old + new sessions side by side in History.
const WTYPE_META = {
  S: { label: "S", color: C.blue,   bg: C.blue   + "22" },
  H: { label: "H", color: C.purple, bg: C.purple + "22" },
  P: { label: "P", color: C.orange, bg: C.orange + "22" },
  X: { label: "X", color: C.muted,  bg: C.border          },
};

// Workout ID accent colors. The recommendation card and the picker
// buttons use these so the active workout has a consistent visual
// identity across surfaces. After the May 2026 rename, "C" inherits
// the green that used to belong to D (so the new C — the neural
// strength touch — keeps its visual identity), and STRETCH gets the
// purple slot that the dropped mobility C used to occupy.
const WORKOUT_COLORS = {
  A: C.blue,
  B: C.orange,
  C: C.green,
  STRETCH: C.purple,
  CLIMB: "#e05560",
  REST: C.muted,
};

function genId() { return Math.random().toString(36).slice(2, 10); }

// ─────────────────────────────────────────────────────────────
// Type badge
// ─────────────────────────────────────────────────────────────
function WTypeBadge({ type }) {
  const meta = WTYPE_META[type] || WTYPE_META.S;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      width: 22, height: 22, borderRadius: 6, flexShrink: 0,
      fontSize: 11, fontWeight: 700, color: meta.color, background: meta.bg,
    }}>{meta.label}</span>
  );
}

// ─────────────────────────────────────────────────────────────
// VideoLink — small "▶ demo" link next to novel exercise names
// ─────────────────────────────────────────────────────────────
// Renders when an exercise carries a videoUrl. Opens the source
// video (typically YouTube — Lattice, Climb Strong, Judd
// Lienhard) in a new tab. Only attached to exercises where the
// movement is novel enough that a 90-second demo beats reading
// the form cues (hard-style situp, banded chops, weighted
// pancake / leg lifts, supine frog, prone external rotation).
// Standard lifts (bench, pullup, dips) intentionally don't
// carry a videoUrl — a "demo" link there would feel condescending.
function VideoLink({ href, label = "▶ demo" }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        fontSize: 11, fontWeight: 600, color: C.blue,
        textDecoration: "none",
        padding: "1px 6px", borderRadius: 4,
        border: `1px solid ${C.blue}55`,
        whiteSpace: "nowrap",
      }}
      onClick={e => e.stopPropagation()}
    >{label}</a>
  );
}

// ─────────────────────────────────────────────────────────────
// SessionExRow — per-set weight + reps tracking
// ─────────────────────────────────────────────────────────────
// Preserved from the previous WorkoutTab. Used for loggable=true
// exercises only. Drives weight suggestions via recommendSet() in
// the parent component and renders the editable input grid.
//
// Unilateral exercises render TWO short rows per set (L on top,
// R below) so each side gets its own reps + weight inputs. The
// pair shares one done button — a "set" of unilateral work is one
// logical unit even though the two sides happen sequentially.
function SessionExRow({ ex, unit, prevSets, setsData, onSetsChange, recommendations = [], last }) {
  const allSetsDone = setsData?.sets
    ? setsData.sets.every(s => s.done)
    : false;
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
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <div style={{ fontSize: 15, color: C.text }}>{ex.name}</div>
            {ex.videoUrl && <VideoLink href={ex.videoUrl} />}
          </div>
          {ex.intent ? (
            <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{ex.intent}</div>
          ) : null}

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
              const rec = recommendations[i];

              const renderSideRow = (side, sLabel, sideKey) => {
                const sideWord  = side === "L" ? "left" : side === "R" ? "right" : null;
                const repsKey   = sideWord ? `${sideWord}Reps`   : "reps";
                const weightKey = sideWord ? `${sideWord}Weight` : "weight";
                const stored = (k) => {
                  const v = s[k];
                  return v != null && v !== "" ? v : null;
                };
                const recReps   = rec ? (rec[repsKey]   ?? rec.reps)   : null;
                const recWeight = rec ? (rec[weightKey] ?? rec.weight) : null;
                const repsVal   = stored(repsKey)   ?? recReps   ?? (side ? "" : ex.reps) ?? "";
                const weightVal = stored(weightKey) ?? recWeight ?? "";
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
                      placeholder={recReps != null ? String(recReps) : (ex.reps || "")}
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
                      placeholder={recWeight != null ? String(recWeight) : ""}
                    />
                    <span style={{ fontSize: 12, color: C.muted }}>{unit}</span>
                    {prevShown ? (
                      <span style={{ fontSize: 12, color: C.muted, width: 44 }}>{prevShown}</span>
                    ) : prevSets?.length > 0 ? (
                      <span style={{ width: 44 }} />
                    ) : null}
                    {(side === null || side === "R") && doneBtn(s.done, () => {
                      const next = [...setsData.sets];
                      next[i] = { ...next[i], done: !next[i].done };
                      onSetsChange({ sets: next });
                    })}
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

              const hintStyle = { fontSize: 10, color: C.muted, marginLeft: 44, marginTop: -2, marginBottom: 4, fontStyle: "italic" };

              if (ex.unilateral) {
                return (
                  <div key={i} style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 11, color: isExtra ? C.orange : C.muted, marginBottom: 2 }}>S{i + 1}</div>
                    {renderSideRow("L", "L", `${i}-L`)}
                    {rec?.leftReasoning  && (<div style={hintStyle}>{rec.leftReasoning}</div>)}
                    {renderSideRow("R", "R", `${i}-R`)}
                    {rec?.rightReasoning && (<div style={hintStyle}>{rec.rightReasoning}</div>)}
                  </div>
                );
              }
              return (
                <div key={i}>
                  {renderSideRow(null, `S${i + 1}`, `${i}`)}
                  {rec?.reasoning && (<div style={hintStyle}>{rec.reasoning}</div>)}
                </div>
              );
            })}

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
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// SimpleExRow — done checkbox + notes for non-loggable exercises
// ─────────────────────────────────────────────────────────────
// Used for exercises where numeric load tracking is the wrong
// shape: bodyweight, banded, time-based, mobility, explosive (med
// ball, jumps, skater bounds). Shows the exercise name, the
// prescription string, the intent paragraph, a done toggle, and
// an optional notes field for session-specific commentary
// ("red band today", "broad jump 2.3m best", etc).
function SimpleExRow({ ex, done, notes, onToggle, onNotesChange, last }) {
  return (
    <div style={{
      padding: "12px 0",
      borderBottom: last ? "none" : `1px solid ${C.border}`,
      opacity: done ? 0.55 : 1,
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <WTypeBadge type={ex.type} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <div style={{ fontSize: 15, color: C.text }}>{ex.name}</div>
              {ex.videoUrl && <VideoLink href={ex.videoUrl} />}
            </div>
            <div style={{ fontSize: 12, color: C.muted, whiteSpace: "nowrap" }}>{ex.prescription}</div>
          </div>
          {ex.intent ? (
            <div style={{ fontSize: 12, color: C.muted, marginTop: 4, lineHeight: 1.4 }}>{ex.intent}</div>
          ) : null}
          <input
            value={notes || ""}
            onChange={e => onNotesChange?.(e.target.value)}
            placeholder="Notes (band, distance, weight…)"
            style={{
              marginTop: 8, width: "100%",
              background: C.bg, border: `1px solid ${C.border}`,
              color: C.text, borderRadius: 6, padding: "5px 8px", fontSize: 12,
            }}
          />
        </div>
        <button onClick={onToggle} style={{
          width: 28, height: 28, borderRadius: "50%", flexShrink: 0,
          background: done ? C.green : "transparent",
          border: `2px solid ${done ? C.green : C.border}`,
          color: done ? "#000" : C.muted,
          cursor: "pointer", fontSize: 12, display: "flex",
          alignItems: "center", justifyContent: "center",
        }}>{done ? "✓" : ""}</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// RecommendationCard
// ─────────────────────────────────────────────────────────────
// Renders recommendNextWorkout() output at the top of the tab.
// The primary suggestion is a big button; alternatives are smaller
// chips below. Clicking any of them sets the active workout for
// the day. The reason text is the engine's one-line "why."
function RecommendationCard({ recommendation, onPickWorkout, pickedId }) {
  if (!recommendation) return null;
  const { primary, reason, caution, alternatives } = recommendation;
  const isAccepted = pickedId === primary.id;
  const accent = WORKOUT_COLORS[primary.id] || C.blue;

  return (
    <Card style={{ marginBottom: 12, border: `1px solid ${accent}66` }}>
      <div style={{ fontSize: 11, color: C.muted, letterSpacing: 0.5, marginBottom: 6 }}>
        TODAY'S RECOMMENDATION
      </div>
      <button
        onClick={() => onPickWorkout(primary.id)}
        style={{
          width: "100%", textAlign: "left",
          background: isAccepted ? `${accent}22` : "transparent",
          border: `1px solid ${isAccepted ? accent : C.border}`,
          borderRadius: 10, padding: "10px 12px",
          cursor: "pointer", color: "inherit",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
          <span style={{
            fontSize: 11, fontWeight: 700, color: accent,
            background: `${accent}1a`,
            padding: "2px 8px", borderRadius: 4, letterSpacing: 0.5,
          }}>{primary.shortName}</span>
          <span style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{primary.name.replace(/^Workout [A-D] — /, "")}</span>
        </div>
        <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5 }}>{reason}</div>
        {caution && (
          <div style={{
            marginTop: 6, fontSize: 11, color: C.orange,
            background: `${C.orange}11`, borderRadius: 6,
            padding: "4px 8px", fontStyle: "italic",
          }}>⚠ {caution}</div>
        )}
      </button>
      {alternatives && alternatives.length > 0 && (
        <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 10, color: C.muted, alignSelf: "center", marginRight: 2 }}>
            or:
          </span>
          {alternatives.map(w => {
            const altAccent = WORKOUT_COLORS[w.id] || C.muted;
            const altActive = pickedId === w.id;
            return (
              <button
                key={w.id}
                onClick={() => onPickWorkout(w.id)}
                style={{
                  background: altActive ? `${altAccent}22` : "transparent",
                  border: `1px solid ${altActive ? altAccent : C.border}`,
                  color: altActive ? altAccent : C.muted,
                  borderRadius: 6, padding: "4px 10px", fontSize: 12,
                  fontWeight: 600, cursor: "pointer",
                }}
              >{w.shortName}</button>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────
// EnergyToggle
// ─────────────────────────────────────────────────────────────
// Manual "I'm wiped" signal for the recommender. When ON, the
// engine blocks A (the BIG day) regardless of overdue staleness
// and falls back to D + a caution. Resets at midnight via the
// date-stamped storage scheme in loadEnergyLow / saveEnergyLow.
function EnergyToggle({ value, onChange }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "8px 10px", marginBottom: 12,
      borderRadius: 8, background: C.bg, border: `1px solid ${value ? C.orange : C.border}`,
    }}>
      <div style={{ fontSize: 12, color: C.muted }}>
        How's the energy?
      </div>
      <div style={{ display: "flex", gap: 4 }}>
        <button
          onClick={() => onChange(false)}
          style={{
            padding: "5px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600,
            cursor: "pointer",
            background: !value ? C.green : "transparent",
            color: !value ? "#000" : C.muted,
            border: `1px solid ${!value ? C.green : C.border}`,
          }}
        >Fresh</button>
        <button
          onClick={() => onChange(true)}
          style={{
            padding: "5px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600,
            cursor: "pointer",
            background: value ? C.orange : "transparent",
            color: value ? "#000" : C.muted,
            border: `1px solid ${value ? C.orange : C.border}`,
          }}
        >Wiped</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Workout picker — explicit A/B/C/D tiles for the four trainable workouts
// ─────────────────────────────────────────────────────────────
// CLIMB and REST are intentionally NOT in the picker — they're the
// absence of a strength workout, not something you pick from a tile.
// Climbing has its own log via the climbing activities flow; REST
// is just "don't open the app today."
//
// The recommender CAN still produce a REST recommendation when
// climbing density is high (Rule 6) — when that happens, the
// recommendation card renders as usual but the user can either
// accept it (logs a marker session) or override via the four
// trainable tiles below.
function WorkoutPicker({ pickedId, onPick }) {
  // Three weekly-rotation workouts in the picker. STRETCH is NOT
  // listed here — it's a daily habit rendered as a separate wide
  // pill below the picker, not a Tuesday-vs-Thursday choice.
  const ORDER = ["A", "B", "C"];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4, marginBottom: 8 }}>
      {ORDER.map(id => {
        const wo = SUPPORT_WORKOUTS[id];
        if (!wo) return null;
        const isPicked = pickedId === id;
        const accent = WORKOUT_COLORS[id] || C.muted;
        return (
          <button
            key={id}
            onClick={() => onPick(id)}
            style={{
              padding: "8px 0", borderRadius: 8, cursor: "pointer",
              fontSize: 12, fontWeight: 700,
              background: isPicked ? accent : "transparent",
              color: isPicked ? "#000" : C.muted,
              border: `1px solid ${isPicked ? accent : C.border}`,
            }}
            title={wo.name}
          >{wo.shortName}</button>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// StretchPill — daily-habit toggle for hip + forearm mobility
// ─────────────────────────────────────────────────────────────
// Renders full-width below the A/B/C picker. Click = toggle: if
// today doesn't yet have a STRETCH session, log a marker session;
// if it does, remove it. Reversible-forever beats a confirm step
// for a low-stakes habit tracker — an accidental tap is fixed by
// tapping again, and the pill's visible state change makes the
// accident immediately obvious.
//
// Color state communicates staleness without prompting:
//   gray   — done today (no pressure)
//   gray   — done yesterday or day before (still fresh)
//   yellow — 3–5 days since last stretch
//   orange — 6+ days since last stretch
// "Days since" is read from the workout log directly; we don't go
// through the recommender's tagDays plumbing for this because we
// want to count STRETCH marker sessions specifically, not anything
// that happens to carry a mobility tag.
//
// The component is presentation-only: parent owns the toggle handler
// and reads/writes the workout log. This keeps the pill testable in
// isolation and makes the pull-trigger explicit in WorkoutTab.
function StretchPill({ done, daysSince, onToggle }) {
  // Color band: green when done today, gray when fresh, yellow at
  // mid-staleness, orange at high. Thresholds matched to the
  // literature's "every few days is fine, weekly is not" — yellow
  // appears around the threshold where adaptation starts to drift
  // back; orange when you'd notice the lost range in climbing.
  let accent = C.muted;
  let pillBg = "transparent";
  let textColor = C.muted;
  if (done) {
    accent = C.green;
    pillBg = `${C.green}22`;
    textColor = C.green;
  } else if (daysSince == null || daysSince >= 6) {
    // Never logged or 6+ days stale → orange. "Never" reads as
    // infinitely stale; we'd rather show the warning color than
    // pretend a brand-new user is on top of mobility.
    accent = C.orange;
    pillBg = `${C.orange}1a`;
    textColor = C.orange;
  } else if (daysSince >= 3) {
    accent = C.yellow;
    pillBg = `${C.yellow}1a`;
    textColor = C.yellow;
  }

  const subtitle = done
    ? "Done today ✓"
    : daysSince == null
      ? "Never logged"
      : daysSince === 0
        ? "Last: earlier today"
        : daysSince === 1
          ? "Last: yesterday"
          : `Last: ${daysSince}d ago`;

  return (
    <button
      onClick={onToggle}
      style={{
        width: "100%",
        padding: "10px 14px",
        marginBottom: 12,
        background: pillBg,
        border: `1px solid ${accent}`,
        borderRadius: 8,
        cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        textAlign: "left",
      }}
      // The toggle is the whole point — a hover hint keeps the
      // tap behavior discoverable without an inline icon.
      title={done ? "Tap to un-log today's stretch" : "Tap to log today's stretch"}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: textColor, letterSpacing: 0.3 }}>
          Daily Stretching
        </div>
        <div style={{ fontSize: 11, color: textColor, opacity: 0.85 }}>
          {subtitle}
        </div>
      </div>
      <div style={{
        fontSize: 11, fontWeight: 700, color: textColor,
        padding: "3px 8px", borderRadius: 4,
        border: `1px solid ${accent}`,
        textTransform: "uppercase", letterSpacing: 0.5,
      }}>
        {done ? "✓" : "Tap to log"}
      </div>
    </button>
  );
}

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
  const [energyLow, setEnergyLow] = useState(() => loadEnergyLow());
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
      energyLow,
      climbingHistory,
      refDate: today(),
    }),
    [recommenderInput, energyLow, climbingHistory]
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

  // ── Energy toggle persistence ────────────────────────
  const handleEnergyChange = (next) => {
    setEnergyLow(next);
    saveEnergyLow(next);
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
      if (ex.loggable) {
        // Seed sets with recommendSet-suggested values from wLog
        // history. Same protocol the legacy tab used.
        const sets = Array.from({ length: ex.sets || 1 }, (_, i) => {
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
              with A/B/C for today's slot. */}
          <StretchPill
            done={stretchState.done}
            daysSince={stretchState.daysSince}
            onToggle={toggleTodaysStretch}
          />

          <EnergyToggle value={energyLow} onChange={handleEnergyChange} />

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
                onClick={startSession}
                style={{
                  width: "100%", padding: "12px",
                  background: WORKOUT_COLORS[activeId] || C.blue,
                  color: "#000", border: "none", borderRadius: 8,
                  fontSize: 15, fontWeight: 700, cursor: "pointer",
                }}
              >
                {activeWorkout.exercises.length === 0
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

// Reduce a stored set object into a compact "prev" display string
// for SessionExRow's prev column. For unilateral sets, returns
// an object { L: "...", R: "..." }; for bilateral, returns a
// single string.
function setSummary(set) {
  if (set == null) return null;
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
  const r = set.reps, w = set.weight;
  if ((r == null || r === "") && (w == null || w === "")) return "";
  return `${r ?? ""}${r && w ? "@" : ""}${w ?? ""}`;
}

