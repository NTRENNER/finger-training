// ─────────────────────────────────────────────────────────────
// ENERGY SYSTEM BREAKDOWN CARD
// ─────────────────────────────────────────────────────────────
// One row per zone (Power / Strength / Endurance) showing
// fail-rate as a horizontal bar plus the underlying energy
// system label and tau constant. The displayed shape comes from
// the parent's `zones` useMemo (computed off the filtered reps),
// which already carries label / color / system / tau / total /
// failures / failRate / desc per zone.
//
// Empty zones still render — they fall back to "No data" with a
// small "Add X hangs to characterise this system" hint, so users
// see WHICH zone is unrepresented instead of a missing row.
//
// Pure props in / JSX out — extracted from AnalysisView to keep
// that file under control. The `zones` shape is documented in
// the AnalysisView's useMemo where it's built.

import React from "react";
import { C } from "../../ui/theme.js";
import { Card } from "../../ui/components.js";

export function EnergySystemBreakdownCard({ zones }) {
  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>Energy System Breakdown</div>
      {Object.entries(zones).map(([, z]) => (
        <div key={z.label} style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 5 }}>
            <span>
              <span style={{ color: z.color, fontWeight: 700 }}>{z.label}</span>
              <span style={{ color: C.muted }}> · {z.system} · {z.tau}</span>
            </span>
            <span style={{ color: C.muted }}>
              {z.total === 0 ? "No data" : `${z.failures} fail / ${z.total} total`}
            </span>
          </div>
          <div style={{ height: 10, background: C.border, borderRadius: 5, overflow: "hidden" }}>
            {z.failRate !== null && (
              <div style={{ height: "100%", width: `${z.failRate * 100}%`, background: z.color, borderRadius: 5, transition: "width 0.4s" }} />
            )}
          </div>
          {z.total === 0 && (
            <div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>
              Add {z.desc} hangs to characterise this system.
            </div>
          )}
        </div>
      ))}
    </Card>
  );
}
