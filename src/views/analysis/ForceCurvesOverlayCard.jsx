// ─────────────────────────────────────────────────────────────
// ForceCurvesOverlayCard — vs-baseline F-D curve comparison
// ─────────────────────────────────────────────────────────────
// Extracted from AnalysisView.js (late May 2026 BACKLOG #156, sixth
// pass). The "Force Curves — vs baseline" Card that lives below the
// Capacity Trajectory card on the Analysis tab.
//
// What lives here:
//   • Pooled / per-hand mode toggle (per-hand auto-falls-back to
//     pooled when one hand lacks a qualifying baseline or a fit at
//     the selected Now date).
//   • Grip selector pills (only when ≥2 grips have overlay data).
//   • "Now" slider over post-baseline session dates. "Baseline" is
//     anchored to gripBaselines[grip] so this card agrees with
//     Capacity % and Curve Improvement.
//   • Baseline (dashed, muted) vs Now (solid, grip color) LineChart.
//   • Per-T delta strip — fixed reference durations (10/30/60/120/180s)
//     with signed Δ% tiles, one row per series.
//
// What's NOT here on purpose:
//   • historyOverlay computation itself — lives in useHistoryOverlay,
//     which feeds this card and also feeds balanceHistory for the
//     Strength Balance card.
//   • The active-grip derivation used to live in AnalysisView as
//     overlayActiveGrip/overlayDates/overlayLast/overlayNowI. All
//     four were only consumed by this card, so they moved in here
//     and AnalysisView's surface narrowed.
//
// Pure render — state is owned by AnalysisView (historyGrip,
// historyNowIdx, historyViewMode) so multiple cards could observe it
// in principle. In practice only this card reads/writes those slots.

