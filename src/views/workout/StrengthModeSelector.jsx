import React from "react";
import { C } from "../../ui/theme.js";
import { WORKOUT_MODES } from "../../model/workoutProgram.js";

export function StrengthModeSelector({ mode, onChange }) {
  return (
    <section aria-label="Weekly strength frequency" className="strength-mode-section">
      <div className="workout-section-heading">
        <div>
          <div className="workout-eyebrow">Weekly strength</div>
          <div className="workout-section-title">Choose the dose that fits this training phase</div>
        </div>
        <div className="strength-day-count">{WORKOUT_MODES[mode]?.days || 2} day{WORKOUT_MODES[mode]?.days === 1 ? "" : "s"}</div>
      </div>
      <div className="strength-mode-grid">
        {Object.values(WORKOUT_MODES).map(option => {
          const selected = option.id === mode;
          return (
            <button
              type="button"
              key={option.id}
              aria-pressed={selected}
              onClick={() => onChange(option.id)}
              className={`strength-mode-button${selected ? " is-selected" : ""}`}
            >
              <span className="strength-mode-label">{option.days} · {option.label}</span>
              <span className="strength-mode-description">{option.description}</span>
            </button>
          );
        })}
      </div>
      <div className="strength-mode-note" style={{ color: C.muted }}>
        The recommendation rotates through the strength days included in this mode.
      </div>
    </section>
  );
}
