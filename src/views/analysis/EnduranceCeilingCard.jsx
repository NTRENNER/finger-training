// ─────────────────────────────────────────────────────────────
// EnduranceCeilingCard — sustained force as a % of measured max
// ─────────────────────────────────────────────────────────────
// The ratio between the curve's long-duration force (the "endurance
// ceiling", F at ENDURANCE_CEILING_T = 240s — deep slow-component
// territory) and the best MEASURED instantaneous peak. June 2026,
// idea borrowed from community dashboards' "Endurance Ceiling — % of
// CMF" cards.
//
// Why it's useful: it's a limiter diagnostic in one number. A low %
// means the gap between what you can pull once and what you can
// sustain is wide — endurance is the relatively undertrained end. A
// high % means your sustained force is already close to max, so raw
// max strength is the lever that lifts the whole curve. We make NO
// absolute "typical range" claims (population norms for this exact
// protocol don't exist) — the comparison that matters is between
// YOUR grips and against your own history.
//
// Inputs: pooled per-grip three-exp amps (grip3xEstimates from
// useGripFits — same fits every other card uses) and measured peaks
// via buildPeakForceTrend. Provisional-peak grips (no max/power
// session yet) are listed but unscored: dividing by a sub-max peak
// would overstate the ratio.

import React, { useMemo } from "react";
import { C } from "../../ui/theme.js";
import { Card } from "../../ui/components.js";
import { GRIP_COLORS } from "../../ui/grip-colors.js";
import { fmt1, toDisp } from "../../ui/format.js";
import { predForceThreeExp, ENDURANCE_CEILING_T } from "../../model/threeExp.js";
import { buildPeakForceTrend } from "../../model/peakForce.js";

export function EnduranceCeilingCard({
  history,
  grip3xEstimates = {},
  // Hand selector (June 2026): in L/R mode the ratio uses that hand's
  // fits (perHandGripEstimates, keys `${grip}|${hand}`) over that
  // hand's measured peaks.
  perHandGripEstimates = {},
  handView = "pooled",
  unit = "lbs",
}) {
  const rows = useMemo(() => {
    const split = handView === "L" || handView === "R";
    const scopedHistory = split
      ? (history || []).filter(r => r?.hand === handView)
      : history;
    const ampsByGrip = split
      ? Object.fromEntries(
          Object.entries(perHandGripEstimates)
            .filter(([key]) => key.endsWith(`|${handView}`))
            .map(([key, amps]) => [key.split("|")[0], amps])
        )
      : grip3xEstimates;
    const trend = buildPeakForceTrend(scopedHistory);
    if (!trend) return [];
    const out = [];
    for (const [grip, amps] of Object.entries(ampsByGrip)) {
      if (!Array.isArray(amps) || amps.length !== 3) continue;
      const ceilingKg = predForceThreeExp(amps, ENDURANCE_CEILING_T);
      if (!(ceilingKg > 0)) continue;
      const peak = trend.best[grip];
      const provisional = !!trend.provisional?.[grip];
      out.push({
        grip,
        ceilingKg,
        peakKg: peak?.kg ?? null,
        pct: (!provisional && peak?.kg > 0)
          ? Math.round((ceilingKg / peak.kg) * 100)
          : null,   // no qualified max measurement yet
      });
    }
    return out.sort((a, b) => a.grip.localeCompare(b.grip));
  }, [history, grip3xEstimates, perHandGripEstimates, handView]);

  if (rows.length === 0) return null;

  // Cross-grip comparison line — only when ≥2 grips have a real %.
  const scored = rows.filter(r => r.pct != null);
  const comparison = scored.length >= 2 ? (() => {
    const hi = scored.reduce((m, r) => (r.pct > m.pct ? r : m));
    const lo = scored.reduce((m, r) => (r.pct < m.pct ? r : m));
    if (hi.pct - lo.pct < 3) return null;  // within noise, say nothing
    return `${lo.grip} has the wider max-to-sustained gap — its endurance end has relatively more room than ${hi.grip}'s.`;
  })() : null;

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>
        Endurance ceiling — sustained vs max
        {(handView === "L" || handView === "R") && (
          <span style={{ color: handView === "R" ? C.orange : C.blue, marginLeft: 8, fontSize: 12 }}>
            {handView === "R" ? "Right hand" : "Left hand"}
          </span>
        )}
      </div>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>
        The curve's force at {ENDURANCE_CEILING_T}s as a share of your
        best measured peak. Low % = wide gap between one hard pull and
        what you can sustain (endurance is the lever); high % = your
        sustained force is already near max (raw strength is the
        lever). Compare across your grips, not against outside numbers.
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {rows.map(r => (
          <div key={r.grip} style={{
            flex: "1 1 130px", background: C.bg, borderRadius: 10,
            padding: "10px 12px", border: `1px solid ${C.border}`,
          }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: GRIP_COLORS[r.grip] || C.blue, marginBottom: 4 }}>
              {r.grip}
            </div>
            {r.pct != null ? (
              <>
                <div style={{ fontSize: 24, fontWeight: 800, color: C.text, lineHeight: 1.1 }}>
                  {r.pct}<span style={{ fontSize: 13, color: C.muted }}>% of max</span>
                </div>
                <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>
                  {fmt1(toDisp(r.ceilingKg, unit))} sustained · {fmt1(toDisp(r.peakKg, unit))} peak {unit}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.4 }}>
                {fmt1(toDisp(r.ceilingKg, unit))} {unit} sustained —
                needs a max/power day for a measured peak before the
                ratio means anything.
              </div>
            )}
          </div>
        ))}
      </div>
      {comparison && (
        <div style={{ fontSize: 11, color: C.muted, marginTop: 10, fontStyle: "italic", lineHeight: 1.4 }}>
          {comparison}
        </div>
      )}
    </Card>
  );
}
