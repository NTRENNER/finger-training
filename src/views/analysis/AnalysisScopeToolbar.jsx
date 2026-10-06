import React from "react";
import { C } from "../../ui/theme.js";
import { Card } from "../../ui/components.jsx";
import { GRIP_COLORS } from "../../ui/grip-colors.js";

const pillStyle = (active, color) => ({
  minHeight: 44,
  padding: "10px 12px",
  borderRadius: 10,
  border: "none",
  background: active ? color : C.border,
  color: active ? "#fff" : C.muted,
  cursor: "pointer",
  fontSize: 14,
  fontWeight: 600,
  fontFamily: "inherit",
  whiteSpace: "nowrap",
  flex: "1 1 auto",
});

function ScopeRow({ label, children }) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "minmax(0, 1fr)",
      alignItems: "center",
      gap: 8,
    }}>
      <div style={{ color: C.muted, fontSize: 12, fontWeight: 700, textTransform: "uppercase" }}>
        {label}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {children}
      </div>
    </div>
  );
}

export function AnalysisScopeToolbar({
  grips = [],
  grip = "",
  onGripChange,
  hand = "pooled",
  onHandChange,
  normalizeOn = false,
  onNormalizeChange,
  canNormalize = false,
}) {
  if (grips.length === 0 && !canNormalize) return null;

  return (
    <div role="group" aria-label="Analysis scope">
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "grid", gap: 10 }}>
          {grips.length > 0 && (
            <ScopeRow label="Grip">
              <button
                type="button"
                aria-pressed={!grip}
                onClick={() => onGripChange?.("")}
                style={pillStyle(!grip, C.orange)}
              >
                All Grips
              </button>
              {grips.map(item => {
                return (
                  <button
                    key={item}
                    type="button"
                    aria-pressed={grip === item}
                    onClick={() => onGripChange?.(item)}
                    style={pillStyle(grip === item, GRIP_COLORS[item] || C.orange)}
                  >
                    {item}
                  </button>
                );
              })}
            </ScopeRow>
          )}

          <ScopeRow label="Hand">
            {[
              { key: "pooled", label: "Pooled", color: C.purple },
              { key: "L", label: "Left", color: C.blue },
              { key: "R", label: "Right", color: C.orange },
            ].map(option => (
              <button
                key={option.key}
                type="button"
                aria-pressed={hand === option.key}
                onClick={() => onHandChange?.(option.key)}
                style={pillStyle(hand === option.key, option.color)}
              >
                {option.label}
              </button>
            ))}
          </ScopeRow>

          {canNormalize && (
            <ScopeRow label="Scale">
              {[
                { key: false, label: "Absolute" },
                { key: true, label: "× BW" },
              ].map(option => (
                <button
                  key={String(option.key)}
                  type="button"
                  aria-pressed={normalizeOn === option.key}
                  onClick={() => onNormalizeChange?.(option.key)}
                  style={pillStyle(normalizeOn === option.key, C.purple)}
                >
                  {option.label}
                </button>
              ))}
            </ScopeRow>
          )}
        </div>
      </Card>
    </div>
  );
}
