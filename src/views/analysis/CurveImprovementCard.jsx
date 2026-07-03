// ─────────────────────────────────────────────────────────────
// CurveImprovementCard — per-grip Δ% + force-curve overlay + slider
// ─────────────────────────────────────────────────────────────
// One card, one block per grip. Each grip block shows:
//   • header: grip name + "since <baselineDate>"
//   • total Δ% + the six zone tiles (Max … End)
//   • the baseline (dashed) vs Now (solid) force curve
//   • a "Now" slider over that grip's post-baseline session dates
//
// The slider drives BOTH the curve AND the tiles: scrubbing recomputes
// every zone Δ% and the total for the selected date, so there's a single
// set of numbers (no separate per-T delta strip) and you can walk the
// progression forward in time. Both grips are always shown — no pills,
// no pooled/per-hand toggle. The fit is the pooled (L+R) per-grip three-
// exp, the same one the headline % uses, so the curve and tiles agree.
//
// (Merged May 2026: absorbed the standalone "Force Curves — vs baseline"
// card. Curve sampling, the fixed y-axis, and the slider all live here
// now; useHistoryOverlay still supplies the per-grip baseline + the
// cumulative ampsByDate map this reads.)
//
// Modes preserved:
//   • perGripMode (no filter, ≥2 grips) — a block per grip with overlay.
//   • selGrip — that grip's block (or an early-days placeholder).
//   • pooled fallback — static total + tiles (no overlay/slider).

