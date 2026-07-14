// Badge collection — a derived, at-a-glance view of the user's level
// across every (grip, zone) they've trained. Pure read of history via
// deriveBadges (no storage). Rendered in the History tab (fingers
// domain). Returns null when the user has no finger history yet.
//
// Presents as a SINGLE top-level row (collapsed by default) — badge
// count + a peek at the top emoji tiers — that expands to the full
// grid on tap, so it doesn't crowd the top of History.
import React, { useMemo, useState } from "react";
import { C } from "../../ui/theme.js";
import { Card } from "../../ui/components.js";
import { deriveBadges } from "../../model/badges.js";

export function BadgeCollection({ history = [] }) {
  const badges = useMemo(() => deriveBadges(history), [history]);
  const [open, setOpen] = useState(false);
  if (badges.length === 0) return null;

  // deriveBadges is already sorted highest-level first, so the first
  // few emojis are a fair "best of" peek for the collapsed row.
  const peek = badges.slice(0, 6).map(b => b.emoji).join(" ");

  return (
    <Card style={{ marginBottom: 16, padding: 0 }}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        style={{
          width: "100%", background: "none", border: "none", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "12px 14px", color: C.text, textAlign: "left",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <span style={{
            fontSize: 12, fontWeight: 700, letterSpacing: 1.2,
            textTransform: "uppercase", color: C.muted, whiteSpace: "nowrap",
          }}>
            Badges
          </span>
          <span style={{
            fontSize: 11, fontWeight: 700, color: C.blue,
            background: C.bg, borderRadius: 10, padding: "1px 7px",
          }}>{badges.length}</span>
          {!open && (
            <span style={{
              fontSize: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>{peek}</span>
          )}
        </span>
        <span style={{ color: C.muted, fontSize: 12, whiteSpace: "nowrap", marginLeft: 8 }}>
          {open ? "Hide ▲" : "Show ▼"}
        </span>
      </button>

      {open && (
        <div style={{ padding: "0 14px 14px" }}>
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
        </div>
      )}
    </Card>
  );
}
