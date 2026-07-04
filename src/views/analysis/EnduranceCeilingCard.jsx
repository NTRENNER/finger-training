// ─────────────────────────────────────────────────────────────
// EnduranceCeilingCard — sustained force vs max, over time
// ─────────────────────────────────────────────────────────────
// Two things per grip, tracked across your history:
//   • the "endurance ceiling" — the curve's force at
//     ENDURANCE_CEILING_T (240s, deep slow-component territory),
//     recomputed at each session date from the cumulative fit; and
//   • your measured max — the SMOOTHED peak-force trend (peakForce.js).
// A dual line lets you watch the gap between what you can pull once
// and what you can sustain widen or close, which is the limiter story
// that matters: is endurance catching up to max, or is max pulling
// away? The headline % (current ceiling ÷ current smoothed max) is the
// snapshot; the lines are the trajectory.
//
// Why a dual line, not a single ratio: the ratio is a quotient of a
// MODELED long-duration force and a SPARSE measured peak, so a single
// off max-test day makes the ratio jump for reasons that have nothing
// to do with endurance. Plotting the two series separately keeps the
// (smooth, informative) sustained line readable and lets the max line's
// noise stay visibly its own. We use the SMOOTHED peak trend (not the
// monotonic PR) as the denominator so a rising max reads as a rising
// max, not a falling endurance %.
//
// Honesty gate: for a grip whose longest real hold is shorter than
// ENDURANCE_CEILING_T, the ceiling is extrapolation — we still plot it
// but flag "modeled beyond your Ns longest hold" so it's not read as
// measured. Provisional-peak grips (no max/power session yet) show the
// sustained line but no ratio — dividing by a sub-max peak would lie.
//
// Per-date fits mirror useHistoryOverlay / useAucHistoryByGrip: fresh
// (rep-1) reps up to each date, leak-free per-date prior, three-exp fit.

