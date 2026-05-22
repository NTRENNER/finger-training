// ─────────────────────────────────────────────────────────────
// CLIMBING LOG CARD — single-card climb logger
// ─────────────────────────────────────────────────────────────
// One climbing entry's worth of data: discipline + venue + grade +
// ascent style + wall (boulder-only) + RPE, plus outdoor-only route
// metadata (route name / cliff / area). Collapses to a one-row
// tappable button when not in use; expands inline with the full
// form on tap. Saves via the onLog callback handed in by the
// caller; doesn't touch storage or sync itself.
//
// Lives in src/views/cards/ rather than next to SetupView because
// it's a self-contained card component with no SetupView-specific
// state — the parent just passes activities + onLog. Extracted
// from SetupView May 2026 to shorten the parent file; the render
// site on Setup is unchanged.
//
// RPE is captured here (vs Activity-Setup at session start) because
// it's part of the climbing entry itself — the lockout system reads
// it as a climbing-dose signal for staleness boost in the coaching
// engine.

import React, { useState } from "react";
import { C } from "../../ui/theme.js";
import { Card, Btn } from "../../ui/components.js";
import { today } from "../../util.js";
import {
  CLIMB_DISCIPLINES, ASCENT_STYLES, BOULDER_WALLS, VENUES,
  gradesFor, defaultGradeFor,
} from "../../lib/climbing-grades.js";

// Per-RPE descriptive label rendered under the slider. Helps the
// user calibrate "what does an 8 actually mean" without leaving
// the form.
const RPE_DESCRIPTIONS = {
  1:  "Very easy — barely a workout",
  2:  "Easy — recovery-level",
  3:  "Light — warm-up intensity",
  4:  "Moderate — comfortable training",
  5:  "Hard — focused training day",
  6:  "Hard+ — pushing into fatigue",
  7:  "Very hard — strong session",
  8:  "Very hard+ — limit attempts",
  9:  "Near maximum — couldn't have done much more",
  10: "Maximum — true RPE 10, full effort",
};

