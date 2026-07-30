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
// Data shapes (see model/repCurveData.js):
//   forecasted:  [{rep:1,t:42}, {rep:2,t:26}, ...]
//   actual:      [{rep:1,t:42,weightKg:12}, ...]
//   prevSession: same shape as actual

import React, { useMemo } from "react";
import {
  ResponsiveContainer, ComposedChart,
  Line, XAxis, YAxis, Tooltip, CartesianGrid,
  ReferenceLine, Legend,
} from "recharts";
import { C } from "../../ui/theme.js";
import { fmtW } from "../../ui/format.js";

const COLORS = {
  forecasted:  "#e879f9",  // pink
  actual:      "#34d399",  // green
  prevSession: "#6b7280",  // gray
  asymptote:   "#f59e0b",  // amber
  target:      "#60a5fa",  // blue
};

function loadAndTime(point, unit) {
  if (!point) return null;
  const time = `${Number(point.value).toFixed(1)}s`;
  return point.weightKg > 0
    ? `${fmtW(point.weightKg, unit)} ${unit} × ${time}`
    : time;
}

function CustomTooltip({ active, payload, label, unit }) {
  if (!active || !payload?.length) return null;
  const byKey = Object.fromEntries(payload.map(p => [p.dataKey, p]));
  const row = payload[0]?.payload || {};
  const forecast = byKey.forecasted;
  const actual = byKey.actual;
  const previous = byKey.prev;
  const anchoredActual =
    Number(label) === 1
    && forecast?.value != null
    && actual?.value != null
    && Math.abs(Number(forecast.value) - Number(actual.value)) < 0.05;

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
      {previous?.value != null && (
        <div style={{ color: previous.color }}>
          Previous comparable{row.prevDate ? ` (${row.prevDate})` : ""}: {loadAndTime({
            value: previous.value,
            weightKg: row.prevWeightKg,
          }, unit)}
        </div>
      )}
      {anchoredActual ? (
        <div style={{ color: COLORS.actual }}>
          Anchor (actual): {loadAndTime({
            value: actual.value,
            weightKg: row.actualWeightKg,
          }, unit)}
        </div>
      ) : (
        <>
          {forecast?.value != null && (
            <div style={{ color: forecast.color }}>
              Forecast: {Number(forecast.value).toFixed(1)}s
            </div>
          )}
          {actual?.value != null && (
            <div style={{ color: actual.color }}>
              Actual: {loadAndTime({
                value: actual.value,
                weightKg: row.actualWeightKg,
              }, unit)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Exported for a focused regression test: the prescribed target must
// participate in the domain even when the user falls short of it.
export function repCurveYMax(merged, targetS) {
  return Math.max(
    60,
    Number(targetS) || 0,
    ...merged.flatMap(r => [r.forecasted, r.actual, r.prev].filter(v => v != null)),
  ) * 1.1;
}

function RepCurveChart({
  forecasted = [],
  actual = [],
  prevSession = [],
  asymptoticHold = null,
  targetS = null,
  // Prescription context. targetWeightKg is what prescription() showed
  // before the session; the exact actual load per rep rides on the
  // actual-series point. usedWeightKg is retained as a legacy/live
  // fallback when a point has no recorded load.
  targetWeightKg = null,
  usedWeightKg = null,
  unit = "lbs",
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
        actualWeightKg: a?.weightKg ?? null,
        prevWeightKg: p?.weightKg ?? null,
        prevDate: p?.date ?? null,
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

  // Include the prescribed target so its reference line cannot land
  // outside the visible domain when the athlete falls short.
  const yMax = repCurveYMax(merged, targetS);
  const anchor = actual.find(p => p.rep === 1) || actual[0] || null;
  const anchorWeightKg = anchor?.weightKg ?? usedWeightKg;

  // Load drift indicator: % overshoot/undershoot of used vs target load.
  // Hidden when within 1% (just noise from grip-weight variance).
  const loadDriftPct = (() => {
    if (targetWeightKg == null || anchorWeightKg == null) return null;
    if (!(targetWeightKg > 0)) return null;
    const pct = (anchorWeightKg - targetWeightKg) / targetWeightKg * 100;
    if (Math.abs(pct) < 1) return null;
    return Math.round(pct);
  })();

  return (
    <div style={{ width: "100%" }}>
      {title && (
        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: C.muted }}>
          {title}
        </div>
      )}
      {(targetWeightKg != null || targetS != null || anchor) && (
        <div style={{ fontSize: 10, color: C.muted, marginBottom: 6, lineHeight: 1.5 }}>
          <div>
            Prescribed:{" "}
            <b style={{ color: "#fff" }}>
              {targetWeightKg != null ? `${fmtW(targetWeightKg, unit)} ${unit}` : ""}
              {targetWeightKg != null && targetS != null ? " × " : ""}
              {targetS != null ? `${targetS}s` : ""}
              {targetWeightKg == null && targetS == null ? "—" : ""}
            </b>
          </div>
          {anchor && (
            <div>
              Anchor (actual rep 1):{" "}
              <b style={{ color: COLORS.actual }}>
                {anchorWeightKg > 0 ? `${fmtW(anchorWeightKg, unit)} ${unit} × ` : ""}
                {Number(anchor.t).toFixed(1)}s
              </b>
              {loadDriftPct != null && (
                <span style={{
                  marginLeft: 6,
                  color: loadDriftPct > 0 ? "#f59e0b" : "#22c55e",
                  fontWeight: 700,
                }}>
                  ({loadDriftPct > 0 ? "+" : ""}{loadDriftPct}% load)
                </span>
              )}
              <span style={{ color: C.muted }}> · tap points for details</span>
            </div>
          )}
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
          <Tooltip content={<CustomTooltip unit={unit} />} />
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
              label={{ value: `prescribed ${targetS}s`, fill: COLORS.target, fontSize: 9, position: "right" }}
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
              name="Previous comparable"
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
              name="Forecast from anchor"
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

// React.memo (2026-07-01): this component sits under the live BLE
// force stream — App-level state updates every animation frame while
// the Tindeq is connected. Memo skips reconciliation entirely when
// this component's own props haven't changed; without it every force
// sample re-rendered the full recharts tree.
const RepCurveChartMemo = React.memo(RepCurveChart);
export { RepCurveChartMemo as RepCurveChart };