import React, { useMemo } from "react";
import {
  ResponsiveContainer, LineChart, Line,
  XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
import { C } from "../../ui/theme.js";
import { Card } from "../../ui/components.js";
import { GRIP_COLORS, HAND_COLORS } from "../../ui/grip-colors.js";
import { fmt1, fmtW, toDisp } from "../../ui/format.js";
import { predForceThreeExp } from "../../model/threeExp.js";

// Toggle / grip-selector pill renderer. Lives here because it's only
// consumed by this card (and the visual is specific to the chip-row
// layout above the chart).
function Pill({ active, disabled, onClick, color, children }) {
  return (
    <button
      onClick={() => !disabled && onClick()}
      disabled={disabled}
      style={{
        background: active ? color : "transparent",
        color: active ? "#fff" : disabled ? C.border : C.muted,
        border: `1px solid ${active ? color : C.border}`,
        borderRadius: 4,
        padding: "4px 10px",
        fontSize: 11,
        fontWeight: 600,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}>{children}</button>
  );
}

export function ForceCurvesOverlayCard({
  // Data
  historyOverlay,
  maxDur,
  unit,
  // State (owned by AnalysisView)
  selGrip,
  historyGrip,
  setHistoryGrip,
  historyNowIdx,
  setHistoryNowIdx,
  historyViewMode,
  setHistoryViewMode,
}) {
  // Active grip for the overlay. Priority:
  //   1) explicit user pick (historyGrip)
  //   2) selGrip when the global filter is set and that grip has
  //      overlay data
  //   3) first overlay-eligible grip alphabetically
  const overlayActiveGrip = useMemo(() => {
    const eligible = Object.keys(historyOverlay);
    if (eligible.length === 0) return null;
    if (historyGrip && eligible.includes(historyGrip)) return historyGrip;
    if (selGrip && eligible.includes(selGrip)) return selGrip;
    return eligible[0];
  }, [historyOverlay, historyGrip, selGrip]);

  // Active grip's post-baseline date list + clamped Now index.
  // Default to last (most-recent date) on first render; clamp into
  // range when the list grows so user scrubs survive new sessions.
  const overlayDates = overlayActiveGrip ? historyOverlay[overlayActiveGrip].dates : [];
  const overlayLast = Math.max(0, overlayDates.length - 1);
  const overlayNowI = historyNowIdx == null
    ? overlayLast
    : Math.max(0, Math.min(overlayLast, historyNowIdx));

  // Short-circuit: no usable overlay data. Caller can render this
  // unconditionally without gating itself.
  if (!overlayActiveGrip || overlayDates.length < 1) return null;

  const overlay = historyOverlay[overlayActiveGrip];
  const eligibleGrips = Object.keys(historyOverlay);
  const pastDate = overlay.baselineDate;
  const nowDate  = overlayDates[overlayNowI];
  const gripColor = GRIP_COLORS[overlayActiveGrip] || C.blue;

  // Per-hand only available when at least one hand has its own
  // qualifying baseline AND has a fit at the selected "now" date.
  // Falls back to pooled when toggle is "per-hand" but data doesn't
  // support it (e.g. user just started training one of the hands).
  const handsWithData = ["L", "R"].filter(h =>
    overlay.perHand?.[h]?.baselineAmps &&
    overlay.perHand[h].ampsByDate.size > 0
  );
  const perHandAvailable = handsWithData.length > 0;
  const mode = (historyViewMode === "per-hand" && perHandAvailable)
    ? "per-hand"
    : "pooled";

  // Series description: one entry per curve-pair to draw. Pooled
  // mode: 1 entry (whole-grip pooled fit). Per-hand mode: 1 entry
  // per hand that has both baseline + a fit at the selected Now date.
  const series = mode === "pooled"
    ? [{
        key: "pooled",
        label: "Pooled",
        pastAmps: overlay.baselineAmps,
        nowAmps:  overlay.ampsByDate.get(nowDate),
        pastColor: C.muted,
        nowColor:  gripColor,
        pastName: `Baseline (${pastDate})`,
        nowName:  `Now (${nowDate})`,
      }]
    : handsWithData
        .filter(h => overlay.perHand[h].ampsByDate.get(nowDate))
        .map(h => ({
          key: h,
          label: h === "L" ? "Left" : "Right",
          pastAmps: overlay.perHand[h].baselineAmps,
          nowAmps:  overlay.perHand[h].ampsByDate.get(nowDate),
          // Same hand color for both past + now; the dashed pattern
          // distinguishes baseline from current.
          pastColor: HAND_COLORS[h],
          nowColor:  HAND_COLORS[h],
          pastName: `${h} baseline`,
          nowName:  `${h} now`,
        }));

  // Curve sampling — 80 points from 5s to a reasonable max. Same
  // range the F-D chart uses (≥5s + a little headroom past the long
  // endurance reps).
  const tMin = 5;
  const tMaxLocal = Math.max(180, maxDur);
  const samples = [];
  for (let i = 0; i < 80; i++) {
    const t = tMin + ((tMaxLocal - tMin) / 79) * i;
    const row = { x: t };
    for (const s of series) {
      const fp = s.pastAmps ? predForceThreeExp(s.pastAmps, t) : null;
      const fn = s.nowAmps  ? predForceThreeExp(s.nowAmps,  t) : null;
      row[`${s.key}_past`] = fp != null ? toDisp(Math.max(fp, 0), unit) : null;
      row[`${s.key}_now`]  = fn != null ? toDisp(Math.max(fn, 0), unit) : null;
    }
    samples.push(row);
  }
  const allYs = samples.flatMap(row => series.flatMap(s =>
    [row[`${s.key}_past`] || 0, row[`${s.key}_now`] || 0]
  ));
  const yMax = Math.max(...allYs, 1);
  const yDomain = [0, Math.ceil(yMax * 1.1 / 10) * 10];

  // Per-T delta strip — fixed reference durations spanning power →
  // endurance. Deltas signed (negative = lost capacity). One row per
  // series.
  const refTs = [10, 30, 60, 120, 180];
  const deltaRows = series.map(s => ({
    key: s.key,
    label: s.label,
    color: s.nowColor,
    cells: refTs.map(t => {
      const fp = s.pastAmps ? predForceThreeExp(s.pastAmps, t) : null;
      const fn = s.nowAmps  ? predForceThreeExp(s.nowAmps,  t) : null;
      const pct = (fp && fp > 0 && fn != null)
        ? Math.round((fn / fp - 1) * 100)
        : null;
      return { t, pct };
    }),
  }));

  const sliderStyle = {
    width: "100%",
    accentColor: gripColor,
    cursor: "pointer",
  };

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4, flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>
          Force Curves — vs baseline
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {/* View mode toggle: pooled / per-hand */}
          <div style={{ display: "flex", gap: 4 }}>
            <Pill active={mode === "pooled"} color={C.purple}
              onClick={() => setHistoryViewMode("pooled")}>
              Pooled
            </Pill>
            <Pill active={mode === "per-hand"} color={C.purple}
              disabled={!perHandAvailable}
              onClick={() => setHistoryViewMode("per-hand")}>
              Per-hand
            </Pill>
          </div>
          {/* Grip selector */}
          {eligibleGrips.length > 1 && (
            <div style={{ display: "flex", gap: 4 }}>
              {eligibleGrips.map(g => (
                <Pill key={g}
                  active={g === overlayActiveGrip}
                  color={GRIP_COLORS[g] || C.blue}
                  onClick={() => {
                    setHistoryGrip(g);
                    setHistoryNowIdx(null);
                  }}>
                  {g}
                </Pill>
              ))}
            </div>
          )}
        </div>
      </div>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 12, lineHeight: 1.5 }}>
        {mode === "pooled"
          ? "Dashed line is your pooled baseline curve (anchored to gripBaselines — same baseline the Capacity % and Curve Improvement cards use). Slide to compare any post-baseline date."
          : "Per-hand mode: each hand's own baseline (dashed) vs current (solid). Reveals asymmetric progress — one hand growing while the other plateaus tells you where to spend your next session."}
      </div>

      {/* Baseline label + Now slider. Past is anchored. */}
      <div style={{ marginBottom: 10, fontSize: 11, color: C.muted }}>
        Baseline: <b style={{ color: C.muted }}>{pastDate}</b>
      </div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: gripColor, marginBottom: 4 }}>
          <span>Now: <b>{nowDate}</b></span>
          <span style={{ color: C.muted }}>{overlayDates.length} sessions since baseline</span>
        </div>
        <input type="range"
          min={0} max={overlayLast} step={1}
          value={overlayNowI}
          onChange={(e) => setHistoryNowIdx(parseInt(e.target.value, 10))}
          style={sliderStyle}
        />
      </div>

      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={samples} margin={{ top: 6, right: 14, bottom: 28, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
          <XAxis type="number" dataKey="x"
            domain={[tMin, tMaxLocal]}
            tick={{ fill: C.muted, fontSize: 11 }}
            label={{ value: "Duration (s)", position: "insideBottom", offset: -16, fill: C.muted, fontSize: 11 }}
          />
          <YAxis domain={yDomain}
            tick={{ fill: C.muted, fontSize: 11 }}
            width={44} unit={` ${unit}`}
          />
          <Tooltip
            contentStyle={{ background: C.card, border: `1px solid ${C.border}`, fontSize: 12 }}
            formatter={(val, name) => [val == null ? "—" : `${fmtW(val, unit)} ${unit}`, name]}
            labelFormatter={(t) => `${fmt1(t)}s`}
          />
          {series.flatMap(s => [
            <Line key={`${s.key}_past`} dataKey={`${s.key}_past`}
              stroke={s.pastColor} strokeWidth={2}
              strokeDasharray="6 4" dot={false} connectNulls
              name={s.pastName} isAnimationActive={false} />,
            <Line key={`${s.key}_now`} dataKey={`${s.key}_now`}
              stroke={s.nowColor} strokeWidth={3}
              dot={false} connectNulls
              name={s.nowName} isAnimationActive={false} />,
          ])}
        </LineChart>
      </ResponsiveContainer>

      {/* Per-T delta strip(s). One row in pooled mode; one per hand
          in per-hand mode with a small label. */}
      {deltaRows.map(({ key, label, color, cells }) => (
        <div key={key} style={{ marginTop: 12 }}>
          {deltaRows.length > 1 && (
            <div style={{ fontSize: 11, fontWeight: 600, color, marginBottom: 4 }}>
              {label}
            </div>
          )}
          <div style={{
            display: "grid",
            gridTemplateColumns: `repeat(${refTs.length}, 1fr)`,
            gap: 6,
          }}>
            {cells.map(({ t, pct }) => {
              const tileColor = pct == null ? C.muted
                              : pct > 0     ? C.green
                              : pct < 0     ? C.red
                                            : C.muted;
              const sign = pct == null ? "" : pct > 0 ? "+" : "";
              return (
                <div key={t} style={{
                  background: C.bg, border: `1px solid ${C.border}`,
                  borderRadius: 6, padding: "6px 8px", textAlign: "center",
                }}>
                  <div style={{ fontSize: 10, color: C.muted, marginBottom: 2 }}>
                    {t}s
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: tileColor }}>
                    {pct == null ? "—" : `${sign}${pct}%`}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </Card>
  );
}
