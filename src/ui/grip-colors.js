// ─────────────────────────────────────────────────────────────
// GRIP_COLORS — canonical per-grip color map
// ─────────────────────────────────────────────────────────────
// Each grip type has a stable color that surfaces use to keep the
// palette consistent across charts, badges, and headlines (Capacity,
// Recovery, Strength Balance, OneRM PR, the F-D chart's split mode,
// the warm-up swap pill, etc.).
//
// Callers do their own fallback (`GRIP_COLORS[g] || C.blue` or
// `|| C.text`) so unknown grip keys don't blow up rendering.
//
// Was duplicated across six files until May 2026 — kept growing
// (and StrengthBalanceCard's copy only had two of the three keys,
// just barely working by accident). Centralized to prevent palette
// drift the next time a new grip type is added.

import { C } from "./theme.js";

export const GRIP_COLORS = {
  Micro:   "#e05560",
  Crusher: C.orange,
  Prime:   "#7c5cbf",
};

// Canonical per-hand color map. Used by the F-D scatter (dot fill),
// the Force Curves overlay (per-hand lines), the session-detail modal
// header, and the Hand Asymmetry rows. Lifted here so the F-D card
// extraction and AnalysisView's other consumers don't drift apart.
export const HAND_COLORS = { L: C.blue, R: C.yellow };
