import React from "react";
import { C } from "../../ui/theme.js";
import { workouts as SUPPORT_WORKOUTS } from "../../model/supportTraining.js";
import { WORKOUT_COLORS } from "./workoutConstants.js";

const ORDER = ["A", "B", "C"];

export function WorkoutPicker({ pickedId, recommendedId, onPick }) {
  return (
    <div className="workout-choice-grid">
      {ORDER.map(id => {
        const wo = SUPPORT_WORKOUTS[id];
        const isPicked = pickedId === id;
        const accent = WORKOUT_COLORS[id] || C.muted;
        return (
          <button
            key={id}
            type="button"
            aria-label={`Choose Workout ${id}: ${wo.name.replace(/^Workout [A-D] — /, "")}`}
            aria-pressed={isPicked}
            onClick={() => onPick(id)}
            style={{
              padding: "14px 16px", minHeight: 76, borderRadius: 8, cursor: "pointer",
              font: "inherit", textAlign: "left", minWidth: 0,
              background: isPicked ? `${accent}18` : C.bg, color: C.text,
              border: `1px solid ${isPicked ? accent : C.border}`,
              boxShadow: isPicked ? `inset 0 0 0 1px ${accent}` : "none",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontSize: 24, fontWeight: 750, color: accent }}>{id}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 650, lineHeight: 1.35 }}>{wo.name.replace(/^Workout [A-D] — /, "")}</div>
                <div style={{ fontSize: 13, color: C.muted, marginTop: 4 }}>{wo.exercises.length} exercises</div>
              </div>
              {recommendedId === id && <span aria-label="Recommended" style={{ color: accent }}>★</span>}
            </div>
          </button>
        );
      })}
    </div>
  );
}
