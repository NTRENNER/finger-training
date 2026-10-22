import React, { useMemo, useState } from "react";
import { buildMeasuredDomainProgress } from "../../model/measuredDomainProgress.js";
import { ZONE6 } from "../../model/zones.js";
import { Card, CardTitle } from "../../ui/components.jsx";
import { fmt1, fmtW, toDisp } from "../../ui/format.js";
import { GRIP_COLORS } from "../../ui/grip-colors.js";
import { C } from "../../ui/theme.js";
import { ymdLocal } from "../../util.js";
import { ZoneSessionHistoryModal } from "./ZoneSessionHistoryModal.jsx";
import "./MeasuredDomainProgressCard.css";

const PEAK_COLOR = ZONE6.find(zone => zone.key === "max_strength")?.color || C.red;

function formatDate(date) {
  if (!date) return "—";
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatSeconds(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  return `${Number.isInteger(seconds) ? seconds : fmt1(seconds)} s`;
}

function signed(value, digits = 1) {
  if (!Number.isFinite(value)) return "—";
  const rounded = Number(value.toFixed(digits));
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(digits)}`;
}

function resultText(result, unit, peak = false) {
  if (!result) return "No measured result";
  const force = `${fmtW(result.forceKg, unit)} ${unit}`;
  return peak ? force : `${force} for ${formatSeconds(result.durationS)}`;
}

function deltaText(first, latest, unit, peak = false) {
  if (!first || !latest) return "Awaiting measured data";
  if (first.date === latest.date) return peak ? "First measured peak" : "First measured workout";
  const forceDelta = toDisp(latest.forceKg - first.forceKg, unit);
  if (peak) return `${signed(forceDelta)} ${unit} peak`;
  const durationDelta = latest.durationS - first.durationS;
  const parts = [];
  parts.push(Math.abs(forceDelta) < 0.05 ? "same force" : `${signed(forceDelta)} ${unit} force`);
  parts.push(Math.abs(durationDelta) < 0.05 ? "same time" : `${signed(durationDelta)} s time`);
  return parts.join(" · ");
}

function DomainRow({ item, unit, onHistory }) {
  const peak = item.key === "peak_force";
  const color = item.color || (peak ? PEAK_COLOR : C.muted);
  const firstLabel = peak ? "First observed" : "First";
  const latestLabel = peak ? "Current best" : "Latest";
  return <div className="domain-progress-row" role="row">
    <div className="domain-progress-name" role="rowheader" style={{ color }}>
      {item.label}
      <span>{peak ? "instantaneous" : `${item.sessions} workout${item.sessions === 1 ? "" : "s"}`}</span>
    </div>
    <div className="domain-progress-comparison">
      <div className="domain-progress-result">
        <span>{firstLabel} · {formatDate(item.first?.date)}</span>
        <strong>{resultText(item.first, unit, peak)}</strong>
      </div>
      <span className="domain-progress-arrow" aria-hidden="true">→</span>
      <div className="domain-progress-result">
        <span>{latestLabel} · {formatDate(item.latest?.date)}</span>
        <strong>{resultText(item.latest, unit, peak)}</strong>
      </div>
    </div>
    <div className="domain-progress-change">{deltaText(item.first, item.latest, unit, peak)}</div>
    {peak ? <span className="domain-progress-history-note">Full trend above</span> : item.sessions > 0 ? (
      <button type="button" className="domain-progress-history" onClick={onHistory}
        aria-label={`View ${item.label} workout history`}>
        {item.sessions} workout{item.sessions === 1 ? "" : "s"} ›
      </button>
    ) : <span />}
  </div>;
}

export function MeasuredDomainProgressCard({
  history = [],
  grips = [],
  handView = "pooled",
  unit = "kg",
  asOf = ymdLocal(),
}) {
  const [detail, setDetail] = useState(null);
  const groups = useMemo(() => grips.map(grip => buildMeasuredDomainProgress(history, {
    grip,
    handView,
    throughDate: asOf,
  })).filter(Boolean), [history, grips, handView, asOf]);
  const hasAny = groups.some(group => group.peak || group.domains.some(domain => domain.sessions > 0));
  const handLabel = handView === "L" ? "Left hand" : handView === "R" ? "Right hand" : "Pooled hands";

  return <Card style={{ marginBottom: 16 }}>
    {detail && <ZoneSessionHistoryModal history={history} grip={detail.grip} zoneKey={detail.zoneKey}
      handView={handView} throughDate={asOf} measuredOnly unit={unit} onClose={() => setDetail(null)} />}
    <CardTitle>Actual Progress by Domain</CardTitle>
    <p className="domain-progress-intro">
      First qualifying result → latest qualifying result. These are measured opening holds, not fitted curve estimates.
      Workouts stay grouped by their prescribed domain even when the achieved time landed in another zone.
      {handView === "pooled" && " Pooled domain values average the available opening hands in each workout; Peak Force remains the highest observed pull."}
    </p>
    {!hasAny ? <p className="domain-progress-empty">
      No qualifying measured opening holds for this grip and hand selection yet.
    </p> : groups.map(group => {
      const items = [group.peak && { ...group.peak, color: PEAK_COLOR }, ...group.domains].filter(Boolean);
      return <section key={group.grip} className="domain-progress-grip"
        aria-label={`${group.grip} actual domain progress`}>
        <div className="domain-progress-grip-title">
          <h4 style={{ color: GRIP_COLORS[group.grip] || C.blue }}>{group.grip}</h4>
          <span>{handLabel}</span>
        </div>
        <div role="table" aria-label={`${group.grip} first and latest measured results`}>
          {items.map(item => <DomainRow key={item.key} item={item} unit={unit}
            onHistory={() => setDetail({ grip: group.grip, zoneKey: item.key })} />)}
        </div>
      </section>;
    })}
  </Card>;
}
