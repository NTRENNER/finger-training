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
// Orthogonal axis (June 2026): `logVariant` adds a compact per-set
// variant <select> (fed by ex.variants) alongside the reps + weight
// inputs — for exercises like TRX Row where the progression variable
// is LEVERAGE (two-arm → feet-elevated → archer → one-arm) and the
// weight input is an optional vest that may stay blank. It's a
// modifier on the default mode (like `unilateral`), not a fourth
// mode; the chosen variant persists into the set object as `variant`.
//
// Unilateral (default + logBand) exercises render TWO short rows
// per set (L on top, R below) so each side gets its own reps +
// weight/band inputs. The pair shares one done button — a "set" of
// unilateral work is one logical unit even though the two sides
// happen sequentially.

import React from "react";
import { isMeasuredSeconds, measuredSecondsOrBlank, parseRepsCount } from "../../model/workout-volume.js";
import {
  copyModifierSelections,
  modifierSelectionSignature,
  modifierSelections,
  modifierValueOptions,
  setModifierSelection,
} from "../../model/workoutModifiers.js";
import { C } from "../../ui/theme.js";
import { WTypeBadge } from "./WTypeBadge.jsx";
import { VideoLink } from "./VideoLink.jsx";
import {
  BAND_COLORS, BAND_COLOR_LOOKUP,
  normalizeBands, toggleBand,
} from "./workoutConstants.js";

// Small color dot used in the prev column + the history pill so a
// stored band value is visible at a glance.
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

// Row of stacked swatches for a multi-band selection (e.g. green + red).
function BandStack({ bands, size = 10, gap = 2 }) {
  const arr = normalizeBands(bands);
  if (arr.length === 0) return null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap }}>
      {arr.map(k => <BandSwatch key={k} colorKey={k} size={size} />)}
    </span>
  );
}

function BandPicker({ bands, label, onToggle }) {
  const activeBands = normalizeBands(bands);
  return (
    <span
      role="group"
      aria-label={label}
      style={{
        display: "inline-flex", alignItems: "center", flexWrap: "wrap",
        gap: 3, maxWidth: 192,
      }}
    >
      {BAND_COLORS.map(band => {
        const active = activeBands.includes(band.key);
        return (
          <button
            key={band.key}
            type="button"
            aria-label={`${label}: ${band.label}`}
            aria-pressed={active}
            onClick={() => onToggle(band.key)}
            title={`${band.label}${active ? " (selected)" : ""} — tap to toggle`}
            style={{
              width: 22, height: 22, borderRadius: "50%",
              background: band.swatch, cursor: "pointer", padding: 0,
              border: active ? "2px solid #fff" : `1px solid ${C.border}`,
              opacity: active ? 1 : 0.55,
              boxShadow: active ? "0 0 0 1px rgba(0,0,0,0.4)" : "none",
              flexShrink: 0,
            }}
          />
        );
      })}
    </span>
  );
}

