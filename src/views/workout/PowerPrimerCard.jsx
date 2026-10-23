import React from "react";
import { C } from "../../ui/theme.js";

export function PowerPrimerCard({ workout, selected, onSelect }) {
  if (!workout) return null;
  return (
    <section className={`power-primer-band${selected ? " is-selected" : ""}`} aria-label="Power primer">
      <div style={{ minWidth: 0 }}>
        <div className="workout-eyebrow" style={{ color: C.orange }}>Before the main session</div>
        <div className="power-primer-title">Power Primer</div>
        <div className="power-primer-copy">
          {workout.exercises.length} low-volume movements for speed, coordination, and readiness.
        </div>
      </div>
      <button type="button" className="secondary-workout-button" onClick={onSelect}>
        {selected ? "Selected" : "View primer"}
      </button>
    </section>
  );
}
