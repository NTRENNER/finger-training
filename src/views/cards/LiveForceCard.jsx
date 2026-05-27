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
// target so the release cue is obvious without reading the number.
//
// Props:
//   seconds        — elapsed seconds (number)
//   targetSeconds  — target hold duration (number)
//   running        — when false the display reads as muted (paused)
export function BigTimer({ seconds, targetSeconds, running }) {
  const pct = targetSeconds ? Math.min(seconds / targetSeconds, 1) : 0;
  const over = seconds >= targetSeconds;
  const color = running ? (over ? C.green : C.blue) : C.muted;
  return (
    <div style={{ textAlign: "center", padding: "24px 0" }}>
      <div style={{ fontSize: 108, fontWeight: 800, fontVariantNumeric: "tabular-nums", color, lineHeight: 1 }}>
        {fmtTime(seconds)}
      </div>
      <div style={{ marginTop: 12, fontSize: 13, color: C.muted }}>
        target: {fmtTime(targetSeconds)}
      </div>
      <div style={{ marginTop: 10, height: 6, background: C.border, borderRadius: 3, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct * 100}%`, background: color, borderRadius: 3, transition: "width 0.2s" }} />
      </div>
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
//   avg        — running plateau-averaged force kg (number)
//   peak       — running peak force kg (number)
//   targetKg   — prescribed target load kg (number | null)
//   maxDisplay — bar's full-scale kg (default 50 — reasonable for
//                Tindeq output forces; bigger isolates the avg
//                marker visually for typical training loads)
//   unit       — "lbs" or "kg" — display only, kg is the wire format
export function ForceGauge({ force, avg, peak, targetKg = null, maxDisplay = 50, unit = "lbs" }) {
  const fPct    = clamp(force / maxDisplay, 0, 1);
  const avgPct  = clamp(avg   / maxDisplay, 0, 1);
  const tgtPct  = targetKg != null ? clamp(targetKg / maxDisplay, 0, 1) : null;

  let barColor = C.blue;
  let numColor = C.blue;
  if (targetKg != null && targetKg > 0) {
    if (force >= targetKg * 1.10) { barColor = C.purple; numColor = C.purple; }
    else if (force >= targetKg * 0.99) { barColor = C.green;  numColor = C.green;  }
    else                               { barColor = C.orange; numColor = C.orange; }
  }

  return (
    <div style={{ marginTop: 8 }}>
      {/* Large live-force number, same scale as BigTimer above. */}
      <div style={{ textAlign: "center", fontSize: 108, fontWeight: 800, fontVariantNumeric: "tabular-nums", color: numColor, lineHeight: 1 }}>
        {fmtW(force, unit)}
      </div>
      <div style={{ textAlign: "center", fontSize: 13, color: C.muted, marginTop: 4, marginBottom: 10 }}>
        live {unit}{targetKg != null ? ` · target ${fmtW(targetKg, unit)} ${unit}` : ""}
      </div>
      {/* Avg / Max running stats — explicit labels because the big
          number above is "live current force." Same color hierarchy
          as the bar marker below (avg green, peak orange). */}
      <div style={{ display: "flex", justifyContent: "space-around", fontSize: 12, color: C.muted, marginBottom: 6 }}>
        <span>Avg: <b style={{ color: C.green, fontVariantNumeric: "tabular-nums" }}>{fmtW(avg, unit)}</b></span>
        <span>Max: <b style={{ color: C.orange, fontVariantNumeric: "tabular-nums" }}>{fmtW(peak, unit)}</b></span>
      </div>
      {/* Bar — live force as colored fill, avg as a green tick, target
          as a faint white marker. */}
      <div style={{ position: "relative", height: 28, background: C.border, borderRadius: 6, overflow: "hidden" }}>
        <div style={{ position: "absolute", height: "100%", width: `${fPct * 100}%`, background: barColor, borderRadius: 6, transition: "width 0.05s" }} />
        <div style={{ position: "absolute", top: 0, bottom: 0, left: `${avgPct * 100}%`, width: 3, background: C.green }} />
        {tgtPct != null && (
          <div style={{ position: "absolute", top: 0, bottom: 0, left: `${tgtPct * 100}%`, width: 2, background: "#ffffff60" }} />
        )}
      </div>
    </div>
  );
}
