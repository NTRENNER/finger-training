// ─────────────────────────────────────────────────────────────
// RECOVERY TREND CARD — observed recovered fraction over time
// ─────────────────────────────────────────────────────────────
// Cross-session view of the per-session RecoveryChart's headline
// metric. Plots observed recovered fraction at rep 2 (the first
// inter-rep recovery measurement) per session over time, per grip.
// Answers "is my recovery improving over weeks/months?" — the
// question the per-session chart can't answer.
//
// Inputs (props):
//   history — full rep history (App-level state). Used to compute
//             the trend per grip via buildRecoveryTrend.
//   grips   — grips to plot (e.g. ["Crusher", "Micro"]). Each
//             grip gets its own line.
//
// Same chart-pattern as CapacityTrajectoryCard: raw dots + smoothed
// 3-session rolling mean, per-grip colors. Reference band at the
// 70-90% operating zone.

import React, { useMemo } from "react";
import {
  ResponsiveContainer, ComposedChart, Line,
  XAxis, YAxis, Tooltip, CartesianGrid, ReferenceArea, ReferenceLine,
} from "recharts";
import { C } from "../../ui/theme.js";
import { Card } from "../../ui/components.js";
import {
  buildRecoveryTrend, withRollingMean,
  OPERATING_LOW, OPERATING_HIGH, GAP_TARGET_REP,
} from "../../model/recoveryDynamics.js";

const GRIP_COLORS = { Micro: "#e05560", Crusher: C.orange, Prime: "#7c5cbf" };

export function RecoveryTrendCard({ history, grips = ["Crusher", "Micro"] }) {
  // Build per-grip trend series, then merge into a single recharts
  // data array indexed by date.
  const { merged, plottedGrips } = useMemo(() => {
    const perGrip = {};
    for (const g of grips) {
      const trend = withRollingMean(buildRecoveryTrend(history, g));
      if (trend.length > 0) perGrip[g] = trend;
    }
    const dates = [...new Set(
      Object.values(perGrip).flatMap(t => t.map(r => r.date))
    )].sort();
    const rows = dates.map(date => {
      const row = { date };
      for (const [g, t] of Object.entries(perGrip)) {
        const point = t.find(p => p.date === date);
        if (point) {
          row[`${g}_raw`] = point.observedAtTarget;
          row[`${g}_sm`]  = point.observedSmoothed;
        }
      }
      return row;
    });
    return { merged: rows, plottedGrips: Object.keys(perGrip) };
  }, [history, grips]);

  // Need at least 2 sessions on at least one grip to render a
  // meaningful trend. Single-point lines are just dots, useless.
  if (merged.length < 2 || plottedGrips.length === 0) return null;

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>
        Recovery Trend — rep {GAP_TARGET_REP} observed fraction
      </div>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>
        How much capacity comes back between rep 1 and rep 2, per session, per grip.
        Bold line is a 3-session rolling mean; dots are raw per-session values.
        Blue band marks the {Math.round(OPERATING_LOW * 100)}–{Math.round(OPERATING_HIGH * 100)}%
        well-calibrated rest zone.
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <ComposedChart data={merged} margin={{ top: 6, right: 14, bottom: 28, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
          {/* Operating-zone band — same colors as the per-session chart. */}
          <ReferenceArea
            y1={OPERATING_LOW} y2={OPERATING_HIGH}
            fill="#60a5fa"
            fillOpacity={0.08}
            stroke="#60a5fa"
            strokeOpacity={0.25}
            strokeDasharray="2 3"
          />
          <XAxis
            dataKey="date"
            tick={{ fill: C.muted, fontSize: 9 }}
            angle={-30} textAnchor="end" interval="preserveStartEnd"
            label={{ value: "Date", position: "insideBottom", offset: -18, fill: C.muted, fontSize: 11 }}
          />
          <YAxis
            domain={[0, 1.05]}
            tickFormatter={v => `${Math.round(v * 100)}%`}
            tick={{ fill: C.muted, fontSize: 11 }}
            width={48}
            label={{ value: "% of rep 1", angle: -90, position: "insideLeft", fill: C.muted, fontSize: 11 }}
          />
          <ReferenceLine y={1.0} stroke={C.muted} strokeDasharray="1 4" strokeOpacity={0.4} />
          <Tooltip
            contentStyle={{ background: C.card, border: `1px solid ${C.border}`, fontSize: 12 }}
            formatter={(val, name) => [val == null ? "—" : `${Math.round(val * 100)}%`, name]}
          />
          {plottedGrips.flatMap(g => {
            const color = GRIP_COLORS[g] || C.blue;
            return [
              <Line key={`${g}_raw`} dataKey={`${g}_raw`} stroke="none"
                dot={{ r: 3, fill: color, stroke: color }} activeDot={{ r: 4 }}
                legendType="none" name={`${g} (raw)`} isAnimationActive={false} />,
              <Line key={`${g}_sm`} dataKey={`${g}_sm`} stroke={color}
                strokeWidth={3} dot={false} connectNulls name={g}
                isAnimationActive={false} />,
            ];
          })}
        </ComposedChart>
      </ResponsiveContainer>
      <div style={{ display: "flex", justifyContent: "space-around", marginTop: 4, fontSize: 10, color: C.muted }}>
        {plottedGrips.map(g => (
          <span key={g} style={{ color: GRIP_COLORS[g] || C.blue }}>━ {g}</span>
        ))}
      </div>
    </Card>
  );
}
