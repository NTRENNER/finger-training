// ─────────────────────────────────────────────────────────────
// SHARED UI COMPONENTS
// ─────────────────────────────────────────────────────────────
// Visual primitives shared across all views — Card surface, Btn
// button, Sect section header, Label form-field label. Theme colors
// come from src/ui/theme.js. No state; pure presentation.

import React from "react";
import { C } from "./theme.js";

// Elevated card surface — the default content container in every view.
export function Card({ children, style }) {
  return (
    <div style={{
      background: C.card, border: `1px solid ${C.border}`,
      borderRadius: 12, padding: "20px 24px", marginBottom: 16,
      ...style,
    }}>
      {children}
    </div>
  );
}

// Primary action button. `color` overrides the brand blue. `small` opts
// into a tighter padding/font for inline use. `disabled` greys out and
// blocks click.
export function Btn({ children, onClick, color = C.blue, disabled, style, small }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: disabled ? C.border : color,
        color: "#fff", border: "none", borderRadius: 8,
        padding: small ? "6px 14px" : "10px 22px",
        fontSize: small ? 13 : 15, fontWeight: 600,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "opacity 0.15s",
        ...style,
      }}
    >
      {children}
    </button>
  );
}

// Form-field label — small caps muted text above an input.
export function Label({ children }) {
  return (
    <div style={{
      fontSize: 12, color: C.muted, marginBottom: 4,
      textTransform: "uppercase", letterSpacing: "0.05em",
    }}>{children}</div>
  );
}

// Section divider with a small-caps title — used inside Cards to group
// related fields with a thin underline.
//
// Header convention across the app — two tiers, intentionally distinct:
//
//   1. Card title (14px / 700, normal case) — top-of-card primary
//      heading. Examples: "Coaching prescription · Crusher",
//      "Zone Workout Summary", "🗓 Session Planner". Inline div, no
//      Sect wrapper. There's only ever ONE per Card.
//
//   2. Subsection (Sect, 11px / 700 uppercase, muted, underline) —
//      groups related fields inside a Card. Examples: "Within Set",
//      "Between Sets", "Grip Type". Use Sect for ALL of these so
//      they share the same visual weight; new subsections that are
//      tempted to inline an 11px uppercase div should reach for
//      Sect instead.
//
// The 11px uppercase pattern ALSO shows up as an "eyebrow" above a
// large title (e.g. "NEXT SESSION FOCUS" above "Train Power" on the
// AnalysisView coaching cards). That's a different role — it's
// labeling the card itself, not a subsection inside it — so it
// stays inline rather than using Sect (which would draw an unwanted
// underline below the eyebrow).
export function Sect({ title, children }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{
        fontSize: 11, color: C.muted, textTransform: "uppercase",
        letterSpacing: "0.08em", marginBottom: 10, paddingBottom: 6,
        borderBottom: `1px solid ${C.border}`,
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}
