// ─────────────────────────────────────────────────────────────
// CAPACITY CHART CARDS — Total Capacity (AUC) trajectory + shape
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
// <ZoneShareCard> — how the curve's capacity DISTRIBUTES across the
//   power / strength / endurance regions over time (June 2026, idea
//   borrowed from community dashboards' "zone weight" charts). The
//   trajectory says how much the curve grew; this says where.
//
// (CapacityAbsoluteCard — raw kg·s sibling — was dropped May 2026:
//  magnitude is already visible on the F-D chart and Strength Balance
//  card, the kg·s axis unit is opaque, and the % version tells the
//  actual training-progress story.)
//
// Extracted from AnalysisView May 2026 (decomp pass).
//
// Inputs (props):
//   aucHistoryByGrip — {
//     grips: ["Micro", "Crusher"],
//     hasPct: boolean,            // % rows have post-baseline data
//     pctRows: [...],             // raw % per session
//     pctRowsBW: [...],           // same, normalized to BW
//     absRows: [...],             // absolute kg·s per session
//     shareRows: [...],           // per-grip zone shares per session
//   }
//   normalizeOn — bool (CapacityTrajectoryCard only) — render BW-
//                 normalized rows instead of raw % when true.
//   activities  — climb log entries (CapacityTrajectoryCard only) —
//                 drives the climbing-load strip.

import React, { useMemo, useState } from "react";
import {
  ResponsiveContainer, LineChart, ComposedChart, Line, Bar,
  XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine,
} from "recharts";
import { C } from "../../ui/theme.js";
import { Card } from "../../ui/components.js";
import { GRIP_COLORS } from "../../ui/grip-colors.js";
import { suggestCookedFromClimbs } from "../../model/climbingFatigue.js";

export function CapacityTrajectoryCard({ aucHistoryByGrip, normalizeOn, activities = [] }) {
  // Climbing-load strip: the same same-day + decayed-yesterday
  // estimate that pre-fills the cookedness slider, evaluated at each
  // plotted session date. Computed before any early return so the
  // hook order stays stable across renders.
  const rows = useMemo(() => {
    if (!aucHistoryByGrip || !aucHistoryByGrip.hasPct) return null;
    const src = normalizeOn ? aucHistoryByGrip.pctRowsBW : aucHistoryByGrip.pctRows;
    return src.map(r => {
      const climb = suggestCookedFromClimbs(activities, r.date);
      return { ...r, climbLoad: climb && climb.cooked > 0 ? climb.cooked : null };
    });
  }, [aucHistoryByGrip, normalizeOn, activities]);

  if (!rows) return null;
  const hasClimb = rows.some(r => r.climbLoad != null);

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>
        Total Capacity (Area Under the Curve) — % vs baseline
        {normalizeOn && <span style={{ color: C.purple, fontSize: 12, marginLeft: 6 }}>· × BW</span>}
      </div>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>
        {normalizeOn
          ? "Same metric, normalized to bodyweight at each session date. Bold line is a 3-session rolling mean to read trend through noise; dots are the raw per-session values."
          : "Same metric as a percentage above each grip's baseline. Bold line is a 3-session rolling mean to read trend through noise; dots are the raw per-session values."}
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
          {aucHistoryByGrip.grips.flatMap(g => {
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
        {aucHistoryByGrip.grips.map(g => (
          <span key={g} style={{ color: GRIP_COLORS[g] || C.blue }}>━ {g}</span>
        ))}
        {hasClimb && <span style={{ color: C.orange, opacity: 0.7 }}>▮ climbing load</span>}
      </div>
    </Card>
  );
}

// Colors for the three share buckets — match the ZONE6 palette ends
// (power red, strength orange, endurance blue) so the buckets read
// consistently with the Curve Improvement tiles and Curve Coverage.
const SHARE_SERIES = [
  { key: "power",     label: "Power (≤50s)",      color: "#e05560" },
  { key: "strength",  label: "Strength (50–140s)", color: "#e07a30" },
  { key: "endurance", label: "Endurance (140s+)",  color: "#3b82f6" },
];

export function ZoneShareCard({ aucHistoryByGrip }) {
  // Per-grip pill — shares are a per-grip shape property; overlaying
  // multiple grips' three lines each is unreadable.
  const grips = aucHistoryByGrip?.grips || [];
  const [selGrip, setSelGrip] = useState(null);
  const grip = selGrip && grips.includes(selGrip) ? selGrip : grips[0];

  if (!aucHistoryByGrip || !aucHistoryByGrip.hasPct || grips.length === 0) return null;
  const rows = aucHistoryByGrip.shareRows;
  if (!rows || !rows.some(r => r[`${grip}_power`] != null)) return null;

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4, flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>Capacity shape — zone share over time</div>
        {grips.length > 1 && (
          <div style={{ display: "flex", gap: 4 }}>
            {grips.map(g => (
              <button key={g} onClick={() => setSelGrip(g)} style={{
                padding: "3px 10px", borderRadius: 20, fontSize: 11, cursor: "pointer", border: "none", fontWeight: 600,
                background: grip === g ? (GRIP_COLORS[g] || C.blue) : C.border,
                color:      grip === g ? "#fff" : C.muted,
              }}>{g}</button>
            ))}
          </div>
        )}
      </div>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>
        Where the curve's capacity sits — the share of the balanced
        score coming from each region. The Total Capacity chart says
        how much the curve grew; this says where. A rising endurance
        share with a flat power share means the gains of that block
        came from the long end.
      </div>
      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={rows} margin={{ top: 6, right: 14, bottom: 28, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
          <XAxis dataKey="date" tick={{ fill: C.muted, fontSize: 9 }} angle={-30} textAnchor="end" interval="preserveStartEnd" />
          <YAxis tick={{ fill: C.muted, fontSize: 11 }} width={44} unit="%" domain={[0, 60]} />
          <Tooltip
            contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }}
            formatter={(val, name) => [val == null ? "—" : `${val}%`, name]}
          />
          {SHARE_SERIES.map(s => (
            <Line key={s.key} dataKey={`${grip}_${s.key}`} name={s.label}
              stroke={s.color} strokeWidth={2} dot={false} connectNulls
              isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
      <div style={{ display: "flex", justifyContent: "space-around", marginTop: 4, fontSize: 10 }}>
        {SHARE_SERIES.map(s => (
          <span key={s.key} style={{ color: s.color }}>━ {s.label}</span>
        ))}
      </div>
    </Card>
  );
}
