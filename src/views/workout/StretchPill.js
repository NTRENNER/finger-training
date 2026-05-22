// ─────────────────────────────────────────────────────────────
// StretchPill — daily-habit toggle for hip + forearm mobility
// ─────────────────────────────────────────────────────────────
// Renders full-width below the A/B/C picker. Click = toggle: if
// today doesn't yet have a STRETCH session, log a marker session;
// if it does, remove it. Reversible-forever beats a confirm step
// for a low-stakes habit tracker — an accidental tap is fixed by
// tapping again, and the pill's visible state change makes the
// accident immediately obvious.
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
// The component is presentation-only: parent owns the toggle handler
// and reads/writes the workout log. This keeps the pill testable in
// isolation and makes the pull-trigger explicit in WorkoutTab.

import React from "react";
import { C } from "../../ui/theme.js";

export function StretchPill({ done, daysSince, onToggle }) {
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
      onClick={onToggle}
      style={{
        width: "100%",
        padding: "10px 14px",
        marginBottom: 12,
        background: pillBg,
        border: `1px solid ${accent}`,
        borderRadius: 8,
        cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        textAlign: "left",
      }}
      // The toggle is the whole point — a hover hint keeps the
      // tap behavior discoverable without an inline icon.
      title={done ? "Tap to un-log today's stretch" : "Tap to log today's stretch"}
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
        {done ? "✓" : "Tap to log"}
      </div>
    </button>
  );
}
