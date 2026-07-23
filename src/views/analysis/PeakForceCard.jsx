// ─────────────────────────────────────────────────────────────
// PeakForceCard — max-strength (peak force) trajectory over time
// ─────────────────────────────────────────────────────────────
// Direct measurement of instantaneous force per grip. Every valid
// Tindeq peak can raise the observed PR; the smoothed comparison line
// remains max-intent-only so routine sub-max pulls cannot depress it.
// Dots mark PR advances and carry the producing workout's zone.
// See model/peakForce.js.
//
// Axis: ONE shared scale for all grips. Crusher (~170 lb) and Micro
// (~50 lb) differ ~3×, and that magnitude gap is real and worth showing
// — a per-grip zoomed axis made the two PR lines overlap and falsely
// read as equal strength. Peak max is fairly flat over a month anyway
// (the month's gains are in capacity/endurance, not raw max), so a
// shared axis is both honest about magnitude and not hiding a big climb.
// The per-grip % climb still appears in the header.

import React, { useMemo, useState } from "react";
import {
  ResponsiveContainer, ComposedChart, Line, Scatter,
  XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from "recharts";
import { C } from "../../ui/theme.js";
import { Card } from "../../ui/components.js";
import { GRIP_COLORS } from "../../ui/grip-colors.js";
import { fmt1, toDisp } from "../../ui/format.js";
import { buildPeakForceTrend } from "../../model/peakForce.js";

export function formatPeakForceTooltip(value, name, item, unit) {
  const context = item?.payload?.[`${item.dataKey}_context`];
  const contextualName = context?.label
    ? `${name} during ${context.label} workout`
    : name;
  return [value != null ? `${fmt1(value)} ${unit}` : "—", contextualName];
}

export function peakForceTooltipRows(payload, unit) {
  const numeric = (payload || []).filter(item =>
    item?.value != null && Number.isFinite(Number(item.value)) && item?.dataKey !== "date"
  );
  const newPrStems = new Set(
    numeric
      .filter(item => String(item.dataKey).endsWith("_newPr"))
      .map(item => String(item.dataKey).replace(/_newPr$/, ""))
  );
  const seen = new Set();
  return numeric
    .filter(item => {
      const key = String(item.dataKey);
      const stem = key.replace(/_pr$/, "");
      if (key.endsWith("_pr") && newPrStems.has(stem)) return false;
      const dedupeKey = `${key}|${item.value}`;
      if (seen.has(dedupeKey)) return false;
      seen.add(dedupeKey);
      return true;
    })
    .map(item => {
      const [value, name] = formatPeakForceTooltip(item.value, item.name, item, unit);
      return { key: String(item.dataKey), value, name, color: item.color };
    });
}

function PeakForceTooltip({ active, payload, label, unit }) {
  if (!active) return null;
  const rows = peakForceTooltipRows(payload, unit);
  if (rows.length === 0) return null;
  return (
    <div style={{
      background: C.card,
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      padding: "8px 10px",
      fontSize: 12,
      lineHeight: 1.3,
      width: 270,
      maxWidth: "calc(100vw - 32px)",
      boxSizing: "border-box",
      boxShadow: "0 6px 18px rgba(0,0,0,0.22)",
    }}>
      <div style={{ color: C.text, fontWeight: 700, marginBottom: 5 }}>{label}</div>
      {rows.map(row => (
        <div key={row.key} style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) auto",
          alignItems: "start",
          gap: 10,
          marginTop: 4,
        }}>
          <span style={{ color: row.color || C.muted, overflowWrap: "anywhere" }}>{row.name}</span>
          <b style={{ color: C.text, whiteSpace: "nowrap" }}>{row.value}</b>
        </div>
      ))}
    </div>
  );
}

function PeakForceLegend({ view }) {
  const items = view.mode === "split"
    ? view.series.map(({ g, h }) => ({ id: `${g}-${h}`, g, label: `${g} ${h} PR`, dashed: h === "R" }))
    : view.grips.map(g => ({ id: g, g, label: `${g} PR`, dashed: false }));
  return (
    <div style={{ display: "flex", justifyContent: "center", flexWrap: "wrap", gap: "4px 14px", fontSize: 11 }}>
      {items.map(({ id, g, label, dashed }) => (
        <span key={id} style={{ display: "inline-flex", alignItems: "center", gap: 5, color: C.muted }}>
          <span style={{
            width: 16,
            borderTop: `2px ${dashed ? "dashed" : "solid"} ${GRIP_COLORS[g] || C.blue}`,
          }} />
          {label}
        </span>
      ))}
    </div>
  );
}

