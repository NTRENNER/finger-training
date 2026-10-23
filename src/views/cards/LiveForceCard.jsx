// ─────────────────────────────────────────────────────────────
// LIVE FORCE CARD — shared big-timer + force-gauge primitives
// ─────────────────────────────────────────────────────────────
// Both the finger-training active rep (ActiveSessionViews.js) and
// the adaptive warm-up hang (WarmupView.js) want the same visual
// language for "you're pulling right now": a giant elapsed-time
// number with target progress, then a giant live-force number with
// running avg / peak and a colored bar relative to target.
//
// Pulled into a shared file so the two consumers stay in sync — a
// tweak to the color thresholds, the font scale, or the layout
// flows to both places without drift. Nothing else changed: the
// component contracts are identical to the originals that lived
// inline in ActiveSessionViews.js prior to this extraction.
//
// Both displays are pure presentational components — they take
// props and render. No tindeq import, no state. The caller wires
// up the BLE stream and the timer.

import React from "react";
import { C } from "../../ui/theme.js";
import { fmtW, fmtTime } from "../../ui/format.js";
import { clamp } from "../../util.js";

// Big seconds counter + target line + progress bar. Used during
// active reps (count up to target) and warm-up hangs (same shape,
// shorter targets). Color flips green when the user has held past
// target to mark the prescription target; this is not a release instruction.
//
// Props:
//   seconds        — elapsed seconds (number)
//   targetSeconds  — target hold duration (number)
//   running        — when false the display reads as muted (paused)
//   showTarget     — false when the target is displayed elsewhere (the
//                    active rep shows it beside the target weight)
function BigTimer({ seconds, targetSeconds, running, referenceOnly = false, showTarget = true }) {
  const pct = targetSeconds ? Math.min(seconds / targetSeconds, 1) : 0;
  const over = !referenceOnly && seconds >= targetSeconds;
  const color = running ? (over ? C.green : C.blue) : C.muted;
  return (
    <div style={{ textAlign: "center", padding: "24px 0" }}>
      <div style={{ fontSize: 108, fontWeight: 800, fontVariantNumeric: "tabular-nums", color, lineHeight: 1 }}>
        {fmtTime(seconds)}
      </div>
      {showTarget && <div style={{ marginTop: 12, fontSize: 13, color: C.muted }}>
        {referenceOnly ? 'fresh reference' : 'target'}: {fmtTime(targetSeconds)}
      </div>}
      {!referenceOnly && <div style={{ marginTop: 10, height: 6, background: C.border, borderRadius: 3, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct * 100}%`, background: color, borderRadius: 3, transition: "width 0.2s" }} />
      </div>}
    </div>
  );
}

// Big live-force number + Avg / Max sub-row + force bar with the
// target marked. Color zones (relative to target):
//   force < 99% of target              → orange (under)
//   force ≥ 99% of target               → green  (in window)
//   force ≥ 110% of target              → purple (over-pulling)
//   no target set                       → neutral blue
//
// Props:
//   force      — live current force kg (number)
//   avg        — running average force kg (number)
//   peak       — running peak force kg (number)
//   targetKg   — prescribed target load kg (number | null)
//   maxDisplay — bar's full-scale kg (default 50 — reasonable for
//                Tindeq output forces; bigger isolates the avg
//                marker visually for typical training loads)
//   unit       — "lbs" or "kg" — display only, kg is the wire format
//   numberSize — CSS font size for the live force; warm-ups scale for phones
//   targetTime / targetTimeLabel — optional preformatted target duration
//                ("45s"); shown beside the target weight so both targets
//                read together during a rep
function ForceGauge({ force, avg, peak, targetKg = null, maxDisplay = 50, unit = "lbs", numberSize = 108, emphasizePeak = false,
  targetTime = null, targetTimeLabel = "Target time" }) {
  const fPct    = clamp(force / maxDisplay, 0, 1);
  const avgPct  = clamp(avg   / maxDisplay, 0, 1);
  const tgtPct  = targetKg != null ? clamp(targetKg / maxDisplay, 0, 1) : null;
  const liveActive = typeof force === "number" && isFinite(force);

  let barColor = C.blue;
  let numColor = C.blue;
  if (targetKg != null && targetKg > 0 && liveActive) {
    if (force >= targetKg * 1.10) { barColor = C.purple; numColor = C.purple; }
    else if (force >= targetKg * 0.99) { barColor = C.green;  numColor = C.green;  }
    else                               { barColor = C.orange; numColor = C.orange; }
  }

  return (
    <div style={{ marginTop: 8 }}>
      {/* A target is optional: Peak Test intentionally has no prescribed
          weight, while training and warm-up callers always provide one. */}
      {(targetTime || Number.isFinite(targetKg)) && <div style={{
        display: "flex", justifyContent: "center", gap: 24, textAlign: "center",
        marginBottom: liveActive ? 16 : 8,
      }}>
        {targetTime && <TargetValue label={targetTimeLabel} value={targetTime} paired={Number.isFinite(targetKg)} />}
        {Number.isFinite(targetKg) && <TargetValue label="Target weight" value={`${fmtW(targetKg, unit)} ${unit}`} paired={!!targetTime} />}
      </div>}

      {/* Live measurement block — only renders with a real sample so the
          card doesn't take up vertical space on dashes when no sensor
          is streaming. */}
      {liveActive && <>
        <div style={{ textAlign: "center", fontSize: numberSize, fontWeight: 800, fontVariantNumeric: "tabular-nums", color: numColor, lineHeight: 1 }}>
          {fmtW(force, unit)}
        </div>
        <div style={{ textAlign: "center", fontSize: 13, color: C.muted, marginTop: 4, marginBottom: 10 }}>
          Live force · {unit}
        </div>
        <div style={{ display: "flex", justifyContent: "space-around", alignItems: "center", flexWrap: "wrap", gap: 16, color: C.muted, margin: "12px 0" }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 14, color: C.text, marginBottom: 4 }}>{emphasizePeak ? 'Peak force' : 'Average weight'}</div>
            <div style={{ fontSize: "clamp(32px, 9vw, 44px)", fontWeight: 800, lineHeight: 1.1, color: C.green, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
              {!emphasizePeak && avg == null ? "—" : fmtW(emphasizePeak ? peak : avg, unit)} <span style={{ fontSize: 16, fontWeight: 600 }}>{unit}</span>
            </div>
          </div>
          <span style={{ fontSize: 12 }}>{emphasizePeak ? 'Avg' : 'Max'}: <b style={{ color: C.orange, fontVariantNumeric: "tabular-nums" }}>{fmtW(emphasizePeak ? avg : peak, unit)}</b></span>
        </div>
        <div style={{ position: "relative", height: 28, background: C.border, borderRadius: 6, overflow: "hidden" }}>
          <div style={{ position: "absolute", height: "100%", width: `${fPct * 100}%`, background: barColor, borderRadius: 6, transition: "width 0.05s" }} />
          {avg != null && <div style={{ position: "absolute", top: 0, bottom: 0, left: `${avgPct * 100}%`, width: 3, background: C.green }} />}
          {tgtPct != null && (
            <div style={{ position: "absolute", top: 0, bottom: 0, left: `${tgtPct * 100}%`, width: 2, background: "#ffffff60" }} />
          )}
        </div>
      </>}
    </div>
  );
}

function TargetValue({ label, value, paired }) {
  return (
    <div style={{ flex: paired ? "1 1 0" : "0 1 auto", minWidth: 0 }}>
      <div style={{ fontSize: 14, color: C.text, marginBottom: 4 }}>{label}</div>
      <div style={{
        fontSize: paired ? "clamp(28px, 8vw, 44px)" : 44, fontWeight: 900, lineHeight: 1.1,
        color: C.blue, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap",
      }}>{value}</div>
    </div>
  );
}

// React.memo (2026-07-01): this component sits under the live BLE
// force stream — App-level state updates every animation frame while
// the Tindeq is connected. Memo skips reconciliation entirely when
// this component's own props haven't changed; without it every force
// sample re-rendered the full recharts tree.
const BigTimerMemo = React.memo(BigTimer);
const ForceGaugeMemo = React.memo(ForceGauge);
export { BigTimerMemo as BigTimer, ForceGaugeMemo as ForceGauge };
