// ─────────────────────────────────────────────────────────────
// CLIMBING HISTORY LIST
// ─────────────────────────────────────────────────────────────
// Date-grouped climb list. Each row supports inline edit (pencil)
// and delete (×). Edit opens a compact form pre-populated with the
// existing values; Save dispatches onUpdateActivity(id, updates),
// Cancel collapses without writing.
//
// onUpdateActivity / onDeleteActivity are optional — omit either
// to render the corresponding control as read-only.

import React, { useMemo, useState } from "react";
import { C } from "../ui/theme.js";
import { Card } from "../ui/components.js";
import {
  CLIMB_DISCIPLINES, ASCENT_STYLES, BOULDER_WALLS, VENUES,
  disciplineMeta, ascentMeta, wallMeta, describeClimb,
  gradesFor, defaultGradeFor,
} from "../lib/climbing-grades.js";

export function ClimbingHistoryList({
  climbs,
  onDeleteActivity = null,
  onUpdateActivity = null,
}) {
  const [editingId, setEditingId] = useState(null);

  const byDate = useMemo(() => {
    const m = new Map();
    for (const c of climbs) {
      const d = c.date || "—";
      if (!m.has(d)) m.set(d, []);
      m.get(d).push(c);
    }
    return [...m.entries()];
  }, [climbs]);

  if (climbs.length === 0) {
    return (
      <Card>
        <div style={{ color: C.muted, fontSize: 13 }}>
          No climbs logged yet. Use the Fingers tab to log your first climb.
        </div>
      </Card>
    );
  }

  return byDate.map(([date, list]) => (
    <Card key={date}>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>
        {date} · {list.length} climb{list.length === 1 ? "" : "s"}
      </div>
      {list.map(c => {
        const isEditing = editingId === c.id;
        if (isEditing && onUpdateActivity) {
          return (
            <ClimbEditRow
              key={c.id}
              climb={c}
              onSave={(updates) => {
                onUpdateActivity(c.id, updates);
                setEditingId(null);
              }}
              onCancel={() => setEditingId(null)}
            />
          );
        }
        return (
          <ClimbRow
            key={c.id || `${c.date}-${c.grade}-${c.ascent}`}
            climb={c}
            onEdit={onUpdateActivity ? () => setEditingId(c.id) : null}
            onDelete={onDeleteActivity ? () => {
              if (window.confirm("Delete this climb?")) onDeleteActivity(c.id);
            } : null}
          />
        );
      })}
    </Card>
  ));
}

