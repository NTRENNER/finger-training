import React from "react";
import { C } from "../../ui/theme.js";
import { Card } from "../../ui/components.js";
import { GRIP_COLORS } from "../../ui/grip-colors.js";

const pillStyle = (active, color) => ({
  minHeight: 30,
  padding: "4px 12px",
  borderRadius: 20,
  border: "none",
  background: active ? color : C.border,
  color: active ? "#fff" : C.muted,
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 600,
  fontFamily: "inherit",
  whiteSpace: "nowrap",
});

function ScopeRow({ label, children }) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "48px minmax(0, 1fr)",
      alignItems: "center",
      gap: 8,
    }}>
      <div style={{ color: C.muted, fontSize: 10, fontWeight: 700, textTransform: "uppercase" }}>
        {label}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {children}
      </div>
    </div>
  );
}

function AttentionBadge({ count }) {
  if (!(count > 0)) return null;
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 16,
        height: 16,
        marginLeft: 5,
        padding: "0 4px",
        borderRadius: 8,
        background: C.bg,
        color: C.orange,
        fontSize: 9,
        fontWeight: 800,
        boxSizing: "border-box",
      }}
    >
      {count}
    </span>
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
  attentionCounts = {},
}) {
  if (grips.length === 0 && !canNormalize) return null;

  const allAttention = Object.values(attentionCounts)
    .reduce((sum, count) => sum + (Number(count) || 0), 0);

  return (
    <div role="group" aria-label="Analysis scope">
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "grid", gap: 10 }}>
          {grips.length > 0 && (
            <ScopeRow label="Grip">
              <button
                type="button"
                aria-pressed={!grip}
                aria-label={`All Grips${allAttention > 0 ? `, ${allAttention} coverage items` : ""}`}
                onClick={() => onGripChange?.("")}
                style={pillStyle(!grip, C.orange)}
              >
                All Grips
                <AttentionBadge count={allAttention} />
              </button>
              {grips.map(item => {
                const count = attentionCounts[item] || 0;
                return (
                  <button
                    key={item}
                    type="button"
                    aria-pressed={grip === item}
                    aria-label={`${item}${count > 0 ? `, ${count} coverage items` : ""}`}
                    onClick={() => onGripChange?.(item)}
                    style={pillStyle(grip === item, GRIP_COLORS[item] || C.orange)}
                  >
                    {item}
                    <AttentionBadge count={count} />
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
