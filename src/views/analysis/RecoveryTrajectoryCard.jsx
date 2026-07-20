// ──────────────────────────────────────────────────────────────
// RECOVERY TRAJECTORY CARD  (Analysis tab)
// ──────────────────────────────────────────────────────────────
// "Is my between-rep recovery improving over time?" — the History tab
// shows recovery dynamics for ONE session; this shows the trend across
// sessions, per grip. Two series on one chart:
//
//   • Duration retention (green): rep-2 hold time ÷ rep-1 hold time at
//     the target rep. HIGHER = you hold a bigger share of your opener.
//   • Model gap (purple): observed fraction − what the fatigue model
//     predicted. Above 0 = retaining MORE time than the model expects;
//     below 0 = less (an early fatigue signal). The shaded ±band is
//     rep-timing noise — gaps inside it just "match the model", so
//     don't read a single dip in the band as a problem.
//
// Deliberately trend-first: the bold lines are 3-session rolling means
// (raw values are faint dots) so the eye reads direction, not the
// per-session scatter. Built entirely from buildRecoveryTrend — the
// same series the deload detector already uses — so nothing new is
// stored or computed off-model.
import React, { useMemo, useState } from "react";
import {
  ResponsiveContainer, ComposedChart, Line,
  XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine, ReferenceArea,
} from "recharts";
import { C } from "../../ui/theme.js";
import { Card } from "../../ui/components.js";
import { GRIP_COLORS } from "../../ui/grip-colors.js";
import { buildRecoveryTrend, withRollingMean, GAP_NOISE_BAND } from "../../model/recoveryDynamics.js";
import { buildPhysModel } from "../../model/repCurveData.js";

const REC_COLOR = C.green;
const GAP_COLOR = C.purple;
const BAND = Math.round(GAP_NOISE_BAND * 100); // ±pp band as a whole number

export function RecoveryTrajectoryCard({ history = [] }) {
  // Grips with at least some timed finger reps — recovery is a per-grip
  // property (tissue + protocol differ), so we never pool grips here.
  const grips = useMemo(() => {
    const s = new Set();
    for (const r of history) {
      if (r && r.grip && Number(r.actual_time_s) > 0) s.add(r.grip);
    }
    return [...s].sort();
  }, [history]);

  const [selGrip, setSelGrip] = useState(null);
  const grip = selGrip && grips.includes(selGrip) ? selGrip : grips[0];

  // Per-grip physModel (for the model-gap line). Seeded with whichever
  // hand actually has reps for this grip; recovery taus are grip-level
  // so the hand mostly affects the base capacity fit, not the gap ratio.
  const rows = useMemo(() => {
    if (!grip) return null;
    const hand = history.some(r => r.grip === grip && r.hand === "R" && Number(r.actual_time_s) > 0) ? "R" : "L";
    let physModel = null;
    try { physModel = buildPhysModel(history, hand, grip); } catch { physModel = null; }
    const trend = withRollingMean(buildRecoveryTrend(history, grip, { physModel }), 3);
    return trend.map(r => ({
      date: r.date,
      recPct: r.observedAtTarget != null ? Math.round(r.observedAtTarget * 100) : null,
      recSm:  r.observedSmoothed != null ? Math.round(r.observedSmoothed * 100) : null,
      gapPct: r.gapAtTarget != null ? Math.round(r.gapAtTarget * 100) : null,
      gapSm:  r.gapSmoothed != null ? Math.round(r.gapSmoothed * 100) : null,
    }));
  }, [history, grip]);

  // Need at least two datapoints with a recovery value to draw a trend.
  const nRec = rows ? rows.filter(r => r.recPct != null).length : 0;
  if (!grip || nRec < 2) return null;
  const hasGap = rows.some(r => r.gapPct != null);

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4, flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>
          Recovery trajectory — rep-time retention over time
        </div>
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
        Green is how much of your opening rep's time you retain by the target rep. It is a duration ratio, not a direct capacity measurement.
        {hasGap && <> Purple is that ratio minus the nonlinear fatigue-model forecast: above 0 you retained more time than expected, below 0 less. The shaded ±{BAND}pp band is timing noise — dips inside it just match the model, so read the bold rolling-mean lines, not single dots.</>}
      </div>
      <ResponsiveContainer width="100%" height={210}>
        <ComposedChart data={rows} margin={{ top: 6, right: 8, bottom: 28, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
          <XAxis dataKey="date" tick={{ fill: C.muted, fontSize: 9 }} angle={-30} textAnchor="end" interval="preserveStartEnd"
            label={{ value: "Date", position: "insideBottom", offset: -18, fill: C.muted, fontSize: 11 }} />
          {/* Left axis — rep-duration retention (%). */}
          <YAxis yAxisId="rec" tick={{ fill: C.muted, fontSize: 11 }} width={44} unit="%" domain={[40, 110]}
            label={{ value: "rep-time", angle: -90, position: "insideLeft", fill: REC_COLOR, fontSize: 11 }} />
          {/* Right axis — model gap (percentage points), centered on 0. */}
          <YAxis yAxisId="gap" orientation="right" tick={{ fill: C.muted, fontSize: 11 }} width={40} unit="pp" domain={[-40, 40]}
            label={{ value: "gap", angle: 90, position: "insideRight", fill: GAP_COLOR, fontSize: 11 }} />
          {/* ±noise band + zero line on the gap axis. */}
          {hasGap && <ReferenceArea yAxisId="gap" y1={-BAND} y2={BAND} fill={GAP_COLOR} fillOpacity={0.08} />}
          {hasGap && <ReferenceLine yAxisId="gap" y={0} stroke={GAP_COLOR} strokeDasharray="2 2" strokeOpacity={0.6} />}
          <Tooltip
            contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }}
            formatter={(val, name) => [
              val == null ? "—" : (name.includes("gap") ? `${val >= 0 ? "+" : ""}${val}pp` : `${val}%`),
              name,
            ]}
          />
          {/* Recovery fraction: faint raw dots + bold smoothed line. */}
          <Line yAxisId="rec" dataKey="recPct" stroke="none"
            dot={{ r: 2.5, fill: REC_COLOR, fillOpacity: 0.5, stroke: "none" }} activeDot={{ r: 4 }}
            name="rep-time (raw)" isAnimationActive={false} />
          <Line yAxisId="rec" dataKey="recSm" stroke={REC_COLOR} strokeWidth={3} dot={false} connectNulls
            name="rep-time retained" isAnimationActive={false} />
          {/* Model gap: faint raw dots + bold dashed smoothed line. */}
          {hasGap && (
            <Line yAxisId="gap" dataKey="gapPct" stroke="none"
              dot={{ r: 2.5, fill: GAP_COLOR, fillOpacity: 0.5, stroke: "none" }} activeDot={{ r: 4 }}
              name="model gap (raw)" isAnimationActive={false} />
          )}
          {hasGap && (
            <Line yAxisId="gap" dataKey="gapSm" stroke={GAP_COLOR} strokeWidth={3} strokeDasharray="5 3" dot={false} connectNulls
              name="model gap" isAnimationActive={false} />
          )}
        </ComposedChart>
      </ResponsiveContainer>
      <div style={{ display: "flex", justifyContent: "center", gap: 16, marginTop: 4, fontSize: 10, color: C.muted }}>
        <span style={{ color: REC_COLOR }}>━ rep-time retained</span>
        {hasGap && <span style={{ color: GAP_COLOR }}>┉ vs model (pp)</span>}
      </div>
    </Card>
  );
}
