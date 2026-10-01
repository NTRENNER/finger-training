// ─────────────────────────────────────────────────────────────
// WTypeBadge — small S/H/P/X chip rendered next to an exercise name
// ─────────────────────────────────────────────────────────────
// Color/label sourced from WTYPE_META. Unknown types fall back to
// the Strength palette rather than crashing.

import React from "react";
import { WTYPE_META } from "./workoutConstants.js";

export function WTypeBadge({ type }) {
  const meta = WTYPE_META[type] || WTYPE_META.S;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      width: 22, height: 22, borderRadius: 6, flexShrink: 0,
      fontSize: 11, fontWeight: 700, color: meta.color, background: meta.bg,
    }}>{meta.label}</span>
  );
}
