// ─────────────────────────────────────────────────────────────
// StretchPill — daily-habit selector for hip + forearm mobility
// ─────────────────────────────────────────────────────────────
// Renders full-width below the A/B/C picker. Tapping the pill selects
// STRETCH as today's workout — the card below the picker then renders
// the stretch exercise list, mirroring the A/B/C preview flow. Logging
// the marker is moved to the green button inside that card so "view"
// and "log" are two separate, unambiguous actions. (Earlier design
// tap-to-log directly here, but it hid the actual exercises behind
// the toggle — users had to leave the app to remember what to do.)
//
// Color state communicates staleness without prompting:
//   green  — done today
//   gray   — done yesterday or day before (still fresh)
//   yellow — 3–5 days since last stretch
//   orange — 6+ days since last stretch
// "Days since" is read from the workout log directly; we don't go
// through the recommender's tagDays plumbing for this because we
// want to count STRETCH marker sessions specifically, not anything
// that happens to carry a mobility tag.
//
// The `selected` prop adds a thicker accent border when STRETCH is
// the currently-active workout — matches the visual weight of the
// A/B/C picker tiles when they're picked.
//
// The component is presentation-only: parent owns the select handler
// and reads/writes the workout log. This keeps the pill testable in
// isolation and makes the data path explicit in WorkoutTab.

import React from "react";
import { C } from "../../ui/theme.js";

export function StretchPill({ done, daysSince, selected = false, onSelect }) {
  // Color band: green when done today, gray when fresh, yellow at
  // mid-staleness, orange at high. Thresholds matched to the
  // literature's "every few days is fine, weekly is not" — yellow
  // appears around the threshold where adaptation starts to drift
  // back; orange when you'd notice the lost range in climbing.
  let accent = C.muted;
  let pillBg = "transparent";
  let textColor = C.muted;
  if (done) {
    accent = C.green;
    pillBg = `${C.green}22`;
    textColor = C.green;
  } else if (daysSince == null || daysSince >= 6) {
    // Never logged or 6+ days stale → orange. "Never" reads as
    // infinitely stale; we'd rather show the warning color than
    // pretend a brand-new user is on top of mobility.
    accent = C.orange;
    pillBg = `${C.orange}1a`;
    textColor = C.orange;
  } else if (daysSince >= 3) {
    accent = C.yellow;
    pillBg = `${C.yellow}1a`;
    textColor = C.yellow;
  }

  const subtitle = done
    ? "Done today ✓"
    : daysSince == null
      ? "Never logged"
      : daysSince === 0
        ? "Last: earlier today"
        : daysSince === 1
          ? "Last: yesterday"
          : `Last: ${daysSince}d ago`;

  return (
    <button
      onClick={onSelect}
      style={{
        width: "100%",
        padding: "10px 14px",
        marginBottom: 12,
        background: pillBg,
        // Thicker border + outline when selected so the pill reads as
        // "this is what's loaded in the card below" — matches the
        // visual weight of the A/B/C picker tiles when they're picked.
        border: `${selected ? 2 : 1}px solid ${accent}`,
        outline: selected ? `1px solid ${accent}` : "none",
        outlineOffset: selected ? -3 : 0,
        borderRadius: 8,
        cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        textAlign: "left",
      }}
      title={selected ? "Selected — log via the button below" : "Tap to view today's stretches"}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: textColor, letterSpacing: 0.3 }}>
          Daily Stretching
        </div>
        <div style={{ fontSize: 11, color: textColor, opacity: 0.85 }}>
          {subtitle}
        </div>
      </div>
      <div style={{
        fontSize: 11, fontWeight: 700, color: textColor,
        padding: "3px 8px", borderRadius: 4,
        border: `1px solid ${accent}`,
        textTransform: "uppercase", letterSpacing: 0.5,
      }}>
        {done ? "✓" : "View"}
      </div>
    </button>
  );
}
