// ─────────────────────────────────────────────────────────────
// PeakForceCard — max-strength (peak force) trajectory over time
// ─────────────────────────────────────────────────────────────
// Direct measurement of instantaneous max force per grip, from your
// MAX/POWER protocol sessions (peak_force_kg). The cleanest strength
// metric in the app — no curve fit, no confound. Peak is neuromuscular
// and instantaneous, so rep duration is NOT filtered; only endurance
// PROTOCOLS (sub-max intent) are excluded. Dots = per-session best peak;
// solid line = running best-to-date (PR). See model/peakForce.js.
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
        o[`${g}_pr`] = r[`${g}_pr`] != null ? toDisp(r[`${g}_pr`], unit) : null;
        // Dots only on sessions that SET (or matched) the running PR.
        // Sub-PR session bests are expected — most days aren't max
        // days, and a submax dot below the line reads as regression
        // when it's just a normal session (June 2026). The card's job
        // is "watch the PR climb"; the line carries that, dots mark
        // the sessions that moved it.
        o[g] = (r[g] != null && r[`${g}_pr`] != null && r[g] >= r[`${g}_pr`])
          ? toDisp(r[g], unit)
          : null;
      }
      return o;
    });
    // Single shared axis: 0 → a little above the strongest grip's best,
    // so every grip sits at its true height and the magnitude gap shows.
    const hi = Math.max(...trend.grips.map(g => toDisp(trend.best[g].kg, unit)));
    const axisMax = Math.ceil((hi * 1.12) / 5) * 5;
    return {
      rows, grips: trend.grips, best: trend.best,
      changePct: trend.changePct, axisMax,
      provisional: trend.provisional || {},
    };
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
                {view.provisional[g] && (
                  <i style={{ color: C.muted, marginLeft: 4, fontSize: 11 }}>prov.</i>
                )}
              </span>
            );
          })}
        </div>
      </div>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>
        Best instantaneous pull from your max/power sessions — a direct
        max-strength measurement (peak force is instantaneous, so rep
        length doesn't matter). The line is your running best-to-date;
        dots mark the sessions that raised it, and the % is how much
        your max has climbed. One shared scale, so each grip sits at
        its true magnitude. Endurance sessions are excluded.
        {Object.keys(view.provisional).length > 0 && (
          <span style={{ fontStyle: "italic" }}>
            {" "}Dashed = provisional: no max/power session logged yet
            for that grip, so its line shows best pulls from sub-max
            sessions and understates true max — the first real max day
            replaces it.
          </span>
        )}
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
            contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }}
            formatter={(v, name) => [v != null ? `${fmt1(v)} ${unit}` : "—", name]}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {view.grips.map(g => {
            const color = GRIP_COLORS[g] || C.blue;
            const prov = view.provisional[g];
            return (
              <Line key={`${g}-pr`} type="monotone" dataKey={`${g}_pr`}
                name={prov ? `${g} (prov.)` : `${g} PR`}
                stroke={color} strokeWidth={2} dot={false}
                strokeDasharray={prov ? "6 4" : undefined}
                opacity={prov ? 0.7 : 1}
                connectNulls isAnimationActive={false} />
            );
          })}
          {view.grips.map(g => {
            const color = GRIP_COLORS[g] || C.blue;
            return (
              <Scatter key={`${g}-dots`} dataKey={g} name={`${g} new PR`}
                fill={color} isAnimationActive={false} />
            );
          })}
        </ComposedChart>
      </ResponsiveContainer>
    </Card>
  );
}
