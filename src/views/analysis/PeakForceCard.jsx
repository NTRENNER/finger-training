// ─────────────────────────────────────────────────────────────
// PeakForceCard — max-strength (peak force) trajectory over time
// ─────────────────────────────────────────────────────────────
// Direct measurement of instantaneous max force per grip, from your
// short near-max reps (peak_force_kg) in MAX/POWER protocol sessions.
// The cleanest strength metric in the app — no curve fit, no confound.
// Dots = per-session best near-max peak; solid line = running best-to-
// date (PR). See model/peakForce.js for the two-stage rep filter.
//
// Axis: ONE shared scale for all grips. Crusher (~170 lb) and Micro
// (~50 lb) differ ~3×, and that magnitude gap is real and worth showing
// — a per-grip zoomed axis made the two PR lines overlap and falsely
// read as equal strength. Peak max is fairly flat over a month anyway
// (the month's gains are in capacity/endurance, not raw max), so a
// shared axis is both honest about magnitude and not hiding a big climb.
// The per-grip % climb still appears in the header.

import React, { useMemo } from "react";
import {
  ResponsiveContainer, ComposedChart, Line, Scatter,
  XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from "recharts";
import { C } from "../../ui/theme.js";
import { Card } from "../../ui/components.js";
import { GRIP_COLORS } from "../../ui/grip-colors.js";
import { fmt1, toDisp } from "../../ui/format.js";
import { buildPeakForceTrend } from "../../model/peakForce.js";

export function PeakForceCard({ history, unit = "lbs" }) {
  const trend = useMemo(() => buildPeakForceTrend(history), [history]);

  const view = useMemo(() => {
    if (!trend) return null;
    const rows = trend.rows.map(r => {
      const o = { date: r.date.slice(5) };
      for (const g of trend.grips) {
        o[g] = r[g] != null ? toDisp(r[g], unit) : null;
        o[`${g}_pr`] = r[`${g}_pr`] != null ? toDisp(r[`${g}_pr`], unit) : null;
      }
      return o;
    });
    // Single shared axis: 0 → a little above the strongest grip's best,
    // so every grip sits at its true height and the magnitude gap shows.
    const hi = Math.max(...trend.grips.map(g => toDisp(trend.best[g].kg, unit)));
    const axisMax = Math.ceil((hi * 1.12) / 5) * 5;
    return { rows, grips: trend.grips, best: trend.best, changePct: trend.changePct, axisMax };
  }, [trend, unit]);

  if (!view || view.rows.length < 1) return null;

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4, flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>Peak force — max strength over time</div>
        <div style={{ fontSize: 12, color: C.muted }}>
          {view.grips.map(g => {
            const pct = view.changePct[g];
            const pctColor = pct == null ? C.muted : pct > 0 ? C.green : pct < 0 ? C.red : C.muted;
            return (
              <span key={g} style={{ marginLeft: 12 }}>
                <span style={{ color: GRIP_COLORS[g] || C.blue }}>{g}</span>{" "}
                <b style={{ color: C.text }}>{fmt1(toDisp(view.best[g].kg, unit))} {unit}</b>
                {pct != null && (
                  <b style={{ color: pctColor, marginLeft: 4 }}>
                    {pct > 0 ? "+" : ""}{pct}%
                  </b>
                )}
              </span>
            );
          })}
        </div>
      </div>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>
        Best instantaneous pull per session, from short near-max reps in
        max/power sessions — a direct max-strength measurement. Dots are
        per-session bests; the line is your running best-to-date, and the %
        is how much your max has climbed. One shared scale, so each grip
        sits at its true magnitude. Endurance-session reps are excluded.
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart data={view.rows} margin={{ top: 6, right: 14, bottom: 24, left: 0 }}>
          <CartesianGrid stroke={C.border} strokeDasharray="3 3" />
          <XAxis dataKey="date" tick={{ fill: C.muted, fontSize: 10 }}
            angle={-30} textAnchor="end" interval="preserveStartEnd" />
          <YAxis
            domain={[0, view.axisMax]}
            tick={{ fill: C.muted, fontSize: 10 }}
            width={46}
            unit={` ${unit}`}
          />
          <Tooltip
            contentStyle={{ background: C.bg, border: `1px solid ${C.border}`, fontSize: 12 }}
            formatter={(v, name) => [v != null ? `${fmt1(v)} ${unit}` : "—", name]}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {view.grips.map(g => {
            const color = GRIP_COLORS[g] || C.blue;
            return (
              <Line key={`${g}-pr`} type="monotone" dataKey={`${g}_pr`}
                name={`${g} PR`} stroke={color} strokeWidth={2} dot={false}
                connectNulls isAnimationActive={false} />
            );
          })}
          {view.grips.map(g => {
            const color = GRIP_COLORS[g] || C.blue;
            return (
              <Scatter key={`${g}-dots`} dataKey={g} name={g}
                fill={color} isAnimationActive={false} />
            );
          })}
        </ComposedChart>
      </ResponsiveContainer>
    </Card>
  );
}
