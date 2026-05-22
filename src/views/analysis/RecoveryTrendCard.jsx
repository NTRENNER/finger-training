// ─────────────────────────────────────────────────────────────
// RECOVERY TREND CARD — gap between observed and predicted recovery
// ─────────────────────────────────────────────────────────────
// Cross-session view of how the user's actual rep 2 recovery
// compares to what the personalized recovery model predicts, per
// session, per grip.
//
// Why gap, not raw observed? The raw rep2/rep1 ratio is confounded
// by rep 1 time changes — as you get stronger and last longer on
// rep 1, the same rest interval refills a smaller fraction of the
// (now deeper) depletion, so observed trends down even when the
// recovery side is unchanged. The model's predicted fraction drops
// in the same way, so the GAP (observed − predicted) stays flat
// when recovery is unchanged. A widening negative gap is the real
// "recovery is degrading" signal worth chasing.
//
// Inputs (props):
//   history — full rep history (App-level state). Used to compute
//             the trend per grip via buildRecoveryTrend, seeded
//             with each grip's personalized physModel.
//   grips   — grips to plot (e.g. ["Crusher", "Micro"]). Each
//             grip gets its own line.
//
// Same chart-pattern as CapacityTrajectoryCard: raw dots + smoothed
// 3-session rolling mean, per-grip colors. Reference line at 0 (gap
// = 0 means "matches model"); reference band at ±NOISE_BAND marks
// the noise floor (gaps inside the band are indistinguishable from
// model expectation given normal rep-time noise).

import React, { useMemo } from "react";
import {
  ResponsiveContainer, ComposedChart, Line,
  XAxis, YAxis, Tooltip, CartesianGrid, ReferenceArea, ReferenceLine,
} from "recharts";
import { C } from "../../ui/theme.js";
import { Card } from "../../ui/components.js";
import {
  buildRecoveryTrend, withRollingMean,
  GAP_TARGET_REP, GAP_NOISE_BAND,
} from "../../model/recoveryDynamics.js";
import { buildPhysModel } from "../../model/repCurveData.js";

const GRIP_COLORS = { Micro: "#e05560", Crusher: C.orange, Prime: "#7c5cbf" };

// Pretty-print a gap value as a signed percentage. 0.05 → "+5%",
// -0.12 → "-12%". Returns "—" for null/undefined.
const fmtGap = (v) => {
  if (v == null || !Number.isFinite(v)) return "—";
  const pct = Math.round(v * 100);
  return `${pct >= 0 ? "+" : ""}${pct}%`;
};

export function RecoveryTrendCard({ history, grips = ["Crusher", "Micro"] }) {
  // Build per-grip trend series, then merge into a single recharts
  // data array indexed by date. physModel is per-grip — recovery taus
  // are grip-level; we pass an arbitrary hand ("L") since predictRepTimes
  // only consults weights/tauD/tauR, all of which are hand-independent.
  const { merged, plottedGrips, yDomain } = useMemo(() => {
    const perGrip = {};
    for (const g of grips) {
      const physModel = buildPhysModel(history, "L", g);
      const trend = withRollingMean(buildRecoveryTrend(history, g, { physModel }));
      // Only include grips with at least one finite gap value — pure
      // observed-only trends shouldn't render on a gap chart.
      const hasGap = trend.some(r => Number.isFinite(r.gapAtTarget));
      if (trend.length > 0 && hasGap) perGrip[g] = trend;
    }
    const dates = [...new Set(
      Object.values(perGrip).flatMap(t => t.map(r => r.date))
    )].sort();
    const rows = dates.map(date => {
      const row = { date };
      for (const [g, t] of Object.entries(perGrip)) {
        const point = t.find(p => p.date === date);
        if (point) {
          row[`${g}_raw`] = point.gapAtTarget;
          row[`${g}_sm`]  = point.gapSmoothed;
        }
      }
      return row;
    });
    // Symmetric y-axis around 0, padded just past the data extreme so
    // the noise band stays visible even when data clusters tightly.
    const all = rows.flatMap(r => Object.entries(r)
      .filter(([k]) => k.endsWith("_raw") || k.endsWith("_sm"))
      .map(([, v]) => v))
      .filter(Number.isFinite);
    const maxAbs = all.length > 0 ? Math.max(...all.map(Math.abs)) : 0.2;
    const pad = Math.max(maxAbs * 1.15, GAP_NOISE_BAND * 1.5, 0.2);
    return {
      merged: rows,
      plottedGrips: Object.keys(perGrip),
      yDomain: [-pad, pad],
    };
  }, [history, grips]);

  // Need at least 2 sessions on at least one grip to render a
  // meaningful trend. Single-point lines are just dots, useless.
  if (merged.length < 2 || plottedGrips.length === 0) return null;

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>
        Recovery Gap — rep {GAP_TARGET_REP} observed minus predicted
      </div>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>
        How much your rep 2 over- or under-performs what the personalized
        recovery model predicts, per session, per grip. 0 = matches model.
        Blue band marks the ±{Math.round(GAP_NOISE_BAND * 100)}% noise floor;
        gaps inside it are indistinguishable from "as expected." A widening
        negative gap means recovery is degrading independent of how rep 1
        is going — the signal raw observed misses as you get stronger.
        Bold line is a 3-session rolling mean; dots are raw per-session values.
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <ComposedChart data={merged} margin={{ top: 6, right: 14, bottom: 28, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
          {/* Noise band — gaps inside are statistical noise, not signal. */}
          <ReferenceArea
            y1={-GAP_NOISE_BAND} y2={GAP_NOISE_BAND}
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
            domain={yDomain}
            tickFormatter={fmtGap}
            tick={{ fill: C.muted, fontSize: 11 }}
            width={48}
            label={{ value: "obs − pred", angle: -90, position: "insideLeft", fill: C.muted, fontSize: 11 }}
          />
          {/* Zero line — "matches model" reference. */}
          <ReferenceLine y={0} stroke={C.muted} strokeDasharray="1 4" strokeOpacity={0.6} />
          <Tooltip
            contentStyle={{ background: C.card, border: `1px solid ${C.border}`, fontSize: 12 }}
            formatter={(val, name) => [fmtGap(val), name]}
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
