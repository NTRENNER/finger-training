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
// credited to Power/Strength/Endurance zone coverage — the climbing
// signal lives in `external_load` in the coaching engine, separate
// from the grip-training zones it stimulates in a finger-specific way.

import React, { useMemo, useState } from "react";
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from "recharts";
import { C } from "../ui/theme.js";
import { Card, Btn, Sect, Label } from "../ui/components.js";
import { today, ymdLocal } from "../util.js";
import {
  CLIMB_DISCIPLINES, ASCENT_STYLES, BOULDER_WALLS,
  gradesFor, defaultGradeFor,
  gradeRank, weekKey,
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
  // Wall surface — boulder only. Defaults to commercial since that's
  // the most common starting point; users on a board re-select.
  const [wall,       setWall]       = useState("commercial");
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
    // Only attach `wall` for boulder; rope routes don't get a wall
    // annotation (and shouldn't carry stale state if the user toggled
    // discipline back and forth).
    const entry = { date: today(), type: "climbing", discipline, grade, ascent };
    if (discipline === "boulder") entry.wall = wall;
    onLog(entry);
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

          {/* Wall surface — boulder only. V4 on a MoonBoard ≠ V4 on
              a commercial set, so we capture the surface alongside
              the grade for honest grade tracking. */}
          {discipline === "boulder" && (
            <>
              <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>Wall</div>
              <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
                {BOULDER_WALLS.map(({ key, label, emoji }) => (
                  <button key={key} onClick={() => setWall(key)} style={{
                    flex: "1 1 30%", padding: "8px 6px", borderRadius: 8, cursor: "pointer",
                    border: wall === key ? `2px solid ${C.blue}` : `1px solid ${C.border}`,
                    background: wall === key ? C.blue + "22" : C.bg,
                    color: C.text, textAlign: "center",
                  }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{emoji} {label}</div>
                  </button>
                ))}
              </div>
            </>
          )}

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

// ─────────────────────────────────────────────────────────────
// CLIMBING TRENDS sub-view
// ─────────────────────────────────────────────────────────────
// Weekly volume (stacked by discipline) + hardest-send line for
// boulder (V-scale) and rope (YDS). Attempts drop off the hardest-
// send line because they aren't sends.
//
// Moved here from the now-gone TrendsView (May 2026) — climbing
// trends live next to the climbing log + history rather than in a
// generic trends container.
function ClimbingTrendsView({ climbs }) {
  // Weekly aggregate: volume by discipline + hardest send per family.
  const weekly = useMemo(() => {
    const weeks = new Map(); // weekKey -> aggregate
    for (const c of climbs) {
      if (!c.date) continue;
      const wk = weekKey(c.date);
      if (!weeks.has(wk)) {
        weeks.set(wk, {
          week: wk,
          boulder: 0, top_rope: 0, lead: 0,
          hardestV: null, hardestYDS: null,
          sends: 0, total: 0,
        });
      }
      const w = weeks.get(wk);
      w.total += 1;
      const isSend = c.ascent && c.ascent !== "attempt";
      if (isSend) w.sends += 1;
      if (c.discipline === "boulder")  w.boulder  += 1;
      if (c.discipline === "top_rope") w.top_rope += 1;
      if (c.discipline === "lead")     w.lead     += 1;

      // Only sends count toward the hardest-grade line.
      if (isSend) {
        const rank = gradeRank(c.grade);
        if (c.discipline === "boulder" && rank >= 0) {
          if (w.hardestV == null || rank > w.hardestV.rank) {
            w.hardestV = { rank, label: c.grade };
          }
        } else if ((c.discipline === "top_rope" || c.discipline === "lead") && rank >= 0) {
          if (w.hardestYDS == null || rank > w.hardestYDS.rank) {
            w.hardestYDS = { rank, label: c.grade };
          }
        }
      }
    }
    return [...weeks.values()].sort((a, b) => (a.week < b.week ? -1 : 1));
  }, [climbs]);

  const chart = useMemo(() => weekly.map(w => ({
    week:          w.week,
    boulder:       w.boulder,
    top_rope:      w.top_rope,
    lead:          w.lead,
    hardestV:      w.hardestV?.rank ?? null,
    hardestVLbl:   w.hardestV?.label ?? "",
    hardestYDS:    w.hardestYDS?.rank ?? null,
    hardestYDSLbl: w.hardestYDS?.label ?? "",
    sendRate:      w.total > 0 ? Math.round((w.sends / w.total) * 100) : 0,
  })), [weekly]);

  const totals = useMemo(() => {
    const sends = climbs.filter(c => c.ascent && c.ascent !== "attempt");
    const maxV   = sends
      .filter(c => c.discipline === "boulder")
      .map(c => ({ rank: gradeRank(c.grade), label: c.grade }))
      .filter(x => x.rank >= 0)
      .sort((a, b) => b.rank - a.rank)[0];
    const maxYDS = sends
      .filter(c => c.discipline === "top_rope" || c.discipline === "lead")
      .map(c => ({ rank: gradeRank(c.grade), label: c.grade }))
      .filter(x => x.rank >= 0)
      .sort((a, b) => b.rank - a.rank)[0];
    return { total: climbs.length, sends: sends.length, maxV, maxYDS };
  }, [climbs]);

  if (climbs.length === 0) return null;

  return (
    <div>
      <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <Card style={{ flex: "1 1 120px" }}>
          <Label>Total climbs</Label>
          <div style={{ fontSize: 22, fontWeight: 800 }}>{totals.total}</div>
          <div style={{ fontSize: 11, color: C.muted }}>{totals.sends} sends</div>
        </Card>
        {totals.maxV && (
          <Card style={{ flex: "1 1 120px" }}>
            <Label>Hardest boulder</Label>
            <div style={{ fontSize: 22, fontWeight: 800, color: C.orange }}>{totals.maxV.label}</div>
            <div style={{ fontSize: 11, color: C.muted }}>send PR</div>
          </Card>
        )}
        {totals.maxYDS && (
          <Card style={{ flex: "1 1 120px" }}>
            <Label>Hardest rope</Label>
            <div style={{ fontSize: 22, fontWeight: 800, color: C.blue }}>{totals.maxYDS.label}</div>
            <div style={{ fontSize: 11, color: C.muted }}>send PR</div>
          </Card>
        )}
      </div>

      <Card>
        <div style={{ fontSize: 13, color: C.muted, marginBottom: 10 }}>Weekly volume by discipline</div>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={chart}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
            <XAxis dataKey="week" tick={{ fill: C.muted, fontSize: 10 }} />
            <YAxis tick={{ fill: C.muted, fontSize: 11 }} allowDecimals={false} />
            <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, color: C.text }} />
            <Legend wrapperStyle={{ fontSize: 11, color: C.muted }} />
            <Bar dataKey="boulder"  stackId="v" name="Boulder"  fill={C.orange} />
            <Bar dataKey="lead"     stackId="v" name="Lead"     fill={C.purple} />
            <Bar dataKey="top_rope" stackId="v" name="Top rope" fill={C.blue}   />
          </BarChart>
        </ResponsiveContainer>
      </Card>

      <Card>
        <div style={{ fontSize: 13, color: C.muted, marginBottom: 10 }}>Hardest send per week</div>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={chart}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
            <XAxis dataKey="week" tick={{ fill: C.muted, fontSize: 10 }} />
            <YAxis
              yAxisId="v"
              orientation="left"
              tick={{ fill: C.orange, fontSize: 11 }}
              tickFormatter={(v) => v == null ? "" : `V${v}`}
              domain={["auto", "auto"]}
            />
            <YAxis
              yAxisId="yds"
              orientation="right"
              tick={{ fill: C.blue, fontSize: 11 }}
              tickFormatter={(v) => {
                if (v == null) return "";
                const n    = Math.floor(v);
                const frac = v - n;
                const sub  = ["a", "b", "c", "d"][Math.round(frac * 4)] || "";
                return `5.${n}${sub}`;
              }}
              domain={["auto", "auto"]}
            />
            <Tooltip
              contentStyle={{ background: C.card, border: `1px solid ${C.border}`, color: C.text }}
              formatter={(val, name, entry) => {
                if (name === "Boulder") return [entry.payload.hardestVLbl || "—", name];
                if (name === "Rope")    return [entry.payload.hardestYDSLbl || "—", name];
                return [val, name];
              }}
            />
            <Legend wrapperStyle={{ fontSize: 11, color: C.muted }} />
            <Line
              yAxisId="v"
              type="monotone"
              dataKey="hardestV"
              stroke={C.orange}
              strokeWidth={2}
              name="Boulder"
              connectNulls
              dot={{ r: 4, fill: C.orange }}
            />
            <Line
              yAxisId="yds"
              type="monotone"
              dataKey="hardestYDS"
              stroke={C.blue}
              strokeWidth={2}
              name="Rope"
              connectNulls
              dot={{ r: 4, fill: C.blue }}
            />
          </LineChart>
        </ResponsiveContainer>
      </Card>
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

      {climbs.length > 0 && (
        <Sect title="Trends">
          <ClimbingTrendsView climbs={climbs} />
        </Sect>
      )}

      <Sect title="History">
        <ClimbingHistoryList climbs={climbs} onDeleteActivity={onDeleteActivity} />
      </Sect>
    </div>
  );
}
