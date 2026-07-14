// Badge collection — a derived, at-a-glance view of the user's level
// across every (grip, zone) they've trained. Pure read of history via
// deriveBadges (no storage). Rendered in the History tab (fingers
// domain). Returns null when the user has no finger history yet.
import React, { useMemo } from "react";
import { C } from "../../ui/theme.js";
import { Card } from "../../ui/components.js";
import { deriveBadges } from "../../model/badges.js";

export function BadgeCollection({ history = [] }) {
  const badges = useMemo(() => deriveBadges(history), [history]);
  if (badges.length === 0) return null;
  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{
        fontSize: 12, fontWeight: 700, marginBottom: 10, color: C.muted,
        letterSpacing: 1.2, textTransform: "uppercase",
      }}>
        Badges
      </div>
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(92px, 1fr))",
        gap: 8,
      }}>
        {badges.map(b => (
          <div
            key={`${b.grip}|${b.zone}`}
            title={`${b.grip} · ${b.zoneLabel} · Level ${b.level}`}
            style={{
              background: C.bg, border: `1px solid ${C.border}`,
              borderRadius: 10, padding: "10px 6px", textAlign: "center",
            }}
          >
            <div style={{ fontSize: 26, lineHeight: 1 }}>{b.emoji}</div>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginTop: 5 }}>{b.grip}</div>
            <div style={{ fontSize: 10, color: b.color || C.muted, marginTop: 1 }}>{b.zoneShort}</div>
            <div style={{ fontSize: 11, fontWeight: 800, color: C.blue, marginTop: 3 }}>Lv {b.level}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}
