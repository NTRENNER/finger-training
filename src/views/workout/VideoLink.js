// ─────────────────────────────────────────────────────────────
// VideoLink — small "▶ demo" link next to novel exercise names
// ─────────────────────────────────────────────────────────────
// Renders when an exercise carries a videoUrl. Opens the source
// video (typically YouTube — Lattice, Climb Strong, Judd
// Lienhard) in a new tab. Only attached to exercises where the
// movement is novel enough that a 90-second demo beats reading
// the form cues (hard-style situp, banded chops, weighted
// pancake / leg lifts, supine frog, prone external rotation).
// Standard lifts (bench, pullup, dips) intentionally don't
// carry a videoUrl — a "demo" link there would feel condescending.

import React from "react";
import { C } from "../../ui/theme.js";

export function VideoLink({ href, label = "▶ demo" }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        fontSize: 11, fontWeight: 600, color: C.blue,
        textDecoration: "none",
        padding: "1px 6px", borderRadius: 4,
        border: `1px solid ${C.blue}55`,
        whiteSpace: "nowrap",
      }}
      onClick={e => e.stopPropagation()}
    >{label}</a>
  );
}
