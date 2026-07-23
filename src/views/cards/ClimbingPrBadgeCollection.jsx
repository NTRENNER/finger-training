import React, { useMemo, useState } from "react";
import { ascentMeta, disciplineMeta } from "../../lib/climbing-grades.js";
import { deriveClimbingPrBadges } from "../../model/climbingPrBadges.js";
import { C } from "../../ui/theme.js";
import { Card } from "../../ui/components.js";

const BADGE_COLORS = {
  boulder_indoor_commercial: C.orange,
  boulder_indoor_moonboard: C.purple,
  boulder_indoor_kilter: C.blue,
  boulder_outdoor: C.green,
  route_indoor: C.red,
  route_outdoor: C.yellow,
};

function formatBadgeDate(ymd) {
  if (!ymd) return "";
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function ClimbingPrBadgeCollection({ climbs = [] }) {
  const badges = useMemo(() => deriveClimbingPrBadges(climbs), [climbs]);
  const [open, setOpen] = useState(false);
  if (badges.length === 0) return null;

  const peek = badges.slice(0, 4).map(badge => badge.grade).join(" · ");

  return (
    <Card style={{ marginBottom: 16, padding: 0 }}>
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        style={{
          width: "100%",
          background: "none",
          border: "none",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 14px",
          color: C.text,
          textAlign: "left",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <span style={{
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: 1.2,
            textTransform: "uppercase",
            color: C.muted,
            whiteSpace: "nowrap",
          }}>
            Climbing PRs
          </span>
          <span style={{
            fontSize: 11,
            fontWeight: 700,
            color: C.green,
            background: C.bg,
            borderRadius: 8,
            padding: "1px 7px",
          }}>
            {badges.length}
          </span>
          {!open && (
            <span style={{
              color: C.text,
              fontSize: 12,
              fontWeight: 700,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}>
              {peek}
            </span>
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
            gridTemplateColumns: "repeat(auto-fill, minmax(148px, 1fr))",
            gap: 8,
          }}>
            {badges.map(badge => {
              const color = BADGE_COLORS[badge.key] || C.blue;
              const ascent = ascentMeta(badge.ascent).label;
              const source = disciplineMeta(badge.sourceDiscipline).label;
              const detail = badge.discipline === "route" ? `${source} · ${ascent}` : ascent;

              return (
                <div
                  key={badge.key}
                  title={[
                    badge.label,
                    badge.grade,
                    badge.routeName,
                    detail,
                    formatBadgeDate(badge.date),
                  ].filter(Boolean).join(" · ")}
                  style={{
                    minWidth: 0,
                    background: C.bg,
                    border: `1px solid ${C.border}`,
                    borderTop: `3px solid ${color}`,
                    borderRadius: 8,
                    padding: "10px 11px",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <span style={{ color, fontSize: 24, fontWeight: 800, lineHeight: 1 }}>
                      {badge.grade}
                    </span>
                    <span style={{ fontSize: 18, lineHeight: 1 }}>{badge.emoji}</span>
                  </div>
                  <div style={{ color: C.text, fontSize: 12, fontWeight: 700, marginTop: 7 }}>
                    {badge.label}
                  </div>
                  {badge.routeName && (
                    <div style={{
                      color: C.text,
                      fontSize: 11,
                      marginTop: 3,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}>
                      {badge.routeName}
                    </div>
                  )}
                  <div style={{ color: C.muted, fontSize: 10, marginTop: 3 }}>
                    {detail}{badge.date ? ` · ${formatBadgeDate(badge.date)}` : ""}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Card>
  );
}
