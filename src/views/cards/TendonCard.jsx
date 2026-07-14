// Tendon-protocol card for the Fingers/Setup screen. Shows weekly
// adherence + streak and launches the guided timer. A completed session
// logs one cloud row (no load). Fully self-contained: reads/writes via
// useTendon, so it can drop into SetupView with no prop threading. This
// track is intentionally separate from the muscular reps model.
import React, { useState } from "react";
import { C } from "../../ui/theme.js";
import { Card, Btn } from "../../ui/components.js";
import { TENDON_PRESET, tendonAdherence, totalSets, totalWorkSeconds } from "../../model/tendon.js";
import { useTendon } from "../../hooks/useTendon.js";
import { TendonTimer } from "./TendonTimer.jsx";
import { today } from "../../util.js";

export function TendonCard() {
  const { sessions, logSession } = useTendon();
  const [active, setActive] = useState(false);
  const adh = tendonAdherence(sessions, today(), 3);

  if (active) {
    return (
      <Card style={{ marginBottom: 0, borderColor: C.blue }}>
        <TendonTimer
          preset={TENDON_PRESET}
          onComplete={({ sets, totalWorkS }) =>
            logSession({ preset: TENDON_PRESET.key, sets, totalWorkS })}
          onCancel={() => setActive(false)}
        />
      </Card>
    );
  }

  return (
    <Card style={{ marginBottom: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 800 }}>
            🩹 Tendon · <span style={{ color: C.blue }}>{TENDON_PRESET.name}</span>
          </div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 1 }}>{TENDON_PRESET.subtitle}</div>
        </div>
        <div style={{ fontSize: 11, color: adh.onTrack ? C.green : C.muted, fontWeight: 700 }}>
          {adh.weekCount}/{adh.goalPerWeek} this wk
        </div>
      </div>

      {/* last-7-days adherence dots */}
      <div style={{ display: "flex", gap: 5, marginTop: 10 }}>
        {adh.last7.map((d, i) => (
          <div key={d.date} title={d.date} style={{
            flex: 1, height: 8, borderRadius: 4,
            background: d.done ? C.green : C.border,
          }} />
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
        <span style={{ fontSize: 11, color: C.muted }}>
          {adh.streak > 0 ? `🔥 ${adh.streak}-day streak` : "last 7 days"}
        </span>
        <span style={{ fontSize: 11, color: C.muted }}>{adh.total} total</span>
      </div>

      <Btn onClick={() => setActive(true)} color={C.blue}
           style={{ marginTop: 12, width: "100%", padding: "12px 0", fontSize: 15, borderRadius: 12 }}>
        ▶ Start tendon session
      </Btn>
      <div style={{ fontSize: 11, color: C.muted, marginTop: 8, textAlign: "center", lineHeight: 1.5 }}>
        {totalSets(TENDON_PRESET)} hangs · 10s on / 50s off · ~{Math.round(totalWorkSeconds(TENDON_PRESET))}s
        under tension · ~{TENDON_PRESET.effortPct}% effort. Do it on your no-hang/board — separate from your
        Tindeq training.
      </div>
    </Card>
  );
}
