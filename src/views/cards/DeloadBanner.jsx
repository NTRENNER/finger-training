// ─────────────────────────────────────────────────────────────
// DeloadBanner — surfaces the deload detector + the weekly plan
// ─────────────────────────────────────────────────────────────
// Two modes:
//   • PROPOSE — the detector fired this session. Shows the evidence
//     (why) + the weekly plan (action), with "Start deload week"
//     (strong only) and "Dismiss".
//   • ACTIVE  — the user accepted a deload week. Shows "DAY N OF 7" +
//     the plan + a live finger-session counter, with "End early".
//
// Detect → explain → PROPOSE → (on accept) a week-scoped REMINDER. It
// caps volume via guidance, not by silently scaling prescribed loads —
// the recovery comes from less volume, not easier sessions. Renders
// null when there's nothing to show.

import React, { useState } from "react";
import { C } from "../../ui/theme.js";

const accentFor = (sev) => (sev === "strong" ? C.orange : C.yellow);

function Wrap({ accent, children }) {
  return (
    <div style={{
      border: `1px solid ${accent}`,
      background: `${accent}14`,
      borderRadius: 10,
      padding: "12px 14px",
      marginBottom: 16,
      display: "flex",
      gap: 12,
      alignItems: "flex-start",
    }}>
      <span style={{ color: accent, fontSize: 14, lineHeight: "20px", marginTop: 1 }}>●</span>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}

const btn = (color) => ({
  background: "none", border: `1px solid ${color}`, color,
  cursor: "pointer", fontSize: 11.5, fontWeight: 600,
  padding: "4px 10px", borderRadius: 6,
});
const linkBtn = { background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 11.5, padding: "4px 2px" };

export function DeloadBanner({
  deload,            // computeDeload() result (propose mode)
  guidance,          // buildDeloadGuidance() result — action text + counts
  weekActive = false,
  dayOfWeek = 1,
  onStartWeek,
  onEndWeek,
}) {
  const [dismissed, setDismissed] = useState(false);

  // ACTIVE deload week — persists regardless of the live detector.
  if (weekActive && guidance) {
    const accent = accentFor(guidance.severity);
    return (
      <Wrap accent={accent}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, color: accent, marginBottom: 4 }}>
          DELOAD WEEK · DAY {dayOfWeek} OF 7
        </div>
        <div style={{ fontSize: 12.5, color: C.text, lineHeight: 1.5 }}>{guidance.action}</div>
        <div style={{ marginTop: 8 }}>
          <button onClick={onEndWeek} style={linkBtn}>End deload week</button>
        </div>
      </Wrap>
    );
  }

  // PROPOSE — detector fired this session.
  if (!deload || !deload.deload || dismissed) return null;
  const accent = accentFor(deload.severity);
  const strong = deload.severity === "strong";
  return (
    <Wrap accent={accent}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, color: accent, marginBottom: 4 }}>
        {strong ? "DELOAD SUGGESTED" : "FATIGUE BUILDING"}
      </div>
      <div style={{ fontSize: 12.5, color: C.text, lineHeight: 1.5 }}>{deload.why}</div>
      {guidance && (
        <div style={{ fontSize: 12.5, color: C.text, lineHeight: 1.5, marginTop: 6 }}>{guidance.action}</div>
      )}
      <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center" }}>
        {strong && onStartWeek && (
          <button onClick={onStartWeek} style={btn(accent)}>Start deload week</button>
        )}
        <button onClick={() => setDismissed(true)} style={linkBtn}>Dismiss</button>
      </div>
    </Wrap>
  );
}
