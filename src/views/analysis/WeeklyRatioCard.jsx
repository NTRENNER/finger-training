// ──────────────────────────────────────────────────────────────
// WEEKLY HOLD-RATIO CARD  (Analysis tab)
// ──────────────────────────────────────────────────────────────
// "Am I outlasting my targets?" — one line per grip, week by week.
// Built (July 2026, per Nathan) after the scheduled coach reported
// "mean actual/target ratio climbed 0.85 → 1.04 (L)" as a two-point
// month comparison: this chart shows the SAME metric continuously.
//
// y = weekly mean of actual_time_s / target_duration, per grip. The
// dashed 1.0 line is "held exactly to target": above it you're
// outlasting the engine's prescriptions (amplitude lifting), below it
// targets are winning.
//
// DEFAULT = OPENERS (rep 1 of set 1) — the fresh rep, the same
// cleanest-signal rep the β learner and the ladder re-pin guard read.
// Validated on the real export: opener means sit around 1.0 and track
// capacity events; the all-reps mean is dragged to 0.3-0.6 in
// high-rep weeks because density-ladder reps 2+ fall short BY DESIGN
// (short rests), so it measures protocol mix. "All reps" stays as a
// toggle — it's the check-in perf signal's estimator.
//
// Instead of a week-scrubbing slider (Nathan's first idea), the whole
// timeline is visible at once — the trend IS the point — and tapping
// any week pins its receipts below the chart: per-grip mean, rep
// count, and the L/R split. Hover/tooltip gives the quick read; the
// pinned strip is the phone-friendly "let me look at that week"
// interaction a slider would have provided, without hiding the rest
// of the timeline while you do it.
//
// Quiet weeks stay on the axis as gaps (buildWeeklyRatio emits every
// calendar week), so a 3-week break reads as a 3-week break. Lines
// connect across the gaps; the dots mark weeks with actual data.
import React, { useMemo, useState } from "react";
import {
  ResponsiveContainer, ComposedChart, Line,
  XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine,
} from "recharts";
import { C } from "../../ui/theme.js";
import { Card } from "../../ui/components.js";
import { GRIP_COLORS } from "../../ui/grip-colors.js";
import { buildWeeklyRatio } from "../../model/weeklyRatio.js";

const HANDS = ["All", "L", "R"];
const MODES = [["openers", "Openers"], ["all", "All reps"]];

