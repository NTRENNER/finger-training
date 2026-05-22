// ─────────────────────────────────────────────────────────────
// WORKOUT TAB CONSTANTS
// ─────────────────────────────────────────────────────────────
// Two small color/label maps shared across the workout-tab cards.
// Kept together because the picker, recommendation card, type
// badge, and stretch pill all consume one or both.

import { C } from "../../ui/theme.js";

// Exercise-type badge palette.
// S = Strength, H = Hypertrophy / mobility, P = Power, X = Stretch.
// Matches the legacy palette so the badge color is consistent if
// you compare old + new sessions side by side in History.
export const WTYPE_META = {
  S: { label: "S", color: C.blue,   bg: C.blue   + "22" },
  H: { label: "H", color: C.purple, bg: C.purple + "22" },
  P: { label: "P", color: C.orange, bg: C.orange + "22" },
  X: { label: "X", color: C.muted,  bg: C.border          },
};

// Workout ID accent colors. The recommendation card and the picker
// buttons use these so the active workout has a consistent visual
// identity across surfaces. After the May 2026 rename, "C" inherits
// the green that used to belong to D (so the new C — the neural
// strength touch — keeps its visual identity), and STRETCH gets the
// purple slot that the dropped mobility C used to occupy.
export const WORKOUT_COLORS = {
  A: C.blue,
  B: C.orange,
  C: C.green,
  STRETCH: C.purple,
  CLIMB: "#e05560",
  REST: C.muted,
};
