// Retrospective day and session ratings. New sessions retain a separate
// immutable adjustment snapshot; diary edits do not rewrite that snapshot.
import React, { useState, useEffect } from "react";
import { C } from "../../ui/theme.js";

export function CookednessSlider({
  date,
  dayValue,            // daily_state.cooked for this date (number | null)
  sessionValue,        // session-specific override (number | null)
  onSaveDay,           // (cooked|null) => void
  onSaveSessionOverride, // (cooked|null) => void  — null clears the override
}) {
  // The slider always edits the EFFECTIVE value (whichever scope is
  // currently active). Mode flips between "day" (default) and
  // "session" (override). Initial mode is "session" iff a session
  // override is already set — opening an overridden session lands
  // in session mode so the displayed value matches what's being
  // edited if the user moves the slider.
  const hasOverride = sessionValue != null;
  const [mode, setMode] = useState(hasOverride ? "session" : "day");

  const effective = mode === "session" ? sessionValue : dayValue;
  const draftFloor = effective ?? 0;

  // Draft state mirrors the slider during drag. Commit on release so
  // the curve fit rebuilds once per gesture, not per pixel.
  const [draft, setDraft] = useState(draftFloor);
  useEffect(() => { setDraft(draftFloor); }, [draftFloor, mode]);

  const commit = () => {
    const v = draft ?? 0;
    if (mode === "session") onSaveSessionOverride(v);
    else onSaveDay(v);
  };

  const statusLine = mode === "session"
    ? "Editing this session's rating" : "Editing your day rating";
  const scopeToggle = (
    <button onClick={() => setMode(mode === "day" ? "session" : "day")} style={linkStyle}>
      {mode === "day" ? "Rate this session separately" : "Edit day rating"}
    </button>
  );

  // Clear action — meaning depends on mode.
  const clearLink = (() => {
    if (mode === "session" && hasOverride) {
      return (
        <button
          onClick={() => onSaveSessionOverride(null)}
          style={linkStyle}
        >clear session rating</button>
      );
    }
    if (mode === "day" && dayValue != null) {
      return (
        <button
          onClick={() => onSaveDay(null)}
          style={linkStyle}
        >clear day</button>
      );
    }
    return null;
  })();

  return (
    <div style={{
      marginTop: 14, paddingTop: 12,
      borderTop: `1px solid ${C.border}`,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
        <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5 }}>
          Cookedness on {date}
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: effective != null ? C.purple : C.muted }}>
            {effective != null ? `${draft}/10` : "unset"}
          </div>
        </div>
      </div>
      <input
        type="range"
        aria-label={mode === "session" ? "Session fatigue rating" : "Day fatigue rating"}
        min="0" max="10" step="1"
        value={draft}
        onChange={(e) => setDraft(Number(e.target.value))}
        onMouseUp={commit}
        onTouchEnd={commit}
        style={{ width: "100%", accentColor: C.purple }}
      />
      <div style={{
        fontSize: 11, color: C.muted, marginTop: 4, lineHeight: 1.4,
        display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap",
      }}>
        <span style={{ flex: 1, minWidth: 0 }}>{statusLine}</span>
        <span style={{ display: "flex", gap: 10, flexShrink: 0 }}>
          {clearLink}
          {scopeToggle}
        </span>
      </div>
      <div style={{ fontSize: 10, color: C.muted, marginTop: 6, lineHeight: 1.4, fontStyle: "italic" }}>
        Higher = more cooked. The curve fit treats this session's reps as
        their fresh-equivalent so future fresh prescriptions don't drift down.
      </div>
    </div>
  );
}

const linkStyle = {
  background: "none", border: "none", color: C.muted,
  fontSize: 11, cursor: "pointer", padding: 0,
  textDecoration: "underline",
};
