// ─────────────────────────────────────────────────────────────
// CookednessSlider — retroactive per-day cookedness editor
// ─────────────────────────────────────────────────────────────
// 0–10 integer slider with a "clear" link for the unset state.
// Local "draft" state lets the slider move smoothly during a drag
// without writing to LS + cloud on every pixel; we commit once on
// mouseup / touchend so the curve-fit pipeline rebuilds per gesture
// instead of per frame.
//
// Per-day, not per-session — multiple finger sessions on the same
// date share one cookedness value. The header always shows the date
// so the user understands what they're editing even when this card
// is rendered inside a per-session context (AnalysisView's session-
// detail modal, HistoryView's per-session cards).
//
// Lives in src/views/cards/ rather than next to a specific consumer
// so both modal + history surfaces can import the same component
// without one importing from the other.

import React, { useState, useEffect } from "react";
import { C } from "../../ui/theme.js";

export function CookednessSlider({ date, value, onChange }) {
  // Draft state mirrors the slider during drag. Sync down from the
  // committed `value` whenever it changes externally (e.g. another
  // device pushed an update, or the user just opened a different
  // session that lives on the same date and triggered a re-read).
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);

  const committed = value ?? null;
  const draftN = draft ?? 0;

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
          <div style={{ fontSize: 16, fontWeight: 800, color: committed != null ? C.purple : C.muted }}>
            {committed != null ? `${draftN}/10` : "unset"}
          </div>
          {committed != null && (
            <button
              onClick={() => onChange(null)}
              title="Clear retroactive cookedness — treat as fresh"
              style={{
                background: "none", border: "none", color: C.muted,
                fontSize: 11, cursor: "pointer", padding: 0,
                textDecoration: "underline",
              }}
            >clear</button>
          )}
        </div>
      </div>
      <input
        type="range"
        min="0" max="10" step="1"
        value={draftN}
        onChange={(e) => setDraft(Number(e.target.value))}
        onMouseUp={() => onChange(draft ?? 0)}
        onTouchEnd={() => onChange(draft ?? 0)}
        style={{ width: "100%", accentColor: C.purple }}
      />
      <div style={{ fontSize: 11, color: C.muted, marginTop: 4, lineHeight: 1.4 }}>
        Tag external fatigue you forgot to declare (climbing, sleep deficit, etc.).
        Higher = more cooked — the curve fit treats this day's reps as their
        fresh-equivalent so future prescriptions don't drift down.
      </div>
    </div>
  );
}
