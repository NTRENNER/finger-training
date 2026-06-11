// ─────────────────────────────────────────────────────────────
// ANALYSIS CONTAINER
// ─────────────────────────────────────────────────────────────
// Top-level "Analysis" tab. Hosts a Fingers / Lifts / Climbs / Weight
// pill bar and renders one of four underlying views:
//   * AnalysisView            — Tindeq finger training (F-D curve, AUC,
//                               Hand Asymmetry, Critical Force).
//   * WorkoutAnalysisView     — gym lifting progression (per-exercise
//                               top weight + volume over time).
//   * ClimbingAnalysisView    — climbing log analytics (grade pyramid,
//                               v-sum session volume, hardest-send
//                               line, ascent style mix).
//   * BodyWeightAnalysisView  — bodyweight log over time + 30/90-day
//                               deltas + 7-day rolling average.
//
// Why one tab. All four surfaces are "look back at what I've done";
// they belong in the same conceptual space. Pairing them under a
// single Analysis tab also frees the top-level nav to put the two
// "doing the work" tabs (Fingers + Workout) next to each other where
// they belong.
//
// The pill choice is persisted to localStorage so re-entering the tab
// lands the user on whichever side they last looked at.
//
// All props for the child views are passed through here — this is a
// thin wrapper, not a smart component, so App.js stays the single
// source of truth for hook state.

import React, { useState } from "react";
import { C } from "../ui/theme.js";
import { loadLS, saveLS, LS_ANALYSIS_SUBTAB_KEY } from "../lib/storage.js";
import { AnalysisView } from "./AnalysisView.js";
import { WorkoutAnalysisView } from "./WorkoutAnalysisView.js";
import { ClimbingAnalysisView } from "./ClimbingAnalysisView.js";
import { BodyWeightAnalysisView } from "./BodyWeightAnalysisView.js";

const VALID_SUBS = new Set(["fingers", "lifts", "climbing", "weight"]);

export function AnalysisContainer(props) {
  const {
    // AnalysisView (fingers) props
    history, unit, bodyWeight, activities,
    freshMap,
    GOAL_CONFIG, RM_GRIPS,
    // Frozen per-grip baselines threaded from App.useUserSettings — see
    // LS_PINNED_GRIP_BASELINES_KEY for the rationale. baselinePinReady
    // gates the pin-on-first-seed WRITE until both cloud reconciles
    // (user_settings + reps) have landed — see App.js.
    pinnedGripBaselines = null,
    onSavePinnedGripBaselines = () => {},
    baselinePinReady = true,
    // WorkoutAnalysisView (lifts) props
    defaultWorkouts,
    // ClimbingAnalysisView (climbs) props — pyramid pins synced via App
    pyramidProjectMap = {},
    onPyramidProjectChange = () => {},
  } = props;

  const [sub, setSub] = useState(() => {
    const saved = loadLS(LS_ANALYSIS_SUBTAB_KEY);
    return VALID_SUBS.has(saved) ? saved : "fingers";
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
          minWidth: 0,  // lets text truncate cleanly on narrow screens
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
        {pill("Climbs", "climbing")}
        {pill("Weight", "weight")}
      </div>

      {sub === "fingers" && (
        <AnalysisView
          history={history}
          unit={unit}
          bodyWeight={bodyWeight}
          activities={activities}
          freshMap={freshMap}
          GOAL_CONFIG={GOAL_CONFIG}
          RM_GRIPS={RM_GRIPS}
          pinnedGripBaselines={pinnedGripBaselines}
          onSavePinnedGripBaselines={onSavePinnedGripBaselines}
          baselinePinReady={baselinePinReady}
        />
      )}
      {sub === "lifts" && (
        <WorkoutAnalysisView
          unit={unit}
          bodyWeight={bodyWeight}
          defaultWorkouts={defaultWorkouts}
        />
      )}
      {sub === "climbing" && (
        <ClimbingAnalysisView
          activities={activities}
          pyramidProjectMap={pyramidProjectMap}
          onPyramidProjectChange={onPyramidProjectChange}
        />
      )}
      {sub === "weight" && (
        <BodyWeightAnalysisView unit={unit} />
      )}
    </div>
  );
}
