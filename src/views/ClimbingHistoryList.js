// ─────────────────────────────────────────────────────────────
// CLIMBING HISTORY LIST
// ─────────────────────────────────────────────────────────────
// Climb list with a filter-pills row above. Default view is
// date-grouped; selecting the Named pill switches to a name-grouped
// view (all sends of "The Journey" stacked into one card, alphabetical
// across cards). Discipline / venue / wall pills further narrow what
// shows — single-select per category, tap a selected pill to clear it.
//
// Filter state persists to localStorage (LS_CLIMBING_HISTORY_FILTERS_KEY)
// so re-entering the tab lands on the same view. View state only —
// not synced to the cloud.
//
// Each row supports inline edit (pencil) and delete (×). Edit opens a
// compact form pre-populated with the existing values; Save dispatches
// onUpdateActivity(id, updates), Cancel collapses without writing.
// onUpdateActivity / onDeleteActivity are optional — omit either to
// render the corresponding control as read-only.

import React, { useEffect, useMemo, useState } from "react";
import { C } from "../ui/theme.js";
import { Card } from "../ui/components.js";
import {
  CLIMB_DISCIPLINES, ASCENT_STYLES, BOULDER_WALLS, VENUES,
  disciplineMeta, ascentMeta, wallMeta, describeClimb,
  gradesFor, defaultGradeFor,
} from "../lib/climbing-grades.js";
import { loadLS, saveLS, LS_CLIMBING_HISTORY_FILTERS_KEY } from "../lib/storage.js";

// Default filter state — everything "all" (no filtering), name-group off.
const DEFAULT_FILTERS = {
  named: false,
  discipline: "all",  // "all" | "boulder" | "lead"
  venue:      "all",  // "all" | "indoor" | "outdoor"
  wall:       "all",  // "all" | "moonboard" | "kilter"
};

