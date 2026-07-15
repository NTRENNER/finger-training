// Tendon-session history — the log of completed tendon-protocol
// sessions, shown under the History tab's "Tendon" domain. Self-
// contained via useTendon (cloud-synced, separate from the reps model).
// Each row: date, preset, and time-under-tension; trash to delete.
import React from "react";
import { C } from "../ui/theme.js";
import { Card } from "../ui/components.js";
import { useTendon } from "../hooks/useTendon.js";
import { presetName, tendonAdherence } from "../model/tendon.js";
import { today } from "../util.js";
import { fmtClock } from "../ui/format.js";

export function TendonHistoryList() {
  const { sessions, loaded, removeSession } = useTendon();
  const adh = tendonAdherence(sessions, today(), 3);

  if (loaded && sessions.length === 0) {
    return (
      <Card>
        <div style={{ color: C.muted, fontSize: 13, lineHeight: 1.6 }}>
          No tendon sessions logged yet. Start one from the Tendon card on the
          Fingers setup screen — it records here once you finish.
        </div>
      </Card>
    );
  }

  const sorted = [...sessions].sort((a, b) =>
    (b.date || "").localeCompare(a.date || "") ||
    (b.created_at || "").localeCompare(a.created_at || ""));

  return (
    <>
      <Card style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>Tendon sessions</div>
          <div style={{ fontSize: 11, color: adh.onTrack ? C.green : C.muted, fontWeight: 700 }}>
            {adh.weekCount}/{adh.goalPerWeek} this week{adh.streak > 0 ? ` · 🔥 ${adh.streak}` : ""}
          </div>
        </div>
        <div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>
          {sessions.length} total · low-load connective-tissue work, separate from finger training.
        </div>
      </Card>

      {sorted.map(s => (
        <Card key={s.id} style={{ marginBottom: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>
                🩹 {presetName(s.preset)}
              </div>
              <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
                {s.date}{s.created_at ? " · " + fmtClock(s.created_at) : ""}
                {s.sets ? ` · ${s.sets} hangs` : ""}
                {s.total_work_s ? ` · ~${s.total_work_s}s under tension` : ""}
              </div>
            </div>
            <button
              onClick={() => {
                // eslint-disable-next-line no-alert
                if (window.confirm(`Delete tendon session from ${s.date}?`)) removeSession(s.id);
              }}
              title="Delete session"
              style={{ background: "none", border: "none", color: C.muted, fontSize: 15, cursor: "pointer", padding: "0 4px", lineHeight: 1 }}
            >🗑</button>
          </div>
        </Card>
      ))}
    </>
  );
}
