// ─────────────────────────────────────────────────────────────
// ENDURANCE CEILING CARD — % of peak sustainable for 3 minutes
// ─────────────────────────────────────────────────────────────
// Per-grip × per-hand readout of F(180s) / F(5s) from the three-exp
// curve. Maps to the climbing question "what fraction of my crimp
// peak can I hold long enough to finish a route?" — same intuition
// CMF/peak gave under the old Monod model, pulled from the three-exp
// curve so the metric matches what every other surface uses.
//
// Benchmarks (climbing literature, ballpark):
//   <30%  needs endurance work
//   30–40 typical
//   40–50 strong
//   >50   elite
//
// Inputs (props):
//   gripHandFits — { Grip: { L?, R?, pooled? } } where each value is
//                  a three-exp amps array (parent runs fitThreeExpAmps).
//                  Prefers per-hand when both exist; falls back to
//                  pooled labeled "Pooled".
//   unit         — display unit ("lbs" / "kg")
//
// Pure props in / Card out. No state, no effects.
//
// Extracted from AnalysisView May 2026 (decomp pass).

import React from "react";
import { C } from "../../ui/theme.js";
import { Card } from "../../ui/components.js";
import { fmtW } from "../../ui/format.js";
import { predForceThreeExp } from "../../model/threeExp.js";

// Per-grip color — kept local rather than imported from AnalysisView,
// matching the same pattern as OneRMPRCard and StrengthBalanceCard.
// Three keys, stable values; if the F-D chart's split mode ever
// drifts in color we'll catch it visually.
const GRIP_COLORS = { Micro: "#e05560", Crusher: C.orange, Prime: "#7c5cbf" };

// Reference times for the ratio. 5s = "peak strength" sample past
// contractile noise; 180s = "long climbing-relevant hold." The ratio
// is a single scalar per scope that summarizes the curve's shape
// between strength and endurance regimes.
const CEIL_PEAK_T = 5;
const CEIL_HOLD_T = 180;

export function EnduranceCeilingCard({ gripHandFits, unit }) {
  if (!gripHandFits || Object.keys(gripHandFits).length === 0) return null;

  const rows = [];
  for (const grip of Object.keys(gripHandFits)) {
    const entry = gripHandFits[grip];
    // Prefer per-hand when both hands have fits; else use pooled
    // labeled "pooled".
    const scopes = [];
    if (entry.L) scopes.push({ scope: "L", amps: entry.L });
    if (entry.R) scopes.push({ scope: "R", amps: entry.R });
    if (scopes.length === 0 && entry.pooled) scopes.push({ scope: "pooled", amps: entry.pooled });
    for (const { scope, amps } of scopes) {
      const peak = predForceThreeExp(amps, CEIL_PEAK_T);
      const hold = predForceThreeExp(amps, CEIL_HOLD_T);
      if (!(peak > 0) || !(hold > 0)) continue;
      rows.push({ grip, scope, peak, hold, ratio: hold / peak });
    }
  }
  if (rows.length === 0) return null;

  const classify = (r) => {
    if (r >= 0.50) return { color: C.green,  text: "Elite" };
    if (r >= 0.40) return { color: C.green,  text: "Strong" };
    if (r >= 0.30) return { color: C.yellow, text: "Typical" };
    return { color: C.orange, text: "Needs work" };
  };
  const scopeLabel = (scope) =>
    scope === "L" ? "Left" : scope === "R" ? "Right" : "Pooled";

  // Group rows by grip for cleaner presentation.
  const grouped = {};
  for (const r of rows) {
    if (!grouped[r.grip]) grouped[r.grip] = [];
    grouped[r.grip].push(r);
  }

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>
        Endurance Ceiling — % of peak sustainable for 3 min
      </div>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>
        F({CEIL_HOLD_T}s) ÷ F({CEIL_PEAK_T}s) from the three-exp curve. Higher = more of your max strength carries into long climbing-relevant durations.
      </div>
      {Object.keys(grouped).map(grip => (
        <div key={grip} style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: GRIP_COLORS[grip] || C.text, marginBottom: 4 }}>
            {grip}
          </div>
          {grouped[grip].map(({ scope, peak, hold, ratio }) => {
            const flag = classify(ratio);
            return (
              <div key={`${grip}-${scope}`} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "6px 0", borderBottom: `1px solid ${C.border}`,
              }}>
                <div>
                  <div style={{ fontSize: 12, color: C.text }}>{scopeLabel(scope)}</div>
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
                    Peak {fmtW(peak, unit)} · 3-min {fmtW(hold, unit)} {unit}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: flag.color }}>
                    {Math.round(ratio * 100)}%
                  </div>
                  <span style={{
                    fontSize: 10, fontWeight: 700, color: flag.color,
                    background: `${flag.color}1a`,
                    padding: "3px 8px", borderRadius: 4,
                    textTransform: "uppercase", letterSpacing: 0.5,
                    whiteSpace: "nowrap",
                  }}>{flag.text}</span>
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </Card>
  );
}
