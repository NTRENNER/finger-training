// ─────────────────────────────────────────────────────────────
// UI THEME
// ─────────────────────────────────────────────────────────────
// Color palette and base typography. Single source of truth for the
// dark-mode palette consumed throughout the React tree as the `C` import.
//
// Conventions: bg = page background, card = elevated surface, border =
// hairlines, text = primary, muted = secondary. Accent colors map to
// semantic roles in chart/badge code:
//   blue   = informational / Endurance zone / Critical Force
//   green  = positive (success, gains, completed reps)
//   red    = negative / Power zone / failure
//   orange = warning / Strength zone / W' (anaerobic capacity)
//   purple = primary brand accent / three-exp curve / brand badges
//   yellow = highlight / diagnostic accents
export const C = {
  bg:      "#0d1117",
  card:    "#161b22",
  border:  "#30363d",
  text:    "#e6edf3",
  muted:   "#8b949e",
  blue:    "#58a6ff",
  green:   "#3fb950",
  red:     "#f85149",
  orange:  "#f0883e",
  purple:  "#bc8cff",
  yellow:  "#e3b341",
};

// Base body styles applied to the App root.
export const base = {
  fontFamily: "'Segoe UI', system-ui, sans-serif",
  color: C.text,
  background: C.bg,
  minHeight: "100vh",
  padding: "0",
  margin: "0",
};
