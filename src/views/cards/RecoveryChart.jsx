// ─────────────────────────────────────────────────────────────
// RECOVERY CHART — between-rep duration retention
// ─────────────────────────────────────────────────────────────
// Visualizes how much of rep 1's failure time the user retains on each
// later rep at constant load. The forecast solves the nonlinear F-D
// model; the plotted ratio itself is not labeled a capacity fraction.
//
// Two series:
//   observed   — actual_time_s(N) / actual_time_s(1) from session
//                rep data. Always 1.0 at rep 1; subsequent reps
//                track how the rest interval handled depletion.
//   predicted  — approximate fraction from the fitted recovery model,
//                given rep 1's time + the rest
//                interval. By construction 1.0 at rep 1.
//
// Retention is descriptive. There is no universal good/bad reference band.
//
// Data shapes (from src/model/recoveryDynamics.js):
//   observed:  [{rep:1, observedFraction:1.0}, ...]
//   predicted: [{rep:1, predictedFraction:1.0}, ...]

import React, { useMemo } from "react";
import {
  ResponsiveContainer, ComposedChart,
  Line, XAxis, YAxis, Tooltip, CartesianGrid,
  ReferenceLine, Legend,
} from "recharts";
import { C } from "../../ui/theme.js";

// Color palette mirrors RepCurveChart so the two charts read as a
// pair: observed/actual in green, predicted/forecast in pink,
// reference accents in blue/amber/muted.
const COLORS = {
  observed:  "#34d399",  // green
  predicted: "#e879f9",  // pink (dashed)
  fresh:     "#f59e0b",  // amber, 100% reference line
};

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: C.bg,
      border: `1px solid ${C.border}`,
      borderRadius: 6,
      padding: "6px 10px",
      fontSize: 11,
      color: "#fff",
    }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>Rep {label}</div>
      {payload.map(p => p.value != null && (
        <div key={p.dataKey} style={{ color: p.color }}>
          {p.name}: {p.dataKey === 'predicted' ? 'about ' : ''}{Math.round(Number(p.value) * 100)}%
        </div>
      ))}
    </div>
  );
}

function RecoveryChart({
  observed = [],
  predicted = [],
  // Observed retention, without a readiness classification.
  headline = null,
  height = 180,
  title = null,
  showLegend = true,
}) {
  // Merge series for recharts (one data array, multiple Line series).
  const { merged, xMax } = useMemo(() => {
    const maxRep = Math.max(observed.length, predicted.length);
    if (maxRep === 0) return { merged: [], xMax: 0 };
    const rows = [];
    for (let i = 1; i <= maxRep; i++) {
      const o = observed.find(p => p.rep === i);
      const p = predicted.find(p => p.rep === i);
      rows.push({
        rep: i,
        observed:  o?.observedFraction ?? null,
        predicted: p?.predictedFraction ?? null,
      });
    }
    return { merged: rows, xMax: maxRep };
  }, [observed, predicted]);

  if (merged.length === 0) {
    return (
      <div style={{ padding: 16, color: C.muted, fontSize: 12, textAlign: "center" }}>
        Not enough data for recovery dynamics.
      </div>
    );
  }

  return (
    <div style={{ width: "100%" }}>
      {title && (
        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: C.muted }}>
          {title}
        </div>
      )}
      {Number.isFinite(headline?.observed) && (
        <div style={{ fontSize: 11, marginBottom: 4, lineHeight: 1.4 }}>
          <span style={{ color: C.text, fontWeight: 700 }}>
            {Math.round(headline.observed * 100)}%
          </span>{" "}
          <span style={{ color: C.muted }}>of rep-1 time on rep 2</span>{" "}
        </div>
      )}
      {predicted.length > 0 && <p style={{ fontSize: 12, color: C.muted, margin: '0 0 8px', lineHeight: 1.5 }}>
        Dashed line: approximate time retained between holds. Shorter holds are expected within a set. This is not a readiness score.
      </p>}
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={merged} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={C.border} opacity={0.3} />
          <XAxis
            dataKey="rep"
            type="number"
            domain={[1, xMax]}
            allowDecimals={false}
            ticks={Array.from({ length: xMax }, (_, i) => i + 1)}
            tick={{ fontSize: 10, fill: C.muted }}
            label={{ value: "Rep", position: "insideBottom", offset: -2, fontSize: 10, fill: C.muted }}
          />
          <YAxis
            domain={[0, 1.1]}
            tickFormatter={v => `${Math.round(v * 100)}%`}
            tick={{ fontSize: 10, fill: C.muted }}
            label={{ value: "% of rep 1", angle: -90, position: "insideLeft", offset: 18, fontSize: 10, fill: C.muted }}
          />
          <Tooltip content={<CustomTooltip />} />
          {showLegend && (
            <Legend wrapperStyle={{ fontSize: 10, paddingTop: 4 }} />
          )}

          {/* Fresh reference (1.0). Subtle — the chart's whole space is
              relative to this so a thick line would visually dominate. */}
          <ReferenceLine
            y={1.0}
            stroke={COLORS.fresh}
            strokeDasharray="1 4"
            strokeOpacity={0.5}
            label={{ value: "rep 1", fill: COLORS.fresh, fontSize: 9, position: "right" }}
          />

          {predicted.length > 0 && (
            <Line
              type="monotone"
              dataKey="predicted"
              name="Approximate estimate"
              stroke={COLORS.predicted}
              strokeWidth={2}
              strokeDasharray="4 3"
              dot={{ r: 3, fill: COLORS.predicted }}
              connectNulls
              isAnimationActive={false}
            />
          )}
          {observed.length > 0 && (
            <Line
              type="monotone"
              dataKey="observed"
              name="Actual"
              stroke={COLORS.observed}
              strokeWidth={2.5}
              dot={{ r: 4, fill: COLORS.observed }}
              connectNulls={false}
              isAnimationActive={false}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

// React.memo (2026-07-01): this component sits under the live BLE
// force stream — App-level state updates every animation frame while
// the Tindeq is connected. Memo skips reconciliation entirely when
// this component's own props haven't changed; without it every force
// sample re-rendered the full recharts tree.
const RecoveryChartMemo = React.memo(RecoveryChart);
export { RecoveryChartMemo as RecoveryChart };
