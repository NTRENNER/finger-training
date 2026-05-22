// ─────────────────────────────────────────────────────────────
// WorkoutPicker — explicit A/B/C tiles for the trainable workouts
// ─────────────────────────────────────────────────────────────
// CLIMB, REST, and STRETCH are intentionally NOT in the picker.
// CLIMB and REST are the absence of a strength workout, not
// something you pick from a tile — climbing has its own log via
// the climbing activities flow, REST is just "don't open the app
// today." STRETCH is a daily habit rendered as its own full-width
// pill below the picker. The recommender never proposes any of
// the three as primary either; the picker shows what the engine
// actually picks from.

import React from "react";
import { C } from "../../ui/theme.js";
import { workouts as SUPPORT_WORKOUTS } from "../../model/supportTraining.js";
import { WORKOUT_COLORS } from "./workoutConstants.js";

const ORDER = ["A", "B", "C"];

export function WorkoutPicker({ pickedId, onPick }) {
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
