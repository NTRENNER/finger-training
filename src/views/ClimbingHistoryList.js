// ─────────────────────────────────────────────────────────────
// CLIMBING HISTORY LIST
// ─────────────────────────────────────────────────────────────
// Climb list with a filter-pills row above plus an independent "Sort
// by" selector. Filters and grouping are orthogonal so the user can
// combine, e.g., 'Named filter + Grade grouping' to see all named
// sends arranged by grade.
//
// Filter pills (additive, tap to toggle):
//   - Named: show only climbs with a route_name set
//   - Boulder / Lead: discipline (single-select per category)
//   - Indoor / Outdoor: venue (single-select per category)
//   - MoonBoard / Kilter: wall (single-select; only shown when the
//     combo allows it — indoor boulder)
//
// Sort-by selector (single-select, default Date):
//   - Date:  one card per date, descending
//   - Name:  one card per route_name, alphabetical; sends inside
//            date-desc. Unnamed climbs collapse into one '—' card.
//   - Grade: one card per grade, hardest-first; sends inside date-desc
//
// When discipline is locked to boulder or lead, a grade range picker
// appears below the pills so the user can also clamp min/max grade
// (V scale for boulder, YDS for lead). The range stays hidden when
// discipline is "all" because the two grade scales can't be mixed.
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
  V_GRADES, YDS_GRADES,
  disciplineMeta, ascentMeta, wallMeta, describeClimb,
  gradeRank,
  gradesFor, defaultGradeFor,
} from "../lib/climbing-grades.js";
import { loadLS, saveLS, LS_CLIMBING_HISTORY_FILTERS_KEY } from "../lib/storage.js";

// Default filter state — nothing filtered, date grouping.
const DEFAULT_FILTERS = {
  named:      false,   // filter to climbs with route_name only
  groupBy:    "date",  // "date" | "name" | "grade"
  discipline: "all",   // "all" | "boulder" | "lead"
  venue:      "all",   // "all" | "indoor" | "outdoor"
  wall:       "all",   // "all" | "moonboard" | "kilter"
  gradeMin:   null,    // grade string (e.g. "V4" / "5.10c") or null
  gradeMax:   null,    // grade string or null
};

// Migrate older LS shapes to the current (named-as-filter + groupBy)
// model. Two prior versions exist in the wild:
//   v1: { named: true/false } with no groupBy — Named was the only
//       grouping concept. Map: groupBy = name when named, else date.
//   v2: { groupBy: "named" } — the intermediate combined version
//       where Named bundled filter + group. Map: split into
//       named=true + groupBy="name".
// Idempotent; current-shape entries pass through.
function migrateFilters(stored) {
  if (!stored || typeof stored !== "object") return DEFAULT_FILTERS;
  const out = { ...DEFAULT_FILTERS, ...stored };
  // v2 → current
  if (stored.groupBy === "named") {
    out.named = true;
    out.groupBy = "name";
  }
  // v1 → current (only triggers when groupBy isn't set at all)
  if (!stored.groupBy && stored.named !== undefined) {
    out.named = !!stored.named;
    out.groupBy = stored.named ? "name" : "date";
  }
  out.named = !!out.named;
  return out;
}