export function SessionExRow({ ex, unit, prevSets, setsData, onSetsChange, recommendations = [], last }) {
  const [repErrorSet, setRepErrorSet] = React.useState(null);
  const repInputRefs = React.useRef(new Map());
  const allSetsDone = setsData?.sets
    ? setsData.sets.every(s => s.done)
    : false;
  const inputStyle = {
    width: 72, background: C.bg, border: `1px solid ${C.border}`,
    color: C.text, borderRadius: 6, padding: "4px 7px", fontSize: 14,
    textAlign: "center",
  };
  // Set-row boxes count their padding in their width so a row's layout
  // is predictable when it wraps on a phone.
  const compactInput = width => ({ ...inputStyle, width, boxSizing: "border-box", padding: "4px 3px", fontSize: 13 });
  const repKeys = ex.unilateral ? ["leftReps", "rightReps"] : ["reps"];
  // Timed holds (front lever, planks, custom "time" exercises) log the
  // seconds each rep was held next to the reps: 3 × 10 s.
  const timeKeys = !ex.logTime ? [] : ex.unilateral ? ["leftSeconds", "rightSeconds"] : ["seconds"];
  const requiredKeys = [...repKeys, ...timeKeys];
  const requiresReps = !ex.circlesOnly || !!ex.reps || ex.tracking === "reps" || ex.tracking === "time";
  const resolvedReps = (set, index, key) => {
    const stored = set?.[key];
    if (stored != null && stored !== "") return stored;
    const recommended = recommendations[index]?.[key] ?? recommendations[index]?.reps;
    if (recommended != null && recommended !== "") return recommended;
    return ex.reps || "";
  };
  // A prescribed range ("5–10") stays a placeholder; only a plain number
  // can stand in for an untyped hold time.
  const resolvedSeconds = (set, key) => {
    const stored = set?.[key];
    return stored != null && stored !== "" ? stored : measuredSecondsOrBlank(ex.seconds);
  };
  const resolvedValue = (set, index, key) => timeKeys.includes(key)
    ? resolvedSeconds(set, key) : resolvedReps(set, index, key);
  const entered = (set, index, key) => timeKeys.includes(key)
    ? isMeasuredSeconds(resolvedSeconds(set, key))
    : parseRepsCount(resolvedReps(set, index, key)) > 0;
  const setRepInputRef = (index, key, node) => {
    const refKey = `${index}-${key}`;
    if (node) repInputRefs.current.set(refKey, node);
    else repInputRefs.current.delete(refKey);
  };
  const toggleSetDone = (index) => {
    const current = setsData.sets[index];
    if (!current || current.done || !requiresReps) {
      const next = [...setsData.sets];
      next[index] = { ...current, done: !current?.done };
      setRepErrorSet(null);
      onSetsChange({ sets: next });
      return;
    }
    const missingKey = requiredKeys.find(key => !entered(current, index, key));
    if (missingKey) {
      setRepErrorSet(index);
      repInputRefs.current.get(`${index}-${missingKey}`)?.focus();
      return;
    }
    const next = [...setsData.sets];
    next[index] = { ...current, done: true };
    for (const key of requiredKeys) next[index][key] = String(resolvedValue(current, index, key));
    setRepErrorSet(null);
    onSetsChange({ sets: next });
  };
  const updateReps = (index, key, value) => {
    const next = [...setsData.sets];
    next[index] = { ...next[index], [key]: value };
    if (requiredKeys.every(requiredKey => entered(next[index], index, requiredKey))) setRepErrorSet(null);
    onSetsChange({ sets: next });
  };
  const repError = index => repErrorSet === index ? (
    <div role="alert" style={{ color: C.red, fontSize: 11, margin: "2px 0 6px 44px" }}>
      {ex.logTime ? "Enter reps and seconds to complete this set." : "Enter reps to complete this set."}
    </div>
  ) : null;
  const setupModifiers = Array.isArray(ex.setupModifiers) ? ex.setupModifiers : [];
  const updateModifier = (set, index, modifier, value) => {
    const next = [...setsData.sets];
    const before = modifierSelectionSignature(set);
    let updated = setModifierSelection(set, modifier, value);
    if (!updated.done && modifierSelectionSignature(updated) !== before) {
      updated = {
        ...updated,
        ...(Object.hasOwn(updated, "weight") ? { weight: "" } : {}),
        ...(Object.hasOwn(updated, "leftWeight") ? { leftWeight: "" } : {}),
        ...(Object.hasOwn(updated, "rightWeight") ? { rightWeight: "" } : {}),
        ...(Object.hasOwn(updated, "band") ? { band: "" } : {}),
        ...(Object.hasOwn(updated, "leftBand") ? { leftBand: "" } : {}),
        ...(Object.hasOwn(updated, "rightBand") ? { rightBand: "" } : {}),
      };
    }
    next[index] = updated;
    onSetsChange({ sets: next });
  };
  const modifierControls = (set, index) => {
    if (setupModifiers.length === 0) return null;
    const selected = modifierSelections(set);
    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "3px 0 7px 44px" }}>
        {setupModifiers.map(modifier => (
          <div key={modifier.id} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ color: C.muted, fontSize: 10 }}>{modifier.name}</span>
            {modifier.control === "bands" ? (
              <BandPicker
                bands={selected[modifier.id]?.value?.split("+") || []}
                label={`${modifier.name} for set ${index + 1}`}
                onToggle={bandKey => {
                  const current = selected[modifier.id]?.value?.split("+").filter(Boolean) || [];
                  const values = current.includes(bandKey)
                    ? current.filter(value => value !== bandKey)
                    : [...current, bandKey];
                  updateModifier(set, index, modifier, values);
                }}
              />
            ) : (
              <select
                aria-label={`${modifier.name} for set ${index + 1}`}
                value={selected[modifier.id]?.value || ""}
                onChange={event => updateModifier(set, index, modifier, event.target.value)}
                style={{
                  background: C.bg, border: `1px solid ${C.border}`, color: C.text,
                  borderRadius: 6, padding: "4px 6px", fontSize: 11,
                }}
              >
                <option value="">None</option>
                {modifierValueOptions(modifier).map(option => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
            )}
          </div>
        ))}
      </div>
    );
  };
  const secondsInput = (set, index, key, width = 40) => (
    <>
      <span style={{ fontSize: 12, color: C.muted }}>×</span>
      <input
        ref={node => setRepInputRef(index, key, node)}
        type="text" inputMode="decimal"
        aria-label={`Seconds for set ${index + 1}${key === "leftSeconds" ? " left" : key === "rightSeconds" ? " right" : ""}`}
        onFocus={e => e.target.select()}
        value={resolvedSeconds(set, key)}
        onChange={e => updateReps(index, key, e.target.value)}
        placeholder={ex.seconds || ""}
        style={{
          ...compactInput(width),
          border: `1px solid ${repErrorSet === index && !isMeasuredSeconds(resolvedSeconds(set, key)) ? C.red : C.border}`,
        }}
      />
      <span style={{ fontSize: 11, color: C.muted }}>s</span>
    </>
  );
  // A new set copies the previous set's hold time, like its variant.
  const secondsBlank = () => {
    if (!ex.logTime) return {};
    const prev = setsData.sets.at(-1) || {};
    return Object.fromEntries(timeKeys.map(key => [key, measuredSecondsOrBlank(prev[key]) || measuredSecondsOrBlank(ex.seconds)]));
  };
  const doneBtn = (isDone, onPress, title) => (
    <button onClick={onPress} title={title} style={{
      width: 28, height: 28, borderRadius: "50%", flexShrink: 0,
      background: isDone ? C.green : "transparent",
      border: `2px solid ${isDone ? C.green : C.border}`,
      color: isDone ? "#000" : C.muted,
      cursor: "pointer", fontSize: 12, display: "flex",
      alignItems: "center", justifyContent: "center",
    }}>{isDone ? "✓" : ""}</button>
  );
  // Circles-only mode: one tappable circle per SET (not per rep).
  // Each circle conveys "did you do this set?" Optionally, if the
  // exercise has a reps prescription (ex.reps), a small reps input
  // sits alongside each circle so the user can also log the rep
  // count without losing the lightweight habit-tracker feel.
  // Used for movements like Ab Wheel where ROM quality is the load
  // axis (no weight, no band) but rep volume is still useful info.
  if (ex.circlesOnly && setsData?.sets) {
    // A rep-tracked custom exercise has no rep target until its first
    // session is logged, but that first session still records reps.
    const showReps = !!ex.reps || ex.tracking === "reps" || ex.tracking === "time";
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
            {/* Surface the prescription text inside the active session
                so the user can see suggested sets × reps without
                bouncing back to the preview card. The reps + sets
                hint disappeared on the May 2026 circlesOnly migration. */}
            {ex.prescription ? (
              <div style={{
                fontSize: 11, color: C.muted, marginTop: 4, fontStyle: "italic",
              }}>
                {ex.prescription}
              </div>
            ) : null}

            <div style={{ marginTop: 12 }}>
              {/* One row per set: label, optional reps input, circle. */}
              {setsData.sets.map((s, i) => (
                <React.Fragment key={i}>
                  <div style={{
                    display: "flex", alignItems: "center", gap: 8, marginBottom: 6,
                  }}>
                    <span style={{ fontSize: 12, color: C.muted, width: 36, flexShrink: 0 }}>
                      Set {i + 1}
                    </span>
                    {showReps && (
                      <input
                        ref={node => setRepInputRef(i, "reps", node)}
                        type="text" inputMode="numeric"
                        // Select-all on focus (June 2026): inputs arrive
                        // pre-filled with the recommendation, and on
                        // phones overriding meant tap → double-tap →
                        // delete → type. One tap now highlights the
                        // value so typing replaces it. inputMode numeric
                        // brings up the number pad on mobile.
                        onFocus={e => e.target.select()}
                        value={resolvedReps(s, i, "reps")}
                        onChange={e => updateReps(i, "reps", e.target.value)}
                        placeholder={ex.reps}
                        style={{
                          width: 60, background: C.bg,
                          border: `1px solid ${repErrorSet === i ? C.red : C.border}`,
                          color: C.text, borderRadius: 6, padding: "4px 7px", fontSize: 14,
                          textAlign: "center",
                        }}
                      />
                    )}
                    {showReps && (
                      <span style={{ fontSize: 11, color: C.muted }}>reps</span>
                    )}
                    {ex.logTime && secondsInput(s, i, "seconds")}
                    <button
                      onClick={() => toggleSetDone(i)}
                      title={`Set ${i + 1}: tap to toggle done`}
                      style={{
                        width: 32, height: 32, borderRadius: "50%",
                        background: s.done ? C.green : "transparent",
                        border: `2px solid ${s.done ? C.green : C.border}`,
                        color: s.done ? "#000" : C.muted,
                        cursor: "pointer", fontSize: 13, fontWeight: 700,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        flexShrink: 0,
                      }}
                    >
                      {s.done ? "✓" : ""}
                    </button>
                    {i >= (ex.sets || 0) && (
                      <button
                        onClick={() => onSetsChange({ sets: setsData.sets.filter((_, j) => j !== i) })}
                        style={{
                          background: "none", border: "none", color: C.muted,
                          cursor: "pointer", fontSize: 14, padding: "0 4px", lineHeight: 1,
                        }}
                        title="Remove this set"
                      >−</button>
                    )}
                  </div>
                  {modifierControls(s, i)}
                  {repError(i)}
                </React.Fragment>
              ))}
              <button
                onClick={() => onSetsChange({
                  sets: [...setsData.sets, showReps ? { reps: "", ...secondsBlank(), done: false } : { done: false }],
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
            <div className="session-set-columns" style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}>
              <span style={{ fontSize: 11, color: C.muted, width: 28, flexShrink: 0 }}></span>
              <span style={{ fontSize: 11, color: C.muted, width: ex.logTime ? 106 : 40, textAlign: "center" }}>
                {ex.logTime ? "reps × sec" : "reps"}
              </span>
              {/* Variant column header (June 2026) — sits between reps
                  and weight to match the input order below. */}
              {ex.logVariant && (
                <span style={{ fontSize: 11, color: C.muted, width: 96, textAlign: "center" }}>variant</span>
              )}
              <span style={{ fontSize: 11, color: C.muted, width: ex.logBand ? 192 : 80, textAlign: "center" }}>
                {ex.logBand ? "bands" : "weight"}
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
                // Prev pill shows whatever the last session recorded.
                // Band mode renders a stack of swatches (handles multi-
                // band selections); weight mode renders the formatted
                // string.
                const renderPrev = () => {
                  if (!prevShown) return prevSets?.length > 0 ? <span style={{ width: 44 }} /> : null;
                  if (ex.logBand && typeof prevShown === "object" && prevShown.bands) {
                    return (
                      <span style={{ fontSize: 12, color: C.muted, width: 44, display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <BandStack bands={prevShown.bands} size={10} />
                        {prevShown.reps || ""}
                      </span>
                    );
                  }
                  return <span style={{ fontSize: 12, color: C.muted, width: 44 }}>{prevShown}</span>;
                };
                return (
                  // Wraps onto a second line on narrow screens; prev and the
                  // tick stay together at the right so the tick stays on screen.
                  <div key={sideKey} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginBottom: side === "L" ? 4 : 6 }}>
                    <span style={{ fontSize: 12, color: isExtra ? C.orange : C.muted, width: 28, flexShrink: 0 }}>
                      {sLabel}
                    </span>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <input
                      ref={node => setRepInputRef(i, repsKey, node)}
                      type="text" inputMode="numeric"
                      // Select-all on focus — see the bilateral reps
                      // input above for the mobile-override rationale.
                      onFocus={e => e.target.select()}
                      value={repsVal}
                      onChange={e => updateReps(i, repsKey, e.target.value)}
                      style={{
                        ...compactInput(40),
                        border: `1px solid ${repErrorSet === i && parseRepsCount(repsVal) <= 0 ? C.red : C.border}`,
                      }}
                      placeholder={recReps != null ? String(recReps) : (ex.reps || "")}
                    />
                    {ex.logTime && secondsInput(s, i, sideWord ? `${sideWord}Seconds` : "seconds")}
                    </span>
                    {/* Per-set variant selector (June 2026). A <select>
                        rather than pill buttons — four leverage rungs
                        with multi-word labels would blow out the row
                        width that the reps/weight inputs share. Stored
                        under the plain `variant` key: the only variant
                        exercise (TRX Row) is bilateral, so no per-side
                        keys yet; a future unilateral variant exercise
                        would need leftVariant/rightVariant the way
                        band mode grew leftBand/rightBand. Empty-value
                        option renders only while the set has no
                        variant (retroactive history edits seed blank)
                        so picking a rung is one tap and un-picking
                        isn't a thing. */}
                    {ex.logVariant && (
                      <select
                        value={s.variant ?? ""}
                        onChange={e => {
                          const next = [...setsData.sets];
                          next[i] = { ...next[i], variant: e.target.value };
                          onSetsChange({ sets: next });
                        }}
                        style={{
                          width: 96, background: C.bg, border: `1px solid ${C.border}`,
                          color: C.text, borderRadius: 6, padding: "4px 4px", fontSize: 12,
                        }}
                      >
                        {!(s.variant) && <option value="">— variant —</option>}
                        {(ex.variants || []).map(v => (
                          <option key={v} value={v}>{v}</option>
                        ))}
                      </select>
                    )}
                    {ex.logBand ? (
                      <BandPicker
                        bands={loadVal}
                        label={`${ex.name} ${sLabel} bands`}
                        onToggle={bandKey => {
                          const nextBands = toggleBand(loadVal, bandKey);
                          const next = [...setsData.sets];
                          next[i] = { ...next[i], [loadKey]: nextBands };
                          onSetsChange({ sets: next });
                        }}
                      />
                    ) : (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <input
                          type="number" inputMode="decimal"
                          // Select-all on focus — see the reps inputs
                          // above for the mobile-override rationale.
                          onFocus={e => e.target.select()}
                          value={loadVal}
                          onChange={e => {
                            const next = [...setsData.sets];
                            next[i] = { ...next[i], [loadKey]: e.target.value };
                            onSetsChange({ sets: next });
                          }}
                          style={compactInput(56)}
                          placeholder={recLoad != null ? String(recLoad) : ""}
                        />
                        <span style={{ fontSize: 12, color: C.muted }}>{unit}</span>
                      </span>
                    )}
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, marginLeft: "auto" }}>
                      {renderPrev()}
                      {(side === null || side === "R") && doneBtn(
                        s.done,
                        () => toggleSetDone(i),
                        `Set ${i + 1}: tap to toggle done`
                      )}
                      {(side === null || side === "R") && isExtra && (
                        <button
                          onClick={() => onSetsChange({ sets: setsData.sets.filter((_, j) => j !== i) })}
                          style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 14, padding: "0 2px", lineHeight: 1 }}
                          title="Remove this set"
                        >−</button>
                      )}
                    </span>
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
                    {modifierControls(s, i)}
                    {repError(i)}
                  </div>
                );
              }
              return (
                <div key={i}>
                  {renderSideRow(null, `S${i + 1}`, `${i}`)}
                  {rec?.reasoning && (<div style={hintStyle}>{rec.reasoning}</div>)}
                  {modifierControls(s, i)}
                  {repError(i)}
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
                  if (ex.logVariant) {
                    // Inherit the previous set's variant — within one
                    // session you almost always keep working the same
                    // leverage rung; fall back to the easiest rung.
                    const prevVariant = setsData.sets[setsData.sets.length - 1]?.variant;
                    return {
                      variant: prevVariant || (ex.variants?.[0] ?? ""),
                      reps: ex.reps || "", weight: "", done: false,
                    };
                  }
                  return { reps: ex.reps || "", weight: "", done: false };
                };
                const blank = { ...makeBlank(), ...secondsBlank() };
                const modifiers = copyModifierSelections(setsData.sets.at(-1));
                onSetsChange({
                  sets: [...setsData.sets, Object.keys(modifiers).length ? { ...blank, modifiers } : blank],
                });
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
