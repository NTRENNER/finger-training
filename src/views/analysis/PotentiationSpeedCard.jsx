import React, { useMemo } from "react";
import {
  ResponsiveContainer, ComposedChart, Line, Scatter,
  XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
import { buildPotentiationSpeedTrend } from "../../model/potentiationRfd.js";
import { Card } from "../../ui/components.jsx";
import { C } from "../../ui/theme.js";
import { GRIP_COLORS } from "../../ui/grip-colors.js";
import { fmt1, toDisp } from "../../ui/format.js";

export function PotentiationSpeedCard({ history = [], grips = [], handView = "pooled", unit = "lbs" }) {
  const trend = useMemo(
    () => buildPotentiationSpeedTrend(history, { grips, hand: handView }),
    [history, grips, handView]
  );
  const display = useMemo(() => {
    if (!trend) return null;
    return {
      ...trend,
      rows: trend.rows.map(row => {
        const next = { date: row.date.slice(5) };
        for (const grip of trend.grips) {
          next[grip] = row[grip] == null ? null : toDisp(row[grip], unit);
          next[`${grip}_trend`] = row[`${grip}_trend`] == null
            ? null
            : toDisp(row[`${grip}_trend`], unit);
        }
        return next;
      }),
    };
  }, [trend, unit]);

  if (!display?.rows.length) return null;
  const displayUnit = `${unit}/s`;

  return <section aria-label="Potentiation speed history">
    <Card style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>Potentiation speed</h3>
        <span style={{ color: C.muted, fontSize: 11 }}>Force rise at 200 ms</span>
      </div>
      <ResponsiveContainer width="100%" height={210}>
        <ComposedChart data={display.rows} margin={{ top: 6, right: 12, bottom: 22, left: 0 }}>
          <CartesianGrid stroke={C.border} strokeDasharray="3 3" />
          <XAxis dataKey="date" tick={{ fill: C.muted, fontSize: 10 }} angle={-30}
            textAnchor="end" interval="preserveStartEnd" />
          <YAxis domain={[0, "auto"]} width={58} tick={{ fill: C.muted, fontSize: 10 }}
            tickFormatter={value => fmt1(value)} unit={` ${displayUnit}`} />
          <Tooltip
            contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8 }}
            labelStyle={{ color: C.text }}
            formatter={(value, name) => [`${fmt1(value)} ${displayUnit}`, name]}
          />
          {display.grips.map(grip => <Line key={`${grip}-trend`} type="monotone"
            dataKey={`${grip}_trend`} name={`${grip} trend`} legendType="none"
            stroke={GRIP_COLORS[grip] || C.blue} strokeWidth={2} dot={false}
            connectNulls isAnimationActive={false} />)}
          {display.grips.map(grip => <Scatter key={`${grip}-pulls`} dataKey={grip} name={grip}
            fill={GRIP_COLORS[grip] || C.blue} isAnimationActive={false} />)}
        </ComposedChart>
      </ResponsiveContainer>
      <div style={{ display: "flex", justifyContent: "center", flexWrap: "wrap", gap: "4px 14px", fontSize: 11, color: C.muted }}>
        {display.grips.map(grip => <span key={grip} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: GRIP_COLORS[grip] || C.blue }} />
          {grip}
        </span>)}
        <span>Median per warm-up</span>
      </div>
    </Card>
  </section>;
}

export default PotentiationSpeedCard;
