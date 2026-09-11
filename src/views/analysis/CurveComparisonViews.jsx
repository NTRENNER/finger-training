import React from "react";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine } from "recharts";
import { C } from "../../ui/theme.js";
import { toDisp, fmt1 } from "../../ui/format.js";
import { ZONE6, ZONE_REF_T } from "../../model/zones.js";
import { zoneReference, defaultComparisonLoad, holdTimeAtForce, holdTimeSeries, forceComparison, forceHistorySeries } from "../../model/curveComparison.js";

const controlStyle = { background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, padding: "9px 10px", font: "inherit", fontSize: 14, minHeight: 42 };
const signed = value => `${value >= 0 ? "+" : ""}${fmt1(value)}`;

export function ComparisonModeSelector({ mode, onChange }) {
  return <div role="group" aria-label="Curve improvement view" style={{ display: "flex", gap: 6, margin: "12px 0", flexWrap: "wrap" }}>
    {[["percent", "%"], ["weight", "Weight"], ["time", "Time"]].map(([key, label]) =>
      <button type="button" key={key} aria-pressed={mode === key} onClick={() => onChange(key)}
        style={{ ...controlStyle, minWidth: 72, fontWeight: 700, background: mode === key ? C.purple : C.bg, color: mode === key ? "#fff" : C.text }}>{label}</button>)}
  </div>;
}

export function WeightTile({ comparison, unit, baselineDate, color = C.text }) {
  if (!comparison) return <span style={{ fontSize: 12, color: C.muted }}>No baseline yet</span>;
  return <>
    <div style={{ fontSize: 20, fontWeight: 800, color: comparison.delta < 0 ? C.red : color }}>{signed(toDisp(comparison.delta, unit))} {unit}</div>
    <div style={{ fontSize: 12, color: C.text, marginTop: 4 }}>{fmt1(toDisp(comparison.before, unit))} → {fmt1(toDisp(comparison.now, unit))} {unit}</div>
    <div style={{ fontSize: 12, color: C.muted, marginTop: 3 }}>at {comparison.duration}s</div>
    {comparison.baselineDate !== baselineDate && <div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>since {comparison.baselineDate}</div>}
  </>;
}

export function HoldTimeView({ overlay, date, unit, reps, zone, onZoneChange }) {
  const comparisons = ZONE6.map(domain => {
    const reference = zoneReference(overlay, domain.key, date);
    const load = defaultComparisonLoad(overlay, domain.key, reference, reps);
    const before = reference ? holdTimeAtForce(reference.amps, load, reference.maxHold) : null;
    const now = holdTimeAtForce(overlay?.ampsByDate?.get(date), load, overlay?.maxHoldByDate?.get(date));
    return { ...domain, reference, load, before, now, available: before != null && now != null };
  });
  const selected = comparisons.find(domain => domain.key === zone) || comparisons[0];
  const { reference, load, before, now, available } = selected;
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
  return <div>
    <div role="group" aria-label="Hold time domains" style={{
      display: "grid",
      gridTemplateColumns: "repeat(auto-fit, minmax(max(130px, calc((100% - 12px) / 3)), 1fr))",
      gap: 6, marginBottom: 16,
    }}>
      {comparisons.map(domain => (
        <button key={domain.key} type="button" aria-label={`${domain.label} hold time`}
          aria-pressed={selected.key === domain.key} onClick={() => onZoneChange(domain.key)}
          title={domain.available ? `Estimated time change at ${fmt1(toDisp(domain.load, unit))} ${unit}` : "No supported comparison at this weight"}
          style={{
            width: "100%", minHeight: 90, padding: "10px 6px", boxSizing: "border-box",
            borderRadius: 8, cursor: "pointer", fontFamily: "inherit", textAlign: "center",
            border: `1px solid ${selected.key === domain.key ? domain.color : `${domain.color}30`}`,
            background: selected.key === domain.key ? `${domain.color}18` : C.bg,
          }}>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 4 }}>{domain.short}</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: !domain.available ? C.muted : domain.now < domain.before ? C.red : domain.color }}>
            {domain.available ? `${signed(domain.now - domain.before)}s` : "—"}
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>
            {domain.load > 0 ? `at ${fmt1(toDisp(domain.load, unit))} ${unit}` : "—"}
          </div>
        </button>
      ))}
    </div>
    <div style={{ fontSize: 16, fontWeight: 700, color: selected.color, marginBottom: 14 }}>
      {selected.label}{load > 0 ? ` · comparing at ${fmt1(toDisp(load, unit))} ${unit}` : ""}
    </div>
    <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.5, marginBottom: 12 }}>
      Compare estimated hold time at one fixed weight. New workouts do not change this weight.
    </div>
    {available ? <div aria-label="Hold time comparison" style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 30, fontWeight: 800, color: now < before ? C.red : selected.color }}>{signed(now - before)}s</div>
      <div style={{ fontSize: 16, color: C.text }}>{fmt1(before)} → {fmt1(now)} seconds at {fmt1(toDisp(load, unit))} {unit}</div>
      <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>Estimated · {reference.date} → {date}</div>
    </div> : <p role="status" style={{ fontSize: 14, color: C.muted, lineHeight: 1.5 }}>
      {!reference ? "No baseline yet for this domain." : "Not enough supported hold-time data at this weight to compare both dates. The baseline weight stays fixed as more training data becomes available."}
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


