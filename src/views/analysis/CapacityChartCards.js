// ─────────────────────────────────────────────────────────────
// CAPACITY CHART CARDS — Total Capacity (AUC) trajectory
// ─────────────────────────────────────────────────────────────
// <CapacityTrajectoryCard> — % vs baseline, per-grip, with a
//   3-session rolling-mean trend line over the raw points. The
//   headline trajectory card; renders right under Curve Improvement
//   in Analysis so the user pivots from "where the gains came from"
//   (zones) to "when they showed up" (over time).
//
// (CapacityAbsoluteCard — raw kg·s sibling — was dropped May 2026:
//  magnitude is already visible on the F-D chart and Strength Balance
//  card, the kg·s axis unit is opaque, and the % version tells the
//  actual training-progress story.)
//
// Extracted from AnalysisView May 2026 (decomp pass).
//
// Inputs (props):
//   aucHistoryByGrip — {
//     grips: ["Micro", "Crusher"],
//     hasPct: boolean,            // % rows have post-baseline data
//     pctRows: [...],             // raw % per session
//     pctRowsBW: [...],           // same, normalized to BW
//     absRows: [...],             // absolute kg·s per session
//   }
//   normalizeOn — bool (CapacityTrajectoryCard only) — render BW-
//                 normalized rows instead of raw % when true.

import React from "react";
import {
  ResponsiveContainer, LineChart, Line,
  XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine,
} from "recharts";
import { C } from "../../ui/theme.js";
import { Card } from "../../ui/components.js";
import { GRIP_COLORS } from "../../ui/grip-colors.js";

export function CapacityTrajectoryCard({ aucHistoryByGrip, normalizeOn }) {
  if (!aucHistoryByGrip || !aucHistoryByGrip.hasPct) return null;

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>
        Total Capacity (Area Under the Curve) — % vs baseline
        {normalizeOn && <span style={{ color: C.purple, fontSize: 12, marginLeft: 6 }}>· × BW</span>}
      </div>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>
        {normalizeOn
          ? "Same metric, normalized to bodyweight at each session date. Bold line is a 3-session rolling mean to read trend through noise; dots are the raw per-session values."
          : "Same metric as a percentage above each grip's baseline. Bold line is a 3-session rolling mean to read trend through noise; dots are the raw per-session values."}
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={normalizeOn ? aucHistoryByGrip.pctRowsBW : aucHistoryByGrip.pctRows} margin={{ top: 6, right: 14, bottom: 28, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
          <XAxis dataKey="date" tick={{ fill: C.muted, fontSize: 9 }} angle={-30} textAnchor="end" interval="preserveStartEnd"
            label={{ value: "Date", position: "insideBottom", offset: -18, fill: C.muted, fontSize: 11 }} />
          <ReferenceLine y={0} stroke={C.muted} strokeWidth={2}
            label={{ value: "baseline", position: "insideRight", fill: C.muted, fontSize: 10 }} />
          <YAxis tick={{ fill: C.muted, fontSize: 11 }} width={48} unit="%"
            label={{ value: "vs baseline", angle: -90, position: "insideLeft", fill: C.muted, fontSize: 11 }} />
          <Tooltip
            contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }}
            formatter={(val, name) => [val == null ? "—" : `${val >= 0 ? "+" : ""}${val}%`, name]}
          />
          {aucHistoryByGrip.grips.flatMap(g => {
            const color = GRIP_COLORS[g] || C.blue;
            return [
              // Raw values: dots only, no connecting line.
              <Line key={`${g}_raw`} dataKey={`${g}_pct`} stroke="none"
                dot={{ r: 3, fill: color, stroke: color }} activeDot={{ r: 4 }}
                legendType="none" name={`${g} (raw)`} isAnimationActive={false} />,
              // Smoothed trend: bold line, no dots.
              <Line key={`${g}_sm`} dataKey={`${g}_pct_sm`} stroke={color}
                strokeWidth={3} dot={false} connectNulls name={g}
                isAnimationActive={false} />,
            ];
          })}
        </LineChart>
      </ResponsiveContainer>
      <div style={{ display: "flex", justifyContent: "space-around", marginTop: 4, fontSize: 10, color: C.muted }}>
        {aucHistoryByGrip.grips.map(g => (
          <span key={g} style={{ color: GRIP_COLORS[g] || C.blue }}>━ {g}</span>
        ))}
      </div>
    </Card>
  );
}

