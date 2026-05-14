// ─────────────────────────────────────────────────────────────
// PRESCRIBED LOAD CARD — per-zone load table for the selected grip
// ─────────────────────────────────────────────────────────────
// Shows the anchored prescription (curve_shape × amplitude_anchor) at
// every zone's reference time for one grip, both hands. Tabular sibling
// of the F-D chart: same fit, expressed as discrete zone buckets.
// Highlights the zone the continuous engine would currently recommend
// so "what should I do next" maps to a specific cell.
//
// Rendered in two places — under the Recommended Session pick on Setup
// (in-the-moment context) and under the F-D chart on Analysis (reference
// view). Lives in src/views/cards/ so neither view imports from the
// other; both sibling views consume from a shared module.
//
// Replaces the historical CF+W'/T card retired with the Monod removal
// (May 2026). Three-exp is the only model now, so no shadow column.

import React, { useMemo, useState } from "react";
import { C } from "../../ui/theme.js";
import { Card } from "../../ui/components.js";
import { fmtW } from "../../ui/format.js";
import { ZONE_KEYS } from "../../model/zones.js";
import { prescription } from "../../model/prescription.js";
import { coachingRecommendationContinuous } from "../../model/coaching.js";
import { fatigueToModifier } from "../../model/climbingFatigue.js";
import { applyPersonalGain } from "../../model/perceivedFatigueLearning.js";