export function WeightHistoryView({ overlay, date, unit, reps, zone, onShowSessions }) {
  const domain = ZONE6.find(item => item.key === zone);
  const comparison = forceComparison(overlay, zone, date);
  const duration = ZONE_REF_T[zone];
  const rowsByDate = new Map(forceHistorySeries(overlay, zone, date)
    .map(row => [row.date, { date: row.date, force: row.force == null ? null : toDisp(row.force, unit) }]));
  for (const rep of reps) {
    if (!comparison || rep.date < comparison.baselineDate || rep.date > date
      || Math.abs(Number(rep.actual_time_s) - duration) > 0.000001) continue;
    const row = rowsByDate.get(rep.date) || { date: rep.date, force: null };
    row.measured = Math.max(row.measured || 0, toDisp(Number(rep.avg_force_kg), unit));
    rowsByDate.set(rep.date, row);
  }
  const rows = [...rowsByDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  return <div aria-label={`${domain.label} weight over time`}>
    <div style={{ fontSize: 16, color: domain.color, fontWeight: 700, marginBottom: 8 }}>{domain.label} · {duration}s holds</div>
    {comparison ? <>
      <div aria-label="Weight progress comparison" style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 30, fontWeight: 800, color: comparison.delta < 0 ? C.red : domain.color }}>{signed(toDisp(comparison.delta, unit))} {unit}</div>
        <div style={{ fontSize: 16, color: C.text }}>{fmt1(toDisp(comparison.before, unit))} → {fmt1(toDisp(comparison.now, unit))} {unit} at {duration} seconds</div>
        <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>Estimated · {comparison.baselineDate} → {date}</div>
      </div>
      <ResponsiveContainer width="100%" height={210}>
        <LineChart data={rows} margin={{ top: 10, right: 12, bottom: 10, left: 0 }}>
          <CartesianGrid stroke={C.border} strokeDasharray="3 3" />
          <XAxis dataKey="date" interval="preserveStartEnd" minTickGap={30} tick={{ fill: C.muted, fontSize: 11 }}
            tickFormatter={value => new Date(`${value}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })} />
          <YAxis width={64} unit={` ${unit}`} tick={{ fill: C.muted, fontSize: 11 }} />
          <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, color: C.text }}
            formatter={(value, name) => [`${fmt1(Number(value))} ${unit}`, name]} />
          <ReferenceLine y={toDisp(comparison.before, unit)} stroke={C.muted} strokeDasharray="4 4" />
          <Line dataKey="force" name={`Estimated weight at ${duration}s`} stroke={domain.color} strokeWidth={3} strokeDasharray="5 3" dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />
          <Line dataKey="measured" name={`Highest recorded weight at ${duration}s`} stroke="none" dot={{ r: 4, fill: C.green, stroke: C.green }} connectNulls={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>Dashed line: estimated · Green dots: recorded holds at {duration}s</div>
    </> : <p role="status" style={{ color: C.muted, fontSize: 14 }}>No supported baseline comparison for this domain yet.</p>}
    {onShowSessions && <button type="button" onClick={onShowSessions} style={controlStyle}>View {domain.label} sessions</button>}
  </div>;
}
