// ─────────────────────────────────────────────────────────────
// DeloadGauge — recovery-readiness light (green → yellow → red)
// ─────────────────────────────────────────────────────────────
// Replaces the two raw recovery-trend charts (cut May 2026 — they were
// diagnostic deviation metrics that read like scoreboards and invited
// "it's going down, is that bad?" misreads). This is the same signal,
// reframed as a glanceable state: how close you are to a deload, from
// your cross-grip between-rep recovery. It uses the SAME conservative
// gating as the deload trigger, so red doesn't flicker on one rough
// session. Pure presentational; takes a deloadStatus() result.

import React from "react";
import { C } from "../../ui/theme.js";
import { Card } from "../../ui/components.js";

const LEVEL_COLOR = { green: C.green, yellow: C.yellow, red: C.red };

export function DeloadGauge({ status }) {
  if (!status) return null;
  const { level, pressure, label, haveSignal, deload } = status;
  const color = LEVEL_COLOR[level] || C.green;
  const markerPct = Math.max(1, Math.min(99, (haveSignal ? pressure : 0) * 100));

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>Recovery status</div>
        <div style={{ fontSize: 12.5, fontWeight: 700, color }}>{label}</div>
      </div>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 14, lineHeight: 1.5 }}>
        How close you are to needing a deload, read from your cross-grip
        between-rep recovery. Green = absorbing your load; yellow = recovery
        softening, ease up soon; red = deload recommended. Intentionally slow
        to move — it won't react to a single rough session.
      </div>

      {/* Traffic-light track with a pointer at the current pressure. */}
      <div style={{ position: "relative", paddingTop: 9 }}>
        <div style={{
          position: "absolute", top: 0, left: `${markerPct}%`, transform: "translateX(-50%)",
          width: 0, height: 0,
          borderLeft: "5px solid transparent", borderRight: "5px solid transparent",
          borderTop: `7px solid ${C.text}`,
          opacity: haveSignal ? 1 : 0.35,
        }} />
        <div style={{
          height: 10, borderRadius: 5, opacity: haveSignal ? 1 : 0.4,
          background: `linear-gradient(90deg, ${C.green} 0%, ${C.green} 30%, ${C.yellow} 42%, ${C.yellow} 70%, ${C.red} 84%, ${C.red} 100%)`,
        }} />
      </div>

      {!haveSignal && (
        <div style={{ fontSize: 11, color: C.muted, marginTop: 12 }}>
          Log a few more sessions across both grips to activate.
        </div>
      )}
      {level !== "green" && deload?.why && (
        <div style={{ fontSize: 12, color: C.muted, marginTop: 12, lineHeight: 1.5 }}>
          {deload.why}
        </div>
      )}
    </Card>
  );
}