export function PeakForceCard({ history, unit = "lbs" }) {
  const trend = useMemo(() => buildPeakForceTrend(history), [history]);

  // Pooled (default) vs per-hand detail. Pooled is the clean daily
  // read; the L/R split is on-demand for asymmetry questions —
  // June 2026, after the pooled redesign proved cleaner but hid the
  // per-hand picture entirely.
  const [split, setSplit] = useState(false);

  const view = useMemo(() => {
    if (!trend) return null;
    if (split) {
      // ── L/R detail: one trend per hand, merged onto shared dates.
      // L renders solid, R dashed, both in the grip's color. The
      // faint pooled trend line is omitted here — six overlapping
      // series is exactly the clutter pooled mode exists to avoid.
      const byHand = {};
      for (const h of ["L", "R"]) {
        const t = buildPeakForceTrend((history || []).filter(r => r?.hand === h));
        if (t) byHand[h] = t;
      }
      const hands = Object.keys(byHand);
      if (hands.length === 0) return null;
      const dateSet = new Set();
      for (const h of hands) for (const r of byHand[h].rows) dateSet.add(r.date);
      const dates = [...dateSet].sort();
      const rows = dates.map(date => {
        const o = { date: date.slice(5) };
        for (const h of hands) {
          const src = byHand[h].rows.find(x => x.date === date);
          for (const g of byHand[h].grips) {
            const pr = src?.[`${g}_pr`];
            o[`${g}_${h}_pr`] = pr != null ? toDisp(pr, unit) : null;
            const newPr = src?.[`${g}_newPr`];
            o[`${g}_${h}_newPr`] = newPr != null ? toDisp(newPr, unit) : null;
            o[`${g}_${h}_newPr_context`] = src?.[`${g}_prContext`] ?? null;
          }
        }
        return o;
      });
      const series = [];
      for (const h of hands) {
        for (const g of byHand[h].grips) {
          series.push({ g, h });
        }
      }
      const hi = Math.max(...series.map(({ g, h }) => toDisp(byHand[h].best[g].kg, unit)));
      const axisMax = Math.ceil((hi * 1.12) / 5) * 5;
      return {
        mode: "split", rows, series, axisMax,
        // Header stats stay pooled in both modes — the summary
        // numbers shouldn't jump when the user pokes at detail.
        grips: trend.grips, best: trend.best,
        changePct: trend.changePct,
        standardizedPending: trend.standardizedPending || {},
      };
    }
    const rows = trend.rows.map(r => {
      const o = { date: r.date.slice(5) };
      for (const g of trend.grips) {
        o[`${g}_pr`] = r[`${g}_pr`] != null ? toDisp(r[`${g}_pr`], unit) : null;
        const newPr = r[`${g}_newPr`];
        o[`${g}_newPr`] = newPr != null ? toDisp(newPr, unit) : null;
        o[`${g}_newPr_context`] = r[`${g}_prContext`] ?? null;
        // Smoothed max-day trend — the line that CAN fall (see
        // peakForce.js). Null until there are at least 3 max days.
        o[`${g}_trend`] = r[`${g}_trend`] != null ? toDisp(r[`${g}_trend`], unit) : null;
      }
      return o;
    });
    // Single shared axis: 0 → a little above the strongest grip's best,
    // so every grip sits at its true height and the magnitude gap shows.
    const hi = Math.max(...trend.grips.map(g => toDisp(trend.best[g].kg, unit)));
    const axisMax = Math.ceil((hi * 1.12) / 5) * 5;
    return {
      mode: "pooled",
      rows, grips: trend.grips, best: trend.best,
      changePct: trend.changePct, axisMax,
      standardizedPending: trend.standardizedPending || {},
    };
  }, [trend, unit, split, history]);

  if (!view || view.rows.length < 1) return null;

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ marginBottom: 4 }}>
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <div style={{ fontSize: 14, fontWeight: 700, flex: "1 1 190px", minWidth: 0 }}>
            Peak force — max strength over time
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            {[{ k: false, label: "Pooled" }, { k: true, label: "L / R" }].map(opt => (
              <button key={String(opt.k)} onClick={() => setSplit(opt.k)} style={{
                padding: "2px 10px", borderRadius: 20, fontSize: 11, cursor: "pointer", border: "none", fontWeight: 600,
                background: split === opt.k ? C.purple : C.border,
                color:      split === opt.k ? "#fff"   : C.muted,
              }}>{opt.label}</button>
            ))}
          </div>
        </div>
        <div style={{
          display: "flex",
          justifyContent: "flex-end",
          flexWrap: "wrap",
          gap: "2px 12px",
          marginTop: 4,
          fontSize: 12,
          color: C.muted,
        }}>
          {view.grips.map(g => {
            const pct = view.changePct[g];
            const pctColor = pct == null ? C.muted : pct > 0 ? C.green : pct < 0 ? C.red : C.muted;
            return (
              <span key={g}>
                <span style={{ color: GRIP_COLORS[g] || C.blue }}>{g}</span>{" "}
                <b style={{ color: C.text }}>{fmt1(toDisp(view.best[g].kg, unit))} {unit}</b>
                {pct != null && (
                  <b style={{ color: pctColor, marginLeft: 4 }}>
                    {pct > 0 ? "+" : ""}{pct}%
                  </b>
                )}
                {view.standardizedPending[g] && (
                  <i style={{ color: C.muted, marginLeft: 4, fontSize: 11 }}>trend pending</i>
                )}
              </span>
            );
          })}
        </div>
      </div>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>
        Highest valid Tindeq peak observed in any workout. The solid line
        is your running best-to-date; dots mark new PRs and identify the
        workout that produced them. The % is how much your observed
        ceiling has climbed. One shared scale keeps each grip at its true
        magnitude.
        {view.mode === "split"
          ? " L solid · R dashed, per-hand PR lines. The standardized trend is pooled-mode only."
          : " The dotted line uses max-intent sessions only, so ordinary sub-max pulls cannot drag it down. It can fall, making it the standardized signal for breakouts and decline."}
        {" "}Periodic 3 × 3s peak tests keep that comparison calibrated,
        but any workout can advance the PR.
        {Object.keys(view.standardizedPending).length > 0 && (
          <span style={{ fontStyle: "italic" }}>
            {" "}Trend pending means that grip has no max-intent session yet;
            its observed PR is still retained.
          </span>
        )}
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart data={view.rows} margin={{ top: 6, right: 14, bottom: 24, left: 0 }}>
          <CartesianGrid stroke={C.border} strokeDasharray="3 3" />
          <XAxis dataKey="date" tick={{ fill: C.muted, fontSize: 10 }}
            angle={-30} textAnchor="end" interval="preserveStartEnd" />
          <YAxis
            domain={[0, view.axisMax]}
            tick={{ fill: C.muted, fontSize: 10 }}
            width={46}
            unit={` ${unit}`}
          />
          <Tooltip
            content={<PeakForceTooltip unit={unit} />}
          />
          <Legend content={() => <PeakForceLegend view={view} />} />
          {view.mode === "split" ? (
            <>
              {view.series.map(({ g, h }) => (
                <Line key={`${g}-${h}-pr`} type="monotone" dataKey={`${g}_${h}_pr`}
                  name={`${g} ${h} PR`}
                  stroke={GRIP_COLORS[g] || C.blue}
                  strokeWidth={h === "L" ? 2 : 1.5}
                  strokeDasharray={h === "R" ? "6 4" : undefined}
                  dot={false} connectNulls isAnimationActive={false} />
              ))}
              {/* PR-set dots per hand — out of the legend to keep it
                  to one entry per (grip, hand) line. */}
              {view.series.map(({ g, h }) => (
                <Scatter key={`${g}-${h}-dots`} dataKey={`${g}_${h}_newPr`}
                  name={`${g} ${h}: New PR`} legendType="none"
                  fill={GRIP_COLORS[g] || C.blue} isAnimationActive={false} />
              ))}
            </>
          ) : (
            <>
              {view.grips.map(g => {
                const color = GRIP_COLORS[g] || C.blue;
                return (
                  <Line key={`${g}-pr`} type="monotone" dataKey={`${g}_pr`}
                    name={`${g} PR`}
                    stroke={color} strokeWidth={2} dot={false}
                    connectNulls isAnimationActive={false} />
                );
              })}
              {/* Smoothed max-day trend stays out of the custom legend
                  so the key remains PR-focused; the description text
                  explains the dotted line. */}
              {view.grips.filter(g => !view.standardizedPending[g]).map(g => (
                <Line key={`${g}-trend`} type="monotone" dataKey={`${g}_trend`}
                  name={`${g} trend`} legendType="none"
                  stroke={GRIP_COLORS[g] || C.blue} strokeWidth={2}
                  strokeDasharray="2 3" opacity={0.7} dot={false}
                  connectNulls isAnimationActive={false} />
              ))}
              {view.grips.map(g => {
                const color = GRIP_COLORS[g] || C.blue;
                return (
                  <Scatter key={`${g}-dots`} dataKey={`${g}_newPr`} name={`${g}: New PR`}
                    fill={color} isAnimationActive={false} />
                );
              })}
            </>
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </Card>
  );
}
