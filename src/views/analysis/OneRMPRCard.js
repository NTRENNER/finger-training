// ─────────────────────────────────────────────────────────────
// 1RM PR TRACKER CARD
// ─────────────────────────────────────────────────────────────
// Standalone card showing per-grip 1RM personal-record progress.
// Reads from the `activities` log (entries of type "oneRM"), groups
// by grip and date, plots one line per grip on a small dual-line
// chart, and flags "🎉 PR today!" when the latest measurement
// equals the all-time max.
//
// The card auto-hides if there are no oneRM activities, and the
// chart auto-hides if there's only a single date (nothing to plot).
//
// Extracted from AnalysisView so that file can shed weight; nothing
// else in the app needs this card. Pure props in / JSX out — no
// state, no effects.

import React from "react";
import {
  ResponsiveContainer, LineChart, Line,
  XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
import { C } from "../../ui/theme.js";
import { Card } from "../../ui/components.js";
import { fmt1, fmtW, toDisp } from "../../ui/format.js";

// Per-grip color — kept local rather than imported from
// AnalysisView's GRIP_COLORS map, since this card stands alone and
// shouldn't reach into a sibling view for a 2-key constant.
// Same shape, same values; if either drifts, the visual stops
// matching the F-D chart's split mode and we'll catch it visually.
const GRIP_COLORS = { Micro: "#e05560", Crusher: C.orange };

export function OneRMPRCard({ activities = [], rmGrips = [], unit = "lbs" }) {
  const rmReps = activities.filter(a => a.type === "oneRM" && a.weight_kg > 0);
  if (rmReps.length === 0) return null;

  const allDates = [...new Set(rmReps.map(a => a.date))].sort();
  const gripData = {};
  for (const g of rmGrips) {
    const byDate = {};
    for (const a of rmReps.filter(r => r.grip === g || (!r.grip && g === "Micro"))) {
      if (!byDate[a.date] || a.weight_kg > byDate[a.date]) byDate[a.date] = a.weight_kg;
    }
    if (Object.keys(byDate).length > 0) {
      gripData[g] = {
        pr: Math.max(...Object.values(byDate)),
        latest: byDate[allDates.filter(d => byDate[d]).at(-1)] ?? 0,
        byDate,
      };
    }
  }
  if (Object.keys(gripData).length === 0) return null;

  // One row per date, one column per grip.
  const chartData = allDates.map(date => {
    const row = { date };
    for (const g of rmGrips) {
      if (gripData[g]?.byDate[date]) row[g] = toDisp(gripData[g].byDate[date], unit);
    }
    return row;
  });
  const hasChart = chartData.length >= 2;

  return (
    <Card style={{ marginBottom: 16, border: `1px solid ${"#e05560"}30` }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>🏋️ 1RM Progress</div>

      {/* PR summary per grip */}
      <div style={{ display: "flex", gap: 16, marginBottom: 12 }}>
        {rmGrips.filter(g => gripData[g]).map(g => {
          const { pr, latest } = gripData[g];
          const isPR = latest >= pr;
          return (
            <div key={g}>
              <div style={{ fontSize: 11, color: C.muted }}>{g} PR</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: GRIP_COLORS[g], lineHeight: 1.1 }}>
                {fmtW(pr, unit)} {unit}
              </div>
              {isPR && chartData.length > 1 && (
                <div style={{ fontSize: 11, color: GRIP_COLORS[g], fontWeight: 600 }}>🎉 PR today!</div>
              )}
            </div>
          );
        })}
      </div>

      {hasChart && (
        <ResponsiveContainer width="100%" height={110}>
          <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
            <XAxis dataKey="date" tick={{ fill: C.muted, fontSize: 9 }}
              tickFormatter={d => d.slice(5)} interval="preserveStartEnd" />
            <YAxis hide domain={["auto", "auto"]} />
            <Tooltip
              contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }}
              formatter={(v, name) => [`${fmt1(v)} ${unit}`, name]}
              labelFormatter={d => d}
            />
            {rmGrips.filter(g => gripData[g]).map(g => (
              <Line key={g} type="monotone" dataKey={g}
                stroke={GRIP_COLORS[g]} strokeWidth={2.5}
                dot={{ r: 3, fill: GRIP_COLORS[g] }} connectNulls />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
      <div style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>
        Max single effort · logged pre-climb
      </div>
    </Card>
  );
}
