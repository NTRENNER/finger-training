// ─────────────────────────────────────────────────────────────
// DeloadBanner — surfaces the deload detector's proposal on Setup
// ─────────────────────────────────────────────────────────────
// Detect → explain → PROPOSE only. The banner shows computeDeload()'s
// why-string and severity; it does NOT regulate load automatically —
// the user reads the suggestion and decides (auto-regulation is a
// deliberate follow-up). Renders null when there's no deload or the
// user has dismissed it for the session.
//
// Severity → accent: strong = orange (warning), mild = yellow (early
// signal). Matches the theme's accent palette; no emoji, consistent
// with the rest of the app's chrome.

import React, { useState } from "react";
import { C } from "../../ui/theme.js";

export function DeloadBanner({ deload }) {
  const [dismissed, setDismissed] = useState(false);
  if (!deload || !deload.deload || dismissed) return null;

  const strong = deload.severity === "strong";
  const accent = strong ? C.orange : C.yellow;
  const label = strong ? "DELOAD SUGGESTED" : "FATIGUE BUILDING";

  return (
    <div style={{
      border: `1px solid ${accent}`,
      background: `${accent}14`,            // ~8% accent tint
      borderRadius: 10,
      padding: "12px 14px",
      marginBottom: 16,
      display: "flex",
      gap: 12,
      alignItems: "flex-start",
    }}>
      <span style={{ color: accent, fontSize: 14, lineHeight: "20px", marginTop: 1 }}>●</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 11, fontWeight: 700, letterSpacing: 0.4,
          color: accent, marginBottom: 4,
        }}>
          {label}
        </div>
        <div style={{ fontSize: 12.5, color: C.text, lineHeight: 1.5 }}>
          {deload.why}
        </div>
      </div>
      <button
        onClick={() => setDismissed(true)}
        style={{
          background: "none", border: "none", color: C.muted,
          cursor: "pointer", fontSize: 12, padding: 0, flexShrink: 0,
        }}
        aria-label="Dismiss deload suggestion"
      >
        Dismiss
      </button>
    </div>
  );
}
