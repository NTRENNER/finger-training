// ─────────────────────────────────────────────────────────────
// RECOVERY CHART — between-rep capacity restoration
// ─────────────────────────────────────────────────────────────
// Visualizes how much capacity the user gets back between reps at
// constant load. The other half of the F-D story: F-D shows force
// decline within a rep, this shows capacity return between reps.
//
// Two series:
//   observed   — actual_time_s(N) / actual_time_s(1) from session
//                rep data. Always 1.0 at rep 1; subsequent reps
//                track how the rest interval handled depletion.
//   predicted  — what the user's personal recovery taus say the
//                fraction SHOULD be, given rep 1's time + the rest
//                interval. By construction 1.0 at rep 1.
//
// Reference band at 70%-90% marks the practical operating zone for
// sustained sets: below 70% the rep is meaningfully degraded;
// above 90% the rest interval has slack and could be shortened.
//
// Data shapes (from src/model/recoveryDynamics.js):
//   observed:  [{rep:1, observedFraction:1.0}, ...]
//   predicted: [{rep:1, predictedFraction:1.0}, ...]

import React, { useMemo } from "react";
import {
  ResponsiveContainer, ComposedChart,
  Line, XAxis, YAxis, Tooltip, CartesianGrid,
  ReferenceLine, ReferenceArea, Legend,
} from "recharts";
import { C } from "../../ui/theme.js";
import { OPERATING_LOW, OPERATING_HIGH } from "../../model/recoveryDynamics.js";

// Color palette mirrors RepCurveChart so the two charts read as a
// pair: observed/actual in green, predicted/forecast in pink,
// reference accents in blue/amber/muted.
const COLORS = {
  observed:  "#34d399",  // green
  predicted: "#e879f9",  // pink (dashed)
  zone:      "#60a5fa",  // blue, low-opacity band
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
          {p.name}: {Math.round(Number(p.value) * 100)}%
        </div>
      ))}
    </div>
  );
}

export function RecoveryChart({
  observed = [],
  predicted = [],
  // Coaching headline displayed above the chart when a gap is
  // available. Shape: { observed: 0.78, classification: "well_calibrated" }.
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

  // Headline: descriptive read on the depletion depth at rep 2.
  // Frames what we OBSERVED — the rest is fixed by the protocol,
  // so we don't editorialize about "under-rested."
  const headlineText = headline?.classification ? (
    headline.classification === "operating_zone"
      ? "Within typical operating zone"
      : headline.classification === "deep_depletion"
        ? "Deep depletion — steep loss between reps"
        : headline.classification === "shallow_depletion"
          ? "Shallow depletion — rest has headroom"
          : null
  ) : null;
  const headlineColor =
    headline?.classification === "operating_zone"    ? C.green
    : headline?.classification === "deep_depletion"  ? C.orange
    : headline?.classification === "shallow_depletion" ? C.muted
    : C.muted;

  return (
    <div style={{ width: "100%" }}>
      {title && (
        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: C.muted }}>
          {title}
        </div>
      )}
      {headlineText && headline?.observed != null && (
        <div style={{ fontSize: 11, marginBottom: 4, lineHeight: 1.4 }}>
          <span style={{ color: headlineColor, fontWeight: 700 }}>
            {Math.round(headline.observed * 100)}%
          </span>{" "}
          <span style={{ color: C.muted }}>recovered at rep 2</span>{" "}
          <span style={{ color: headlineColor, fontStyle: "italic" }}>
            · {headlineText}
          </span>
        </div>
      )}
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={merged} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={C.border} opacity={0.3} />
          {/* Operating zone — well-calibrated rest lands in this band. */}
          <ReferenceArea
            y1={OPERATING_LOW} y2={OPERATING_HIGH}
            fill={COLORS.zone}
            fillOpacity={0.08}
            stroke={COLORS.zone}
            strokeOpacity={0.25}
            strokeDasharray="2 3"
          />
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
            label={{ value: "fresh", fill: COLORS.fresh, fontSize: 9, position: "right" }}
          />

          {predicted.length > 0 && (
            <Line
              type="monotone"
              dataKey="predicted"
              name="Forecast"
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
