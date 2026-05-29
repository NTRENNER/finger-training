// ─────────────────────────────────────────────────────────────
// CurveImprovementCard — per-zone Δ% summary under the F-D chart
// ─────────────────────────────────────────────────────────────
// Extracted from AnalysisView.js (late May 2026 BACKLOG #156, fifth
// pass). Renders the "Curve Improvement" Card that sits directly
// under the F-D chart: per-zone Δ% tiles + total AUC ratio,
// branching across three modes:
//
//   1. perGripMode — no grip filter active AND ≥2 grips have current
//      fits. One section per grip so Micro (FDP pinch) and Crusher
//      (FDS crush) each show their own Δ% against the shared
//      per-grip baseline. Avoids the cross-muscle artifact a pooled
//      number would re-introduce.
//   2. selGrip — grip filter active. One row of Δ% vs that grip's
//      pooled baseline.
//   3. Default — pooled global baseline (rare; only when a single
//      grip is in the data or no per-grip baselines yet).
//
// Each mode has an "early days" placeholder showing baseline-unlock
// progress ("3 of 5 failures · 2 of 3 durations") so the user can
// see why a section is gated and how close they are.
//
// Pure render — no state, no memos. The card's `(improvement ||
// gripImprovement...)` gate is the responsibility of the caller;
// AnalysisView renders <CurveImprovementCard ... /> unconditionally
// and the component itself short-circuits to null when nothing to
// show. That keeps the parent JSX flat.

import React from "react";
import { C } from "../../ui/theme.js";
import { Card } from "../../ui/components.js";
import { ZONE6 } from "../../model/zones.js";
import { improvementForAmps } from "../../model/baselines.js";
import { effectiveLoad } from "../../model/load.js";

// Per-grip baseline-unlock thresholds. Match the gates in
// buildGripBaselines so the "X of 5 failures" copy in the early-days
// placeholders is honest.
const FAIL_THRESHOLD = 5;
const DUR_THRESHOLD  = 3;

// Compute progress toward a per-grip (or per-grip × hand) baseline
// unlock. Returns { failures, distinctDurations, ready } so the UI
// placeholders can show concrete "3 of 5" / "2 of 3" rather than the
// static threshold copy.
//
// Hand is optional; pass null/undefined to count across both hands.
// Train-to-failure model: every rep with a valid actual_time_s is a
// (T, F) failure data point.
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

// Reusable row renderer — one header (optional label) plus the
// six-zone Δ% tiles plus a big "total" headline. Used by every mode
// of the card.
function ImprovementRow({ label, imp }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
        {label && (
          <div style={{ fontSize: 12, fontWeight: 700, color: C.text }}>
            {label}
          </div>
        )}
        <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginLeft: "auto" }}>
          <div style={{ fontSize: 26, fontWeight: 900, color: imp.total >= 0 ? C.green : C.red, lineHeight: 1 }}>
            {imp.total >= 0 ? "+" : ""}{imp.total}%
          </div>
          <div style={{ fontSize: 11, color: C.muted }}>total</div>
        </div>
      </div>
      {/* 6 zone tiles. Two rows of three on narrow screens
          (gridTemplateColumns auto-wraps via `repeat(3, ...)`).
          Short labels (Max/Pwr/P/S/Str/S/E/End) keep tiles
          readable on mobile. Driven by ZONE6 so labels and
          colors come from the schema. */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, 1fr)",
        gap: 6,
      }}>
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

