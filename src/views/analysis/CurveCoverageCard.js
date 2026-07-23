// Curve coverage is an exception surface: it stays out of the metric stack
// unless a previously sampled zone is stale or approaching its lockout.

import React, { useMemo, useState } from "react";
import { C } from "../../ui/theme.js";
import { Card } from "../../ui/components.js";
import { ZONE_KEYS, ZONE6 } from "../../model/zones.js";
import { GRIP_COLORS } from "../../ui/grip-colors.js";
import { getZoneStaleness, LOCKOUT_WINDOW_DAYS } from "../../model/lockout.js";

const GRIP_ORDER = ["Crusher", "Micro", "Prime"];
const ATTENTION_STATUSES = new Set(["stale", "warning"]);

const zoneRangeLabel = zone =>
  !isFinite(zone.max) ? `${zone.min}s+`
  : zone.min === 0 ? `<${zone.max}s`
  : `${zone.min}–${zone.max}s`;
const ZONE_RANGE = Object.fromEntries(ZONE6.map(zone => [zone.key, zoneRangeLabel(zone)]));

export function CurveCoverageCard({ history = [] }) {
  const [selectedGrip, setSelectedGrip] = useState(null);
  const presentGrips = useMemo(() => {
    const set = new Set(history.map(rep => rep?.grip).filter(Boolean));
    const ordered = GRIP_ORDER.filter(grip => set.has(grip));
    for (const grip of set) if (!ordered.includes(grip)) ordered.push(grip);
    return ordered;
  }, [history]);

  const coverageByGrip = useMemo(() => {
    const byGrip = new Map();
    for (const grip of presentGrips) {
      byGrip.set(grip, getZoneStaleness(history.filter(rep => rep?.grip === grip)));
    }
    return byGrip;
  }, [history, presentGrips]);

  const attentionGrips = presentGrips.filter(grip =>
    ZONE_KEYS.some(zone => ATTENTION_STATUSES.has(coverageByGrip.get(grip)?.[zone]?.status))
  );
  if (attentionGrips.length === 0) return null;

  const activeGrip = selectedGrip && attentionGrips.includes(selectedGrip)
    ? selectedGrip
    : attentionGrips[0];
  const staleness = coverageByGrip.get(activeGrip);
  const attentionZones = ZONE_KEYS.filter(zone => ATTENTION_STATUSES.has(staleness[zone].status));
  const staleCount = attentionZones.filter(zone => staleness[zone].status === "stale").length;
  const warningCount = attentionZones.length - staleCount;

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>Curve Coverage</div>
        <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
          Data that needs attention
        </div>
      </div>

      {attentionGrips.length > 1 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
          {attentionGrips.map(grip => {
            const active = activeGrip === grip;
            const color = GRIP_COLORS[grip] || C.blue;
            return (
              <button
                key={grip}
                onClick={() => setSelectedGrip(grip)}
                style={{
                  padding: "4px 12px",
                  borderRadius: 999,
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                  border: `1px solid ${active ? color : C.border}`,
                  background: active ? `${color}22` : "transparent",
                  color: active ? color : C.muted,
                }}
              >
                {grip}
              </button>
            );
          })}
        </div>
      )}

      <div style={{
        padding: "8px 10px",
        marginBottom: 8,
        background: C.bg,
        borderRadius: 8,
        border: `1px solid ${staleCount > 0 ? C.red : C.orange}40`,
        fontSize: 11,
        color: C.muted,
        lineHeight: 1.5,
      }}>
        {staleCount > 0 && (
          <span style={{ color: C.red, fontWeight: 700 }}>{staleCount} stale</span>
        )}
        {staleCount > 0 && warningCount > 0 && " · "}
        {warningCount > 0 && (
          <span style={{ color: C.orange, fontWeight: 700 }}>{warningCount} aging</span>
        )}
        <div style={{ marginTop: 4 }}>
          {staleCount > 0
            ? "The engine will prioritize a fresh sample."
            : "The engine is beginning to favor a fresh sample."}
        </div>
      </div>

      {attentionZones.map(zone => {
        const status = staleness[zone];
        const stale = status.status === "stale";
        const color = stale ? C.red : C.orange;
        const daysText = status.days === 1 ? "1 day ago" : `${status.days} days ago`;
        return (
          <div
            key={zone}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 8,
              padding: "7px 0",
              borderBottom: `1px solid ${C.border}`,
            }}
          >
            <div style={{ minWidth: 0, fontSize: 12, color: C.text }}>
              {zone.replace(/_/g, " · ").replace(/\b\w/g, char => char.toUpperCase())}
              <span style={{
                color: C.muted,
                fontSize: 11,
                marginLeft: 6,
                fontVariantNumeric: "tabular-nums",
                whiteSpace: "nowrap",
              }}>
                {ZONE_RANGE[zone]}
              </span>
            </div>
            <div style={{ flexShrink: 0, textAlign: "right" }}>
              <div style={{ fontSize: 11, color: C.muted, fontVariantNumeric: "tabular-nums" }}>
                {daysText}
              </div>
              <div style={{ fontSize: 9, fontWeight: 700, color, textTransform: "uppercase" }}>
                {stale ? "stale" : "soon"} · {LOCKOUT_WINDOW_DAYS[zone]}d
              </div>
            </div>
          </div>
        );
      })}
    </Card>
  );
}