function fmtWeek(ymd) {
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function WeeklyRatioCard({ history = [] }) {
  const [hand, setHand] = useState("All");
  const [mode, setMode] = useState("openers");
  const [pinnedWeek, setPinnedWeek] = useState(null);

  const { grips, weeks } = useMemo(
    () => buildWeeklyRatio(history, { repsMode: mode }),
    [history, mode]
  );

  // Chart rows: one field per grip, respecting the hand filter.
  const rows = useMemo(() => weeks.map((w) => {
    const row = { week: w.week, label: fmtWeek(w.week) };
    for (const g of grips) {
      const b = w.byGrip[g];
      row[g] = b == null ? null : (hand === "All" ? b.mean : b.hands[hand].mean);
    }
    return row;
  }), [weeks, grips, hand]);

  // Need at least two weeks with data for a trend to mean anything.
  const dataWeeks = weeks.filter((w) => Object.keys(w.byGrip).length > 0);
  if (dataWeeks.length < 2) return null;

  const pinned = pinnedWeek ? weeks.find((w) => w.week === pinnedWeek) : null;
  const pinnedGrips = pinned ? grips.filter((g) => pinned.byGrip[g]) : [];

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4, flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>
          Weekly hold ratio — actual ÷ target, per grip
        </div>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {MODES.map(([key, label]) => (
            <button key={key} onClick={() => setMode(key)} style={{
              padding: "3px 10px", borderRadius: 20, fontSize: 11, cursor: "pointer", border: "none", fontWeight: 600,
              background: mode === key ? C.green : C.border,
              color:      mode === key ? "#fff" : C.muted,
            }}>{label}</button>
          ))}
          <span style={{ width: 6 }} />
          {HANDS.map((h) => (
            <button key={h} onClick={() => setHand(h)} style={{
              padding: "3px 10px", borderRadius: 20, fontSize: 11, cursor: "pointer", border: "none", fontWeight: 600,
              background: hand === h ? C.blue : C.border,
              color:      hand === h ? "#fff" : C.muted,
            }}>{h}</button>
          ))}
        </div>
      </div>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>
        {mode === "openers"
          ? <>Each point is that week's mean opening-rep hold ÷ target — the fresh rep of each session, the cleanest capacity signal. </>
          : <>Each point is that week's mean hold ÷ target across every loaded rep — the check-in's estimator. Ladder reps 2+ run short by design, so this reads lower than Openers in high-rep weeks. </>}
        Above the dashed 1.0 line you're outlasting the engine's targets — usually curve amplitude lifting;
        below it, targets are winning. Tap a week for its receipts. Gaps are weeks with no qualifying reps.
      </div>
      <ResponsiveContainer width="100%" height={210}>
        <ComposedChart
          data={rows}
          margin={{ top: 6, right: 8, bottom: 28, left: 0 }}
          onClick={(st) => {
            const wk = st && st.activeLabel != null && st.activePayload && st.activePayload.length
              ? rows.find((r) => r.label === st.activeLabel) : null;
            setPinnedWeek(wk ? (wk.week === pinnedWeek ? null : wk.week) : null);
          }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
          <XAxis dataKey="label" tick={{ fill: C.muted, fontSize: 9 }} angle={-30} textAnchor="end" interval="preserveStartEnd"
            label={{ value: "Week of", position: "insideBottom", offset: -18, fill: C.muted, fontSize: 11 }} />
          <YAxis tick={{ fill: C.muted, fontSize: 11 }} width={40} domain={["auto", "auto"]}
            label={{ value: "hold ÷ target", angle: -90, position: "insideLeft", fill: C.muted, fontSize: 11 }} />
          {/* 1.0 = held exactly to prescription. */}
          <ReferenceLine y={1} stroke={C.muted} strokeDasharray="4 3" strokeOpacity={0.8} />
          <Tooltip
            contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }}
            formatter={(val, name) => [val == null ? "—" : `${val}×`, name]}
            labelFormatter={(l) => `Week of ${l}`}
          />
          {grips.map((g) => (
            <Line key={g} dataKey={g} stroke={GRIP_COLORS[g] || C.blue} strokeWidth={2.5} connectNulls
              dot={{ r: 3, fill: GRIP_COLORS[g] || C.blue, stroke: "none" }} activeDot={{ r: 5 }}
              name={g} isAnimationActive={false} />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
      <div style={{ display: "flex", justifyContent: "center", gap: 16, marginTop: 4, fontSize: 10, color: C.muted }}>
        {grips.map((g) => (
          <span key={g} style={{ color: GRIP_COLORS[g] || C.blue }}>━ {g}</span>
        ))}
      </div>

      {/* Pinned-week receipts: what a scrubbing slider would have shown,
          without hiding the timeline. Tap the same week again to unpin. */}
      {pinned && pinnedGrips.length > 0 && (
        <div style={{ marginTop: 10, padding: "8px 10px", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: C.muted, marginBottom: 4 }}>
            Week of {fmtWeek(pinned.week)}
          </div>
          {pinnedGrips.map((g) => {
            const b = pinned.byGrip[g];
            const handBit = (hd) => b.hands[hd].mean != null ? `${hd} ${b.hands[hd].mean}× (${b.hands[hd].n})` : null;
            const parts = [handBit("L"), handBit("R")].filter(Boolean).join(" · ");
            return (
              <div key={g} style={{ fontSize: 12, color: C.text, marginTop: 2 }}>
                <span style={{ color: GRIP_COLORS[g] || C.blue, fontWeight: 700 }}>{g}</span>
                {" — "}mean {b.mean}× across {b.n} rep{b.n === 1 ? "" : "s"}{parts ? ` · ${parts}` : ""}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
