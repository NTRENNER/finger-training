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
import { GRIP_COLORS } from "../../ui/grip-colors.js";
import {
  buildRecoveryTrend, withRollingMean,
  GAP_TARGET_REP, GAP_NOISE_BAND,
  OPERATING_LOW, OPERATING_HIGH,
} from "../../model/recoveryDynamics.js";
import { buildPhysModel } from "../../model/repCurveData.js";

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

// ─────────────────────────────────────────────────────────────
// RECOVERY OBSERVED TREND CARD — raw rep 2 / rep 1, smoothed
// ─────────────────────────────────────────────────────────────
// Companion to RecoveryTrendCard (the gap card). Where that one
// shows "is my recovery side outperforming the model?", this one
// shows the more directly-readable "how fragmented are my sets in
// practice?" — the raw rep 2 / rep 1 ratio, 3-session rolling mean.
//
// Confound to keep in mind: as rep 1 lengthens (you get stronger),
// the same 20s rest refills a smaller fraction of the now-deeper
// depletion, so observed trends down even when the recovery side
// is unchanged. The gap card factors that out; this one doesn't.
// They answer different questions:
//   observed → "What does the set shape feel like over time?"
//   gap      → "Is something off with recovery vs my model?"
//
// Reference band at 70–90% mirrors the per-session chart's operating
// zone so the two views are visually consistent.

const formatPct = (v) => {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${Math.round(v * 100)}%`;
};

export function RecoveryObservedTrendCard({ history, grips = ["Crusher", "Micro"] }) {
  const { merged, plottedGrips } = useMemo(() => {
    const perGrip = {};
    for (const g of grips) {
      // physModel not strictly needed here (we only read observedSmoothed),
      // but pass one anyway so the same trend rows can populate both cards
      // without recomputing — cheap, and keeps the data shape consistent.
      const physModel = buildPhysModel(history, "L", g);
      const trend = withRollingMean(buildRecoveryTrend(history, g, { physModel }));
      const hasObserved = trend.some(r => Number.isFinite(r.observedAtTarget));
      if (trend.length > 0 && hasObserved) perGrip[g] = trend;
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
    return {
      merged: rows,
      plottedGrips: Object.keys(perGrip),
    };
  }, [history, grips]);

  if (merged.length < 2 || plottedGrips.length === 0) return null;

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>
        Rep {GAP_TARGET_REP} recovery — trend over time
      </div>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>
        Raw rep {GAP_TARGET_REP} / rep 1 ratio, smoothed over 3 sessions per grip.
        Reads the shape of your sets directly: a downward trend means later
        reps are losing more ground at the same protocol. Blue band marks the
        {" "}{Math.round(OPERATING_LOW * 100)}–{Math.round(OPERATING_HIGH * 100)}%
        typical operating zone. Note: as you get stronger and rep 1 lengthens,
        observed naturally drifts down — the companion gap chart below factors
        that out.
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <ComposedChart data={merged} margin={{ top: 6, right: 14, bottom: 28, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
          {/* Operating zone — same band as the per-session chart. */}
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
            domain={[0, 1.1]}
            tickFormatter={formatPct}
            tick={{ fill: C.muted, fontSize: 11 }}
            width={48}
            label={{ value: "% of rep 1", angle: -90, position: "insideLeft", fill: C.muted, fontSize: 11 }}
          />
          {/* Fresh reference (100%) — what perfect recovery would look like. */}
          <ReferenceLine
            y={1.0}
            stroke="#f59e0b"
            strokeDasharray="1 4"
            strokeOpacity={0.5}
          />
          <Tooltip
            contentStyle={{ background: C.card, border: `1px solid ${C.border}`, fontSize: 12 }}
            formatter={(val, name) => [formatPct(val), name]}
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
