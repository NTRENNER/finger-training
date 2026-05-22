// ─────────────────────────────────────────────────────────────
// SessionExRow — per-set weight + reps tracking row
// ─────────────────────────────────────────────────────────────
// Renders one loggable exercise inside the active workout session.
// Provides the editable input grid (reps + weight per set), the
// done toggle, and the recommendSet-driven placeholder values that
// pre-fill suggested loads.
//
// Unilateral exercises render TWO short rows per set (L on top,
// R below) so each side gets its own reps + weight inputs. The
// pair shares one done button — a "set" of unilateral work is one
// logical unit even though the two sides happen sequentially.

import React from "react";
import { C } from "../../ui/theme.js";
import { WTypeBadge } from "./WTypeBadge.js";
import { VideoLink } from "./VideoLink.js";

export function SessionExRow({ ex, unit, prevSets, setsData, onSetsChange, recommendations = [], last }) {
  const allSetsDone = setsData?.sets
    ? setsData.sets.every(s => s.done)
    : false;
  const inputStyle = {
    width: 72, background: C.bg, border: `1px solid ${C.border}`,
    color: C.text, borderRadius: 6, padding: "4px 7px", fontSize: 14,
    textAlign: "center",
  };
  const doneBtn = (isDone, onPress) => (
    <button onClick={onPress} style={{
      width: 28, height: 28, borderRadius: "50%", flexShrink: 0,
      background: isDone ? C.green : "transparent",
      border: `2px solid ${isDone ? C.green : C.border}`,
      color: isDone ? "#000" : C.muted,
      cursor: "pointer", fontSize: 12, display: "flex",
      alignItems: "center", justifyContent: "center",
    }}>{isDone ? "✓" : ""}</button>
  );
  return (
    <div style={{
      padding: "12px 0",
      borderBottom: last ? "none" : `1px solid ${C.border}`,
      opacity: allSetsDone ? 0.55 : 1,
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <WTypeBadge type={ex.type} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <div style={{ fontSize: 15, color: C.text }}>{ex.name}</div>
            {ex.videoUrl && <VideoLink href={ex.videoUrl} />}
          </div>
          {ex.intent ? (
            <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{ex.intent}</div>
          ) : null}

          <div style={{ marginTop: 10 }}>
            {/* Column headers */}
            <div style={{ display: "flex", gap: 8, marginBottom: 6, alignItems: "center" }}>
              <span style={{ fontSize: 11, color: C.muted, width: 36, flexShrink: 0 }}></span>
              <span style={{ fontSize: 11, color: C.muted, width: 48, textAlign: "center" }}>reps</span>
              <span style={{ fontSize: 11, color: C.muted, width: 72, textAlign: "center" }}>weight</span>
              {prevSets?.length > 0 && (
                <span style={{ fontSize: 11, color: C.muted, width: 44, textAlign: "center" }}>prev</span>
              )}
            </div>

            {setsData.sets.map((s, i) => {
              const isExtra = i >= (ex.sets || 0);
              const rec = recommendations[i];

              const renderSideRow = (side, sLabel, sideKey) => {
                const sideWord  = side === "L" ? "left" : side === "R" ? "right" : null;
                const repsKey   = sideWord ? `${sideWord}Reps`   : "reps";
                const weightKey = sideWord ? `${sideWord}Weight` : "weight";
                const stored = (k) => {
                  const v = s[k];
                  return v != null && v !== "" ? v : null;
                };
                const recReps   = rec ? (rec[repsKey]   ?? rec.reps)   : null;
                const recWeight = rec ? (rec[weightKey] ?? rec.weight) : null;
                const repsVal   = stored(repsKey)   ?? recReps   ?? (side ? "" : ex.reps) ?? "";
                const weightVal = stored(weightKey) ?? recWeight ?? "";
                const prev      = prevSets?.[i];
                const prevShown = side
                  ? (prev && typeof prev === "object" ? prev[side] : null)
                  : prev;
                return (
                  <div key={sideKey} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: side === "L" ? 4 : 6 }}>
                    <span style={{ fontSize: 12, color: isExtra ? C.orange : C.muted, width: 36, flexShrink: 0 }}>
                      {sLabel}
                    </span>
                    <input
                      type="text" inputMode="text"
                      value={repsVal}
                      onChange={e => {
                        const next = [...setsData.sets];
                        next[i] = { ...next[i], [repsKey]: e.target.value };
                        onSetsChange({ sets: next });
                      }}
                      style={{ ...inputStyle, width: 48, fontSize: 13 }}
                      placeholder={recReps != null ? String(recReps) : (ex.reps || "")}
                    />
                    <input
                      type="number" inputMode="decimal"
                      value={weightVal}
                      onChange={e => {
                        const next = [...setsData.sets];
                        next[i] = { ...next[i], [weightKey]: e.target.value };
                        onSetsChange({ sets: next });
                      }}
                      style={inputStyle}
                      placeholder={recWeight != null ? String(recWeight) : ""}
                    />
                    <span style={{ fontSize: 12, color: C.muted }}>{unit}</span>
                    {prevShown ? (
                      <span style={{ fontSize: 12, color: C.muted, width: 44 }}>{prevShown}</span>
                    ) : prevSets?.length > 0 ? (
                      <span style={{ width: 44 }} />
                    ) : null}
                    {(side === null || side === "R") && doneBtn(s.done, () => {
                      const next = [...setsData.sets];
                      next[i] = { ...next[i], done: !next[i].done };
                      onSetsChange({ sets: next });
                    })}
                    {(side === null || side === "R") && isExtra && (
                      <button
                        onClick={() => onSetsChange({ sets: setsData.sets.filter((_, j) => j !== i) })}
                        style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 14, padding: "0 2px", lineHeight: 1 }}
                        title="Remove this set"
                      >−</button>
                    )}
                  </div>
                );
              };

              const hintStyle = { fontSize: 10, color: C.muted, marginLeft: 44, marginTop: -2, marginBottom: 4, fontStyle: "italic" };

              if (ex.unilateral) {
                return (
                  <div key={i} style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 11, color: isExtra ? C.orange : C.muted, marginBottom: 2 }}>S{i + 1}</div>
                    {renderSideRow("L", "L", `${i}-L`)}
                    {rec?.leftReasoning  && (<div style={hintStyle}>{rec.leftReasoning}</div>)}
                    {renderSideRow("R", "R", `${i}-R`)}
                    {rec?.rightReasoning && (<div style={hintStyle}>{rec.rightReasoning}</div>)}
                  </div>
                );
              }
              return (
                <div key={i}>
                  {renderSideRow(null, `S${i + 1}`, `${i}`)}
                  {rec?.reasoning && (<div style={hintStyle}>{rec.reasoning}</div>)}
                </div>
              );
            })}

            <button
              onClick={() => onSetsChange({
                sets: [...setsData.sets, ex.unilateral
                  ? { leftReps: ex.reps || "", leftWeight: "", rightReps: ex.reps || "", rightWeight: "", done: false }
                  : { weight: "", reps: ex.reps || "", done: false }
                ]
              })}
              style={{
                marginTop: 4, width: "100%", padding: "5px 0",
                background: "none", border: `1px dashed ${C.border}`,
                color: C.muted, borderRadius: 6, fontSize: 12, cursor: "pointer",
              }}
            >+ Set</button>
          </div>
        </div>
      </div>
    </div>
  );
}
