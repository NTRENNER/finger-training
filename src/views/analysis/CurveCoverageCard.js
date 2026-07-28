// Curve coverage is an exception surface: it stays out of the metric stack
// unless a previously sampled zone is stale or approaching its lockout.

import React, { useMemo } from "react";
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

export function curveCoverageAttentionByGrip(history = [], { handView = "pooled" } = {}) {
  const scopedHistory = handView === "pooled"
    ? history
    : history.filter(rep => rep?.hand === handView);
  const set = new Set(scopedHistory.map(rep => rep?.grip).filter(Boolean));
  const presentGrips = GRIP_ORDER.filter(grip => set.has(grip));
  for (const grip of set) if (!presentGrips.includes(grip)) presentGrips.push(grip);

  const out = {};
  for (const grip of presentGrips) {
    const staleness = getZoneStaleness(scopedHistory.filter(rep => rep?.grip === grip));
    const attentionZones = ZONE_KEYS.filter(zone =>
      ATTENTION_STATUSES.has(staleness?.[zone]?.status)
    );
    if (attentionZones.length === 0) continue;
    const staleCount = attentionZones.filter(zone => staleness[zone].status === "stale").length;
    out[grip] = {
      staleness,
      attentionZones,
      staleCount,
      warningCount: attentionZones.length - staleCount,
    };
  }
  return out;
}

function GripCoverage({ grip, coverage, showGrip }) {
  const { staleness, attentionZones, staleCount, warningCount } = coverage;
  return (
    <div style={{ marginTop: showGrip ? 16 : 0 }}>
      {showGrip && (
        <div style={{
          marginBottom: 8,
          color: GRIP_COLORS[grip] || C.blue,
          fontSize: 12,
          fontWeight: 700,
        }}>
          {grip}
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
    </div>
  );
}

export function CurveCoverageCard({ history = [], grip = "", handView = "pooled" }) {
  const attentionByGrip = useMemo(
    () => curveCoverageAttentionByGrip(history, { handView }),
    [history, handView]
  );
  const attentionGrips = useMemo(() => {
    const available = Object.keys(attentionByGrip);
    if (grip) return available.includes(grip) ? [grip] : [];
    const ordered = GRIP_ORDER.filter(item => available.includes(item));
    for (const item of available) if (!ordered.includes(item)) ordered.push(item);
    return ordered;
  }, [attentionByGrip, grip]);

  if (attentionGrips.length === 0) return null;

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ marginBottom: attentionGrips.length > 1 ? 0 : 12 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>Curve Coverage</div>
        <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
          Data that needs attention
          {handView !== "pooled" && ` · ${handView === "L" ? "left" : "right"} hand`}
        </div>
      </div>

      {attentionGrips.map(item => (
        <GripCoverage
          key={item}
          grip={item}
          coverage={attentionByGrip[item]}
          showGrip={!grip}
        />
      ))}
    </Card>
  );
}
