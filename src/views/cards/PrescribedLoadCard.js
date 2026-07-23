// ──────────────────────────────────────────────────────────────
// PRESCRIBED LOAD CARD — per-zone load table for the selected grip
// ──────────────────────────────────────────────────────────────
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
import { capacityMultiplier } from "../../model/fatigueBeta.js";

export function PrescribedLoadCard({
  history, grip, freshMap, threeExpPriors, activities = [], unit, GOAL_CONFIG,
  // Controlled-mode props: when both are passed, state lives in the
  // parent. When omitted (Analysis what-if exploration) we fall back
  // to local state and treat the slider as informational only —
  // nothing is upserted to daily_state from this card.
  cooked: cookedProp,
  onCookedChange,
  // Per-grip β model from user_settings.settings.fatigue_model.
  // Drives the displayed load scale-down via exp(-β_grip · cooked).
  fatigueModel = null,
}) {
  // "How cooked today?" slider. 0 = fresh (multiplier = 1); 10 = wrecked.
  // In Analysis mode the slider is for retrospective what-if, so we keep
  // the local-state fallback at 0 (no scale-down by default). In Setup
  // mode this card is no longer rendered — SessionPlanCard owns the
  // mandatory slider and the daily_state upsert.
  const [cookedLocal, setCookedLocal] = useState(0);
  const isControlled = cookedProp != null && typeof onCookedChange === "function";
  const cooked = isControlled ? cookedProp : cookedLocal;
  const setCooked = isControlled ? onCookedChange : setCookedLocal;

  const rec = useMemo(
    () => grip
      ? coachingRecommendationContinuous(history, grip, {
          freshMap, threeExpPriors, activities,
          perceivedFatigue: cooked || 0,
        })
      : null,
    [history, grip, freshMap, threeExpPriors, activities, cooked]
  );
  const recommendedZone = rec?.zone;

  const rows = useMemo(() => {
    if (!grip) return null;
    // Per-grip multiplier — same value applies to every tile because
    // β is per-grip in this model. exp(-β·cooked); 1.0 at cooked=0.
    const fatigueMod = capacityMultiplier(fatigueModel, grip, cooked);
    return ZONE_KEYS.map(key => {
      const cfg = GOAL_CONFIG[key];
      if (!cfg) return null;
      const T = cfg.refTime;
      const pL = prescription(history, "L", grip, T, { freshMap, threeExpPriors });
      const pR = prescription(history, "R", grip, T, { freshMap, threeExpPriors });
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
        // Anti-collapse floor lifted the load above the bare curve value
        // (the three-exp fit has no non-zero asymptote, so far past your
        // longest hold it decays to implausibly light loads). Worse/either
        // hand — surfacing it tells the user the number is a sane floor,
        // not a literal curve read.
        extrapFloored: Boolean(pL?.extrapFloored || pR?.extrapFloored),
        // A load reduced to the peak-force ceiling where that ceiling
        // came from an OLDER measurement (no recent max in the window),
        // not the generic corruption backstop. Worth flagging so the
        // number reads as "capped by a stale measured peak — retest."
        peakStaleCapped: Boolean((pL?.peakCapped && pL?.peakCapStale) || (pR?.peakCapped && pR?.peakCapStale)),
        extrapolationBoundaryS: [pL?.extrapolationBoundaryS, pR?.extrapolationBoundaryS]
          .filter(Number.isFinite)
          .reduce((m, v) => Math.min(m, v), Infinity),
      };
    }).filter(Boolean);
  }, [history, grip, freshMap, threeExpPriors, GOAL_CONFIG, fatigueModel, cooked]);

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
      {/* What-if cookedness slider for retrospective exploration. 0 =
          fresh (no scale-down). Drag right to see how the loads would
          drop on a cooked day. Per-grip multiplier exp(-β·c); same
          factor applies to every zone tile. The Setup screen owns the
          authoritative slider — this one is informational only. */}
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
            {cooked === 0 ? "fresh — no scale-down" : `cooked ${cooked}/10`}
            {cooked > 0 && grip && (() => {
              // True applied multiplier (fixed manual scaling) — not
              // the β-derived discount the disabled learner would have
              // applied. Keeps this card honest alongside SessionPlanCard.
              const pct = Math.round((1 - capacityMultiplier(fatigueModel, grip, cooked)) * 100);
              if (pct < 1) return null;
              return (
                <span style={{ marginLeft: 6, color: C.purple, fontStyle: "italic" }}>
                  · {pct}% scale-down
                </span>
              );
            })()}
          </div>
        </div>
        <input
          type="range" min={0} max={10} step={1}
          value={cooked}
          onChange={e => setCooked(Number(e.target.value))}
          style={{ flex: 1, accentColor: C.orange }}
          aria-label="Cookedness (0 fresh, 10 wrecked)"
        />
        {cooked > 0 && (
          <button
            onClick={() => setCooked(0)}
            style={{
              flex: "0 0 auto", fontSize: 10, padding: "2px 8px",
              borderRadius: 4, border: `1px solid ${C.border}`,
              background: "transparent", color: C.muted, cursor: "pointer",
            }}
          >fresh</button>
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
              {r.extrapFloored && (
                <div
                  style={{ fontSize: 9, color: C.orange, marginTop: 2, fontStyle: "italic" }}
                  title="This duration is beyond the supported data range. The app holds load at the modeled data boundary instead of presenting the flat tail as physiology. Log a longer failure to extend support."
                >
                  ⚠ unsupported beyond {Number.isFinite(r.extrapolationBoundaryS) ? `${r.extrapolationBoundaryS}s` : "data"} · load held at boundary
                </div>
              )}
              {r.peakStaleCapped && (
                <div
                  style={{ fontSize: 9, color: C.muted, marginTop: 2, fontStyle: "italic" }}
                  title="Capped by your best MEASURED peak force — but that measurement is older than the recent window. A safe physical ceiling; retest your max to refresh it."
                >
                  ⓘ ceiling from an older max — retest to refresh
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