export function ClimbingHistoryList({
  climbs,
  onDeleteActivity = null,
  onUpdateActivity = null,
}) {
  const [editingId, setEditingId] = useState(null);

  // ── Filter state (persisted) ────────────────────────────────
  const [filters, setFiltersState] = useState(() => {
    return migrateFilters(loadLS(LS_CLIMBING_HISTORY_FILTERS_KEY));
  });
  const updateFilters = (next) => {
    setFiltersState(next);
    saveLS(LS_CLIMBING_HISTORY_FILTERS_KEY, next);
  };
  // Pick handler for the pill row. Three kinds of controls:
  //   - groupBy: tap a sort pill to select that grouping; tapping
  //     the active one resets to "date" so the user can always get
  //     back to the default with one tap.
  //   - named: pure toggle (it's a filter now, no longer a grouping).
  //   - everything else (discipline / venue / wall): single-select
  //     per category with tap-to-deselect.
  const pickFilter = (key, value) => {
    if (key === "groupBy") {
      const next = (filters.groupBy === value) ? "date" : value;
      updateFilters({ ...filters, groupBy: next });
      return;
    }
    if (key === "named") {
      updateFilters({ ...filters, named: !filters.named });
      return;
    }
    const next = (filters[key] === value) ? "all" : value;
    updateFilters({ ...filters, [key]: next });
  };
  // Grade range pickers (min/max) only show meaningful values when a
  // single discipline is selected — the V and YDS scales can't share a
  // dropdown. The picker callbacks accept null to clear.
  const setGradeMin = (g) => updateFilters({ ...filters, gradeMin: g || null });
  const setGradeMax = (g) => updateFilters({ ...filters, gradeMax: g || null });

  // Wall pills only make sense for indoor boulder (or "all venues"
  // boulder). Hide the row when not applicable; auto-clear any
  // stale wall selection so it doesn't silently exclude data.
  const wallPillsVisible =
    (filters.discipline === "boulder" || filters.discipline === "all")
    && filters.venue !== "outdoor";
  useEffect(() => {
    if (!wallPillsVisible && filters.wall !== "all") {
      updateFilters({ ...filters, wall: "all" });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallPillsVisible]);

  // Grade range picker only shows when a single discipline is picked;
  // when discipline flips, the prior range may be on the wrong scale
  // (V vs YDS). Auto-clear so a stale range can't silently exclude.
  useEffect(() => {
    if (filters.discipline === "all" && (filters.gradeMin || filters.gradeMax)) {
      updateFilters({ ...filters, gradeMin: null, gradeMax: null });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.discipline]);

  // ── Apply filters ───────────────────────────────────────────
  const minRank = filters.gradeMin ? gradeRank(filters.gradeMin) : null;
  const maxRank = filters.gradeMax ? gradeRank(filters.gradeMax) : null;
  const filtered = useMemo(() => {
    return climbs.filter(c => {
      if (filters.named && !c.route_name) return false;
      if (filters.discipline !== "all" && c.discipline !== filters.discipline) return false;
      if (filters.venue !== "all") {
        const v = c.venue || "indoor";  // legacy fallback
        if (v !== filters.venue) return false;
      }
      if (filters.wall !== "all" && c.wall !== filters.wall) return false;
      // Grade range applies only when both ends are on the same scale
      // as the climb — guard via discipline match above (range only
      // settable when a single discipline is picked, so c.discipline
      // matches if we got this far).
      if (minRank != null || maxRank != null) {
        const r = gradeRank(c.grade);
        if (!Number.isFinite(r)) return false;
        if (minRank != null && r < minRank) return false;
        if (maxRank != null && r > maxRank) return false;
      }
      return true;
    });
  }, [climbs, filters, minRank, maxRank]);

  // ── Group: by date (default), name, or grade ──
  // Date mode: one card per date, descending.
  // Name mode: one card per route_name, alphabetical. Unnamed climbs
  //   (route_name === "") collapse into a single '—' card.
  // Grade mode: one card per grade, hardest-first (rank desc).
  // Within each non-date card, sends are listed date-descending.
  const grouped = useMemo(() => {
    const m = new Map();
    if (filters.groupBy === "name") {
      for (const c of filtered) {
        const key = c.route_name || "—";
        if (!m.has(key)) m.set(key, []);
        m.get(key).push(c);
      }
      for (const arr of m.values()) {
        arr.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      }
      // Alphabetical across cards; push the '—' (unnamed) bucket to
      // the bottom so it doesn't dominate the top of the list.
      return [...m.entries()].sort((a, b) => {
        if (a[0] === "—") return 1;
        if (b[0] === "—") return -1;
        return a[0].localeCompare(b[0]);
      });
    }
    if (filters.groupBy === "grade") {
      for (const c of filtered) {
        const key = c.grade || "—";
        if (!m.has(key)) m.set(key, []);
        m.get(key).push(c);
      }
      for (const arr of m.values()) {
        arr.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      }
      // Sort groups by grade rank descending (hardest first). Unknown
      // grades drop to the bottom via the -1 rank fallback.
      return [...m.entries()].sort((a, b) => {
        const ra = gradeRank(a[0]);
        const rb = gradeRank(b[0]);
        return rb - ra;
      });
    }
    // Default: date.
    for (const c of filtered) {
      const key = c.date || "—";
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(c);
    }
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [filtered, filters.groupBy]);

  return (
    <div>
      <FilterPills
        filters={filters}
        onPick={pickFilter}
        wallVisible={wallPillsVisible}
        onSetGradeMin={setGradeMin}
        onSetGradeMax={setGradeMax}
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
              {filters.groupBy === "name" && (
                <span><b style={{ color: C.text }}>{groupKey}</b> · {list.length} send{list.length === 1 ? "" : "s"}</span>
              )}
              {filters.groupBy === "grade" && (
                <span><b style={{ color: C.text }}>{groupKey}</b> · {list.length} climb{list.length === 1 ? "" : "s"}</span>
              )}
              {filters.groupBy === "date" && (
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
                  // Show the date inline whenever date isn't the
                  // grouping key (name + grade modes both need it).
                  showDate={filters.groupBy !== "date"}
                  // Only suppress route_name in name mode (it's the
                  // card header there); keep it visible in grade mode.
                  hideRouteName={filters.groupBy === "name"}
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
// FilterPills — pill row + optional grade-range picker
// ─────────────────────────────────────────────────────────────
// Top Rope and Commercial-wall are intentionally omitted from the
// pill set — they're the "unnamed default" the user typically climbs
// and don't need their own filter. With everything deselected, the
// list shows the full unfiltered set, so top_rope and commercial
// climbs are still visible by default.
//
// Group pills (Named, Grade) sit in their own visual cluster at the
// start of the row so they read as "view mode" toggles distinct from
// the "what's in scope" filter pills that follow.
//
// The min/max grade-range pickers appear below the pills when
// discipline is locked to a single value — V grades when boulder is
// active, YDS grades when lead is. When discipline = "all" the
// picker hides (the two scales can't share a dropdown sensibly).
function FilterPills({
  filters, onPick, wallVisible,
  onSetGradeMin, onSetGradeMax,
  totalClimbs, filteredCount,
}) {
  const pill = (label, key, value) => {
    const active = key === "groupBy"
      ? filters.groupBy === value
      : key === "named"
        ? !!filters.named
        : filters[key] === value;
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

  // Grade range picker is only meaningful for a single discipline.
  const gradeRangeVisible = filters.discipline !== "all";
  const gradeList = filters.discipline === "boulder" ? V_GRADES : YDS_GRADES;
  const selectStyle = {
    padding: "3px 6px", borderRadius: 6, fontSize: 11,
    background: C.bg, color: C.text, border: `1px solid ${C.border}`,
    cursor: "pointer",
  };

  // Suffix tail line: shows N of M and a hint of the active grouping.
  const groupingHint = filters.groupBy === "name"
    ? " · grouped by name"
    : filters.groupBy === "grade"
      ? " · grouped by grade (hardest first)"
      : "";

  return (
    <Card style={{ marginBottom: 12 }}>
      {/* Filter pills row (additive). Named is a pure filter — tapping
          it just toggles 'only show climbs with a route_name'. */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
        {pill("Named", "named", true)}
        <span style={{ width: 6 }} />
        {/* Discipline pills — driven by CLIMB_DISCIPLINES so every
            logged discipline (boulder / top rope / lead) gets a filter.
            Previously hardcoded to Boulder/Lead, which silently dropped
            Top rope from the filter row even though it's loggable. */}
        {CLIMB_DISCIPLINES.map(d => pill(d.label, "discipline", d.key))}
        <span style={{ width: 6 }} />
        {pill("Indoor",  "venue", "indoor")}
        {pill("Outdoor", "venue", "outdoor")}
        {wallVisible && <>
          <span style={{ width: 6 }} />
          {pill("MoonBoard", "wall", "moonboard")}
          {pill("Kilter",    "wall", "kilter")}
        </>}
      </div>

      {/* Sort selector — independent from the filters above. Default
          is Date; tap Name or Grade to switch grouping. Tapping the
          active pill resets to Date. This lets the user combine
          'Named filter + Grade grouping' or any other pair. */}
      <div style={{
        display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center",
        marginTop: 8, fontSize: 11, color: C.muted,
      }}>
        <span>Sort:</span>
        {pill("Date",  "groupBy", "date")}
        {pill("Name",  "groupBy", "name")}
        {pill("Grade", "groupBy", "grade")}
      </div>

      {gradeRangeVisible && (
        <div style={{
          display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center",
          marginTop: 8, fontSize: 11, color: C.muted,
        }}>
          <span>Grades:</span>
          <select
            value={filters.gradeMin || ""}
            onChange={(e) => onSetGradeMin(e.target.value)}
            style={selectStyle}
            title="Hide climbs softer than this grade. Leave blank for no lower bound."
          >
            <option value="">min</option>
            {gradeList.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
          <span>to</span>
          <select
            value={filters.gradeMax || ""}
            onChange={(e) => onSetGradeMax(e.target.value)}
            style={selectStyle}
            title="Hide climbs harder than this grade. Leave blank for no upper bound."
          >
            <option value="">max</option>
            {gradeList.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
        </div>
      )}

      <div style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>
        {filteredCount} of {totalClimbs} climb{totalClimbs === 1 ? "" : "s"}{groupingHint}
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
  // Optional star rating + notes — render only when set so blank
  // climbs stay visually compact.
  const stars = Number.isFinite(c.stars) && c.stars >= 1 && c.stars <= 5 ? c.stars : 0;
  const notes = typeof c.notes === "string" && c.notes.trim().length > 0 ? c.notes.trim() : null;

  return (
    <div style={{
      display: "flex", alignItems: "flex-start", gap: 10,
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
          {stars > 0 && (
            <span style={{ marginLeft: 6, color: C.orange, fontSize: 12, letterSpacing: 1 }}
                  title={`Quality: ${stars}/5`}>
              {"★".repeat(stars)}
            </span>
          )}
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
        {notes && (
          <div style={{
            fontSize: 11, color: C.muted, marginTop: 4, lineHeight: 1.4,
            fontStyle: "italic", whiteSpace: "pre-wrap",
          }}>
            {notes}
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
  // Quality + notes parity with ClimbingLogCard. 0 = unset; only 1-5
  // round-trip to the DB. Notes trim on save and clear (null) when
  // emptied so deletes propagate.
  const [stars,      setStars]      = useState(
    Number.isFinite(climb.stars) && climb.stars >= 1 && climb.stars <= 5 ? climb.stars : 0
  );
  const [notes,      setNotes]      = useState(climb.notes || "");

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
    // Stars + notes — null on either edge so the DB column clears
    // properly when the user reduces a rated climb back to 0 or
    // wipes the notes field.
    updates.stars = stars >= 1 && stars <= 5 ? stars : null;
    updates.notes = notes.trim() || null;
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

      {/* RPE — per-climb effort, matching ClimbingLogCard's label
          so the create + edit flows agree on what this number means. */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
        {sectionLabel("Climb Effort (RPE)")}
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

      {/* Quality — same 5-star picker as ClimbingLogCard. Tap a star
          to set; tap it again to clear back to 0 = unset. */}
      {sectionLabel("Quality (optional)")}
      <div style={{ display: "flex", gap: 4, marginBottom: 12, alignItems: "center" }}>
        {[1, 2, 3, 4, 5].map(n => (
          <button
            key={n}
            type="button"
            onClick={() => setStars(stars === n ? 0 : n)}
            aria-label={`${n} star${n > 1 ? "s" : ""}`}
            style={{
              background: "none", border: "none", cursor: "pointer",
              padding: "2px", fontSize: 20, lineHeight: 1,
              color: n <= stars ? C.orange : C.border,
            }}
          >
            {n <= stars ? "★" : "☆"}
          </button>
        ))}
        {stars > 0 && (
          <span style={{ fontSize: 10, color: C.muted, marginLeft: 6 }}>
            {stars}/5
          </span>
        )}
      </div>

      {/* Notes — free text. Trimmed at save; empty clears. */}
      {sectionLabel("Notes (optional)")}
      <textarea
        value={notes}
        onChange={e => setNotes(e.target.value)}
        placeholder="Beta, conditions, what felt good or off…"
        rows={2}
        style={{
          width: "100%", padding: "6px 8px", marginBottom: 12,
          background: C.bg, color: C.text,
          border: `1px solid ${C.border}`, borderRadius: 6,
          fontSize: 12, fontFamily: "inherit", resize: "vertical",
          boxSizing: "border-box",
        }}
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