export function ClimbingHistoryList({
  climbs,
  onDeleteActivity = null,
  onUpdateActivity = null,
}) {
  const [editingId, setEditingId] = useState(null);

  // ── Filter state (persisted) ────────────────────────────────
  const [filters, setFiltersState] = useState(() => {
    const stored = loadLS(LS_CLIMBING_HISTORY_FILTERS_KEY);
    return { ...DEFAULT_FILTERS, ...(stored || {}) };
  });
  const updateFilters = (next) => {
    setFiltersState(next);
    saveLS(LS_CLIMBING_HISTORY_FILTERS_KEY, next);
  };
  // Tap-to-deselect: tapping the active pill in a category clears it
  // back to "all". Tapping a different pill in the same category
  // switches selection. The Named pill is a plain toggle.
  const pickFilter = (key, value) => {
    if (key === "named") {
      updateFilters({ ...filters, named: !filters.named });
      return;
    }
    const next = (filters[key] === value) ? "all" : value;
    updateFilters({ ...filters, [key]: next });
  };

  // Wall pills only make sense for indoor boulder (or "all venues"
  // boulder). Hide the row when not applicable; auto-clear any
  // stale wall selection so it doesn't silently exclude data.
  const wallPillsVisible = filters.discipline !== "lead" && filters.venue !== "outdoor";
  useEffect(() => {
    if (!wallPillsVisible && filters.wall !== "all") {
      updateFilters({ ...filters, wall: "all" });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallPillsVisible]);

  // ── Apply filters ───────────────────────────────────────────
  const filtered = useMemo(() => {
    return climbs.filter(c => {
      if (filters.named && !c.route_name) return false;
      if (filters.discipline !== "all" && c.discipline !== filters.discipline) return false;
      if (filters.venue !== "all") {
        const v = c.venue || "indoor";  // legacy fallback
        if (v !== filters.venue) return false;
      }
      if (filters.wall !== "all" && c.wall !== filters.wall) return false;
      return true;
    });
  }, [climbs, filters]);

  // ── Group: by date (default) or by name (Named mode) ───────
  // Date mode: existing behavior — one card per date, descending.
  // Name mode: one card per route_name, alphabetical. Within each
  // card, sends are listed date-descending so the most recent ascent
  // surfaces first.
  const grouped = useMemo(() => {
    const m = new Map();
    if (filters.named) {
      for (const c of filtered) {
        const key = c.route_name || "—";
        if (!m.has(key)) m.set(key, []);
        m.get(key).push(c);
      }
      // Sort within group by date desc; then sort groups alphabetically.
      for (const arr of m.values()) {
        arr.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      }
      return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    }
    for (const c of filtered) {
      const key = c.date || "—";
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(c);
    }
    // Date groups already come pre-sorted descending from the caller,
    // but force the order here in case callers stop sorting upstream.
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [filtered, filters.named]);

  return (
    <div>
      <FilterPills
        filters={filters}
        onPick={pickFilter}
        wallVisible={wallPillsVisible}
        totalClimbs={climbs.length}
        filteredCount={filtered.length}
      />

      {filtered.length === 0 ? (
        <Card>
          <div style={{ color: C.muted, fontSize: 13 }}>
            {climbs.length === 0
              ? "No climbs logged yet. Use the Fingers tab to log your first climb."
              : "No climbs match these filters. Clear a pill above to widen the view."}
          </div>
        </Card>
      ) : (
        grouped.map(([groupKey, list]) => (
          <Card key={groupKey}>
            <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>
              {filters.named ? (
                <span><b style={{ color: C.text }}>{groupKey}</b> · {list.length} send{list.length === 1 ? "" : "s"}</span>
              ) : (
                <span>{groupKey} · {list.length} climb{list.length === 1 ? "" : "s"}</span>
              )}
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
                  // In name mode the route_name is in the card header,
                  // so suppress it on the row and show the date instead
                  // (since date is no longer the grouping key).
                  showDate={filters.named}
                  hideRouteName={filters.named}
                  onEdit={onUpdateActivity ? () => setEditingId(c.id) : null}
                  onDelete={onDeleteActivity ? () => {
                    if (window.confirm("Delete this climb?")) onDeleteActivity(c.id);
                  } : null}
                />
              );
            })}
          </Card>
        ))
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// FilterPills — single row of toggleable filters above the list
// ─────────────────────────────────────────────────────────────
// Top Rope and Commercial-wall are intentionally omitted from the
// pill set — they're the "unnamed default" the user typically climbs
// and don't need their own filter. With everything deselected, the
// list shows the full unfiltered set, so top_rope and commercial
// climbs are still visible by default.
function FilterPills({ filters, onPick, wallVisible, totalClimbs, filteredCount }) {
  const pill = (label, key, value) => {
    const active = key === "named" ? filters.named : filters[key] === value;
    return (
      <button
        key={`${key}-${value}`}
        onClick={() => onPick(key, value)}
        style={{
          padding: "4px 10px", borderRadius: 12, fontSize: 11, cursor: "pointer",
          border: "none", fontWeight: 600,
          background: active ? C.purple : C.border,
          color:      active ? "#fff" : C.muted,
        }}
      >
        {label}
      </button>
    );
  };
  return (
    <Card style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
        {pill("Named", "named", true)}
        <span style={{ width: 6 }} />
        {pill("Boulder", "discipline", "boulder")}
        {pill("Lead",    "discipline", "lead")}
        <span style={{ width: 6 }} />
        {pill("Indoor",  "venue", "indoor")}
        {pill("Outdoor", "venue", "outdoor")}
        {wallVisible && <>
          <span style={{ width: 6 }} />
          {pill("MoonBoard", "wall", "moonboard")}
          {pill("Kilter",    "wall", "kilter")}
        </>}
      </div>
      <div style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>
        {filteredCount} of {totalClimbs} climb{totalClimbs === 1 ? "" : "s"}
        {filters.named && " · grouped by name"}
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────
// ClimbRow — read-only display for one climb entry
// ─────────────────────────────────────────────────────────────
function ClimbRow({ climb: c, onEdit, onDelete, showDate = false, hideRouteName = false }) {
  const isSend = c.ascent && c.ascent !== "attempt";
  const disc   = disciplineMeta(c.discipline);
  const wall   = c.discipline === "boulder" && c.wall ? wallMeta(c.wall) : null;
  const venueLabel = c.venue === "outdoor" ? "Outdoor" : null;
  // Build the location label: route_name (suppressed in name-group
  // mode since it's in the card header) + crag + area. Only the
  // pieces that exist render; typically only on outdoor climbs.
  const showRouteName = !hideRouteName && c.route_name;
  const locationParts = [showRouteName && c.route_name, c.crag, c.area].filter(Boolean);

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
          {showDate && c.date ? `${c.date} · ` : ""}
          {c.ascent ? ascentMeta(c.ascent).label : describeClimb(c)}
          {Number.isFinite(c.rpe) ? ` · RPE ${c.rpe}` : ""}
        </div>
        {locationParts.length > 0 && (
          <div style={{
            fontSize: 11, color: C.text, marginTop: 2,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {showRouteName && <b>{c.route_name}</b>}
            {showRouteName && (c.crag || c.area) ? " · " : ""}
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
