import React from "react";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine } from "recharts";
import { C } from "../../ui/theme.js";
import { toDisp, fromDisp, fmt1 } from "../../ui/format.js";
import { ZONE6 } from "../../model/zones.js";
import { zoneReference, defaultComparisonLoad, holdTimeAtForce, holdTimeSeries } from "../../model/curveComparison.js";

const controlStyle = { background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, padding: "9px 10px", font: "inherit", fontSize: 14, minHeight: 42 };
const signed = value => `${value >= 0 ? "+" : ""}${fmt1(value)}`;

export function ComparisonModeSelector({ mode, onChange }) {
  return <div role="group" aria-label="Curve improvement view" style={{ display: "flex", gap: 6, margin: "12px 0", flexWrap: "wrap" }}>
    {[["percent", "%"], ["weight", "Weight"], ["time", "Hold time"]].map(([key, label]) =>
      <button type="button" key={key} aria-pressed={mode === key} onClick={() => onChange(key)}
        style={{ ...controlStyle, minWidth: 72, fontWeight: 700, background: mode === key ? C.purple : C.bg, color: mode === key ? "#fff" : C.text }}>{label}</button>)}
  </div>;
}

export function WeightTile({ comparison, unit, baselineDate }) {
  if (!comparison) return <span style={{ fontSize: 12, color: C.muted }}>No baseline yet</span>;
  return <>
    <div style={{ fontSize: 20, fontWeight: 800, color: comparison.delta < 0 ? C.red : C.text }}>{signed(toDisp(comparison.delta, unit))} {unit}</div>
    <div style={{ fontSize: 12, color: C.text, marginTop: 4 }}>{fmt1(toDisp(comparison.before, unit))} → {fmt1(toDisp(comparison.now, unit))} {unit}</div>
    <div style={{ fontSize: 12, color: C.muted, marginTop: 3 }}>at {comparison.duration}s</div>
    {comparison.baselineDate !== baselineDate && <div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>since {comparison.baselineDate}</div>}
  </>;
}

export function HoldTimeView({ overlay, date, unit, reps, zone, onZoneChange, weights, onWeightChange }) {
  const reference = zoneReference(overlay, zone, date);
  const defaultLoad = defaultComparisonLoad(overlay, zone, reference, reps);
  const load = Object.prototype.hasOwnProperty.call(weights, zone) ? weights[zone] : defaultLoad;
  const before = reference ? holdTimeAtForce(reference.amps, load, reference.maxHold) : null;
  const now = holdTimeAtForce(overlay?.ampsByDate?.get(date), load, overlay?.maxHoldByDate?.get(date));
  const estimates = holdTimeSeries(overlay, reference, load, date);
  const matches = reps.filter(rep => rep.date >= reference?.date && rep.date <= date
    && Math.abs(Number(rep.avg_force_kg) - load) < 0.000001).sort((a, b) => b.date.localeCompare(a.date));
  const byDate = new Map(estimates.map(row => [row.date, { ...row }]));
  for (const rep of matches) {
    const row = byDate.get(rep.date) || { date: rep.date, seconds: null };
    row.measured = Math.max(row.measured || 0, Number(rep.actual_time_s));
    byDate.set(rep.date, row);
  }
  const rows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const available = before != null && now != null;
  return <div>
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end", marginBottom: 14 }}>
      <label style={{ display: "grid", gap: 5, fontSize: 13 }}>Domain
        <select aria-label="Hold time domain" value={zone} onChange={e => onZoneChange(e.target.value)} style={controlStyle}>
          {ZONE6.map(z => <option key={z.key} value={z.key}>{z.label}</option>)}
        </select>
      </label>
      <label style={{ display: "grid", gap: 5, fontSize: 13 }}>Fixed weight ({unit})
        <input key={`${zone}-${unit}`} aria-label={`Fixed weight (${unit})`} type="number" min="0.1" step="0.1"
          value={load == null ? "" : Number(toDisp(load, unit).toFixed(1))}
          onChange={e => onWeightChange(zone, e.target.value === "" ? null : fromDisp(Number(e.target.value), unit))}
          style={{ ...controlStyle, width: 125 }} />
      </label>
    </div>
    <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.5, marginBottom: 12 }}>
      Compare estimated hold time at one fixed weight. New workouts do not change this weight.
    </div>
    {available ? <div aria-label="Hold time comparison" style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 30, fontWeight: 800, color: now < before ? C.red : C.text }}>{signed(now - before)}s</div>
      <div style={{ fontSize: 16, color: C.text }}>{fmt1(before)} → {fmt1(now)} seconds at {fmt1(toDisp(load, unit))} {unit}</div>
      <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>Estimated · {reference.date} → {date}</div>
    </div> : <p role="status" style={{ fontSize: 14, color: C.muted, lineHeight: 1.5 }}>
      {!reference ? "No baseline yet for this domain." : "Not enough supported hold-time data at this weight to compare both dates. Choose a weight covered by your recorded pulls."}
    </p>}
    {rows.some(row => row.seconds != null || row.measured != null) && <ResponsiveContainer width="100%" height={210}>
      <LineChart data={rows} margin={{ top: 10, right: 12, bottom: 10, left: 0 }}>
        <CartesianGrid stroke={C.border} strokeDasharray="3 3" />
        <XAxis dataKey="date" tick={{ fill: C.muted, fontSize: 11 }} interval="preserveStartEnd" minTickGap={30}
          tickFormatter={value => new Date(`${value}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })} />
        <YAxis unit="s" width={48} tick={{ fill: C.muted, fontSize: 11 }} />
        <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, color: C.text }} formatter={(value, name) => [`${fmt1(Number(value))}s`, name]} />
        {before != null && <ReferenceLine y={before} stroke={C.muted} strokeDasharray="4 4" />}
        <Line dataKey="seconds" name="Estimated hold time" stroke={C.purple} strokeWidth={3} strokeDasharray="5 3" dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />
        <Line dataKey="measured" name="Longest recorded hold" stroke="none" dot={{ r: 4, fill: C.green, stroke: C.green }} activeDot={{ r: 6 }} connectNulls={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>}
    {rows.some(row => row.seconds != null || row.measured != null) && <div style={{ fontSize: 12, color: C.muted }}>Dashed line: estimated · Green dots: longest recorded holds</div>}
    {matches.length > 0 && <details style={{ marginTop: 10, fontSize: 13 }}>
      <summary style={{ cursor: "pointer", color: C.text }}>Recorded pulls at this weight ({matches.length})</summary>
      <ul style={{ paddingLeft: 20, lineHeight: 1.7 }}>{matches.map((rep, i) => <li key={`${rep.id || rep.session_id}-${i}`}>
        {rep.date} · {rep.hand || "Hand unrecorded"} · {fmt1(Number(rep.actual_time_s))}s
      </li>)}</ul>
      <div style={{ color: C.muted }}>Recorded averages; compare the same hand and setup when judging a change.</div>
    </details>}
  </div>;
}
