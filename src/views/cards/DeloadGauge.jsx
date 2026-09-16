// ─────────────────────────────────────────────────────────────
// DeloadGauge — recovery-readiness light (green → yellow → red)
// ─────────────────────────────────────────────────────────────
// Replaces the two raw recovery-trend charts (cut May 2026 — they were
// diagnostic deviation metrics that read like scoreboards and invited
// "it's going down, is that bad?" misreads). This is the same signal,
// reframed as a glanceable state: how close you are to a deload, from
// your cross-grip between-rep recovery. It uses the SAME conservative
// gating as the deload trigger, so red doesn't flicker on one rough
// session. Pure presentational; takes a deloadStatus() result.

import React from "react";
import { C } from "../../ui/theme.js";
import { Card } from "../../ui/components.js";

const LEVEL_COLOR = { green: C.green, yellow: C.yellow, red: C.red, unknown: C.muted };

const formatDate = ymd => new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

export function DeloadGauge({
  status,
  timelineDates = [],
  asOfDate = null,
  currentDate = null,
  onAsOfDateChange = null,
  // Collapsed by default when the news is "nothing to report" — see
  // RecoveryStatusCard. Undefined keeps the always-open behaviour for
  // any other caller.
  expanded = true,
  onToggleExpanded = null,
}) {
  if (!status) return null;
  const { level, pressure, label, haveSignal, deload } = status;
  const usesHistoricalEstimates = Object.values(deload?.signals?.gripGaps || {}).some(g => g.confidence === "historical_estimate");
  const color = LEVEL_COLOR[level] || C.muted;
  const markerPct = Math.max(1, Math.min(99, (haveSignal ? pressure : 0) * 100));
  const matchedIndex = timelineDates.indexOf(asOfDate);
  const selectedIndex = matchedIndex >= 0 ? matchedIndex : Math.max(0, timelineDates.length - 1);
  const hasTimeline = timelineDates.length > 1 && onAsOfDateChange;
  const isHistorical = asOfDate && currentDate && asOfDate !== currentDate;

  // Collapsed: one line that still carries the state and its colour, with
  // a short bar so the reading is visible at a glance. Everything that
  // explains the reading waits behind a tap.
  if (!expanded) {
    return (
      <Card style={{ marginBottom: 16, padding: 0 }}>
        <button
          onClick={() => onToggleExpanded?.()}
          aria-expanded={false}
          style={{
            width: "100%", padding: "12px 16px", background: "none", border: "none",
            cursor: onToggleExpanded ? "pointer" : "default", color: C.text,
            display: "flex", alignItems: "center", gap: 10, textAlign: "left",
          }}
        >
          <span style={{
            width: 8, height: 8, borderRadius: 4, flex: "0 0 auto",
            background: color, opacity: haveSignal ? 1 : 0.5,
          }} />
          <span style={{ fontSize: 13, fontWeight: 600, flex: "0 0 auto" }}>Recovery</span>
          <span style={{ fontSize: 12, color, flex: 1, minWidth: 0 }}>{label}</span>
          <span style={{ fontSize: 11, color: C.muted, flex: "0 0 auto" }}>details</span>
          <span aria-hidden style={{ fontSize: 10, color: C.muted, flex: "0 0 auto" }}>▾</span>
        </button>
      </Card>
    );
  }

  return (
    <Card style={{ marginBottom: 16 }}>
      {/* The whole header row is the collapse control. A muted "hide"
          tucked beside the title tested as invisible — the first person
          to use it reported there was no way to close the card at all.
          An affordance nobody finds is not an affordance. */}
      <div
        {...(onToggleExpanded ? {
          role: "button", tabIndex: 0, "aria-expanded": true,
          onClick: () => onToggleExpanded(),
          onKeyDown: e => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggleExpanded(); }
          },
        } : {})}
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          flexWrap: "wrap",
          gap: 6,
          marginBottom: 4,
          cursor: onToggleExpanded ? "pointer" : "default",
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 700 }}>
          Recovery status
          {onToggleExpanded && (
            <span aria-hidden style={{ fontSize: 10, color: C.muted, marginLeft: 6 }}>▴</span>
          )}
        </div>
        {usesHistoricalEstimates && <div style={{ fontSize: 12, color: C.muted }}>Includes historical estimates using planned rest.</div>}
        <div style={{ fontSize: 12.5, fontWeight: 700, color }}>{label}</div>
      </div>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 14, lineHeight: 1.5 }}>
        How close you {isHistorical ? "were" : "are"} to needing a deload, read from your cross-grip
        between-rep recovery. Gray = insufficient current evidence; green = observed recovery within range; yellow = recovery
        softening, ease up soon; red = deload recommended. Intentionally slow
        to move — it won't react to a single rough session.
      </div>

      {/* Traffic-light track with a pointer at the current pressure. */}
      <div style={{ position: "relative", paddingTop: 9 }}>
        <div style={{
          position: "absolute", top: 0, left: `${markerPct}%`, transform: "translateX(-50%)",
          width: 0, height: 0,
          borderLeft: "5px solid transparent", borderRight: "5px solid transparent",
          borderTop: `7px solid ${C.text}`,
          opacity: haveSignal ? 1 : 0,
        }} />
        <div style={{
          height: 10, borderRadius: 5, opacity: haveSignal ? 1 : 0.4,
          background: !haveSignal ? C.muted : `linear-gradient(90deg, ${C.green} 0%, ${C.green} 30%, ${C.yellow} 42%, ${C.yellow} 70%, ${C.red} 84%, ${C.red} 100%)`,
        }} />
      </div>

      {hasTimeline && (
        <div style={{ marginTop: 12 }}>
          <div style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 8,
            marginBottom: 4,
            fontSize: 11,
            color: C.muted,
          }}>
            <span>
              As of: <b style={{ color }}>{isHistorical ? formatDate(asOfDate) : "Now"}</b>
            </span>
            <span>{selectedIndex + 1} of {timelineDates.length}</span>
          </div>
          <input
            aria-label="Recovery status history"
            type="range"
            min={0}
            max={timelineDates.length - 1}
            step={1}
            value={selectedIndex}
            onChange={event => onAsOfDateChange(timelineDates[Number(event.target.value)])}
            style={{ width: "100%", accentColor: color, cursor: "pointer" }}
          />
        </div>
      )}

      {!haveSignal && (
        <div style={{ fontSize: 11, color: C.muted, marginTop: 12 }}>
          Recent comparable sessions are needed to assess recovery. Missing data does not establish readiness.
        </div>
      )}
      {level !== "green" && deload?.why && (
        <div style={{ fontSize: 12, color: C.muted, marginTop: 12, lineHeight: 1.5 }}>
          {deload.why}
        </div>
      )}
    </Card>
  );
}
