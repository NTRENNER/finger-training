// ─────────────────────────────────────────────────────────────
// SessionExRow — per-set tracking row
// ─────────────────────────────────────────────────────────────
// Renders one loggable exercise inside the active workout session.
// Three input modes, picked by exercise flags:
//   - default (logWeight): reps + numeric weight per set.
//   - logBand: reps + band-color dropdown per set. Storage uses
//     `band` (or `leftBand` / `rightBand` for unilateral) instead
//     of `weight`. The band color is a brand-agnostic label —
//     progression is "step up to the next color" rather than +5 lb.
//   - circlesOnly: no reps, no weight, just a clickable circle per
//     set. Used for habit-style exercises like Ab Wheel where the
//     done/not-done flag is the only useful signal.
//
// Unilateral (default + logBand) exercises render TWO short rows
// per set (L on top, R below) so each side gets its own reps +
// weight/band inputs. The pair shares one done button — a "set" of
// unilateral work is one logical unit even though the two sides
// happen sequentially.

import React from "react";
import { C } from "../../ui/theme.js";
import { WTypeBadge } from "./WTypeBadge.js";
import { VideoLink } from "./VideoLink.js";
import { BAND_COLORS, BAND_COLOR_LOOKUP } from "./workoutConstants.js";

// Small color dot used in the band picker + the prev column so the
// stored color is visible at a glance.
function BandSwatch({ colorKey, size = 12 }) {
  const meta = BAND_COLOR_LOOKUP[colorKey];
  if (!meta) return null;
  return (
    <span style={{
      display: "inline-block", width: size, height: size, borderRadius: "50%",
      background: meta.swatch, border: "1px solid rgba(255,255,255,0.2)",
      flexShrink: 0,
    }} />
  );
}

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
  // Circles-only mode: short-circuit the whole render and just show
  // one tappable circle per set. No reps, no weight, no headers —
  // the only signal that matters is "did you do the set?". Used for
  // habit-style exercises like Ab Wheel where ROM quality isn't
  // worth numeric tracking.
  if (ex.circlesOnly && setsData?.sets) {
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
            <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
              {setsData.sets.map((s, i) => (
                <button
                  key={i}
                  onClick={() => {
                    const next = [...setsData.sets];
                    next[i] = { ...next[i], done: !next[i].done };
                    onSetsChange({ sets: next });
                  }}
                  title={`Set ${i + 1}: tap to toggle done`}
                  style={{
                    width: 36, height: 36, borderRadius: "50%",
                    background: s.done ? C.green : "transparent",
                    border: `2px solid ${s.done ? C.green : C.border}`,
                    color: s.done ? "#000" : C.muted,
                    cursor: "pointer", fontSize: 13, fontWeight: 700,
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                >
                  {s.done ? "✓" : i + 1}
                </button>
              ))}
              <button
                onClick={() => onSetsChange({ sets: [...setsData.sets, { done: false }] })}
                style={{
                  width: 36, height: 36, borderRadius: "50%",
                  background: "none", border: `1px dashed ${C.border}`,
                  color: C.muted, cursor: "pointer", fontSize: 16,
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}
                title="Add a set"
              >+</button>
              {setsData.sets.length > (ex.sets || 1) && (
                <button
                  onClick={() => onSetsChange({ sets: setsData.sets.slice(0, -1) })}
                  style={{
                    width: 28, height: 28, borderRadius: "50%",
                    background: "none", border: `1px solid ${C.border}`,
                    color: C.muted, cursor: "pointer", fontSize: 14,
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                  title="Remove the last set"
                >−</button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

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
            {/* Column headers — load column header swaps for band mode. */}
            <div style={{ display: "flex", gap: 8, marginBottom: 6, alignItems: "center" }}>
              <span style={{ fontSize: 11, color: C.muted, width: 36, flexShrink: 0 }}></span>
              <span style={{ fontSize: 11, color: C.muted, width: 48, textAlign: "center" }}>reps</span>
              <span style={{ fontSize: 11, color: C.muted, width: ex.logBand ? 96 : 72, textAlign: "center" }}>
                {ex.logBand ? "band" : "weight"}
              </span>
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
                // Load key swaps based on the exercise's logging mode:
                // numeric weight for the default, band-color label for
                // logBand. Storage uses different field names so a
                // future mode-change for the same exercise wouldn't
                // collide with prior session shapes.
                const loadKey   = ex.logBand
                  ? (sideWord ? `${sideWord}Band` : "band")
                  : (sideWord ? `${sideWord}Weight` : "weight");
                const stored = (k) => {
                  const v = s[k];
                  return v != null && v !== "" ? v : null;
                };
                const recReps = rec ? (rec[repsKey] ?? rec.reps) : null;
                const recLoad = rec ? (rec[loadKey] ?? (ex.logBand ? rec.band : rec.weight)) : null;
                const repsVal = stored(repsKey) ?? recReps ?? (side ? "" : ex.reps) ?? "";
                const loadVal = stored(loadKey) ?? recLoad ?? "";
                const prev    = prevSets?.[i];
                const prevShown = side
                  ? (prev && typeof prev === "object" ? prev[side] : null)
                  : prev;
                // For band mode, the prev pill shows the swatch + name.
                // For weight mode, just the formatted prev string.
                const renderPrev = () => {
                  if (!prevShown) return prevSets?.length > 0 ? <span style={{ width: 44 }} /> : null;
                  if (ex.logBand && typeof prevShown === "object" && prevShown.band) {
                    return (
                      <span style={{ fontSize: 12, color: C.muted, width: 44, display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <BandSwatch colorKey={prevShown.band} size={10} />
                        {prevShown.reps || ""}
                      </span>
                    );
                  }
                  return <span style={{ fontSize: 12, color: C.muted, width: 44 }}>{prevShown}</span>;
                };
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
                    {ex.logBand ? (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, width: 96 }}>
                        <BandSwatch colorKey={loadVal} />
                        <select
                          value={loadVal}
                          onChange={e => {
                            const next = [...setsData.sets];
                            next[i] = { ...next[i], [loadKey]: e.target.value };
                            onSetsChange({ sets: next });
                          }}
                          style={{
                            background: C.bg, color: C.text, border: `1px solid ${C.border}`,
                            borderRadius: 6, padding: "4px 6px", fontSize: 13, cursor: "pointer",
                            flex: 1, minWidth: 0,
                          }}
                        >
                          <option value="">band</option>
                          {BAND_COLORS.map(b => (
                            <option key={b.key} value={b.key}>{b.label}</option>
                          ))}
                        </select>
                      </span>
                    ) : (
                      <>
                        <input
                          type="number" inputMode="decimal"
                          value={loadVal}
                          onChange={e => {
                            const next = [...setsData.sets];
                            next[i] = { ...next[i], [loadKey]: e.target.value };
                            onSetsChange({ sets: next });
                          }}
                          style={inputStyle}
                          placeholder={recLoad != null ? String(recLoad) : ""}
                        />
                        <span style={{ fontSize: 12, color: C.muted }}>{unit}</span>
                      </>
                    )}
                    {renderPrev()}
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
              onClick={() => {
                // Seed shape matches the exercise's logging mode so
                // adding a set mid-session doesn't drop into a weight
                // input for a band exercise (or vice versa).
                const makeBlank = () => {
                  if (ex.unilateral && ex.logBand) {
                    return { leftReps: ex.reps || "", leftBand: "", rightReps: ex.reps || "", rightBand: "", done: false };
                  }
                  if (ex.unilateral) {
                    return { leftReps: ex.reps || "", leftWeight: "", rightReps: ex.reps || "", rightWeight: "", done: false };
                  }
                  if (ex.logBand) {
                    return { reps: ex.reps || "", band: "", done: false };
                  }
                  return { reps: ex.reps || "", weight: "", done: false };
                };
                onSetsChange({ sets: [...setsData.sets, makeBlank()] });
              }}
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
