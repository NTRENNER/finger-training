// ─────────────────────────────────────────────────────────────
// PRESCRIBED LOAD CARD — per-zone load table for the selected grip
// ─────────────────────────────────────────────────────────────
// Shows the anchored prescription (curve_shape × amplitude_anchor) at
// every zone's reference time for one grip, both hands. Tabular sibling
// of the F-D chart: same fit, expressed as discrete zone buckets.
// Highlights the zone the continuous engine would currently recommend
// so "what should I do next" maps to a specific cell.
//
// Rendered in two places — under the Recommended Session pick on Setup
// (in-the-moment context) and under the F-D chart on Analysis (reference
// view). Lives in src/views/cards/ so neither view imports from the
// other; both sibling views consume from a shared module.
//
// Replaces the historical CF+W'/T card retired with the Monod removal
// (May 2026). Three-exp is the only model now, so no shadow column.

import React, { useMemo } from "react";
import { C } from "../../ui/theme.js";
import { Card } from "../../ui/components.js";
import { fmtW } from "../../ui/format.js";
import { ZONE_KEYS } from "../../model/zones.js";
import { prescription } from "../../model/prescription.js";
import { coachingRecommendationContinuous } from "../../model/coaching.js";

export function PrescribedLoadCard({
  history, grip, freshMap, threeExpPriors, activities = [], unit, GOAL_CONFIG,
}) {
  const rec = useMemo(
    () => grip
      ? coachingRecommendationContinuous(history, grip, { freshMap, threeExpPriors, activities })
      : null,
    [history, grip, freshMap, threeExpPriors, activities]
  );
  const recommendedZone = rec?.zone;

  const rows = useMemo(() => {
    if (!grip) return null;
    return ZONE_KEYS.map(key => {
      const cfg = GOAL_CONFIG[key];
      if (!cfg) return null;
      const T = cfg.refTime;
      const pL = prescription(history, "L", grip, T, { freshMap, threeExpPriors });
      const pR = prescription(history, "R", grip, T, { freshMap, threeExpPriors });
      return {
        key, label: cfg.label, emoji: cfg.emoji, color: cfg.color, T,
        L: pL?.value ?? null,
        R: pR?.value ?? null,
        // Reliability — worse of the two hands. If either is
        // extrapolating, dim the row so the user knows the load is
        // a long reach past data.
        reliability:
          !pL && !pR ? null
          : pL?.reliability === "extrapolation" || pR?.reliability === "extrapolation" ? "extrapolation"
          : pL?.reliability === "marginal" || pR?.reliability === "marginal" ? "marginal"
          : "well-supported",
      };
    }).filter(Boolean);
  }, [history, grip, freshMap, threeExpPriors, GOAL_CONFIG]);

  if (!grip) return null;
  if (!rows || rows.every(r => r.L == null && r.R == null)) return null;

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>
        Prescribed Load — {grip}
      </div>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>
        Per-zone load at the curve's reference time, anchored to your most recent rep 1.
        Recommended zone is highlighted.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {rows.map(r => {
          const active = r.key === recommendedZone;
          const dim = r.reliability === "extrapolation";
          return (
            <div key={r.key} style={{
              padding: "10px 12px", borderRadius: 8,
              background: active ? r.color + "1a" : C.bg,
              border: `1px solid ${active ? r.color : C.border}`,
              opacity: dim ? 0.55 : 1,
            }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: r.color }}>
                  {r.emoji} {r.label}
                </div>
                <div style={{ fontSize: 10, color: C.muted }}>{r.T}s</div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5 }}>L</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: C.blue, lineHeight: 1 }}>
                    {r.L != null ? fmtW(r.L, unit) : "—"}
                  </div>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5 }}>R</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: C.blue, lineHeight: 1 }}>
                    {r.R != null ? fmtW(r.R, unit) : "—"}
                  </div>
                </div>
              </div>
              {r.reliability === "extrapolation" && (
                <div style={{ fontSize: 9, color: C.muted, marginTop: 4, fontStyle: "italic" }}>
                  extrapolating
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 10, color: C.muted, marginTop: 10, textAlign: "right" }}>
        values in {unit}
      </div>
    </Card>
  );
}
