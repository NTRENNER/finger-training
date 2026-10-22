import React, { useMemo } from "react";
import { C } from "../../ui/theme.js";
import { Card } from "../../ui/components.jsx";
import { ZONE6, TRAINING_ZONE_KEYS } from "../../model/zones.js";
import { GRIP_COLORS } from "../../ui/grip-colors.js";
import { getZoneStaleness } from "../../model/lockout.js";
import { buildPeakForceTrend } from "../../model/peakForce.js";

const GRIP_ORDER = ["Crusher", "Micro", "Prime"];
const LABELS = Object.fromEntries(ZONE6.map(zone => [zone.key, zone.label]));

export function curveCoverageByGrip(history = [], { handView = "pooled" } = {}) {
  const scopedHistory = handView === "pooled"
    ? history
    : history.filter(rep => rep?.hand === handView);
  const set = new Set(scopedHistory.map(rep => rep?.grip).filter(Boolean));
  const grips = GRIP_ORDER.filter(grip => set.has(grip));
  for (const grip of set) if (!grips.includes(grip)) grips.push(grip);

  return Object.fromEntries(grips.map(grip => {
    const gripHistory = scopedHistory.filter(rep => rep?.grip === grip);
    const staleness = getZoneStaleness(gripHistory);
    const maxMeasured = buildPeakForceTrend(gripHistory)?.grips?.includes(grip) === true;
    const missing = [];
    const aging = [];
    const stale = [];
    if (!maxMeasured) missing.push(LABELS.max_strength);
    for (const zone of TRAINING_ZONE_KEYS) {
      const status = staleness[zone]?.status;
      if (status === "never") missing.push(LABELS[zone]);
      else if (status === "warning") aging.push(LABELS[zone]);
      else if (status === "stale") stale.push(LABELS[zone]);
    }
    const current = (maxMeasured ? 1 : 0)
      + TRAINING_ZONE_KEYS.filter(zone => staleness[zone]?.status === "ok").length;
    return [grip, { current, total: 6, missing, aging, stale }];
  }));
}

function CoverageRing({ current, total, color }) {
  const fraction = total > 0 ? Math.max(0, Math.min(1, current / total)) : 0;
  const degrees = Math.round(fraction * 360);
  return <div
    aria-label={`${current} of ${total} domains current`}
    style={{
      width: 72,
      height: 72,
      flex: "0 0 72px",
      borderRadius: "50%",
      display: "grid",
      placeItems: "center",
      background: `conic-gradient(${color} ${degrees}deg, ${C.border} ${degrees}deg)`,
    }}
  >
    <div style={{
      width: 54,
      height: 54,
      borderRadius: "50%",
      display: "grid",
      placeItems: "center",
      background: C.card,
      color: C.text,
      fontSize: 16,
      fontWeight: 800,
      fontVariantNumeric: "tabular-nums",
    }}>
      {current}/{total}
    </div>
  </div>;
}

function IssueLine({ label, values, color }) {
  if (!values.length) return null;
  return <div aria-label={`${label}: ${values.join(", ")}`} style={{ color, fontSize: 11, lineHeight: 1.45 }}>
    <strong>{label}:</strong> {values.join(", ")}
  </div>;
}

export function CurveCoverageCard({
  history = [],
  grip = "",
  handView = "pooled",
  onOpenHistory = null,
}) {
  const coverageByGrip = useMemo(
    () => curveCoverageByGrip(history, { handView }),
    [history, handView]
  );
  const available = Object.keys(coverageByGrip);
  const visible = grip ? available.filter(item => item === grip) : available;
  if (visible.length === 0) return null;

  return <Card style={{ marginBottom: 16 }}>
    <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 3 }}>Curve coverage</div>
    <p style={{ color: C.muted, fontSize: 12, lineHeight: 1.5, margin: "0 0 10px" }}>
      Current evidence across six force-duration domains. Max records an observed peak; the five trained domains age on their own cadence.
    </p>
    <div style={{ display: "grid", gap: 0 }}>
      {visible.map((item, index) => {
        const coverage = coverageByGrip[item];
        const color = GRIP_COLORS[item] || C.blue;
        const content = <>
          <CoverageRing current={coverage.current} total={coverage.total} color={color} />
          <div style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
            <div style={{ color, fontSize: 13, fontWeight: 700, marginBottom: 3 }}>{item}</div>
            <div style={{ color: C.text, fontSize: 12, marginBottom: 3 }}>
              {coverage.current === coverage.total
                ? "All domains have current evidence."
                : `${coverage.current} of ${coverage.total} domains current.`}
            </div>
            <IssueLine label="Missing" values={coverage.missing} color={C.muted} />
            <IssueLine label="Aging" values={coverage.aging} color={C.orange} />
            <IssueLine label="Stale" values={coverage.stale} color={C.red} />
          </div>
          {onOpenHistory && <span aria-hidden="true" style={{ color: C.blue, fontSize: 18 }}>›</span>}
        </>;
        const style = {
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 0",
          border: "none",
          borderTop: index > 0 ? `1px solid ${C.border}` : "none",
          background: "transparent",
          color: "inherit",
          font: "inherit",
        };
        return onOpenHistory
          ? <button key={item} type="button" style={{ ...style, cursor: "pointer" }}
              onClick={() => onOpenHistory({ grip: item, handView })}
              aria-label={`Open ${item} finger history`}>
              {content}
            </button>
          : <div key={item} style={style}>{content}</div>;
      })}
    </div>
  </Card>;
}
