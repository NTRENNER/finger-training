// ─────────────────────────────────────────────────────────────
// STRENGTH BALANCE CARD — open-hand vs crimp dominance
// ─────────────────────────────────────────────────────────────
// Per-hand ratio of Crusher (open-hand, FDP-loaded) to Micro (small
// edge, FDS-loaded) force at 10s. The badge classifies the CURRENT
// ratio by deviation from the USER'S OWN median ratio (the "personal
// baseline"), NOT against literature-anchored absolute bands.
//
// Why personal baseline: the Tindeq Micro implement is much smaller
// than the ~8-10mm edges literature bands assume. For very small
// probes the natural ratio runs higher than the bands suggest, just
// from contact-area geometry. Anchoring on the user's own median
// turns the metric into a trend signal ("am I drifting toward
// small-edge strength?") instead of a fixed-band judgment.
//
// Inputs (props):
//   gripHandFits    — { Crusher: { L, R, pooled }, Micro: { L, R, pooled } }
//                     where each value is a three-exp amps array.
//                     Parent (AnalysisView) computes via fitThreeExpAmps.
//   balanceHistory  — per-hand { current, median, count, delta } from
//                     parent useMemo over the cumulative historyOverlay.
//                     null when fewer than 1 shared (Crusher, Micro)
//                     date exists for that hand.
//   unit            — display unit ("lbs" / "kg")
//
// Pure props in / Card out. No state, no effects.
//
// Extracted from AnalysisView May 2026 (decomp pass) to shed weight.

import React from "react";
import { C } from "../../ui/theme.js";
import { Card } from "../../ui/components.js";
import { fmt1, fmtW } from "../../ui/format.js";
import { predForceThreeExp } from "../../model/threeExp.js";

// Per-grip color — kept local rather than imported from AnalysisView,
// matching the same pattern used by OneRMPRCard. Two keys, stable
// values; the maintenance cost of two copies is lower than the
// coupling cost of a shared module that exists only for this constant.
const GRIP_COLORS = { Crusher: C.orange, Micro: "#e05560" };

// Reference time for the ratio. 10s is a "near-peak" sample that's
// past contractile noise but still in the alactic / strength regime
// — it differentiates the grips on raw strength rather than endurance.
const BAL_T = 10;

export function StrengthBalanceCard({ gripHandFits, balanceHistory, unit }) {
  if (!gripHandFits?.Crusher || !gripHandFits?.Micro) return null;

  const rows = [];
  for (const hand of ["L", "R"]) {
    const cAmps = gripHandFits.Crusher[hand];
    const mAmps = gripHandFits.Micro[hand];
    if (!cAmps || !mAmps) continue;
    const cF = predForceThreeExp(cAmps, BAL_T);
    const mF = predForceThreeExp(mAmps, BAL_T);
    if (!(cF > 0) || !(mF > 0)) continue;
    rows.push({
      key: hand,
      label: hand === "L" ? "Left hand" : "Right hand",
      ratio: cF / mF, cF, mF,
      history: balanceHistory?.[hand] || null,
    });
  }
  if (rows.length === 0) {
    const cAmps = gripHandFits.Crusher.pooled;
    const mAmps = gripHandFits.Micro.pooled;
    if (cAmps && mAmps) {
      const cF = predForceThreeExp(cAmps, BAL_T);
      const mF = predForceThreeExp(mAmps, BAL_T);
      if (cF > 0 && mF > 0) {
        rows.push({ key: "pooled", label: "Pooled", ratio: cF / mF, cF, mF, history: null });
      }
    }
  }
  if (rows.length === 0) return null;

  // Personal-baseline classification: flag by deviation from YOUR
  // median. Negative delta = ratio dropping = small-edge strength
  // catching up (good). Positive delta = gap widening. Need ≥2 shared
  // dates before this becomes meaningful (a single data point makes
  // "median" trivially equal to current).
  const classify = (history) => {
    if (!history || history.count < 2 || history.delta == null) return null;
    const pct = history.delta * 100;
    if (pct <= -10) return { color: C.green,  text: "Small-edge gaining" };
    if (pct <=  -3) return { color: C.green,  text: "Trending good"      };
    if (pct <    3) return { color: C.muted,  text: "At your baseline"   };
    if (pct <   10) return { color: C.yellow, text: "Drifting up"        };
    return            { color: C.orange, text: "Gap widening"      };
  };

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>
        Open-hand vs Crimp dominance
      </div>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>
        Ratio of <span style={{ color: GRIP_COLORS.Crusher }}>Crusher</span> (open hand) to <span style={{ color: GRIP_COLORS.Micro }}>Micro</span> (crimp) force at {BAL_T}s. Edge geometry sets the natural baseline — a smaller Micro probe runs higher absolute ratios. We compare your current ratio against <b>your own median</b> over time; a dropping number means small-edge strength is catching up.
      </div>
      {rows.map(({ key, label, ratio, cF, mF, history }) => {
        const flag = classify(history);
        const deltaPct = history?.delta != null ? Math.round(history.delta * 100) : null;
        const deltaSign = deltaPct == null ? "" : deltaPct > 0 ? "+" : "";
        return (
          <div key={key} style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "8px 0", borderBottom: `1px solid ${C.border}`,
          }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{label}</div>
              <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
                Crusher {fmtW(cF, unit)} {unit} · Micro {fmtW(mF, unit)} {unit}
                {history && history.count >= 1 && (
                  <> · baseline <b style={{ color: C.text }}>{fmt1(history.median)}×</b> ({history.count} session{history.count === 1 ? "" : "s"})</>
                )}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: flag?.color || C.text }}>
                  {fmt1(ratio)}×
                </div>
                {deltaPct != null && (
                  <div style={{ fontSize: 10, color: flag?.color || C.muted, marginTop: 2 }}>
                    {deltaSign}{deltaPct}% vs baseline
                  </div>
                )}
              </div>
              {flag && (
                <span style={{
                  fontSize: 10, fontWeight: 700, color: flag.color,
                  background: `${flag.color}1a`,
                  padding: "3px 8px", borderRadius: 4,
                  textTransform: "uppercase", letterSpacing: 0.5,
                  whiteSpace: "nowrap",
                }}>{flag.text}</span>
              )}
            </div>
          </div>
        );
      })}
    </Card>
  );
}
