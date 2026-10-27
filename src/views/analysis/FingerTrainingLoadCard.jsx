import React, { useMemo, useState } from "react";
import {
  Bar, CartesianGrid, ComposedChart, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { buildFingerTrainingLoad } from "../../model/fingerTrainingLoad.js";
import { Card } from "../../ui/components.jsx";
import { C } from "../../ui/theme.js";
import { fmt1, toDisp } from "../../ui/format.js";
import { today } from "../../util.js";

const controlStyle = {
  minHeight: 40,
  minWidth: 76,
  padding: "8px 12px",
  border: `1px solid ${C.border}`,
  borderRadius: 8,
  font: "inherit",
  fontSize: 13,
  fontWeight: 700,
  cursor: "pointer",
};

function weekLabel(value) {
  return new Date(`${value}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function LoadTooltip({ active, payload, mode, unit }) {
  const row = active && payload?.[0]?.payload;
  if (!row) return null;
  const value = mode === "time" ? `${fmt1(row.time)} min` : `${fmt1(row.volume)} ${unit}·min`;
  return <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 10px" }}>
    <div style={{ color: C.text, fontWeight: 700 }}>Week of {weekLabel(row.week)}</div>
    <div style={{ color: C.muted, fontSize: 11, marginTop: 3 }}>{mode === "time" ? "Time under tension" : "Load × duration"}</div>
    <div style={{ color: C.text, marginTop: 3 }}>{value}</div>
    <div style={{ color: C.muted, marginTop: 2 }}>{row.sessions} session{row.sessions === 1 ? "" : "s"}</div>
  </div>;
}

export function FingerTrainingLoadCard({ history = [], grips = [], handView = "pooled", unit = "lbs" }) {
  const [mode, setMode] = useState("time");
  const load = useMemo(() => buildFingerTrainingLoad(history, {
    grips,
    hand: handView,
    throughDate: today(),
  }), [history, grips, handView]);
  const display = useMemo(() => {
    if (!load) return null;
    return {
      ...load,
      rows: load.rows.map(row => ({
        ...row,
        time: row.tutS / 60,
        volume: toDisp(row.volumeKgS / 60, unit),
      })),
      reference: {
        time: load.reference.tutS / 60,
        volume: toDisp(load.reference.volumeKgS / 60, unit),
        weeks: load.reference.weeks,
      },
    };
  }, [load, unit]);

  if (!display?.rows.length) return null;

  const dataKey = mode === "time" ? "time" : "volume";
  const color = mode === "time" ? C.blue : C.orange;
  const suffix = mode === "time" ? "min" : `${unit}·min`;
  const reference = display.reference[dataKey];
  const current = display.rows[display.rows.length - 1]?.[dataKey] || 0;

  return <section aria-label="Finger training load history">
    <Card style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 16 }}>Finger training load</h3>
          <div style={{ color: C.muted, fontSize: 11, marginTop: 3 }}>
            {mode === "time" ? "Time under tension" : "Load × duration"} by week · current week is partial
          </div>
        </div>
        <div role="group" aria-label="Finger training load measure" style={{ display: "flex", gap: 6 }}>
          {[["time", "Time"], ["volume", "Volume"]].map(([key, label]) => <button
            key={key}
            type="button"
            aria-pressed={mode === key}
            onClick={() => setMode(key)}
            style={{
              ...controlStyle,
              background: mode === key ? C.purple : C.bg,
              color: mode === key ? "#fff" : C.text,
            }}
          >{label}</button>)}
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={display.rows} margin={{ top: 8, right: 8, bottom: 20, left: 0 }}>
            <CartesianGrid stroke={C.border} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="week" tick={{ fill: C.muted, fontSize: 10 }}
              tickFormatter={weekLabel} interval="preserveStartEnd" minTickGap={26} />
            <YAxis width={58} domain={[0, "auto"]} tick={{ fill: C.muted, fontSize: 10 }}
              tickFormatter={value => fmt1(value)} unit={` ${suffix}`} />
            <Tooltip content={<LoadTooltip mode={mode} unit={unit} />} cursor={{ fill: `${color}12` }} />
            {display.reference.weeks > 0 && reference > 0 && <ReferenceLine
              y={reference} stroke={C.muted} strokeDasharray="5 4" strokeWidth={1.5} />}
            <Bar dataKey={dataKey} name={mode === "time" ? "Time under tension" : "Training volume"}
              fill={color} radius={[3, 3, 0, 0]} maxBarSize={38} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, color: C.muted, fontSize: 12 }}>
        <span>This week <strong style={{ color: C.text }}>{fmt1(current)} {suffix}</strong></span>
        {display.reference.weeks > 0 && <span>Previous {display.reference.weeks}-week average <strong style={{ color: C.text }}>{fmt1(reference)} {suffix}</strong></span>}
      </div>
    </Card>
  </section>;
}

export default FingerTrainingLoadCard;
