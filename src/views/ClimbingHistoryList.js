// ─────────────────────────────────────────────────────────────
// CLIMBING HISTORY LIST
// ─────────────────────────────────────────────────────────────
// Shared date-grouped climb list. Used in the Climbing tab and the
// History tab's "climbing" domain — both render per-climb rows with
// optional delete affordance. Pure presentation; data comes in via
// `climbs` prop, deletes are dispatched via `onDeleteActivity`
// callback (omit to render in read-only mode).

import React, { useMemo } from "react";
import { C } from "../ui/theme.js";
import { Card } from "../ui/components.js";
import {
  disciplineMeta, ascentMeta, wallMeta, describeClimb,
} from "../lib/climbing-grades.js";

export function ClimbingHistoryList({ climbs, onDeleteActivity = null }) {
  const byDate = useMemo(() => {
    const m = new Map();
    for (const c of climbs) {
      const d = c.date || "—";
      if (!m.has(d)) m.set(d, []);
      m.get(d).push(c);
    }
    return [...m.entries()];
  }, [climbs]);

  if (climbs.length === 0) {
    return (
      <Card>
        <div style={{ color: C.muted, fontSize: 13 }}>
          No climbs logged yet. Use the Climbing tab to log your first climb.
        </div>
      </Card>
    );
  }

  return byDate.map(([date, list]) => (
    <Card key={date}>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>
        {date} · {list.length} climb{list.length === 1 ? "" : "s"}
      </div>
      {list.map(c => {
        const isSend = c.ascent && c.ascent !== "attempt";
        const disc   = disciplineMeta(c.discipline);
        // Wall is boulder-only and may be missing on legacy entries.
        const wall   = c.discipline === "boulder" && c.wall ? wallMeta(c.wall) : null;
        return (
          <div key={c.id || `${c.date}-${c.grade}-${c.ascent}`} style={{
            display: "flex", alignItems: "center", gap: 10,
            padding: "8px 0",
            borderTop: `1px solid ${C.border}`,
          }}>
            <div style={{ fontSize: 18 }}>{disc.emoji}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                {c.grade || "—"}{" "}
                <span style={{ color: C.muted, fontWeight: 400 }}>
                  {disc.label}{wall ? ` · ${wall.label}` : ""}
                </span>
              </div>
              <div style={{ fontSize: 11, color: isSend ? C.green : C.muted }}>
                {c.ascent ? ascentMeta(c.ascent).label : describeClimb(c)}
              </div>
            </div>
            {onDeleteActivity && c.id && (
              <button
                onClick={() => {
                  if (window.confirm("Delete this climb?")) onDeleteActivity(c.id);
                }}
                style={{
                  background: "none", border: "none", color: C.muted,
                  cursor: "pointer", fontSize: 16, padding: "4px 6px",
                }}
                title="Delete climb"
              >
                ×
              </button>
            )}
          </div>
        );
      })}
    </Card>
  ));
}
