// ─────────────────────────────────────────────────────────────
// EnduranceCeilingCard — measured sustained holds vs measured max
// ─────────────────────────────────────────────────────────────
// (File/export name kept for wiring stability; the card's identity is
// now "Sustained vs max — measured".)
//
// REWORKED July 2026 (per Nathan): the previous version plotted the
// three-exp curve's modeled F(240s) against the measured max. Nathan
// called the coupling: the modeled tail inherits the curve's overall
// amplitude, so a max gain lifts the extrapolated 240s value through
// the fit's prior/shrinkage even with zero endurance change — the
// ratio was partially self-referential (the same structural critique
// that retired the original F(180)/F(5) card in May 2026, half-fixed
// by measuring the denominator but not the numerator). And the tail
// region is exactly where the July 2026 endurance-ceiling work showed
// the model runs hot.
//
// Now BOTH series are measurements:
//   • solid line — smoothed measured max (peak tests, peakForce.js),
//     unchanged;
//   • dots + dashed line — the heaviest load actually held ≥120s on
//     each date (sustainedHolds.js: Tindeq-measured, seed-artifacts
//     excluded, manual/nominal loads excluded). No model anywhere.
//
// The headline % is the best qualifying hold in the last 90 days as a
// share of the current smoothed max — a demonstrated lower bound, so
// it's annotated with the hold that earned it (load × duration, date).
// Honesty notes: a stale max test or a stale long hold is flagged
// instead of silently divided by. Grips with measured reps but no
// ≥120s hold yet (e.g. Prime) get one quiet line, not a fake panel.
//
// The old cross-grip "wider gap" comparison line is gone: each grip's
// % now reads at ITS best hold's duration (163s vs 230s are different
// claims), so cross-grip ratio comparisons would mislead. Compare each
// grip against itself over time.

