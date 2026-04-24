// ─────────────────────────────────────────────────────────────
// CLIMBING TAB
// ─────────────────────────────────────────────────────────────
// Top-level "Climbing" tab — three sections stacked vertically:
//
//   1. Log a climb — collapsible widget that captures one entry
//      (discipline / grade / ascent style). Auto-resets the grade
//      picker to the new discipline's default when discipline
//      changes so we never end up with a V-grade on a lead route.
//   2. Last 30 days — quick stats card (total climbs, sends,
//      attempts, breakdown by discipline).
//   3. History — full date-grouped list via ClimbingHistoryList.
//
// Climbing is tracked for readiness/context but is intentionally NOT
// credited to Power/Strength/Capacity zone coverage — the climbing
// signal lives in `external_load` in the coaching engine, separate
// from the grip-training zones it stimulates in a finger-specific way.

import React, { useMemo, useState } from "react";
import { C } from "../ui/theme.js";
import { Card, Btn, Sect } from "../ui/components.js";
import { today, ymdLocal } from "../util.js";
import {
  CLIMB_DISCIPLINES, ASCENT_STYLES,
  gradesFor, defaultGradeFor,
} from "../lib/climbing-grades.js";
import { ClimbingHistoryList } from "./ClimbingHistoryList.js";

// ─────────────────────────────────────────────────────────────
// Climb-log widget — collapsed pill that expands into a single
// climb entry form. Used inside ClimbingTab; not exported because
// no other view needs to render an entry form.
// ─────────────────────────────────────────────────────────────
function ClimbingLogWidget({ activities = [], onLog = () => {} }) {
  const [open,       setOpen]       = useState(false);
  const [discipline, setDiscipline] = useState("boulder");
  const [grade,      setGrade]      = useState(defaultGradeFor("boulder"));
  const [ascent,     setAscent]     = useState("flash");
  const [logged,     setLogged]     = useState(false);

  const todayActivities = activities.filter(a => a.date === today() && a.type === "climbing");
  const hasToday        = todayActivities.length > 0;

  const handleDiscipline = (key) => {
    setDiscipline(key);
    // If switching grading systems, reset grade to the new default so
    // we never end up with a V-grade on a lead route or vice versa.
    const valid = gradesFor(key);
    if (!valid.includes(grade)) setGrade(defaultGradeFor(key));
  };

  const handleLog = () => {
    onLog({ date: today(), type: "climbing", discipline, grade, ascent });
    setLogged(true);
    setTimeout(() => setLogged(false), 3000);
  };

  return (
    <div style={{ marginBottom: 16 }}>
      {/* Collapsed row */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          style={{
            width: "100%", padding: "10px 16px", borderRadius: 10, cursor: "pointer",
            background: C.card, border: `1px solid ${C.border}`,
            display: "flex", alignItems: "center", justifyContent: "space-between",
            color: C.text, fontSize: 13,
          }}
        >
          <span>
            🧗 {hasToday
              ? `${todayActivities.length} climb${todayActivities.length === 1 ? "" : "s"} logged today`
              : logged ? "✓ Climb logged!" : "Log a climb"}
          </span>
          <span style={{ fontSize: 11, color: C.muted }}>discipline · grade · style</span>
        </button>
      )}

      {/* Expanded form */}
      {open && (
        <Card style={{ border: `1px solid ${C.blue}40` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>🧗 Log Climb</div>
            <button onClick={() => setOpen(false)} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 18, lineHeight: 1 }}>×</button>
          </div>

          {/* Discipline picker */}
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>Discipline</div>
          <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
            {CLIMB_DISCIPLINES.map(({ key, label, emoji }) => (
              <button key={key} onClick={() => handleDiscipline(key)} style={{
                flex: "1 1 30%", padding: "8px 6px", borderRadius: 8, cursor: "pointer",
                border: discipline === key ? `2px solid ${C.blue}` : `1px solid ${C.border}`,
                background: discipline === key ? C.blue + "22" : C.bg,
                color: C.text, textAlign: "center",
              }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{emoji} {label}</div>
              </button>
            ))}
          </div>

          {/* Grade picker (V for boulder, YDS for TR/lead) */}
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>
            Grade ({discipline === "boulder" ? "V-scale" : "YDS"})
          </div>
          <select
            value={grade}
            onChange={(e) => setGrade(e.target.value)}
            style={{
              width: "100%", padding: "8px 10px", marginBottom: 14, borderRadius: 8,
              background: C.bg, color: C.text, border: `1px solid ${C.border}`,
              fontSize: 13,
            }}
          >
            {gradesFor(discipline).map(g => (
              <option key={g} value={g}>{g}</option>
            ))}
          </select>

          {/* Ascent style */}
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>Ascent</div>
          <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
            {ASCENT_STYLES.map(({ key, label, desc }) => (
              <button key={key} onClick={() => setAscent(key)} style={{
                flex: "1 1 40%", padding: "8px 6px", borderRadius: 8, cursor: "pointer",
                border: ascent === key ? `2px solid ${C.blue}` : `1px solid ${C.border}`,
                background: ascent === key ? C.blue + "22" : C.bg,
                color: C.text, textAlign: "left",
              }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{label}</div>
                <div style={{ fontSize: 10, color: C.muted }}>{desc}</div>
              </button>
            ))}
          </div>

          <Btn onClick={handleLog} color={C.blue} style={{ width: "100%", padding: "10px 0", borderRadius: 8 }}>
            Log Climb
          </Btn>
        </Card>
      )}
    </div>
  );
}

export function ClimbingTab({ activities = [], onLogActivity = () => {}, onDeleteActivity = () => {} }) {
  const climbs = useMemo(
    () => activities
      .filter(a => a.type === "climbing")
      .slice()
      .sort((a, b) => (b.date || "").localeCompare(a.date || "")),
    [activities]
  );

  // Quick stats (last 30 days)
  const stats = useMemo(() => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const cutoffStr = ymdLocal(cutoff);
    const recent = climbs.filter(c => (c.date || "") >= cutoffStr);
    const sends  = recent.filter(c => c.ascent && c.ascent !== "attempt");
    return {
      total:  recent.length,
      sends:  sends.length,
      byDisc: CLIMB_DISCIPLINES.map(d => ({
        ...d,
        count: recent.filter(c => c.discipline === d.key).length,
      })),
    };
  }, [climbs]);

  return (
    <div style={{ padding: "16px 20px", maxWidth: 640, margin: "0 auto" }}>
      <Sect title="Log a climb">
        <ClimbingLogWidget activities={activities} onLog={onLogActivity} />
      </Sect>

      {climbs.length > 0 && (
        <Sect title="Last 30 days">
          <Card>
            <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, color: C.muted }}>Climbs</div>
                <div style={{ fontSize: 22, fontWeight: 700 }}>{stats.total}</div>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, color: C.muted }}>Sends</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: C.green }}>{stats.sends}</div>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, color: C.muted }}>Attempts</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: C.muted }}>
                  {stats.total - stats.sends}
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {stats.byDisc.filter(d => d.count > 0).map(d => (
                <div key={d.key} style={{
                  padding: "4px 10px", borderRadius: 999,
                  background: C.bg, border: `1px solid ${C.border}`,
                  fontSize: 12, color: C.muted,
                }}>
                  {d.emoji} {d.label} · {d.count}
                </div>
              ))}
            </div>
          </Card>
        </Sect>
      )}

      <Sect title="History">
        <ClimbingHistoryList climbs={climbs} onDeleteActivity={onDeleteActivity} />
      </Sect>
    </div>
  );
}