export function ClimbingLogCard({ activities = [], onLog }) {
  const [open, setOpen]             = useState(false);
  const [discipline, setDiscipline] = useState("boulder");
  const [venue, setVenue]           = useState("indoor");
  const [grade, setGrade]           = useState(defaultGradeFor("boulder"));
  const [ascent, setAscent]         = useState("flash");
  const [wall, setWall]             = useState("commercial");
  const [rpe, setRpe]               = useState(7);
  const [logged, setLogged]         = useState(false);
  // Outdoor-only metadata. Free text, all optional. Cleared after
  // save so the next outdoor log starts blank rather than pre-
  // populated with the previous climb's route name (which would
  // produce weird duplicates if the user logged two climbs in a
  // row at the same crag without re-typing).
  const [routeName, setRouteName] = useState("");
  const [crag,      setCrag]      = useState("");
  const [area,      setArea]      = useState("");

  const todayClimbing = activities.filter(a => a.date === today() && a.type === "climbing");

  const handleDiscipline = (key) => {
    setDiscipline(key);
    // Reset grade to the new default so we never end up with a V-grade
    // on a lead route or vice versa.
    const valid = gradesFor(key);
    if (!valid.includes(grade)) setGrade(defaultGradeFor(key));
  };

  // Wall surface only applies to indoor boulders. Commercial sets,
  // MoonBoards, and Kilters are all gym walls; outdoor boulders are
  // real rock with no comparable categorisation.
  const showWall = venue === "indoor" && discipline === "boulder";
  // Route/crag/area only meaningful outdoors. Gyms have named
  // routes too, but their nomenclature changes every set so logging
  // them rarely pays off; the field cluster stays outdoor-gated.
  const showOutdoorMeta = venue === "outdoor";

  const handleSave = () => {
    const entry = {
      date: today(), type: "climbing",
      discipline, venue, grade, ascent, rpe,
    };
    if (showWall) entry.wall = wall;
    if (showOutdoorMeta) {
      // Trim and drop empties so we don't write whitespace-only
      // values that look like data but break sort/filter.
      const rn = routeName.trim();
      const cr = crag.trim();
      const ar = area.trim();
      if (rn) entry.route_name = rn;
      if (cr) entry.crag       = cr;
      if (ar) entry.area       = ar;
    }
    onLog(entry);
    setLogged(true);
    setOpen(false);
    // Reset outdoor fields so the next log isn't pre-populated.
    setRouteName(""); setCrag(""); setArea("");
    setTimeout(() => setLogged(false), 2500);
  };

  // Collapsed state — single-row tappable button.
  if (!open) {
    return (
      <Card style={{
        marginBottom: 16,
        padding: 0,
        background: logged ? `${C.green}1a` : C.card,
        border: `1px solid ${logged ? C.green : C.border}`,
        transition: "all 0.2s",
      }}>
        <button
          onClick={() => setOpen(true)}
          style={{
            width: "100%", padding: "12px 16px", background: "none", border: "none",
            cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between",
            color: C.text, fontSize: 13, fontWeight: 600,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16 }}>🧗</span>
            <span>{logged ? "Logged ✓" : "Log a climb"}</span>
          </div>
          <div style={{ fontSize: 11, color: C.muted, fontWeight: 400 }}>
            {todayClimbing.length > 0
              ? `${todayClimbing.length} logged today · tap to add another`
              : "discipline · grade · style · effort"}
          </div>
        </button>
      </Card>
    );
  }

  // Expanded form
  return (
    <Card style={{ marginBottom: 16, border: `1px solid ${C.purple}40` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>🧗 Log Climb</div>
        <button
          onClick={() => setOpen(false)}
          style={{
            background: "none", border: "none", color: C.muted,
            cursor: "pointer", fontSize: 12, padding: 0,
          }}
        >
          Cancel
        </button>
      </div>

      {/* Discipline */}
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>
        Discipline
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
        {CLIMB_DISCIPLINES.map(({ key, label, emoji }) => (
          <button
            key={key}
            onClick={() => handleDiscipline(key)}
            style={{
              flex: "1 1 30%", padding: "8px 4px", borderRadius: 8, cursor: "pointer",
              background: discipline === key ? C.purple : C.bg,
              color: discipline === key ? "#fff" : C.muted,
              border: `1px solid ${discipline === key ? C.purple : C.border}`,
              fontSize: 12, fontWeight: 600, textAlign: "center",
            }}
          >
            <div style={{ fontSize: 14 }}>{emoji}</div>
            <div style={{ marginTop: 2 }}>{label}</div>
          </button>
        ))}
      </div>

      {/* Venue — orthogonal to discipline. A 5.10c onsight at the local
          crag is meaningfully different data from a 5.10c onsight in
          the gym (route-reading, exposure, gear, rock quality). */}
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>
        Venue
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
        {VENUES.map(({ key, label, emoji }) => (
          <button
            key={key}
            onClick={() => setVenue(key)}
            style={{
              flex: "1 1 45%", padding: "8px 4px", borderRadius: 8, cursor: "pointer",
              background: venue === key ? C.purple : C.bg,
              color: venue === key ? "#fff" : C.muted,
              border: `1px solid ${venue === key ? C.purple : C.border}`,
              fontSize: 12, fontWeight: 600, textAlign: "center",
            }}
          >
            <div style={{ fontSize: 14 }}>{emoji}</div>
            <div style={{ marginTop: 2 }}>{label}</div>
          </button>
        ))}
      </div>

      {/* Outdoor route metadata — only shown when venue=outdoor.
          Three free-text inputs (route name, cliff/crag, area) so a
          send at "Y-12 · Obed · The Journey" stays searchable later.
          All optional — leaving blank just records the climb without
          the location detail. */}
      {showOutdoorMeta && (() => {
        const inputStyle = {
          width: "100%", padding: "8px 10px", borderRadius: 8,
          background: C.bg, color: C.text, border: `1px solid ${C.border}`,
          fontSize: 13, marginBottom: 8,
        };
        return (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>
              Route (optional)
            </div>
            <input type="text" placeholder="Route name (e.g. The Journey)"
              value={routeName} onChange={e => setRouteName(e.target.value)}
              style={inputStyle} />
            <input type="text" placeholder="Cliff / crag (e.g. Y-12)"
              value={crag} onChange={e => setCrag(e.target.value)}
              style={inputStyle} />
            <input type="text" placeholder="Area (e.g. Obed)"
              value={area} onChange={e => setArea(e.target.value)}
              style={{ ...inputStyle, marginBottom: 0 }} />
          </div>
        );
      })()}

      {/* Wall surface — indoor boulder only. V4 on a MoonBoard ≠ V4 on
          a commercial set. Outdoor boulders are real rock with no
          comparable surface categorisation, so the picker hides. */}
      {showWall && (
        <>
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>
            Wall
          </div>
          <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
            {BOULDER_WALLS.map(({ key, label, emoji }) => (
              <button
                key={key}
                onClick={() => setWall(key)}
                style={{
                  flex: "1 1 30%", padding: "8px 4px", borderRadius: 8, cursor: "pointer",
                  background: wall === key ? C.purple : C.bg,
                  color: wall === key ? "#fff" : C.muted,
                  border: `1px solid ${wall === key ? C.purple : C.border}`,
                  fontSize: 12, fontWeight: 600, textAlign: "center",
                }}
              >
                <div style={{ fontSize: 14 }}>{emoji}</div>
                <div style={{ marginTop: 2 }}>{label}</div>
              </button>
            ))}
          </div>
        </>
      )}

      {/* Grade */}
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>
        Grade ({discipline === "boulder" ? "V-scale" : "YDS"})
      </div>
      <select
        value={grade}
        onChange={(e) => setGrade(e.target.value)}
        style={{
          width: "100%", padding: "8px 10px", marginBottom: 14, borderRadius: 8,
          background: C.bg, color: C.text, border: `1px solid ${C.border}`, fontSize: 13,
        }}
      >
        {gradesFor(discipline).map(g => (
          <option key={g} value={g}>{g}</option>
        ))}
      </select>

      {/* Ascent style */}
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>
        Ascent
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
        {ASCENT_STYLES.map(({ key, label, desc }) => (
          <button
            key={key}
            onClick={() => setAscent(key)}
            style={{
              flex: "1 1 40%", padding: "8px 6px", borderRadius: 8, cursor: "pointer",
              background: ascent === key ? C.purple : C.bg,
              color: ascent === key ? "#fff" : C.muted,
              border: `1px solid ${ascent === key ? C.purple : C.border}`,
              fontSize: 12, fontWeight: 600, textAlign: "left",
            }}
          >
            <div style={{ fontSize: 13 }}>{label}</div>
            <div style={{ fontSize: 10, color: ascent === key ? "#fff" : C.muted, opacity: 0.85 }}>{desc}</div>
          </button>
        ))}
      </div>

      {/* RPE */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
        <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5 }}>
          Effort (RPE)
        </div>
        <div style={{ fontSize: 22, fontWeight: 800, color: C.purple }}>
          {rpe}<span style={{ fontSize: 12, color: C.muted, fontWeight: 400 }}>/10</span>
        </div>
      </div>
      <input
        type="range"
        min="1" max="10" step="1"
        value={rpe}
        onChange={(e) => setRpe(Number(e.target.value))}
        style={{ width: "100%", accentColor: C.purple }}
      />
      <div style={{
        fontSize: 11, color: C.muted, marginTop: 6, marginBottom: 14, lineHeight: 1.4,
        minHeight: "1.4em",
      }}>
        {RPE_DESCRIPTIONS[rpe]}
      </div>

      <Btn onClick={handleSave} color={C.green} style={{ width: "100%" }}>
        Log Climb
      </Btn>
    </Card>
  );
}
