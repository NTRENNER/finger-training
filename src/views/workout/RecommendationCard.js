import React from "react";
import { C } from "../../ui/theme.js";
import { WORKOUT_COLORS } from "./workoutConstants.js";

// One selectable recommendation; the workout picker owns alternatives.
export function RecommendationCard({ recommendation, onPickWorkout, pickedId }) {
  if (!recommendation) return null;
  const { primary, reason, caution } = recommendation;
  const isAccepted = pickedId === primary.id;
  const accent = WORKOUT_COLORS[primary.id] || C.blue;

  return (
    <button
      type="button"
      aria-label={`Use recommended Workout ${primary.shortName}`}
      aria-pressed={isAccepted}
      onClick={() => onPickWorkout(primary.id)}
      style={{
        width: "100%", textAlign: "left", boxSizing: "border-box",
        background: C.bg, color: C.text, font: "inherit",
        border: `1px solid ${isAccepted ? accent : C.border}`,
        boxShadow: isAccepted ? `inset 0 0 0 1px ${accent}` : "none",
        borderRadius: 8, padding: 16, cursor: "pointer",
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 700, color: accent, letterSpacing: 0.5, marginBottom: 12 }}>
        {isAccepted ? "★ RECOMMENDED" : "↩ USE RECOMMENDED WORKOUT"}
      </div>
      <div style={{ fontSize: 24, fontWeight: 750, lineHeight: 1.25 }}>
        <span style={{ color: accent }}>{primary.shortName} · </span>
        {primary.name.replace(/^Workout [A-D] — /, "")}
      </div>
      <div style={{ fontSize: 14, color: C.muted, marginTop: 8 }}>
        {primary.exercises.length} exercises
      </div>
      <div style={{ fontSize: 16, lineHeight: 1.5, marginTop: 12 }}>{reason}</div>
      {caution && <div style={{ marginTop: 10, fontSize: 14, lineHeight: 1.5, color: C.orange }}>⚠ {caution}</div>}
    </button>
  );
}
