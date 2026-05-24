// ─────────────────────────────────────────────────────────────
// ExercisePicker — modal-style chooser for mid-workout swaps
// ─────────────────────────────────────────────────────────────
// Full-screen overlay. Search box at top, filtered scrollable list
// of every loggable exercise in the catalog. Tap a row to commit
// the pick — closes via onPick(exercise). Tap the backdrop or
// Cancel to dismiss.
//
// Source of truth for the list is `exercises` from supportTraining.js.
// Excluded options are passed in via `excludeIds` so we don't offer
// the user an exercise that's already in the live session (no
// duplicate rows). The picker doesn't know or care WHY a swap is
// happening — it just returns the chosen exercise definition.
//
// Phase 2 future-work: when the exercises catalog moves out of code
// into editable user data, this component is the consumer that
// needs the least change — swap the `exercises` import for whatever
// the new source is. UI stays the same.

import React, { useMemo, useState } from "react";
import { C } from "../../ui/theme.js";
import { exercises as EXERCISE_CATALOG } from "../../model/supportTraining.js";
import { migrateExerciseId } from "../../model/exerciseIds.js";

// Short label for the exercise type. Mirrors the existing type
// taxonomy (S=Strength, P=Power, etc.) used elsewhere — kept tiny
// so it doesn't dominate the row.
const TYPE_LABELS = {
  S: "Strength",
  P: "Power",
  C: "Conditioning",
  M: "Mobility",
  A: "Accessory",
};

function typeBadge(type) {
  if (!type) return null;
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, color: C.muted,
      background: C.bg, border: `1px solid ${C.border}`,
      padding: "1px 6px", borderRadius: 4,
      letterSpacing: 0.5, textTransform: "uppercase",
      marginLeft: 6, flexShrink: 0,
    }}>
      {TYPE_LABELS[type] || type}
    </span>
  );
}

export function ExercisePicker({ title = "Pick exercise", excludeIds = [], onPick, onCancel }) {
  const [q, setQ] = useState("");

  // Stable Set for "already in this workout" lookup. Kept outside the
  // useMemo so the items list re-renders only when the underlying ids
  // actually change. (excludeIds is reconstructed on every parent
  // render — joining its sorted ids gives a stable dep for useMemo.)
  const excludedKey = useMemo(
    () => (excludeIds || []).slice().sort().join("|"),
    [excludeIds],
  );

  // Build the candidate list from the catalog. We keep non-loggable
  // workout templates (A/B/C) out — they have no `loggable` flag at
  // all, and we explicitly require `loggable !== false`. We DO keep
  // already-in-workout exercises in the list but mark them as
  // disabled, since silently hiding them confuses users ("where did
  // Med Ball Slams go?" when editing Workout B, which already
  // includes it).
  const items = useMemo(() => {
    // Migrate excluded ids through the legacy → current map so a
    // session that still stores the old `slam_balls` id correctly
    // marks the catalog's `medBallThrows` row as already added.
    // Without this, the user could add a duplicate that resolves to
    // the same canonical exercise.
    const excluded = new Set((excludeIds || []).map(migrateExerciseId));
    const all = Object.values(EXERCISE_CATALOG)
      .filter(ex => ex && typeof ex === "object" && ex.id && ex.name)
      .filter(ex => ex.loggable !== false)         // skip non-loggable workout templates
      .map(ex => ({ ...ex, _alreadyAdded: excluded.has(migrateExerciseId(ex.id)) }));
    // Case-insensitive substring match across name + intent + tags so
    // a user can type "press", "shoulder", or "snatch" and find the
    // right exercise without remembering its exact catalog key.
    const needle = q.trim().toLowerCase();
    const filtered = needle
      ? all.filter(ex => {
          const hay = [
            ex.name || "",
            ex.intent || "",
            (ex.tags || []).join(" "),
          ].join(" ").toLowerCase();
          return hay.includes(needle);
        })
      : all;
    // Sort: pickable first (so the user sees actionable options up
    // top), then alphabetical within each group.
    return filtered.sort((a, b) => {
      if (a._alreadyAdded !== b._alreadyAdded) return a._alreadyAdded ? 1 : -1;
      return (a.name || "").localeCompare(b.name || "");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, excludedKey]);

  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed", inset: 0, zIndex: 200,
        background: "rgba(0,0,0,0.7)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: C.card ?? "#1a1a1a",
          borderRadius: 12,
          width: "100%", maxWidth: 480,
          maxHeight: "85vh", overflow: "hidden",
          display: "flex", flexDirection: "column",
          border: `1px solid ${C.border}`,
        }}
      >
        {/* Header */}
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          padding: "12px 16px", borderBottom: `1px solid ${C.border}`,
        }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{title}</div>
          <button
            onClick={onCancel}
            aria-label="Close picker"
            style={{
              background: "none", border: "none", color: C.muted,
              fontSize: 20, cursor: "pointer", padding: "0 4px", lineHeight: 1,
            }}
          >×</button>
        </div>

        {/* Search */}
        <div style={{ padding: "10px 12px", borderBottom: `1px solid ${C.border}` }}>
          <input
            type="text"
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search by name, intent, or tag…"
            autoFocus
            style={{
              width: "100%", padding: "8px 10px", borderRadius: 8,
              background: C.bg, color: C.text,
              border: `1px solid ${C.border}`, fontSize: 13,
              boxSizing: "border-box",
            }}
          />
        </div>

        {/* List */}
        <div style={{
          flex: 1, overflowY: "auto",
          padding: "4px 0",
        }}>
          {items.length === 0 ? (
            <div style={{
              padding: "32px 16px", textAlign: "center",
              fontSize: 12, color: C.muted,
            }}>
              No exercises match "{q}".
            </div>
          ) : (
            items.map(ex => {
              const disabled = ex._alreadyAdded;
              return (
                <button
                  key={ex.id}
                  onClick={() => !disabled && onPick(ex)}
                  disabled={disabled}
                  title={disabled ? "Already in this workout" : "Tap to pick"}
                  style={{
                    width: "100%", textAlign: "left",
                    padding: "10px 16px",
                    background: "none", border: "none",
                    borderBottom: `1px solid ${C.border}`,
                    cursor: disabled ? "not-allowed" : "pointer",
                    color: "inherit",
                    opacity: disabled ? 0.45 : 1,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center" }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
                      {ex.name}
                    </span>
                    {typeBadge(ex.type)}
                    {disabled && (
                      <span style={{
                        fontSize: 9, color: C.muted, marginLeft: 6,
                        textTransform: "uppercase", letterSpacing: 0.5,
                      }}>
                        already added
                      </span>
                    )}
                    {ex.prescription && (
                      <span style={{
                        fontSize: 11, color: C.muted, marginLeft: "auto",
                        flexShrink: 0,
                      }}>
                        {ex.prescription}
                      </span>
                    )}
                  </div>
                  {ex.intent && (
                    <div style={{
                      fontSize: 11, color: C.muted, marginTop: 2, lineHeight: 1.4,
                      overflow: "hidden", textOverflow: "ellipsis",
                      display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
                    }}>
                      {ex.intent}
                    </div>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
