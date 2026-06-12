// ─────────────────────────────────────────────────────────────
// ForceDurationCard — the F-D scatter + 3-exp curve + asymmetry rows
// ─────────────────────────────────────────────────────────────
// Extracted from AnalysisView.js (late May 2026 BACKLOG #156, fourth
// pass). The Card-wrapped headline visual on the Analysis tab.
//
// What lives here:
//   • Title + legend strip (changes shape between single-curve and
//     per-grip split modes).
//   • ComposedChart with: zone-shaded backgrounds, scatter dots
//     (single-fit mode L/R, split-mode per-grip × per-hand outlined),
//     three-exp curve, 3-min sustainable reference line.
//   • Zone-name label strip beneath the chart.
//   • Hand Asymmetry rows folded into the same Card (tabular
//     companion to the L/R scatter — auto-hidden when every grip is
//     symmetric, see useGripFits / computeHandAsymmetry).
//
// What stays in AnalysisView:
//   • The data derivations that feed this card (threeExpFit,
//     threeExpCurveData, threeExpRef180, fdSplitData, dotsRel (pooled),
//     maxDur, maxForceRel, limiterZoneBounds, curveColor).
//     Those memos depend on view state (selGrip + normalizeOn) and
//     the threeExpFit consumer fans out beyond this card.
//   • The session-detail modal — separate concern, triggered by
//     handleDotClick passed in here.
//
// Why one big component vs. splitting chart-vs-asymmetry: the two
// share the Card border by design (Hand Asymmetry is the tabular
// companion to the L/R dot scatter), and the asymmetry section is
// small (~50 lines). Splitting them would require either two
// adjacent Cards or a wrapper component — neither earns its weight.

import React, { useMemo } from "react";
import {
  ResponsiveContainer, ComposedChart, Line, Scatter,
  XAxis, YAxis, Tooltip, CartesianGrid,
  ReferenceLine, ReferenceArea,
} from "recharts";
import { C } from "../../ui/theme.js";
import { Card, HandViewPills } from "../../ui/components.js";
import { GRIP_COLORS } from "../../ui/grip-colors.js";
import { fmt1, fmtW, toDisp, forceOverBW } from "../../ui/format.js";
import { ZONE6 } from "../../model/zones.js";
import {
  predForceThreeExp,
} from "../../model/threeExp.js";
import { fitAmpsForPts } from "../../model/baselines.js";
import { effectiveLoad, freshFitReps } from "../../model/load.js";
import { freshLoadFor } from "../../model/prescription.js";

// Match AnalysisView's chart-min duration (5s — same lower bound as
// the curve-sample grid in threeExpCurveData). Lives here as a local
// constant since it's only used by the chart-render block below.
const F_D_T_MIN = 5;

// Single pooled dot color for single-grip mode (both hands combined).
// A neutral blue that reads as "your reps" against the grip-tinted curve.
const POOLED_DOT = C.blue;

// Custom tooltip for the scatter chart. Lives in this file because no
// other consumer needs it — moving it out would just add an import.
function ScatterTooltip({ active, payload, unit }) {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload;
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, padding: "8px 12px", borderRadius: 8, fontSize: 12 }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>{d.date}{d.grip ? ` · ${d.grip}` : ""}</div>
      <div>Duration: <b>{fmt1(d.x)}s</b></div>
      <div>Force: <b>{fmt1(d.y)} {unit}</b></div>
    </div>
  );
}