// ─────────────────────────────────────────────────────────────
// ClimbRow — read-only display for one climb entry
// ─────────────────────────────────────────────────────────────
function ClimbRow({ climb: c, onEdit, onDelete }) {
  const isSend = c.ascent && c.ascent !== "attempt";
  const disc   = disciplineMeta(c.discipline);
  const wall   = c.discipline === "boulder" && c.wall ? wallMeta(c.wall) : null;
  const venueLabel = c.venue === "outdoor" ? "Outdoor" : null;
  // Build the outdoor location label: "Route, Crag, Area" — only the
  // pieces that exist. Renders as a third line under the main row
  // when any are present (typically only on outdoor climbs).
  const locationParts = [c.route_name, c.crag, c.area].filter(Boolean);

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
      padding: "8px 0",
      borderTop: `1px solid ${C.border}`,
    }}>
      <div style={{ fontSize: 18 }}>{disc.emoji}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>
          {c.grade || "—"}{" "}
          <span style={{ color: C.muted, fontWeight: 400 }}>
            {disc.label}
            {venueLabel ? ` · ${venueLabel}` : ""}
            {wall ? ` · ${wall.label}` : ""}
          </span>
        </div>
        <div style={{ fontSize: 11, color: isSend ? C.green : C.muted }}>
          {c.ascent ? ascentMeta(c.ascent).label : describeClimb(c)}
          {Number.isFinite(c.rpe) ? ` · RPE ${c.rpe}` : ""}
        </div>
        {locationParts.length > 0 && (
          <div style={{
            fontSize: 11, color: C.text, marginTop: 2,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {c.route_name && <b>{c.route_name}</b>}
            {c.route_name && (c.crag || c.area) ? " · " : ""}
            <span style={{ color: C.muted }}>
              {[c.crag, c.area].filter(Boolean).join(", ")}
            </span>
          </div>
        )}
      </div>
      {onEdit && c.id && (
        <button
          onClick={onEdit}
          style={{
            background: "none", border: "none", color: C.muted,
            cursor: "pointer", fontSize: 14, padding: "4px 6px",
          }}
          title="Edit climb"
        >
          ✎
        </button>
      )}
      {onDelete && c.id && (
        <button
          onClick={onDelete}
          style={{
            background: "none", border: "none", color: C.muted,
            cursor: "pointer", fontSize: 16, padding: "4px 6px",
          }}
          title="Delete climb"
        >
          ×
        </button>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// ClimbEditRow — inline editor for one climb entry
// ─────────────────────────────────────────────────────────────
// Mirrors the field set of ClimbingLogCard (date, discipline,
// venue, wall, grade, ascent, RPE). Visually compact since it
// expands inside a list row rather than living as a full Card.
//
// Wall is only included in the saved updates when the
// indoor + boulder combination is selected — switching a climb
// from boulder to lead drops the now-meaningless wall annotation.
function ClimbEditRow({ climb, onSave, onCancel }) {
  const [date,       setDate]       = useState(climb.date || "");
  const [discipline, setDiscipline] = useState(climb.discipline || "boulder");
  const [venue,      setVenue]      = useState(climb.venue || "indoor");
  const [wall,       setWall]       = useState(climb.wall || "commercial");
  const [grade,      setGrade]      = useState(climb.grade || defaultGradeFor(climb.discipline || "boulder"));
  const [ascent,     setAscent]     = useState(climb.ascent || "flash");
  const [rpe,        setRpe]        = useState(Number.isFinite(climb.rpe) ? climb.rpe : 7);
  const [routeName,  setRouteName]  = useState(climb.route_name || "");
  const [crag,       setCrag]       = useState(climb.crag || "");
  const [area,       setArea]       = useState(climb.area || "");

  const handleDiscipline = (key) => {
    setDiscipline(key);
    const valid = gradesFor(key);
    if (!valid.includes(grade)) setGrade(defaultGradeFor(key));
  };

  const showWall = venue === "indoor" && discipline === "boulder";
  const showOutdoorMeta = venue === "outdoor";

  const save = () => {
    const updates = { date, discipline, venue, grade, ascent, rpe };
    // Drop wall when the new combination doesn't allow it. Setting to
    // null tells pushActivity to clear the column on the upserted row.
    updates.wall = showWall ? wall : null;
    // Name (route_name) applies to any climb; crag/area stay outdoor-
    // only. null clears a column when the value is deleted or when
    // switching a climb from outdoor to indoor. Switching to indoor
    // keeps the name but drops the location fields.
    updates.route_name = routeName.trim() || null;
    if (showOutdoorMeta) {
      updates.crag = crag.trim() || null;
      updates.area = area.trim() || null;
    } else {
      updates.crag = null;
      updates.area = null;
    }
    onSave(updates);
  };

  // Compact pill renderer — same visual language as ClimbingLogCard
  // but smaller / tighter to fit inside a row.
  const pill = (active, label, emoji, onClick) => (
    <button
      onClick={onClick}
      style={{
        flex: "1 1 30%", padding: "6px 4px", borderRadius: 6, cursor: "pointer",
        background: active ? C.purple : C.bg,
        color:      active ? "#fff"   : C.muted,
        border:     `1px solid ${active ? C.purple : C.border}`,
        fontSize: 11, fontWeight: 600, textAlign: "center",
      }}
    >
      {emoji && <div style={{ fontSize: 12 }}>{emoji}</div>}
      <div style={{ marginTop: 2 }}>{label}</div>
    </button>
  );

  const sectionLabel = (text) => (
    <div style={{
      fontSize: 10, color: C.muted, marginBottom: 4,
      textTransform: "uppercase", letterSpacing: 0.5,
    }}>{text}</div>
  );

  return (
    <div style={{
      padding: "10px 0", borderTop: `1px solid ${C.border}`,
    }}>
      {/* Date */}
      <div style={{ marginBottom: 10 }}>
        {sectionLabel("Date")}
        <input
          type="date"
          value={date}
          onChange={e => setDate(e.target.value)}
          style={{
            width: "100%", padding: "6px 8px", borderRadius: 6,
            background: C.bg, color: C.text, border: `1px solid ${C.border}`,
            fontSize: 12,
          }}
        />
      </div>

      {/* Discipline */}
      {sectionLabel("Discipline")}
      <div style={{ display: "flex", gap: 4, marginBottom: 10, flexWrap: "wrap" }}>
        {CLIMB_DISCIPLINES.map(({ key, label, emoji }) =>
          pill(discipline === key, label, emoji, () => handleDiscipline(key))
        )}
      </div>

      {/* Venue */}
      {sectionLabel("Venue")}
      <div style={{ display: "flex", gap: 4, marginBottom: 10, flexWrap: "wrap" }}>
        {VENUES.map(({ key, label, emoji }) =>
          pill(venue === key, label, emoji, () => setVenue(key))
        )}
      </div>

      {/* Wall — indoor boulder only */}
      {showWall && <>
        {sectionLabel("Wall")}
        <div style={{ display: "flex", gap: 4, marginBottom: 10, flexWrap: "wrap" }}>
          {BOULDER_WALLS.map(({ key, label, emoji }) =>
            pill(wall === key, label, emoji, () => setWall(key))
          )}
        </div>
      </>}

      {/* Name + outdoor location. Name applies to any climb; crag/area
          stay outdoor-only. Same field set as ClimbingLogCard so
          creating and editing share one mental model. */}
      {sectionLabel("Name (optional)")}
      {[
        { val: routeName, set: setRouteName, ph: "Name this climb" },
        ...(showOutdoorMeta ? [
          { val: crag, set: setCrag, ph: "Cliff / crag" },
          { val: area, set: setArea, ph: "Area" },
        ] : []),
      ].map(({ val, set, ph }) => (
        <input key={ph} type="text" placeholder={ph}
          value={val} onChange={e => set(e.target.value)}
          style={{
            width: "100%", padding: "6px 8px", marginBottom: 6,
            borderRadius: 6, background: C.bg, color: C.text,
            border: `1px solid ${C.border}`, fontSize: 12,
          }} />
      ))}
      <div style={{ marginBottom: 4 }} />

      {/* Grade */}
      {sectionLabel(`Grade (${discipline === "boulder" ? "V-scale" : "YDS"})`)}
      <select
        value={grade}
        onChange={e => setGrade(e.target.value)}
        style={{
          width: "100%", padding: "6px 8px", marginBottom: 10, borderRadius: 6,
          background: C.bg, color: C.text, border: `1px solid ${C.border}`,
          fontSize: 12,
        }}
      >
        {gradesFor(discipline).map(g => (
          <option key={g} value={g}>{g}</option>
        ))}
      </select>

      {/* Ascent */}
      {sectionLabel("Ascent")}
      <div style={{ display: "flex", gap: 4, marginBottom: 10, flexWrap: "wrap" }}>
        {ASCENT_STYLES.map(({ key, label }) =>
          pill(ascent === key, label, null, () => setAscent(key))
        )}
      </div>

      {/* RPE */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
        {sectionLabel("Effort (RPE)")}
        <div style={{ fontSize: 16, fontWeight: 700, color: C.purple }}>
          {rpe}<span style={{ fontSize: 10, color: C.muted, fontWeight: 400 }}>/10</span>
        </div>
      </div>
      <input
        type="range" min="1" max="10" step="1"
        value={rpe}
        onChange={e => setRpe(Number(e.target.value))}
        style={{ width: "100%", accentColor: C.purple, marginBottom: 12 }}
      />

      {/* Actions */}
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={save} style={{
          flex: 1, padding: "8px 0", borderRadius: 6, fontSize: 12, fontWeight: 700,
          background: C.green, color: "#fff", border: "none", cursor: "pointer",
        }}>Save</button>
        <button onClick={onCancel} style={{
          flex: 1, padding: "8px 0", borderRadius: 6, fontSize: 12, fontWeight: 600,
          background: C.border, color: C.muted, border: "none", cursor: "pointer",
        }}>Cancel</button>
      </div>
    </div>
  );
}
