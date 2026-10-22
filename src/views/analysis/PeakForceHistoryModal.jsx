import React, { useEffect, useMemo } from "react";
import { C } from "../../ui/theme.js";
import { PeakForceCard } from "./PeakForceCard.jsx";

export function PeakForceHistoryModal({
  history = [],
  grip,
  handView = "pooled",
  throughDate = null,
  unit = "lbs",
  onClose,
}) {
  const scopedHistory = useMemo(
    () => throughDate
      ? history.filter(rep => !rep?.date || rep.date <= throughDate)
      : history,
    [history, throughDate]
  );

  useEffect(() => {
    const onKeyDown = event => {
      if (event.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="peak-force-history-title"
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
        maxWidth: 760,
        maxHeight: "90vh",
        overflowY: "auto",
        background: C.card,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        boxShadow: "0 18px 60px rgba(0,0,0,0.45)",
      }}>
        <div style={{
          position: "sticky",
          top: 0,
          zIndex: 2,
          background: C.card,
          borderBottom: `1px solid ${C.border}`,
          padding: "12px 16px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}>
          <div>
            <div id="peak-force-history-title" style={{ color: C.text, fontSize: 17, fontWeight: 800 }}>
              Peak Force history
            </div>
            <div style={{ color: C.muted, fontSize: 11, marginTop: 3 }}>
              {grip}{throughDate ? ` · through ${throughDate}` : ""}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close peak force history"
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
        <div style={{ padding: 12 }}>
          <PeakForceCard
            history={scopedHistory}
            unit={unit}
            grip={grip}
            handView={handView}
            embedded
          />
        </div>
      </div>
    </div>
  );
}
