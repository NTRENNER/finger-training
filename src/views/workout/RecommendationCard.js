// ─────────────────────────────────────────────────────────────
// RecommendationCard — top-of-tab "today's recommendation"
// ─────────────────────────────────────────────────────────────
// Renders recommendNextWorkout() output at the top of the tab.
// The primary suggestion is a big button; alternatives are smaller
// chips below. Clicking any of them sets the active workout for
// the day. The reason text is the engine's one-line "why."

import React from "react";
import { C } from "../../ui/theme.js";
import { Card } from "../../ui/components.js";
import { WORKOUT_COLORS } from "./workoutConstants.js";

export function RecommendationCard({ recommendation, onPickWorkout, pickedId }) {
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
