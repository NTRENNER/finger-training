// ─────────────────────────────────────────────────────────────
// REP CURVE CHART — shared component
// ─────────────────────────────────────────────────────────────
// One chart, three render sites: live during a workout
// (ActiveSessionViews), per-session detail on History, and click-to-
// expand on the Analysis tab's F-D scatter. All series are optional
// so each surface can pass only what it has.
//
// X axis: rep number (1..N). Y axis: hold duration in seconds.
//
// Series:
//   forecasted     — pink dashed line, predictRepTimes output
//   actual         — green solid line + dots, observed reps
//   prevSession    — gray faded line, last similar-zone session's actuals
//   asymptoticHold — horizontal reference line (the floor)
//   targetS        — horizontal reference line (the prescribed target)
//
// Data shapes (all arrays of { rep, t }, see model/repCurveData.js):
//   forecasted:  [{rep:1,t:42}, {rep:2,t:26}, ...]
//   actual:      same shape, indexed by rep order
//   prevSession: same shape

import React, { useMemo } from "react";
import {
  ResponsiveContainer, ComposedChart,
  Line, XAxis, YAxis, Tooltip, CartesianGrid,
  ReferenceLine, Legend,
} from "recharts";
import { C } from "../../ui/theme.js";

const COLORS = {
  forecasted:  "#e879f9",  // pink
  actual:      "#34d399",  // green
  prevSession: "#6b7280",  // gray
  asymptote:   "#f59e0b",  // amber
  target:      "#60a5fa",  // blue
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
          {p.name}: {Number(p.value).toFixed(1)}s
        </div>
      ))}
    </div>
  );
}

export function RepCurveChart({
  forecasted = [],
  actual = [],
  prevSession = [],
  asymptoticHold = null,
  targetS = null,
  height = 220,
  showLegend = true,
  title = null,
}) {
  // Merge all series into a single array of { rep, forecasted, actual,
  // prev } so recharts can render multiple Lines off the same data.
  // Domain is the max rep across all series.
  const { merged, xMax } = useMemo(() => {
    const maxRep = Math.max(
      forecasted.length, actual.length, prevSession.length,
    );
    if (maxRep === 0) return { merged: [], xMax: 0 };
    const rows = [];
    for (let i = 1; i <= maxRep; i++) {
      const f = forecasted.find(p => p.rep === i);
      const a = actual.find(p => p.rep === i);
      const p = prevSession.find(p => p.rep === i);
      rows.push({
        rep: i,
        forecasted: f ? f.t : null,
        actual:     a ? a.t : null,
        prev:       p ? p.t : null,
      });
    }
    return { merged: rows, xMax: maxRep };
  }, [forecasted, actual, prevSession]);

  if (merged.length === 0) {
    return (
      <div style={{ padding: 16, color: C.muted, fontSize: 12, textAlign: "center" }}>
        Not enough data to draw the rep curve.
      </div>
    );
  }

  // Y-axis upper bound: a little above the highest forecasted/actual/prev
  // so the curve has headroom. Falls back to 60s for empty-y cases.
  const yMax = Math.max(
    60,
    ...merged.flatMap(r => [r.forecasted, r.actual, r.prev].filter(v => v != null)),
  ) * 1.1;

  return (
    <div style={{ width: "100%" }}>
      {title && (
        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: C.muted }}>
          {title}
        </div>
      )}
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
            domain={[0, yMax]}
            tick={{ fontSize: 10, fill: C.muted }}
            label={{ value: "Hold (s)", angle: -90, position: "insideLeft", offset: 12, fontSize: 10, fill: C.muted }}
          />
          <Tooltip content={<CustomTooltip />} />
          {showLegend && (
            <Legend wrapperStyle={{ fontSize: 10, paddingTop: 4 }} />
          )}

          {/* Reference lines render under the data lines */}
          {targetS != null && (
            <ReferenceLine
              y={targetS}
              stroke={COLORS.target}
              strokeDasharray="2 4"
              strokeOpacity={0.6}
              label={{ value: `target ${targetS}s`, fill: COLORS.target, fontSize: 9, position: "right" }}
            />
          )}
          {asymptoticHold != null && asymptoticHold > 0 && (
            <ReferenceLine
              y={asymptoticHold}
              stroke={COLORS.asymptote}
              strokeDasharray="1 3"
              strokeOpacity={0.5}
              label={{ value: `floor ~${asymptoticHold.toFixed(0)}s`, fill: COLORS.asymptote, fontSize: 9, position: "left" }}
            />
          )}

          {prevSession.length > 0 && (
            <Line
              type="monotone"
              dataKey="prev"
              name="Previous"
              stroke={COLORS.prevSession}
              strokeWidth={1.5}
              strokeOpacity={0.6}
              dot={{ r: 2, fill: COLORS.prevSession, fillOpacity: 0.6 }}
              connectNulls
              isAnimationActive={false}
            />
          )}
          {forecasted.length > 0 && (
            <Line
              type="monotone"
              dataKey="forecasted"
              name="Forecasted"
              stroke={COLORS.forecasted}
              strokeWidth={2}
              strokeDasharray="4 3"
              dot={{ r: 3, fill: COLORS.forecasted }}
              connectNulls
              isAnimationActive={false}
            />
          )}
          {actual.length > 0 && (
            <Line
              type="monotone"
              dataKey="actual"
              name="Actual"
              stroke={COLORS.actual}
              strokeWidth={2.5}
              dot={{ r: 4, fill: COLORS.actual }}
              connectNulls={false}
              isAnimationActive={false}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
