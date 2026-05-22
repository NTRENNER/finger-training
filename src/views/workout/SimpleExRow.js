// ─────────────────────────────────────────────────────────────
// SimpleExRow — done checkbox + notes for non-loggable exercises
// ─────────────────────────────────────────────────────────────
// Used for exercises where numeric load tracking is the wrong
// shape: bodyweight, banded, time-based, mobility, explosive (med
// ball, jumps, skater bounds). Shows the exercise name, the
// prescription string, the intent paragraph, a done toggle, and
// an optional notes field for session-specific commentary
// ("red band today", "broad jump 2.3m best", etc).

import React from "react";
import { C } from "../../ui/theme.js";
import { WTypeBadge } from "./WTypeBadge.js";
import { VideoLink } from "./VideoLink.js";

export function SimpleExRow({ ex, done, notes, onToggle, onNotesChange, last }) {
  return (
    <div style={{
      padding: "12px 0",
      borderBottom: last ? "none" : `1px solid ${C.border}`,
      opacity: done ? 0.55 : 1,
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <WTypeBadge type={ex.type} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <div style={{ fontSize: 15, color: C.text }}>{ex.name}</div>
              {ex.videoUrl && <VideoLink href={ex.videoUrl} />}
            </div>
            <div style={{ fontSize: 12, color: C.muted, whiteSpace: "nowrap" }}>{ex.prescription}</div>
          </div>
          {ex.intent ? (
            <div style={{ fontSize: 12, color: C.muted, marginTop: 4, lineHeight: 1.4 }}>{ex.intent}</div>
          ) : null}
          <input
            value={notes || ""}
            onChange={e => onNotesChange?.(e.target.value)}
            placeholder="Notes (band, distance, weight…)"
            style={{
              marginTop: 8, width: "100%",
              background: C.bg, border: `1px solid ${C.border}`,
              color: C.text, borderRadius: 6, padding: "5px 8px", fontSize: 12,
            }}
          />
        </div>
        <button onClick={onToggle} style={{
          width: 28, height: 28, borderRadius: "50%", flexShrink: 0,
          background: done ? C.green : "transparent",
          border: `2px solid ${done ? C.green : C.border}`,
          color: done ? "#000" : C.muted,
          cursor: "pointer", fontSize: 12, display: "flex",
          alignItems: "center", justifyContent: "center",
        }}>{done ? "✓" : ""}</button>
      </div>
    </div>
  );
}
