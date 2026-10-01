// ─────────────────────────────────────────────────────────────
// VideoLink — small "▶ demo" link next to novel exercise names
// ─────────────────────────────────────────────────────────────
// Renders when an exercise carries a videoUrl and opens the
// movement demonstration in a new tab.

import React from "react";
import { C } from "../../ui/theme.js";

export function VideoLink({ href, label = "▶ demo", ariaLabel }) {
  return (
    <a
      href={href}
      aria-label={ariaLabel}
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
