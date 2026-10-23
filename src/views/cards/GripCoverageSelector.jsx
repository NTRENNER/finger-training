import React, { useMemo } from "react";
import { curveCoverageByGrip } from "../../model/curveCoverage.js";
import { ZONE6 } from "../../model/zones.js";
import { GRIP_COLORS } from "../../ui/grip-colors.js";
import { C } from "../../ui/theme.js";

const SHORT_LABELS = Object.fromEntries(ZONE6.map(zone => [zone.label, zone.short]));

function CoverageRing({ current, total, color, selected }) {
  const fraction = total > 0 ? Math.max(0, Math.min(1, current / total)) : 0;
  const degrees = Math.round(fraction * 360);

  return <div aria-hidden="true" style={{
    width: 72,
    height: 72,
    borderRadius: "50%",
    display: "grid",
    placeItems: "center",
    background: `conic-gradient(${color} ${degrees}deg, ${C.border} ${degrees}deg)`,
    boxShadow: selected ? `0 0 0 3px ${color}33` : "none",
  }}>
    <div style={{
      width: 54,
      height: 54,
      borderRadius: "50%",
      display: "grid",
      placeItems: "center",
      background: C.card,
      color: C.text,
      fontSize: 15,
      fontWeight: 800,
      fontVariantNumeric: "tabular-nums",
    }}>
      {current}/{total}
    </div>
  </div>;
}

function compactLabels(values) {
  return values.map(label => SHORT_LABELS[label] || label).join(", ");
}

function CoverageStatus({ grip, coverage }) {
  if (!coverage) return null;
  if (coverage.current === coverage.total) {
    return <div style={{ color: C.muted, fontSize: 12, lineHeight: 1.5 }}>
      <strong style={{ color: C.text }}>{grip}:</strong> all six domains have current evidence.
    </div>;
  }

  const issues = [
    ["Missing", coverage.missing, C.muted],
    ["Aging", coverage.aging, C.orange],
    ["Stale", coverage.stale, C.red],
  ].filter(([, values]) => values.length > 0);

  return <div style={{ display: "flex", flexWrap: "wrap", gap: "3px 10px", fontSize: 12, lineHeight: 1.5 }}>
    <strong style={{ color: C.text }}>{grip}</strong>
    {issues.map(([label, values, color]) => (
      <span key={label} aria-label={`${label}: ${values.join(", ")}`} style={{ color }}>
        {label}: {compactLabels(values)}
      </span>
    ))}
  </div>;
}

export function GripCoverageSelector({
  history = [],
  grips = [],
  value = "",
  onChange,
}) {
  const coverageByGrip = useMemo(
    () => curveCoverageByGrip(history, { grips }),
    [history, grips],
  );
  const selectedCoverage = coverageByGrip[value];

  return <section aria-label="Grip selection" style={{ marginBottom: 24 }}>
    <h2 style={{ margin: "0 0 16px", fontSize: 24, fontWeight: 750 }}>Select a Device to Begin</h2>
    <div role="group" aria-label="Training device" style={{
      display: "grid",
      gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
      gap: 8,
    }}>
      {grips.map(grip => {
        const coverage = coverageByGrip[grip] || {
          current: 0, total: 6, missing: [], aging: [], stale: [],
        };
        const selected = value === grip;
        const color = GRIP_COLORS[grip] || C.blue;

        return <button
          key={grip}
          type="button"
          onClick={() => onChange?.(grip)}
          aria-pressed={selected}
          aria-label={`${grip}, ${coverage.current} of ${coverage.total} domains current`}
          style={{
            minWidth: 0,
            minHeight: 116,
            padding: "10px 4px 8px",
            borderRadius: 10,
            border: `${selected ? 2 : 1}px solid ${selected ? color : "transparent"}`,
            background: selected ? `${color}12` : "transparent",
            color: selected ? C.text : C.muted,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 7,
            cursor: "pointer",
            font: "inherit",
          }}
        >
          <CoverageRing {...coverage} color={color} selected={selected} />
          <span style={{ fontSize: 14, fontWeight: 750 }}>{grip}</span>
        </button>;
      })}
    </div>
    {value && <div style={{ marginTop: 10, minHeight: 18 }}>
      <CoverageStatus grip={value} coverage={selectedCoverage} />
    </div>}
  </section>;
}
