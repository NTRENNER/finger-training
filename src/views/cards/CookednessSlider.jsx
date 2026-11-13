// Retrospective session rating. Each session keeps its own rating
// (reps.session_cooked), so a fresh warm-up and a cooked session after
// climbing on the same day stay separate. Days rated before ratings moved
// to sessions show that day rating until the session is given its own.
// New sessions retain a separate immutable adjustment snapshot; rating
// edits do not rewrite that snapshot.
import React, { useState, useEffect } from "react";
import { C } from "../../ui/theme.js";

export function CookednessSlider({
  sessionValue,        // this session's own rating (number | null)
  dayValue = null,     // legacy daily_state.cooked for this date (number | null)
  onSave,              // (cooked|null) => void — writes this session only
}) {
  const effective = sessionValue ?? dayValue;
  const draftFloor = effective ?? 0;

  // Draft state mirrors the slider during drag. Commit on release so
  // the curve fit rebuilds once per gesture, not per pixel.
  const [draft, setDraft] = useState(draftFloor);
  useEffect(() => { setDraft(draftFloor); }, [draftFloor]);

  const commit = () => onSave(draft ?? 0);

  return (
    <div style={{
      marginTop: 14, paddingTop: 12,
      borderTop: `1px solid ${C.border}`,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
        <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5 }}>
          Cookedness
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: effective != null ? C.purple : C.muted }}>
            {effective != null ? `${draft}/10` : "unset"}
          </div>
        </div>
      </div>
      <input
        type="range"
        aria-label="Session fatigue rating"
        min="0" max="10" step="1"
        value={draft}
        onChange={(e) => setDraft(Number(e.target.value))}
        onMouseUp={commit}
        onTouchEnd={commit}
        style={{ width: "100%", accentColor: C.purple }}
      />
      {sessionValue != null && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
          <button onClick={() => onSave(null)} style={linkStyle}>clear</button>
        </div>
      )}
      <div style={{ fontSize: 10, color: C.muted, marginTop: 6, lineHeight: 1.4, fontStyle: "italic" }}>
        Higher = more cooked. Changing this rating records how you felt;
        it does not change your recorded loads or future recommendations.
      </div>
    </div>
  );
}

const linkStyle = {
  background: "none", border: "none", color: C.muted,
  fontSize: 11, cursor: "pointer", padding: 0,
  textDecoration: "underline",
};
