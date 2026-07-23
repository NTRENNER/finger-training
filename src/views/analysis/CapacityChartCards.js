// ─────────────────────────────────────────────────────────────
// CAPACITY CHART CARD — whole-curve capacity trajectory
// ─────────────────────────────────────────────────────────────
// <CapacityTrajectoryCard> — % vs baseline, per-grip, with a
//   3-session rolling-mean trend line over the raw points, and a
//   climbing-load bar strip along the bottom (June 2026) so dips and
//   plateaus can be read against same-day/yesterday climbing instead
//   of being mistaken for detraining. The headline trajectory card;
//   renders right under Curve Improvement in Analysis so the user
//   pivots from "where the gains came from" (zones) to "when they
//   showed up" (over time).
//
// (CapacityAbsoluteCard — raw kg·s sibling — was dropped May 2026:
//  magnitude is already visible on the F-D chart and Strength Balance
//  card, the kg·s axis unit is opaque, and the % version tells the
//  actual training-progress story.)
//
// Extracted from AnalysisView May 2026 (decomp pass).
//
// Inputs (props):
//   capacityHistoryByGrip — {
//     grips: ["Micro", "Crusher"],
//     hasPct: boolean,            // % rows have post-baseline data
//     pctRows: [...],             // raw % per session
//     pctRowsBW: [...],           // same, normalized to BW
//   }
//   normalizeOn — bool (CapacityTrajectoryCard only) — render BW-
//                 normalized rows instead of raw % when true.
//   activities  — climb log entries (CapacityTrajectoryCard only) —
//                 drives the climbing-load strip.

import React, { useMemo } from "react";
import {
  ResponsiveContainer, ComposedChart, Line, Bar,
  XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine,
} from "recharts";
import { C } from "../../ui/theme.js";
import { Card, HandViewPills } from "../../ui/components.js";
import { GRIP_COLORS } from "../../ui/grip-colors.js";
import { suggestCookedFromClimbs } from "../../model/climbingFatigue.js";
import { buildCapacityChanges } from "../../model/capacityTrend.js";
import { today } from "../../util.js";