import React, { useMemo } from "react";
import {
  ResponsiveContainer, LineChart, Line,
  XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
import { C } from "../../ui/theme.js";
import { Card, HandViewPills } from "../../ui/components.js";
import { GRIP_COLORS } from "../../ui/grip-colors.js";
import { fmt1, fmtW, toDisp } from "../../ui/format.js";
import { predForceThreeExp, ENDURANCE_CEILING_T, buildThreeExpPriors } from "../../model/threeExp.js";
import { fitAmpsForPts } from "../../model/baselines.js";
import { effectiveLoad, freshFitReps } from "../../model/load.js";
import { buildPeakForceTrend } from "../../model/peakForce.js";

const T_CEIL = ENDURANCE_CEILING_T;

export function EnduranceCeilingCard({
  history,
  // Hand selector (June 2026): in L/R mode the series run on that
  // hand's fresh reps and that hand's measured peaks.
  handView = "pooled",
  onHandViewChange = null,
  unit = "lbs",
}) {
  const rows = useMemo(() => {
    const split = handView === "L" || handView === "R";
    const scoped = split ? (history || []).filter(r => r?.hand === handView) : (history || []);
    const trend = buildPeakForceTrend(scoped);
    if (!trend) return [];

    // Leak-free per-date prior cache — same priorsAt pattern as the
    // overlay / AUC-history hooks; built once per date across grips.
    const priorCache = new Map();
    const priorsAt = (date) => {
      if (!priorCache.has(date)) priorCache.set(date, buildThreeExpPriors(scoped, { upTo: date }));
      return priorCache.get(date);
    };

    const fresh = freshFitReps(scoped).filter(r => effectiveLoad(r) > 0 && r.actual_time_s > 0);
    const grips = [...new Set(fresh.map(r => r.grip).filter(Boolean))].sort();

    const out = [];
    for (const grip of grips) {
      const gr = fresh.filter(r => r.grip === grip)
        .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
      if (gr.length < 3) continue;
      const maxHold = gr.reduce((m, r) => Math.max(m, r.actual_time_s || 0), 0);
      const dates = [...new Set(gr.map(r => r.date))].sort();

      // Sustained ceiling series — cumulative three-exp fit at each date.
      const susByDate = new Map();
      for (const date of dates) {
        const upTo = gr.filter(r => (r.date || "") <= date);
        const durs = new Set(upTo.map(r => r.target_duration));
        if (upTo.length < 3 || durs.size < 2) continue;   // too thin for a stable fit
        const amps = fitAmpsForPts(
          upTo.map(r => ({ T: r.actual_time_s, F: effectiveLoad(r) })),
          grip,
          priorsAt(date),
        );
        if (!amps) continue;
        const v = predForceThreeExp(amps, T_CEIL);
        if (v > 0) susByDate.set(date, v);
      }
      if (susByDate.size === 0) continue;

      // Max series — SMOOTHED peak trend, fall back to session best.
      const provisional = !!trend.provisional?.[grip];
      const maxByDate = new Map();
      for (const row of trend.rows) {
        const v = provisional ? null : (row[`${grip}_trend`] ?? row[grip] ?? null);
        if (v != null && v > 0) maxByDate.set(row.date, v);
      }

      const allDates = [...new Set([...susByDate.keys(), ...maxByDate.keys()])].sort();
      const data = allDates.map(d => ({
        date: d,
        sus: susByDate.has(d) ? toDisp(susByDate.get(d), unit) : null,
        max: maxByDate.has(d) ? toDisp(maxByDate.get(d), unit) : null,
      }));

      // Snapshot ratio = current ceiling ÷ current SMOOTHED max (the
      // chart's right edge), not the PR.
      const lastSusKg = [...susByDate.values()].pop();
      const lastMaxDate = [...maxByDate.keys()].pop();
      const lastMaxKg = lastMaxDate != null ? maxByDate.get(lastMaxDate) : null;
      const pct = (lastMaxKg > 0) ? Math.round((lastSusKg / lastMaxKg) * 100) : null;

      out.push({
        grip, data, pct, lastSusKg, lastMaxKg,
        maxHold: Math.round(maxHold),
        extrapolated: maxHold < T_CEIL,
        provisional,
      });
    }
    return out.sort((a, b) => a.grip.localeCompare(b.grip));
  }, [history, handView, unit]);

  if (rows.length === 0) return null;

  // Cross-grip comparison line — only when ≥2 grips have a real %.
  const scored = rows.filter(r => r.pct != null);
  const comparison = scored.length >= 2 ? (() => {
    const hi = scored.reduce((m, r) => (r.pct > m.pct ? r : m));
    const lo = scored.reduce((m, r) => (r.pct < m.pct ? r : m));
    if (hi.pct - lo.pct < 3) return null;
    return `${lo.grip} has the wider max-to-sustained gap — its endurance end has relatively more room than ${hi.grip}'s.`;
  })() : null;

  const fmtDate = (d) => (d || "").slice(5);   // MM-DD

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4, flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>
          Endurance ceiling — sustained vs max
          {(handView === "L" || handView === "R") && (
            <span style={{ color: handView === "R" ? C.orange : C.blue, marginLeft: 8, fontSize: 12 }}>
              {handView === "R" ? "Right hand" : "Left hand"}
            </span>
          )}
        </div>
        {onHandViewChange && <HandViewPills value={handView} onChange={onHandViewChange} />}
      </div>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 12, lineHeight: 1.5 }}>
        Your curve's force at {T_CEIL}s (sustained ceiling) tracked against
        your smoothed measured max. A widening gap = raw max pulling ahead
        of endurance; a closing gap = endurance catching up. The % is the
        current ceiling as a share of your current max. Compare across your
        grips, not against outside numbers.
      </div>

      {rows.map((r, i) => {
        const color = GRIP_COLORS[r.grip] || C.blue;
        return (
          <div key={r.grip} style={{
            paddingBottom: i < rows.length - 1 ? 14 : 0,
            borderBottom: i < rows.length - 1 ? `1px solid ${C.border}` : "none",
            marginBottom: i < rows.length - 1 ? 14 : 0,
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6, flexWrap: "wrap", gap: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color }}>{r.grip}</div>
              {r.pct != null ? (
                <div style={{ fontSize: 12, color: C.muted }}>
                  <b style={{ color: C.text, fontSize: 15 }}>{r.pct}%</b> of max
                  <span style={{ marginLeft: 6 }}>
                    · {fmt1(toDisp(r.lastSusKg, unit))} sustained / {fmt1(toDisp(r.lastMaxKg, unit))} max {unit}
                  </span>
                </div>
              ) : (
                <div style={{ fontSize: 11, color: C.muted }}>
                  no measured max yet — do a peak test for the ratio
                </div>
              )}
            </div>

            <ResponsiveContainer width="100%" height={150}>
              <LineChart data={r.data} margin={{ top: 6, right: 12, bottom: 4, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis dataKey="date" tickFormatter={fmtDate} tick={{ fill: C.muted, fontSize: 10 }} minTickGap={24} />
                <YAxis tick={{ fill: C.muted, fontSize: 10 }} width={34} domain={[0, "auto"]} />
                <Tooltip
                  contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }}
                  labelFormatter={(d) => d}
                  formatter={(val, name) => [val == null ? "—" : `${fmtW(val, unit)} ${unit}`, name]}
                />
                <Line dataKey="max" name="Max (smoothed)" stroke={color} strokeWidth={2}
                  dot={false} connectNulls isAnimationActive={false} />
                <Line dataKey="sus" name={`Sustained @${T_CEIL}s`} stroke={C.blue} strokeWidth={2}
                  strokeDasharray="5 4" dot={false} connectNulls isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>

            {r.extrapolated && (
              <div style={{ fontSize: 10, color: C.muted, marginTop: 4, fontStyle: "italic", lineHeight: 1.4 }}>
                Sustained line is modeled beyond your {r.maxHold}s longest hold on this grip — extend your long holds to measure it directly.
              </div>
            )}
          </div>
        );
      })}

      {comparison && (
        <div style={{ fontSize: 11, color: C.muted, marginTop: 10, fontStyle: "italic", lineHeight: 1.4 }}>
          {comparison}
        </div>
      )}
    </Card>
  );
}