export function PrescribedLoadCard({
  history, grip, freshMap, threeExpPriors, activities = [], unit, GOAL_CONFIG,
  // Controlled-mode props: when both are passed (Setup, where the
  // slider value drives the actual workout), state lives in the
  // parent so the runner can stamp perceived_rpe onto every rep.
  // When omitted (Analysis, pure what-if exploration) we fall back
  // to local state.
  perceivedRpe: perceivedRpeProp,
  onPerceivedRpeChange,
  // Per-zone learned gains from perceivedFatigueLearning. Adapts
  // the population fatigue curve to the user's actual response.
  // Null/undefined = use population curve unmodified.
  personalGains = null,
}) {
  // "How cooked do you feel today?" slider. 1 = totally fresh
  // (no scaling); 10 = destroyed. Two coupled effects:
  //   * each tile's L/R load is multiplied by fatigueToModifier(zone, rpe, 0)
  //     so the user sees the scale-down per zone.
  //   * the same value is fed to coachingRecommendationContinuous as
  //     perceivedFatigue so the highlighted "recommended" zone shifts
  //     toward less intense work as the user dials it up — Power gets
  //     the hardest hit, Endurance the lightest, matching the
  //     per-zone curve in climbingFatigue.fatigueToModifier.
  const [perceivedRpeLocal, setPerceivedRpeLocal] = useState(1);
  const isControlled = perceivedRpeProp != null && typeof onPerceivedRpeChange === "function";
  const perceivedRpe = isControlled ? perceivedRpeProp : perceivedRpeLocal;
  const setPerceivedRpe = isControlled ? onPerceivedRpeChange : setPerceivedRpeLocal;

  const rec = useMemo(
    () => grip
      ? coachingRecommendationContinuous(history, grip, {
          freshMap, threeExpPriors, activities,
          perceivedFatigue: perceivedRpe > 1 ? perceivedRpe : 0,
          personalGains,
        })
      : null,
    [history, grip, freshMap, threeExpPriors, activities, perceivedRpe, personalGains]
  );
  const recommendedZone = rec?.zone;

  const rows = useMemo(() => {
    if (!grip) return null;
    return ZONE_KEYS.map(key => {
      const cfg = GOAL_CONFIG[key];
      if (!cfg) return null;
      const T = cfg.refTime;
      const pL = prescription(history, "L", grip, T, { freshMap, threeExpPriors });
      const pR = prescription(history, "R", grip, T, { freshMap, threeExpPriors });
      // hoursAgo=0 so the slider lands at full strength. Same per-zone
      // curve the engine uses, so the displayed load matches what the
      // recommendation is scoring against. The personal gain (learned
      // from past actual-vs-predicted reps under known RPE conditions)
      // adapts the population suppression curve to this user.
      const fatigueMod = perceivedRpe > 1
        ? applyPersonalGain(
            fatigueToModifier(key, perceivedRpe, 0),
            personalGains?.[key],
          )
        : 1.0;
      return {
        key, label: cfg.label, emoji: cfg.emoji, color: cfg.color, T,
        L: pL?.value != null ? pL.value * fatigueMod : null,
        R: pR?.value != null ? pR.value * fatigueMod : null,
        fatigueMod,
        // Reliability — worse of the two hands. If either is
        // extrapolating, dim the row so the user knows the load is
        // a long reach past data.
        reliability:
          !pL && !pR ? null
          : pL?.reliability === "extrapolation" || pR?.reliability === "extrapolation" ? "extrapolation"
          : pL?.reliability === "marginal" || pR?.reliability === "marginal" ? "marginal"
          : "well-supported",
      };
    }).filter(Boolean);
  }, [history, grip, freshMap, threeExpPriors, GOAL_CONFIG, perceivedRpe, personalGains]);

  if (!grip) return null;
  if (!rows || rows.every(r => r.L == null && r.R == null)) return null;

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>
        Prescribed Load — {grip}
      </div>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>
        Per-zone load at the curve's reference time, anchored to your most recent rep 1.
        Recommended zone is highlighted.
      </div>
      {/* Perceived-fatigue slider. Slide right and the loads scale down
          per the zone's sensitivity curve (Max/Power get hit hardest,
          Endurance least). The recommended-zone highlight also shifts
          since the engine sees the same fatigue scalar. */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "10px 12px", marginBottom: 12,
        borderRadius: 8, background: C.bg, border: `1px solid ${C.border}`,
      }}>
        <div style={{ flex: "0 0 auto" }}>
          <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 2 }}>
            How cooked today?
          </div>
          <div style={{ fontSize: 10, color: C.muted }}>
            {perceivedRpe === 1 ? "fresh — no scale-down" : `RPE ${perceivedRpe}`}
            {personalGains && perceivedRpe > 1 && (() => {
              // Show a tiny "calibrated" tag when the recommended-zone's
              // gain has drifted meaningfully from the population curve.
              const zoneKey = recommendedZone;
              const g = zoneKey ? personalGains[zoneKey] : null;
              if (g == null || Math.abs(g - 1) < 0.1) return null;
              const direction = g < 1 ? "less cooked than avg" : "more cooked than avg";
              return (
                <span style={{ marginLeft: 6, color: C.purple, fontStyle: "italic" }}>
                  · calibrated ({direction})
                </span>
              );
            })()}
          </div>
        </div>
        <input
          type="range" min={1} max={10} step={1}
          value={perceivedRpe}
          onChange={e => setPerceivedRpe(Number(e.target.value))}
          style={{ flex: 1, accentColor: C.orange }}
          aria-label="Perceived fatigue (1 fresh, 10 cooked)"
        />
        {perceivedRpe > 1 && (
          <button
            onClick={() => setPerceivedRpe(1)}
            style={{
              flex: "0 0 auto", fontSize: 10, padding: "2px 8px",
              borderRadius: 4, border: `1px solid ${C.border}`,
              background: "transparent", color: C.muted, cursor: "pointer",
            }}
          >reset</button>
        )}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {rows.map(r => {
          const active = r.key === recommendedZone;
          const dim = r.reliability === "extrapolation";
          const scalePct = r.fatigueMod < 0.999 ? Math.round((1 - r.fatigueMod) * 100) : 0;
          return (
            <div key={r.key} style={{
              padding: "10px 12px", borderRadius: 8,
              background: active ? r.color + "1a" : C.bg,
              border: `1px solid ${active ? r.color : C.border}`,
              opacity: dim ? 0.55 : 1,
            }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: r.color }}>
                  {r.emoji} {r.label}
                </div>
                <div style={{ fontSize: 10, color: C.muted }}>
                  {scalePct > 0 && <span style={{ marginRight: 6, color: C.orange }}>−{scalePct}%</span>}
                  {r.T}s
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5 }}>L</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: C.blue, lineHeight: 1 }}>
                    {r.L != null ? fmtW(r.L, unit) : "—"}
                  </div>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5 }}>R</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: C.blue, lineHeight: 1 }}>
                    {r.R != null ? fmtW(r.R, unit) : "—"}
                  </div>
                </div>
              </div>
              {r.reliability === "extrapolation" && (
                <div style={{ fontSize: 9, color: C.muted, marginTop: 4, fontStyle: "italic" }}>
                  extrapolating
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 10, color: C.muted, marginTop: 10, textAlign: "right" }}>
        values in {unit}
      </div>
    </Card>
  );
}