export function CapacityTrajectoryCard({
  capacityHistoryByGrip, normalizeOn, activities = [],
  // Global hand-view state, repeated as a local control (June 2026).
  handView = "pooled", onHandViewChange = null,
}) {
  const asOfDate = today();
  // Climbing-load strip: the same same-day + decayed-yesterday
  // estimate that pre-fills the cookedness slider, evaluated at each
  // plotted session date. Computed before any early return so the
  // hook order stays stable across renders.
  const rows = useMemo(() => {
    if (!capacityHistoryByGrip || !capacityHistoryByGrip.hasPct) return null;
    const src = normalizeOn ? capacityHistoryByGrip.pctRowsBW : capacityHistoryByGrip.pctRows;
    return src.map(r => {
      const climb = suggestCookedFromClimbs(activities, r.date);
      return { ...r, climbLoad: climb && climb.cooked > 0 ? climb.cooked : null };
    });
  }, [capacityHistoryByGrip, normalizeOn, activities]);
  const capacityChanges = useMemo(
    () => buildCapacityChanges(rows, capacityHistoryByGrip?.grips || [], 28, asOfDate),
    [rows, capacityHistoryByGrip, asOfDate]
  );

  if (!rows) return null;
  const hasClimb = rows.some(r => r.climbLoad != null);

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4, flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>
          Whole-Curve Capacity — % vs baseline
          {normalizeOn && <span style={{ color: C.purple, fontSize: 12, marginLeft: 6 }}>· × BW</span>}
          {handView !== "pooled" && (
            <span style={{ color: handView === "R" ? C.orange : C.blue, fontSize: 12, marginLeft: 6 }}>
              · {handView === "R" ? "Right hand" : "Left hand"}
            </span>
          )}
        </div>
        {onHandViewChange && <HandViewPills value={handView} onChange={onHandViewChange} />}
      </div>
      {capacityChanges.length > 0 && (
        <div
          aria-label="28-day capacity change"
          style={{
            display: "grid",
            gap: 5,
            padding: "9px 0",
            marginBottom: 8,
            borderTop: `1px solid ${C.border}`,
            borderBottom: `1px solid ${C.border}`,
            fontSize: 12,
          }}
        >
          {capacityChanges.map(({ grip, changePct }) => {
            const flat = Math.abs(changePct) < 0.5;
            const direction = flat ? "essentially flat" : changePct > 0 ? "up" : "down";
            const color = flat ? C.muted : changePct > 0 ? C.green : C.red;
            return (
              <div key={grip}>
                <span style={{ color: GRIP_COLORS[grip] || C.blue, fontWeight: 700 }}>{grip}</span>
                {" whole-curve capacity is "}
                <span style={{ color, fontWeight: 700 }}>
                  {direction}{flat ? "" : ` ${Math.abs(changePct).toFixed(1)}%`}
                </span>
                {" over 28 days."}
              </div>
            );
          })}
        </div>
      )}
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>
        {normalizeOn
          ? "Balanced capacity across the force-duration curve, normalized to bodyweight at each session date. Bold line is a 3-session rolling mean; dots are raw per-session estimates."
          : "Balanced capacity across the force-duration curve, shown relative to each grip's baseline. Bold line is a 3-session rolling mean; dots are raw per-session estimates."}
        {hasClimb && " Orange bars along the bottom are climbing load around that session (same-day + decayed yesterday, 0–10) — read dips against them before calling a plateau."}
      </div>
      <ResponsiveContainer width="100%" height={hasClimb ? 230 : 200}>
        <ComposedChart data={rows} margin={{ top: 6, right: 14, bottom: 28, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
          <XAxis dataKey="date" tick={{ fill: C.muted, fontSize: 9 }} angle={-30} textAnchor="end" interval="preserveStartEnd"
            label={{ value: "Date", position: "insideBottom", offset: -18, fill: C.muted, fontSize: 11 }} />
          <ReferenceLine y={0} yAxisId="pct" stroke={C.muted} strokeWidth={2}
            label={{ value: "baseline", position: "insideRight", fill: C.muted, fontSize: 10 }} />
          <YAxis yAxisId="pct" tick={{ fill: C.muted, fontSize: 11 }} width={48} unit="%"
            label={{ value: "vs baseline", angle: -90, position: "insideLeft", fill: C.muted, fontSize: 11 }} />
          {/* Hidden axis for the climbing-load strip: domain 0–40 keeps
              a 10/10 climbing day inside the bottom quarter of the
              chart so the bars never collide with the % lines. */}
          <YAxis yAxisId="climb" hide domain={[0, 40]} />
          <Tooltip
            contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }}
            formatter={(val, name) => name === "climbing load"
              ? [val == null ? "—" : `${val}/10`, name]
              : [val == null ? "—" : `${val >= 0 ? "+" : ""}${val}%`, name]}
          />
          {hasClimb && (
            <Bar yAxisId="climb" dataKey="climbLoad" name="climbing load"
              fill={C.orange} opacity={0.45} barSize={5}
              legendType="none" isAnimationActive={false} />
          )}
          {capacityHistoryByGrip.grips.flatMap(g => {
            const color = GRIP_COLORS[g] || C.blue;
            return [
              // Raw values: dots only, no connecting line.
              <Line key={`${g}_raw`} yAxisId="pct" dataKey={`${g}_pct`} stroke="none"
                dot={{ r: 3, fill: color, stroke: color }} activeDot={{ r: 4 }}
                legendType="none" name={`${g} (raw)`} isAnimationActive={false} />,
              // Smoothed trend: bold line, no dots.
              <Line key={`${g}_sm`} yAxisId="pct" dataKey={`${g}_pct_sm`} stroke={color}
                strokeWidth={3} dot={false} connectNulls name={g}
                isAnimationActive={false} />,
            ];
          })}
        </ComposedChart>
      </ResponsiveContainer>
      <div style={{ display: "flex", justifyContent: "space-around", marginTop: 4, fontSize: 10, color: C.muted }}>
        {capacityHistoryByGrip.grips.map(g => (
          <span key={g} style={{ color: GRIP_COLORS[g] || C.blue }}>━ {g}</span>
        ))}
        {hasClimb && <span style={{ color: C.orange, opacity: 0.7 }}>▮ climbing load</span>}
      </div>
    </Card>
  );
}