// Inline placeholder strip — "[<grip> · ] 3 of 5 failures · 2 of 3
// durations" with each count tinted green once it crosses the
// threshold. Two callers with slightly different styling:
//
//   • perGripMode (showGrip=true): renders the grip name in bold as a
//     prefix, counts unbolded. Inside a card section that's per-grip.
//   • selGrip-no-baseline (showGrip=false, bold=true): the grip is
//     already named in the sentence above, so we skip the prefix and
//     bold the counts instead.
function ProgressLine({ grip, history, showGrip = true, bold = false }) {
  const p = baselineProgress(history, grip);
  const fontWeight = bold ? 600 : undefined;
  return (
    <>
      {showGrip && (<><b style={{ color: C.text }}>{grip}</b>{" · "}</>)}
      <span style={{ color: p.failures >= FAIL_THRESHOLD ? C.green : C.text, fontWeight }}>
        {Math.min(p.failures, FAIL_THRESHOLD)} of {FAIL_THRESHOLD} failures
      </span>
      {" · "}
      <span style={{ color: p.distinctDurations >= DUR_THRESHOLD ? C.green : C.text, fontWeight }}>
        {Math.min(p.distinctDurations, DUR_THRESHOLD)} of {DUR_THRESHOLD} durations
      </span>
    </>
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
}) {
  // Short-circuit: nothing to show. Caller can render this
  // unconditionally without gating itself.
  if (!improvement && Object.keys(gripImprovement).length === 0) return null;

  // perGripMode is keyed off having multiple per-grip CURRENT fits,
  // not improvements — so users mid-data-collection see an honest
  // "early days" message instead of falling back to the pooled
  // improvement number, which would re-introduce the same cross-
  // muscle artifact (Crusher's high-CF reps inflating Micro's
  // baseline) that motivated the per-grip split in the first
  // place.
  const perGripMode = !selGrip && Object.keys(grip3xEstimates).length >= 2;
  const gripImpEntries = Object.entries(gripImprovement);

  // When a grip filter is active, compute its improvement vs the
  // per-grip pooled baseline — same calc as the Capacity (AUC) chart
  // at this grip's most-recent point, so the numbers tie out across
  // surfaces. The Curve Improvement headline previously had a
  // per-hand branch (and earlier still, an "average of per-hand
  // improvements" alternative) but both went away with the page-level
  // hand filter.
  let scopedImp = null;
  let scopedBaselineDate = null;
  let scopedScopeLabel = null;
  if (selGrip) {
    const gRef = gripBaselines[selGrip];
    if (gRef && grip3xEstimates[selGrip]) {
      scopedImp = improvementForAmps(grip3xEstimates[selGrip], gRef.amps);
      scopedBaselineDate = gRef.date;
      scopedScopeLabel = `${selGrip} (pooled fit)`;
    }
  }

  return (
    <Card style={{ marginBottom: 16, border: `1px solid ${C.purple}40` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>Curve Improvement</div>
        {!perGripMode && !selGrip && global3xBaseline && (
          <div style={{ fontSize: 11, color: C.muted }}>since {global3xBaseline.date}</div>
        )}
        {selGrip && scopedImp && (
          <div style={{ fontSize: 11, color: C.muted }}>since {scopedBaselineDate}</div>
        )}
      </div>
      {perGripMode ? (
        gripImpEntries.length > 0 ? (
          <>
            {gripImpEntries.map(([grip, imp], i, arr) => (
              <div key={grip} style={{
                paddingBottom: i < arr.length - 1 ? 12 : 0,
                borderBottom: i < arr.length - 1 ? `1px solid ${C.border}` : "none",
                marginBottom: i < arr.length - 1 ? 12 : 0,
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: C.text }}>{grip}</div>
                  <div style={{ fontSize: 10, color: C.muted }}>since {imp.baselineDate}</div>
                </div>
                <ImprovementRow label={null} imp={imp} />
              </div>
            ))}
            {/* Show an "early days" placeholder for any grip with a
                current fit but no qualifying per-grip baseline yet,
                so the user knows we're aware of it and waiting on
                more data rather than silently dropping it. */}
            {Object.keys(grip3xEstimates).filter(g => !gripImprovement[g]).map(grip => (
              <div key={grip} style={{
                paddingTop: 12, marginTop: 12, borderTop: `1px solid ${C.border}`,
                fontSize: 11, color: C.muted, lineHeight: 1.5,
              }}>
                <ProgressLine grip={grip} history={history} />
              </div>
            ))}
          </>
        ) : (
          <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
            Need ≥5 failures across ≥3 target durations <i>per grip</i> to seed a stable per-grip baseline. Until then the three-exp fit can't separate the fast / medium / slow components cleanly enough for the per-zone Δ% to be meaningful.
          </div>
        )
      ) : selGrip ? (
        scopedImp ? (
          <>
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>
              {/* Pooled-fit label only — reads as "X vs X baseline".
                  Previously had a per-hand and an averaged-hands
                  variant, both retired with the page-level hand
                  filter. */}
              {`${scopedScopeLabel} vs ${scopedScopeLabel} baseline`}
            </div>
            <ImprovementRow label={null} imp={scopedImp} />
          </>
        ) : (
          <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
            Need ≥{FAIL_THRESHOLD} failures across ≥{DUR_THRESHOLD} target durations on <b>{selGrip}</b> for a fair apples-to-apples comparison. Pooled global baseline isn't shown here — it mixes muscle groups (FDP pinch vs FDS crush) and would produce misleading Δ%.
            <div style={{ marginTop: 6, fontSize: 11 }}>
              Progress:{" "}
              <ProgressLine grip={selGrip} history={history} showGrip={false} bold />
            </div>
          </div>
        )
      ) : improvement ? (
        <ImprovementRow label={null} imp={improvement} />
      ) : null}
    </Card>
  );
}