import React, { useState } from "react";
import {
  ResponsiveContainer, LineChart, Line,
  XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
import { C } from "../../ui/theme.js";
import { Card, HandViewPills } from "../../ui/components.js";
import { GRIP_COLORS } from "../../ui/grip-colors.js";
import { fmt1, fmtW, toDisp } from "../../ui/format.js";
import { ZONE6 } from "../../model/zones.js";
import { improvementForAmps } from "../../model/baselines.js";
import { predForceThreeExp } from "../../model/threeExp.js";
import { effectiveLoad } from "../../model/load.js";

// Per-grip baseline-unlock thresholds. Match the gates in
// buildGripBaselines so the "X of 5 failures" copy is honest.
const FAIL_THRESHOLD = 5;
const DUR_THRESHOLD  = 3;

function baselineProgress(history, grip, hand = null) {
  let failures = 0;
  const durs = new Set();
  for (const r of history || []) {
    if (r.grip !== grip) continue;
    if (hand && r.hand !== hand) continue;
    if (!(effectiveLoad(r) > 0)) continue;
    if (!(r.actual_time_s > 0)) continue;
    failures += 1;
    if (r.target_duration) durs.add(r.target_duration);
  }
  return {
    failures,
    distinctDurations: durs.size,
    ready: failures >= FAIL_THRESHOLD && durs.size >= DUR_THRESHOLD,
  };
}

// One-line explainer under the header.
function BasisNote() {
  return (
    <div style={{ fontSize: 11, color: C.muted, marginBottom: 12, lineHeight: 1.4 }}>
      What your reps actually showed — sessions trained deep in fatigue count at the loads you actually held, so hard training weeks can dip.
    </div>
  );
}

// Static per-grip block: header (grip + since date) + tiles. The
// fallback shape for grips without an interactive overlay.
function StaticGripTiles({ grip, imp, divider }) {
  return (
    <div style={{
      paddingBottom: divider ? 14 : 0,
      borderBottom: divider ? `1px solid ${C.border}` : "none",
      marginBottom: divider ? 14 : 0,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: GRIP_COLORS[grip] || C.blue }}>{grip}</div>
        <div style={{ fontSize: 11, color: C.muted }}>since {imp.baselineDate}</div>
      </div>
      <ImprovementRow label={null} imp={imp} />
    </div>
  );
}

// Total Δ% + the six zone tiles. Shared by every render path.
function ImprovementRow({ label, imp }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
        {label && (
          <div style={{ fontSize: 12, fontWeight: 700, color: C.text }}>{label}</div>
        )}
        <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginLeft: "auto" }}>
          <div style={{ fontSize: 26, fontWeight: 900, color: imp.total >= 0 ? C.green : C.red, lineHeight: 1 }}>
            {imp.total >= 0 ? "+" : ""}{imp.total}%
          </div>
          <div style={{ fontSize: 11, color: C.muted }}>total</div>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
        {ZONE6.map(z => {
          const val = imp[z.key];
          if (val == null) return null;
          return (
            <div key={z.key} style={{
              background: C.bg, borderRadius: 10, padding: "8px 6px", textAlign: "center",
              border: `1px solid ${z.color}30`,
            }}>
              <div style={{ fontSize: 9, color: C.muted, marginBottom: 3 }}>{z.short}</div>
              <div style={{ fontSize: 16, fontWeight: 800, color: val >= 0 ? z.color : C.red }}>
                {val >= 0 ? "+" : ""}{val}%
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Baseline vs Now force-curve chart with a FIXED y-axis (sized once from
// the tallest curve any slider position can draw, so scrubbing doesn't
// rescale the axis). tMin..tMax sampled at 80 points.
function OverlayChart({ baselineAmps, nowAmps, candidateAmps, unit, maxDur, color, baselineDate, nowDate }) {
  const tMin = 5;
  const tMax = Math.max(180, maxDur || 0);
  const samples = [];
  for (let i = 0; i < 80; i++) {
    const t = tMin + ((tMax - tMin) / 79) * i;
    samples.push({
      x: t,
      past: baselineAmps ? toDisp(Math.max(predForceThreeExp(baselineAmps, t), 0), unit) : null,
      now:  nowAmps      ? toDisp(Math.max(predForceThreeExp(nowAmps, t), 0), unit)      : null,
    });
  }
  const yPeak = candidateAmps.reduce(
    (m, a) => Math.max(m, toDisp(Math.max(predForceThreeExp(a, tMin), 0), unit)),
    1
  );
  const yDomain = [0, Math.ceil(yPeak * 1.1 / 10) * 10];

  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={samples} margin={{ top: 6, right: 14, bottom: 26, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
        <XAxis type="number" dataKey="x" domain={[tMin, tMax]}
          tick={{ fill: C.muted, fontSize: 11 }}
          label={{ value: "Duration (s)", position: "insideBottom", offset: -14, fill: C.muted, fontSize: 11 }}
        />
        <YAxis domain={yDomain} tick={{ fill: C.muted, fontSize: 11 }} width={44} unit={` ${unit}`} />
        <Tooltip
          contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }}
          formatter={(val, name) => [val == null ? "—" : `${fmtW(val, unit)} ${unit}`, name]}
          labelFormatter={(t) => `${fmt1(t)}s`}
        />
        <Line dataKey="past" stroke={C.muted} strokeWidth={2} strokeDasharray="6 4"
          dot={false} connectNulls name={`Baseline (${baselineDate})`} isAnimationActive={false} />
        <Line dataKey="now" stroke={color} strokeWidth={3}
          dot={false} connectNulls name={`Now (${nowDate})`} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

// One grip's full block: header, tiles (at slider date), curve, slider.
function GripBlock({ grip, overlay, unit, maxDur, nowIdx, onScrub, divider }) {
  const dates = overlay.dates;
  const last = Math.max(0, dates.length - 1);
  const idx = nowIdx == null ? last : Math.max(0, Math.min(last, nowIdx));
  const nowDate = dates[idx];
  const nowAmps = overlay.ampsByDate.get(nowDate);
  const color = GRIP_COLORS[grip] || C.blue;

  const imp = nowAmps ? improvementForAmps(nowAmps, overlay.baselineAmps) : null;

  // Every drawable curve for this grip — for the fixed y-axis.
  const candidateAmps = [overlay.baselineAmps, ...overlay.ampsByDate.values()].filter(Boolean);

  return (
    <div style={{
      paddingBottom: divider ? 14 : 0,
      borderBottom: divider ? `1px solid ${C.border}` : "none",
      marginBottom: divider ? 14 : 0,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color }}>{grip}</div>
        <div style={{ fontSize: 11, color: C.muted }}>since {overlay.baselineDate}</div>
      </div>

      {imp && <ImprovementRow label={null} imp={imp} />}

      <OverlayChart
        baselineAmps={overlay.baselineAmps}
        nowAmps={nowAmps}
        candidateAmps={candidateAmps}
        unit={unit}
        maxDur={maxDur}
        color={color}
        baselineDate={overlay.baselineDate}
        nowDate={nowDate}
      />

      {/* Now slider — scrub the comparison date; tiles + curve follow.
          BELOW the chart (June 2026): the scrubbing thumb sits under
          the user's finger, and with the slider above, that hand
          covered exactly the curve they were trying to watch move. */}
      <div style={{ margin: "8px 0 0" }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color, marginBottom: 4 }}>
          <span>Now: <b>{nowDate}</b></span>
          <span style={{ color: C.muted }}>{idx + 1} of {dates.length} session{dates.length === 1 ? "" : "s"} since baseline</span>
        </div>
        <input type="range" min={0} max={last} step={1} value={idx}
          onChange={(e) => onScrub(grip, parseInt(e.target.value, 10))}
          style={{ width: "100%", accentColor: color, cursor: "pointer" }}
        />
      </div>
    </div>
  );
}

export function CurveImprovementCard({
  improvement,
  gripImprovement,
  grip3xEstimates,
  gripBaselines,
  global3xBaseline,
  selGrip,
  history,
  // Merged-in overlay data (per grip: baselineAmps, baselineDate, dates,
  // ampsByDate). Supplies the curve + slider.
  historyOverlay = {},
  maxDur = 180,
  unit = "lbs",
  // Hand selector (June 2026): "pooled" | "L" | "R". In L/R mode the
  // card renders STATIC per-grip tiles from perHandGripImprovement
  // (keys `${grip}|${hand}`, vs the FROZEN per-hand baselines) — the
  // interactive overlay + slider stay pooled-only, where the fits
  // have the data density to be worth scrubbing.
  handView = "pooled",
  perHandGripImprovement = {},
  // Repeated local control for the global hand-view state (June 2026).
  onHandViewChange = null,
}) {
  // Per-grip "Now" slider index. null → latest date for that grip.
  const [nowIdxByGrip, setNowIdxByGrip] = useState({});
  const scrub = (grip, idx) => setNowIdxByGrip(prev => ({ ...prev, [grip]: idx }));


  if (!improvement && Object.keys(gripImprovement).length === 0) return null;

  const perGripMode = !selGrip && Object.keys(grip3xEstimates).length >= 2;
  const impMap = gripImprovement;
  const gripImpEntries = Object.entries(impMap);

  // Grips that have an interactive overlay (baseline + ≥1 post-baseline
  // fit). These render as full blocks; grips with an improvement but no
  // overlay fall back to a static tiles row.
  const overlayGrips = new Set(
    Object.keys(historyOverlay).filter(g => historyOverlay[g]?.dates?.length > 0)
  );

  // ── Per-hand mode: static tiles vs frozen per-hand baselines ──
  if (handView === "L" || handView === "R") {
    const handImpMap = perHandGripImprovement;
    const entries = Object.entries(handImpMap)
      .filter(([key]) => key.endsWith(`|${handView}`))
      .map(([key, imp]) => [key.split("|")[0], imp])
      .sort((a, b) => a[0].localeCompare(b[0]));
    return (
      <Card style={{ marginBottom: 16, border: `1px solid ${C.purple}40` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4, flexWrap: "wrap", gap: 8 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>
            Curve Improvement
            <span style={{ color: handView === "R" ? C.orange : C.blue, marginLeft: 8, fontSize: 12 }}>
              {handView === "R" ? "Right hand" : "Left hand"}
            </span>
          </div>
          {onHandViewChange && <HandViewPills value={handView} onChange={onHandViewChange} />}
        </div>
        <div style={{ fontSize: 11, color: C.muted, marginBottom: 4, lineHeight: 1.4 }}>
          Per-hand fits vs that hand's frozen baseline — half the data
          of the pooled view, so expect noisier numbers.
        </div>
        <BasisNote />
        {entries.length > 0 ? entries.map(([grip, imp], i, arr) => (
          <StaticGripTiles key={grip} grip={grip} imp={imp}
            divider={i < arr.length - 1} />
        )) : (
          <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
            No {handView === "R" ? "right" : "left"}-hand baseline seeded
            yet — a hand needs ≥{FAIL_THRESHOLD} failures across
            ≥{DUR_THRESHOLD} durations of its own before its frame freezes.
          </div>
        )}
      </Card>
    );
  }

  return (
    <Card style={{ marginBottom: 16, border: `1px solid ${C.purple}40` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4, flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>Curve Improvement</div>
        {onHandViewChange && <HandViewPills value={handView} onChange={onHandViewChange} />}
      </div>
      <BasisNote />

      {perGripMode ? (
        gripImpEntries.length > 0 ? (
          <>
            {gripImpEntries.map(([grip, imp], i, arr) => {
              const divider = i < arr.length - 1;
              if (overlayGrips.has(grip)) {
                return (
                  <GripBlock key={grip} grip={grip} overlay={historyOverlay[grip]}
                    unit={unit} maxDur={maxDur}
                    nowIdx={nowIdxByGrip[grip]} onScrub={scrub} divider={divider} />
                );
              }
              // No overlay — static tiles at latest.
              return (
                <StaticGripTiles key={grip} grip={grip} imp={imp} divider={divider} />
              );
            })}
            {/* Early-days placeholder for grips with a current fit but no
                qualifying baseline yet. */}
            {Object.keys(grip3xEstimates).filter(g => !impMap[g]).map(grip => {
              const p = baselineProgress(history, grip);
              return (
                <div key={grip} style={{
                  paddingTop: 12, marginTop: 12, borderTop: `1px solid ${C.border}`,
                  fontSize: 11, color: C.muted, lineHeight: 1.5,
                }}>
                  <b style={{ color: C.text }}>{grip}</b>{" · "}
                  <span style={{ color: p.failures >= FAIL_THRESHOLD ? C.green : C.text }}>
                    {Math.min(p.failures, FAIL_THRESHOLD)} of {FAIL_THRESHOLD} failures
                  </span>{" · "}
                  <span style={{ color: p.distinctDurations >= DUR_THRESHOLD ? C.green : C.text }}>
                    {Math.min(p.distinctDurations, DUR_THRESHOLD)} of {DUR_THRESHOLD} durations
                  </span>
                </div>
              );
            })}
          </>
        ) : (
          <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
            Need ≥5 failures across ≥3 target durations <i>per grip</i> to seed a stable per-grip baseline. Until then the three-exp fit can't separate the fast / medium / slow components cleanly enough for the per-zone Δ% to be meaningful.
          </div>
        )
      ) : selGrip ? (
        overlayGrips.has(selGrip) ? (
          <GripBlock grip={selGrip} overlay={historyOverlay[selGrip]}
            unit={unit} maxDur={maxDur}
            nowIdx={nowIdxByGrip[selGrip]} onScrub={scrub} divider={false} />
        ) : (
          <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
            Need ≥{FAIL_THRESHOLD} failures across ≥{DUR_THRESHOLD} target durations on <b>{selGrip}</b> for a fair apples-to-apples comparison. Pooled global baseline isn't shown here — it mixes muscle groups (FDP pinch vs FDS crush) and would produce misleading Δ%.
            <div style={{ marginTop: 6, fontSize: 11 }}>
              Progress:{" "}
              {(() => {
                const p = baselineProgress(history, selGrip);
                return (
                  <>
                    <span style={{ color: p.failures >= FAIL_THRESHOLD ? C.green : C.text, fontWeight: 600 }}>
                      {Math.min(p.failures, FAIL_THRESHOLD)} of {FAIL_THRESHOLD} failures
                    </span>{" · "}
                    <span style={{ color: p.distinctDurations >= DUR_THRESHOLD ? C.green : C.text, fontWeight: 600 }}>
                      {Math.min(p.distinctDurations, DUR_THRESHOLD)} of {DUR_THRESHOLD} durations
                    </span>
                  </>
                );
              })()}
            </div>
          </div>
        )
      ) : improvement ? (
        // Global fallback (single-grip histories) — the pooled global fit.
        <>
          {global3xBaseline && (
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 8, textAlign: "right" }}>
              since {global3xBaseline.date}
            </div>
          )}
          <ImprovementRow label={null} imp={improvement} />
        </>
      ) : null}
    </Card>
  );
}