export function ForceDurationCard({
  // Display context
  unit,
  bodyWeight,
  useRel,
  normalizeOn,
  // Global hand-view state, repeated here as a local control so the
  // user can flip hands without scrolling to the top (June 2026).
  // Single-grip mode's dots/curve arrive pre-scoped via props; the
  // split-mode block below scopes its own per-grip fits by handView.
  handView = "pooled",
  onHandViewChange = null,
  // Chart-data props (memoized in AnalysisView)
  fdSplitData,
  threeExpCurveDataRel,
  threeExpRef180,
  curveColor,
  dotsRel,
  maxDur,
  maxForceRel,
  // Per-grip Hand Asymmetry rows
  handAsymmetry,
  // Raw history + priors (only used for the per-grip split-mode
  // series below; the single-fit path uses the pre-computed dot/curve
  // props above).
  history,
  threeExpPriors,
  // freshMap — the engine's fresh-equivalent load corrections. Split-
  // mode curves fit on the same basis prescription() uses (June 2026
  // audit; matches the single-grip curve's engine-basis change).
  freshMap = null,
  // Callback when a dot is clicked (opens session-detail modal)
  handleDotClick,
}) {
  // ── Relative strength helpers ──
  // Local to this card — fmtForce and forceUnit aren't consumed
  // anywhere else in AnalysisView, so they live next to the only
  // surface that reads them.
  const fmtForce = (kg) => {
    if (kg == null) return "—";
    if (useRel) return fmt1(forceOverBW(kg, bodyWeight));   // unitless ratio
    return fmtW(kg, unit);
  };
  const forceUnit = useRel ? "× BW" : unit;

  const splitMode = !!fdSplitData;

  // ── Split-mode series, precomputed (June 2026 audit) ─────────
  // This work — freshFitReps scans, per-grip three-exp fits, curve
  // sampling — used to run inline inside the chart's render JSX on
  // every render. Memoized here so it only recomputes when its
  // actual inputs change. Curve fits use the ENGINE BASIS (all reps
  // at fresh-equivalent loads, same as prescription()); dots stay
  // observed fresh rep-1s.
  const splitSeries = useMemo(() => {
    if (!fdSplitData || !threeExpPriors?.get) return null;
    const tMax = Math.max(maxDur, F_D_T_MIN + 10);
    const out = [];
    for (const grip of Object.keys(fdSplitData)) {
      const color = GRIP_COLORS[grip] || C.blue;
      // Engine-basis curve fit: all reps, fresh-equivalent loads.
      const fitReps = (history || []).filter(r =>
        r.grip === grip
        && (handView === "pooled" || r.hand === handView)
        && r.actual_time_s > 0 && effectiveLoad(r) > 0
      );
      let teeCurve = null;
      let ref180 = null;
      if (fitReps.length >= 2) {
        const pts = fitReps.map(r => ({
          T: r.actual_time_s,
          F: freshMap ? freshLoadFor(r, freshMap) : effectiveLoad(r),
        }));
        const amps = fitAmpsForPts(pts, grip, threeExpPriors);
        if (amps && (amps[0] + amps[1] + amps[2]) > 0) {
          teeCurve = Array.from({ length: 80 }, (_, i) => {
            const t = F_D_T_MIN + ((tMax - F_D_T_MIN) / 79) * i;
            const f = Math.max(predForceThreeExp(amps, t), 0);
            return {
              x: t,
              y: useRel && bodyWeight > 0
                ? forceOverBW(f, bodyWeight)
                : toDisp(f, unit),
            };
          });
          const r180 = predForceThreeExp(amps, 180);
          if (r180 > 0) ref180 = r180;
        }
      }
      // Dots: observed FRESH first reps only (matches the single-grip
      // scatter) — the within-set fatigue cloud lives in the
      // click-through session detail, not the main scatter.
      const dots = freshFitReps(history).filter(r =>
        r.grip === grip
        && (handView === "pooled" || r.hand === handView)
        && r.actual_time_s > 0
        && effectiveLoad(r) > 0
      ).map(r => ({
        x: r.actual_time_s,
        y: useRel && bodyWeight > 0
          ? forceOverBW(effectiveLoad(r), bodyWeight)
          : toDisp(effectiveLoad(r), unit),
        grip, date: r.date, hand: r.hand,
        session_id: r.session_id,
        target_duration: r.target_duration,
        rest_s: r.rest_s,
      }));
      out.push({ grip, color, teeCurve, ref180, dots });
    }
    return out;
  }, [fdSplitData, history, threeExpPriors, freshMap, handView, useRel, bodyWeight, unit, maxDur]);

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4, flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>Force vs. Duration</div>
        {onHandViewChange && <HandViewPills value={handView} onChange={onHandViewChange} />}
      </div>
      <div style={{ display: "flex", gap: 16, fontSize: 11, color: C.muted, marginBottom: 10, flexWrap: "wrap" }}>
        {!splitMode && <span><span style={{ color: POOLED_DOT }}>●</span> reps ({handView === "pooled" ? "pooled" : handView === "L" ? "left hand" : "right hand"})</span>}
        {!splitMode && threeExpCurveDataRel.length > 0 && <span title="Three-timescale F-D model fit on the SAME basis the prescription engine uses: every rep, at its fresh-equivalent load (corrected for within-set fatigue and cookedness). The curve is modeled fresh capacity — the line your recommendations come from — while the dots are observed fresh first reps."><span style={{ color: curveColor }}>―</span> modeled fresh capacity (3-exp)</span>}
        {!splitMode && threeExpRef180 != null && <span title="Three-exp prediction at T=180s — well past the medium component's decay, where the slow component carries essentially the whole load. The closest model analog to a 'long-duration sustainable force' reference."><span style={{ color: curveColor }}>╌</span> 3-min sustainable</span>}
        {splitMode && Object.keys(fdSplitData).map(g => (
          <span key={g}>
            <span style={{ color: GRIP_COLORS[g] || C.blue }}>―</span> {g}
            <span style={{ color: GRIP_COLORS[g] || C.blue, opacity: 0.7 }}> ╌</span> 3-min
          </span>
        ))}
        {useRel && <span style={{ color: C.purple }}>× bodyweight ({fmtW(bodyWeight, unit)} {unit})</span>}
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <ComposedChart margin={{ top: 10, right: 16, bottom: 28, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
          <XAxis
            type="number" dataKey="x"
            domain={[0, maxDur + 10]}
            label={{ value: "Duration (s)", position: "insideBottom", offset: -16, fill: C.muted, fontSize: 11 }}
            tick={{ fill: C.muted, fontSize: 11 }}
          />
          <YAxis
            type="number"
            domain={[0, Math.ceil(maxForceRel * 1.15 / (useRel ? 0.1 : 10)) * (useRel ? 0.1 : 10)]}
            tick={{ fill: C.muted, fontSize: 11 }}
            unit={useRel ? "" : ` ${unit}`}
            width={42}
          />
          <Tooltip content={<ScatterTooltip unit={forceUnit} />} />
          {/* Zone backgrounds — uniform neutral tint per zone. Driven by
              ZONE6 so the 6-zone schema is the single source of truth for
              both boundaries and colors. (The extra-saturated "limiter"
              highlight was removed May 2026 along with computeLimiterZone.) */}
          {ZONE6.map(z => {
            const x1 = z.min;
            const x2 = z.max === Infinity ? maxDur + 10 : z.max;
            return (
              <ReferenceArea
                key={z.key}
                x1={x1}
                x2={x2}
                fill={z.color}
                fillOpacity={0.07}
              />
            );
          })}
          {/* Single-fit overlays only when NOT in per-grip split mode.
              In split mode they'd be ambiguous (which grip's CF? which
              3-exp? which 90% band?). Per-grip rendering takes over. */}
          {/* 3-min sustainable reference from three-exp at T=180s
              (replaces the Monod CF asymptote, since three-exp has
              no true asymptote — it decays to 0). At 180s the slow
              curve-fit component carries essentially the whole
              load; this is the closest model analog to "what you
              can sustain for a long hold" the three-timescale
              fit can produce. */}
          {!fdSplitData && threeExpRef180 != null && (
            <ReferenceLine
              y={useRel ? forceOverBW(threeExpRef180, bodyWeight) : toDisp(threeExpRef180, unit)}
              stroke={curveColor} strokeDasharray="6 3" strokeWidth={1.5}
              label={{ value: `3-min ${fmtForce(threeExpRef180)} ${forceUnit}`, position: "insideTopRight", fill: curveColor, fontSize: 10 }}
            />
          )}
          {/* Primary curve — three-exp F-D. Solid line, tinted to the
              selected grip's color when one is filtered (matches the
              per-grip palette the All-Grips split-mode view uses);
              falls back to neutral purple in unfiltered mode. */}
          {!fdSplitData && threeExpCurveDataRel.length > 0 && (
            <Line data={threeExpCurveDataRel} dataKey="y" stroke={curveColor}
                  strokeWidth={2} dot={false}
                  legendType="none" isAnimationActive={false} />
          )}
          {!fdSplitData && (
            <Scatter data={dotsRel} dataKey="y" fill={POOLED_DOT} opacity={0.85} name="reps" onClick={handleDotClick} style={{ cursor: "pointer" }} />
          )}
          {/* Per-grip split mode: one curve + one set of dots per grip.
              Avoids the cross-muscle mudding (Micro FDP pinch ~5-10kg vs
              Crusher FDS crush ~15-30kg on a single curve). Failure dots
              retain their red/green meaning, but get a colored OUTLINE
              matching the grip so you can tell which is which. */}
          {splitSeries && splitSeries.flatMap(({ grip, color, teeCurve, ref180, dots }) => {
            const elements = [];
            if (teeCurve) {
              elements.push(
                <Line key={`${grip}-tee`} data={teeCurve} dataKey="y"
                  stroke={color} strokeWidth={2} dot={false}
                  legendType="none" isAnimationActive={false} />
              );
            }
            if (ref180 != null) {
              const refY = useRel && bodyWeight > 0
                ? forceOverBW(ref180, bodyWeight)
                : toDisp(ref180, unit);
              elements.push(
                <ReferenceLine key={`${grip}-ref180`} y={refY}
                  stroke={color} strokeDasharray="6 3" strokeWidth={1}
                  strokeOpacity={0.7}
                  label={{ value: `${grip} 3-min ${fmtForce(ref180)} ${forceUnit}`,
                    position: "insideRight", fill: color, fontSize: 9 }}
                />
              );
            }
            elements.push(
              <Scatter key={`${grip}-dots`} data={dots} dataKey="y"
                fill={color} opacity={0.85}
                onClick={handleDotClick} style={{ cursor: "pointer" }} />
            );
            return elements;
          })}
        </ComposedChart>
      </ResponsiveContainer>
      {/* Zone labels — 6-zone scheme. Wraps to two rows on narrow
          screens so all six fit cleanly. Boundaries come from ZONE6
          so labels stay in sync if the schema is tuned later. */}
      <div style={{
        display: "flex", flexWrap: "wrap", justifyContent: "center",
        gap: "4px 12px", marginTop: 6, fontSize: 10, color: C.muted,
      }}>
        {ZONE6.map(z => {
          const range = z.max === Infinity
            ? `${z.min}s+`
            : z.min === 0
              ? `<${z.max}s`
              : `${z.min}–${z.max}s`;
          return (
            <span key={z.key} style={{ color: z.color, whiteSpace: "nowrap" }}>
              {z.short} {range}
            </span>
          );
        })}
      </div>
      {/* Per-grip Hand Asymmetry rows — folded in below the chart.
          Tabular companion to the L/R dot scatter above: for each
          grip with both L and R fits, shows weaker hand load + the
          asymmetry %. Below ~5% reads as 'symmetric'; above ~15%
          flags the weaker hand as the real climbing limiter on this
          grip. Computed at T=30s (middle of curve, exercises fast +
          middle components).
          Auto-hide rule (May 2026): the section only renders when at
          least one grip crosses the 5% asymmetric threshold. When
          everything is symmetric there's no signal worth surfacing,
          and silently hiding keeps the F-D chart tighter. The check
          surfaces itself again automatically if asymmetry drifts in
          (injury, asymmetric training, instrument drift), so the
          user doesn't have to remember to look for it. */}
      {handAsymmetry.some(h => h.asymPct >= 0.05) && (
        <div style={{ marginTop: 16, paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>
            Hand Asymmetry
          </div>
          {handAsymmetry.map(({ grip, L, R, stronger, weaker, asymPct }) => {
            const flagColor = asymPct >= 0.15 ? C.red
                           : asymPct >= 0.05 ? C.orange
                           : C.green;
            const flagText  = asymPct >= 0.15 ? "limiter"
                           : asymPct >= 0.05 ? "asymmetric"
                           : "symmetric";
            const pctRound  = Math.round(asymPct * 100);
            // L and R are in kg from the asymmetry useMemo. When
            // normalizeOn, render both as % of current bodyweight
            // so the per-grip strength reads in climbing units
            // (a 35% BW micro-pinch means more to a climber than
            // an absolute kg figure).
            const renderForce = (kg) => {
              if (normalizeOn && bodyWeight > 0) {
                return `${Math.round((kg / bodyWeight) * 100)}% BW`;
              }
              return `${fmtW(kg, unit)} ${unit}`;
            };
            return (
              <div key={grip} style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "8px 0",
                borderBottom: `1px solid ${C.border}`,
              }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: GRIP_COLORS[grip] || C.text }}>
                    {grip}
                  </div>
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
                    L {renderForce(L)} · R {renderForce(R)}
                    {pctRound > 0 && (
                      <> · <b style={{ color: C.text }}>{weaker}</b> is {pctRound}% behind <b style={{ color: C.text }}>{stronger}</b></>
                    )}
                  </div>
                </div>
                <span style={{
                  fontSize: 10, fontWeight: 700, color: flagColor,
                  background: `${flagColor}1a`,
                  padding: "3px 8px", borderRadius: 4,
                  textTransform: "uppercase", letterSpacing: 0.5,
                  whiteSpace: "nowrap",
                }}>
                  {flagText}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* (Fit diagnostic line removed — was a vestigial training-RMSE
          readout from the three-exp validation phase. Curve quality
          is judged by eye on the scatter above.) */}
    </Card>
  );
}
