// ─────────────────────────────────────────────────────────────
// ANALYSIS CONTAINER
// ─────────────────────────────────────────────────────────────
// Top-level "Analysis" tab. Hosts a Fingers / Lifts pill bar and
// renders one of two underlying views:
//   * AnalysisView          — Tindeq finger training (F-D curve, AUC,
//                             Hand Asymmetry, Critical Force).
//   * WorkoutAnalysisView   — gym lifting progression (per-exercise top
//                             weight + volume over time).
//
// Why one tab. Both surfaces are "look back at what I've done"; they
// belong in the same conceptual space. Pairing them under a single
// Analysis tab also frees the top-level nav to put the two "doing the
// work" tabs (Fingers + Workout) next to each other where they belong.
//
// The pill choice is persisted to localStorage so re-entering the tab
// lands the user on whichever side they last looked at.
//
// All props for both child views are passed through here — this is a
// thin wrapper, not a smart component, so App.js stays the single
// source of truth for hook state.

import React, { useState } from "react";
import { C } from "../ui/theme.js";
import { loadLS, saveLS, LS_ANALYSIS_SUBTAB_KEY } from "../lib/storage.js";
import { AnalysisView } from "./AnalysisView.js";
import { WorkoutAnalysisView } from "./WorkoutAnalysisView.js";

export function AnalysisContainer(props) {
  const {
    // AnalysisView (fingers) props
    history, unit, bodyWeight, activities,
    liveEstimate, gripEstimates, freshMap,
    GOAL_CONFIG, RM_GRIPS,
    // WorkoutAnalysisView (lifts) props
    defaultWorkouts,
  } = props;

  const [sub, setSub] = useState(() => {
    const saved = loadLS(LS_ANALYSIS_SUBTAB_KEY);
    return saved === "lifts" ? "lifts" : "fingers";
  });

  const pickSub = (key) => {
    setSub(key);
    saveLS(LS_ANALYSIS_SUBTAB_KEY, key);
  };

  // Pill bar — same visual weight as the workout-picker pills in
  // WorkoutTab, so the two "pick what you're looking at" UIs read
  // as a consistent pattern across the app.
  const pill = (label, key) => {
    const active = sub === key;
    return (
      <button
        key={key}
        onClick={() => pickSub(key)}
        style={{
          flex: 1, padding: "12px 4px", borderRadius: 10, cursor: "pointer",
          background: active ? C.blue : C.border,
          color:      active ? "#000" : C.muted,
          fontWeight: 700, fontSize: 15,
          border: "2px solid transparent",
          transition: "all 0.15s",
        }}
      >
        {label}
      </button>
    );
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 6, padding: "12px 16px 0" }}>
        {pill("Fingers", "fingers")}
        {pill("Lifts", "lifts")}
      </div>

      {sub === "fingers" && (
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
        />
      )}
      {sub === "lifts" && (
        <WorkoutAnalysisView
          unit={unit}
          bodyWeight={bodyWeight}
          defaultWorkouts={defaultWorkouts}
        />
      )}
    </div>
  );
}
