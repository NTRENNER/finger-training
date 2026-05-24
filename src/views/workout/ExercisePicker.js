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

  // Build the candidate list from the catalog. Filter out non-loggable
  // catalog entries (the A/B/C workout definitions live in the same
  // export under unique keys and shouldn't appear as picker rows) and
  // anything the caller asked us to hide.
  const items = useMemo(() => {
    const excluded = new Set(excludeIds);
    const all = Object.values(EXERCISE_CATALOG)
      .filter(ex => ex && typeof ex === "object" && ex.id && ex.name)
      .filter(ex => ex.loggable !== false)         // skip non-loggable workout templates
      .filter(ex => !excluded.has(ex.id));
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
    return filtered.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }, [q, excludeIds]);

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
            items.map(ex => (
              <button
                key={ex.id}
                onClick={() => onPick(ex)}
                style={{
                  width: "100%", textAlign: "left",
                  padding: "10px 16px",
                  background: "none", border: "none",
                  borderBottom: `1px solid ${C.border}`,
                  cursor: "pointer", color: "inherit",
                }}
              >
                <div style={{ display: "flex", alignItems: "center" }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
                    {ex.name}
                  </span>
                  {typeBadge(ex.type)}
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
            ))
          )}
        </div>
      </div>
    </div>
  );
}
