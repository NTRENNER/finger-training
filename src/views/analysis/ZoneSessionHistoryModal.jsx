import React, { useEffect, useMemo } from "react";
import { ZONE6 } from "../../model/zones.js";
import { buildZoneSessionHistory } from "../../model/zoneSessionHistory.js";
import { C } from "../../ui/theme.js";
import { fmt1, fmtClock, fmtTime, fmtW, toDisp } from "../../ui/format.js";

function formatDate(ymd) {
  if (!ymd) return "—";
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatSeconds(value) {
  if (!Number.isFinite(value)) return "—";
  return Number.isInteger(value) ? String(value) : fmt1(value);
}

function signed(value, suffix = "") {
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded}${suffix}`;
}

function Metric({ label, value, detail, color = C.text }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{
        color: C.muted,
        fontSize: 9,
        textTransform: "uppercase",
        letterSpacing: 0.5,
        marginBottom: 3,
      }}>
        {label}
      </div>
      <div style={{ color, fontSize: 13, fontWeight: 750, lineHeight: 1.25 }}>
        {value}
      </div>
      <div style={{ color: C.muted, fontSize: 9, lineHeight: 1.35, marginTop: 2 }}>
        {detail}
      </div>
    </div>
  );
}

export function ZoneSessionHistoryModal({
  history = [],
  grip,
  zoneKey,
  handView = "pooled",
  throughDate = null,
  unit = "lbs",
  onClose,
}) {
  const zone = ZONE6.find(item => item.key === zoneKey);
  const sessions = useMemo(
    () => buildZoneSessionHistory(history, { grip, zoneKey, handView, throughDate }),
    [history, grip, zoneKey, handView, throughDate]
  );

  useEffect(() => {
    const onKeyDown = event => {
      if (event.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  if (!zone) return null;

  const oldest = sessions[sessions.length - 1]?.date;
  const newest = sessions[0]?.date;
  const handLabel = handView === "L" ? "Left hand" : handView === "R" ? "Right hand" : "Pooled";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="zone-session-history-title"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose?.();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 120,
        background: "rgba(0,0,0,0.72)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div style={{
        width: "100%",
        maxWidth: 520,
        maxHeight: "90vh",
        overflowY: "auto",
        background: C.card,
        border: `1px solid ${zone.color}80`,
        borderRadius: 8,
        boxShadow: "0 18px 60px rgba(0,0,0,0.45)",
      }}>
        <div style={{
          position: "sticky",
          top: 0,
          zIndex: 1,
          background: C.card,
          borderBottom: `1px solid ${C.border}`,
          padding: "14px 16px 12px",
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
        }}>
          <div style={{ minWidth: 0 }}>
            <div id="zone-session-history-title" style={{ color: zone.color, fontSize: 17, fontWeight: 800 }}>
              {zone.label} history
            </div>
            <div style={{ color: C.text, fontSize: 12, fontWeight: 650, marginTop: 3 }}>
              {grip} · {handLabel}
              {throughDate ? ` · through ${formatDate(throughDate)}` : ""}
            </div>
            <div style={{ color: C.muted, fontSize: 10, marginTop: 4 }}>
              {sessions.length > 0
                ? `${sessions.length} session${sessions.length === 1 ? "" : "s"} · ${formatDate(oldest)} to ${formatDate(newest)}`
                : "No sessions prescribed in this zone"}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close zone history"
            style={{
              flex: "0 0 32px",
              width: 32,
              height: 32,
              borderRadius: 8,
              border: `1px solid ${C.border}`,
              background: C.bg,
              color: C.muted,
              cursor: "pointer",
              fontSize: 18,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        {sessions.length === 0 ? (
          <div style={{ color: C.muted, fontSize: 12, padding: "28px 16px", textAlign: "center" }}>
            No {zone.label.toLowerCase()} workouts match this grip, hand, and date.
          </div>
        ) : (
          <div style={{ padding: "0 16px 8px" }}>
            {sessions.map((session, index) => {
              const ratioPct = Math.round(session.ratio * 100);
              const ratioColor = ratioPct >= 100 ? C.green : ratioPct >= 90 ? C.orange : C.red;
              const outcome = ZONE6.find(item => item.key === session.outcomeZoneKey);
              const loadDelta = Number.isFinite(session.loadDeltaKg)
                ? signed(toDisp(session.loadDeltaKg, unit), ` ${unit} vs prior`)
                : "First session in zone";
              const ratioDelta = Number.isFinite(session.ratioDelta)
                ? signed(session.ratioDelta * 100, "pp vs prior")
                : "No prior comparison";

              return (
                <div
                  key={session.key}
                  style={{
                    padding: "12px 0",
                    borderBottom: index < sessions.length - 1 ? `1px solid ${C.border}` : "none",
                    background: index === 0 ? `${zone.color}08` : "transparent",
                  }}
                >
                  <div style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    marginBottom: 8,
                  }}>
                    <span style={{ color: C.text, fontSize: 12, fontWeight: 750 }}>
                      {formatDate(session.date)}
                      {session.sessionStartedAt ? ` · ${fmtClock(session.sessionStartedAt)}` : ""}
                    </span>
                    <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                      {outcome && outcome.key !== zone.key && (
                        <span style={{ color: outcome.color, fontSize: 9, whiteSpace: "nowrap" }}>
                          Opened in {outcome.short}
                        </span>
                      )}
                      {index === 0 && (
                        <span style={{
                          color: zone.color,
                          background: `${zone.color}18`,
                          borderRadius: 8,
                          padding: "2px 6px",
                          fontSize: 9,
                          fontWeight: 750,
                        }}>
                          Latest
                        </span>
                      )}
                    </span>
                  </div>

                  <div style={{
                    display: "grid",
                    gridTemplateColumns: "0.9fr 1.35fr 1fr",
                    gap: 10,
                    alignItems: "start",
                  }}>
                    <Metric
                      label="Held load"
                      value={`${fmtW(session.openingLoadKg, unit)} ${unit}`}
                      detail={loadDelta}
                    />
                    <Metric
                      label="Opening hold"
                      value={`${formatSeconds(session.openingActualS)} / ${formatSeconds(session.targetS)}s`}
                      detail={`${ratioPct}% target · ${ratioDelta}`}
                      color={ratioColor}
                    />
                    <Metric
                      label="Session"
                      value={`${session.repCount} rep${session.repCount === 1 ? "" : "s"}`}
                      detail={`${fmtTime(session.tutS)} TUT${session.hands.length ? ` · ${session.hands.join("/")}` : ""}`}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div style={{
          borderTop: `1px solid ${C.border}`,
          color: C.muted,
          fontSize: 9,
          lineHeight: 1.4,
          padding: "9px 16px 11px",
        }}>
          Opening hold is the mean first fresh rep for the selected hand view. Changes compare with the previous workout prescribed in this zone.
        </div>
      </div>
    </div>
  );
}