import React, { useMemo } from "react";
import {
  ResponsiveContainer, LineChart, Line,
  XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
import { C } from "../../ui/theme.js";
import { Card, HandViewPills } from "../../ui/components.js";
import { GRIP_COLORS } from "../../ui/grip-colors.js";
import { fmt1, fmtW, toDisp } from "../../ui/format.js";
import { buildPeakForceTrend, maxTestStaleness, MAX_TEST_STALE_DAYS } from "../../model/peakForce.js";
import {
  buildSustainedHolds, bestHoldSince, lastHold,
  SUSTAINED_MIN_S, SUSTAINED_RECENT_D,
} from "../../model/sustainedHolds.js";
import { today } from "../../util.js";

function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
}
function fmtShortDate(ymd) {
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function EnduranceCeilingCard({
  history,
  // Hand selector (June 2026): in L/R mode the series run on that
  // hand's holds and that hand's measured peaks.
  handView = "pooled",
  onHandViewChange = null,
  unit = "lbs",
}) {
  const todayStr = today();
  const { rows, quiet } = useMemo(() => {
    const split = handView === "L" || handView === "R";
    const scoped = split ? (history || []).filter(r => r?.hand === handView) : (history || []);
    const sustained = buildSustainedHolds(scoped, { hand: null });  // already scoped
    const trend = buildPeakForceTrend(scoped);
    const recentFrom = addDays(todayStr, -SUSTAINED_RECENT_D);

    const rows = [];
    for (const grip of Object.keys(sustained.grips)) {
      const { holds, longestHoldS } = sustained.grips[grip];

      // Max series — SMOOTHED peak trend; provisional grips (no real
      // max/power session) get holds but no ratio.
      const provisional = !trend || !!trend.provisional?.[grip];
      const maxByDate = new Map();
      if (trend && !provisional) {
        for (const row of trend.rows) {
          const v = row[`${grip}_trend`] ?? row[grip] ?? null;
          if (v != null && v > 0) maxByDate.set(row.date, v);
        }
      }

      const holdByDate = new Map(holds.map(h => [h.date, h]));
      const allDates = [...new Set([...holdByDate.keys(), ...maxByDate.keys()])].sort();
      // Series stay in KG here — display conversion happens at render
      // so the unit toggle doesn't re-run the memo.
      const data = allDates.map(d => ({
        date: d,
        hold: holdByDate.has(d) ? holdByDate.get(d).loadKg : null,
        holdS: holdByDate.has(d) ? holdByDate.get(d).holdS : null,
        max: maxByDate.has(d) ? maxByDate.get(d) : null,
      }));

      // Ratio: best hold in the trailing window ÷ current smoothed max.
      // Nothing recent → fall back to the last hold ever, flagged stale.
      const recent = bestHoldSince(holds, recentFrom);
      const ref = recent || lastHold(holds);
      const refStale = !recent && ref ? daysBetween(ref.date, todayStr) : null;
      const lastMaxDate = [...maxByDate.keys()].pop();
      const lastMaxKg = lastMaxDate != null ? maxByDate.get(lastMaxDate) : null;
      const pct = ref && lastMaxKg > 0 ? Math.round((ref.loadKg / lastMaxKg) * 100) : null;

      const staleness = maxTestStaleness(scoped.filter(r => r?.grip === grip), todayStr);

      rows.push({
        grip, data, pct, ref, refStale, lastMaxKg, longestHoldS,
        provisional,
        maxStaleDays: staleness.recommended ? staleness.staleDays : null,
      });
    }
    return { rows: rows.sort((a, b) => a.grip.localeCompare(b.grip)), quiet: sustained.quiet };
  }, [history, handView, todayStr]);

  if (rows.length === 0 && quiet.length === 0) return null;

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4, flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>
          Sustained vs max — measured
          {(handView === "L" || handView === "R") && (
            <span style={{ color: handView === "R" ? C.orange : C.blue, marginLeft: 8, fontSize: 12 }}>
              {handView === "R" ? "Right hand" : "Left hand"}
            </span>
          )}
        </div>
        {onHandViewChange && <HandViewPills value={handView} onChange={onHandViewChange} />}
      </div>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 12, lineHeight: 1.5 }}>
        Both series are measurements — no curve model. Solid line: your
        smoothed measured max from peak tests. Dots: the heaviest load you
        actually held for ≥{SUSTAINED_MIN_S}s that day. The % is your best
        such hold in the last {SUSTAINED_RECENT_D} days as a share of your
        current max — a demonstrated lower bound, annotated with the hold
        that earned it. Hold durations differ between grips, so compare each
        grip against itself over time, not grip vs grip.
      </div>

      {rows.map((r, i) => {
        const color = GRIP_COLORS[r.grip] || C.blue;
        // kg → display units (the memo above is unit-agnostic).
        const data = r.data.map(p => ({
          ...p,
          hold: p.hold != null ? toDisp(p.hold, unit) : null,
          max: p.max != null ? toDisp(p.max, unit) : null,
        }));
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
                    · {fmt1(toDisp(r.ref.loadKg, unit))} {unit} × {r.ref.holdS}s ({fmtShortDate(r.ref.date)})
                    {" / "}{fmt1(toDisp(r.lastMaxKg, unit))} max
                  </span>
                </div>
              ) : (
                <div style={{ fontSize: 11, color: C.muted }}>
                  no measured max yet — do a peak test for the ratio
                </div>
              )}
            </div>

            <ResponsiveContainer width="100%" height={150}>
              <LineChart data={data} margin={{ top: 6, right: 12, bottom: 4, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis dataKey="date" tickFormatter={(d) => (d || "").slice(5)} tick={{ fill: C.muted, fontSize: 10 }} minTickGap={24} />
                <YAxis tick={{ fill: C.muted, fontSize: 10 }} width={34} domain={[0, "auto"]} />
                <Tooltip
                  contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }}
                  labelFormatter={(d) => d}
                  formatter={(val, name, p) => {
                    if (val == null) return ["—", name];
                    const isHold = name && name.startsWith("Held");
                    const dur = isHold && p?.payload?.holdS ? ` × ${p.payload.holdS}s` : "";
                    return [`${fmtW(val, unit)} ${unit}${dur}`, name];
                  }}
                />
                <Line dataKey="max" name="Max (smoothed)" stroke={color} strokeWidth={2}
                  dot={false} connectNulls isAnimationActive={false} />
                <Line dataKey="hold" name={`Held ≥${SUSTAINED_MIN_S}s`} stroke={C.blue} strokeWidth={2}
                  strokeDasharray="5 4" connectNulls isAnimationActive={false}
                  dot={{ r: 3.5, fill: C.blue, stroke: "none" }} activeDot={{ r: 5 }} />
              </LineChart>
            </ResponsiveContainer>

            {r.refStale != null && (
              <div style={{ fontSize: 10, color: C.muted, marginTop: 4, fontStyle: "italic", lineHeight: 1.4 }}>
                Last ≥{SUSTAINED_MIN_S}s hold was {r.refStale} days ago — the % reads against an old demonstration. A new long hold refreshes it.
              </div>
            )}
            {r.maxStaleDays != null && (
              <div style={{ fontSize: 10, color: C.muted, marginTop: 4, fontStyle: "italic", lineHeight: 1.4 }}>
                Max last tested {r.maxStaleDays} days ago (cadence is ~{MAX_TEST_STALE_DAYS}) — retest to keep the denominator honest.
              </div>
            )}
          </div>
        );
      })}

      {quiet.length > 0 && (
        <div style={{ fontSize: 11, color: C.muted, marginTop: rows.length ? 10 : 0, fontStyle: "italic", lineHeight: 1.4 }}>
          {quiet.map(g => `${g} — no measured holds ≥${SUSTAINED_MIN_S}s yet; nothing demonstrated to plot.`).join(" ")}
        </div>
      )}
    </Card>
  );
}
