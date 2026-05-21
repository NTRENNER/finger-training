// ─────────────────────────────────────────────────────────────
// CLIMBING ANALYSIS VIEW
// ─────────────────────────────────────────────────────────────
// Third sibling under the Analysis tab (alongside fingers + lifts).
// Reads the climbing log entries from `activities` (type === "climbing")
// and renders a small set of high-signal cards:
//
//   1. Headline — sessions, sends, weekly volume, average RPE.
//   2. Grade pyramid — clean sends per grade, discipline-filtered,
//      time-window selectable. The card every climber wants.
//   3. Hardest send over time — best clean-send grade per week, one
//      line per discipline. Progression at a glance.
//   4. Ascent style mix — onsight/flash/redpoint/rest/attempt %.
//      Diagnoses style: are you grinding redpoints or onsighting?
//
// Counts only "clean sends" (onsight/flash/redpoint) for the pyramid +
// hardest-send line; "rest" sends and "attempt" entries appear in the
// style-mix card but not in the grade-progression metrics.
//
// No coaching engine attached — climbing analysis is descriptive, not
// prescriptive. The Tindeq side has the model and the prescription
// chain; this view just shows the climber what they've actually done.

import React, { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from "recharts";
import { PyramidChart } from "./cards/PyramidChart.jsx";
import { C } from "../ui/theme.js";
import { Card, Sect } from "../ui/components.js";
import {
  CLIMB_DISCIPLINES, ASCENT_STYLES, BOULDER_WALLS, VENUES,
  V_GRADES, YDS_GRADES,
  gradeRank, weekKey,
  disciplineMeta,
} from "../lib/climbing-grades.js";

// Color per discipline. Boulder = orange (power), top_rope = purple,
// lead = blue (rope-climbing palette). Falls back to muted for unknowns.
const DISCIPLINE_COLORS = {
  boulder:  C.orange,
  top_rope: C.purple,
  lead:     C.blue,
};

// Color per ascent style. Cleanest sends green, redpoint+rest orange,
// attempt red. Matches the mental model "green = success" elsewhere.
const ASCENT_COLORS = {
  onsight:  C.green,
  flash:    C.green,
  redpoint: C.orange,
  rest:     C.yellow,
  attempt:  C.red,
};

// "Clean send" = onsight, flash, or redpoint. Excludes rest (took weight)
// and attempt (didn't send). Used by the pyramid + hardest-send line so
// the progression metrics aren't inflated by working attempts.
const CLEAN_SEND_STYLES = new Set(["onsight", "flash", "redpoint"]);
const isCleanSend = (a) => CLEAN_SEND_STYLES.has(a.ascent);

// Ordered list of clean-send styles for the Max-sends card. Order is
// hardest-style-first (onsight = most impressive, redpoint = gritty
// projecting). Module-level so the maxByStyle useMemo's dep list
// stays stable across renders.
const MAX_STYLES = ["onsight", "flash", "redpoint"];

// "Sent" = clean send OR a completion that took weight. Used by the
// session-volume (v-sum) chart so a session where you actually finished
// every route gets credit even if you took rests; only attempts are
// excluded from volume since by definition you didn't send the route.
const SENT_STYLES = new Set(["onsight", "flash", "redpoint", "rest"]);
const wasSent = (a) => SENT_STYLES.has(a.ascent);

// Time window options for the grade pyramid. "All" is included so a
// new climber with sparse data still sees something useful.
const WINDOWS = [
  { key: "30",  label: "30d", days: 30 },
  { key: "90",  label: "90d", days: 90 },
  { key: "365", label: "1y",  days: 365 },
  { key: "all", label: "All", days: null },
];

// Filter activities to climbing entries within an optional date window.
function clamberFilter(activities, days) {
  const climbs = activities.filter(a => a.type === "climbing");
  if (!days) return climbs;
  const cutoff = new Date(Date.now() - days * 86400_000)
    .toISOString().slice(0, 10);
  return climbs.filter(a => a.date >= cutoff);
}

export function ClimbingAnalysisView({ activities = [] }) {
  const [pyramidDiscipline, setPyramidDiscipline] = useState("boulder");
  const [pyramidVenue,      setPyramidVenue]      = useState("all");  // "all" | "indoor" | "outdoor"
  const [pyramidWall,       setPyramidWall]       = useState("all");  // "all" | "commercial" | "moonboard" | "kilter"
  const [pyramidWindow,     setPyramidWindow]     = useState("90");

  // Wall filter only applies to indoor boulders. For everything else
  // the row hides and the filter auto-resets to "all" so a hidden
  // selection can't silently exclude data.
  const wallFilterActive = pyramidDiscipline === "boulder" && pyramidVenue !== "outdoor";
  useEffect(() => {
    if (!wallFilterActive && pyramidWall !== "all") setPyramidWall("all");
  }, [wallFilterActive, pyramidWall]);

  // ── Max sends card state ────────────────────────────────────
  // Independent filter set from the pyramid (above) so the user can
  // look at "all-time max sends on lead" while the pyramid stays
  // narrowed to "boulder, last 90 days." Default window is "All"
  // because max-grade is naturally a lifetime PR question.
  const [maxDiscipline, setMaxDiscipline] = useState("boulder");
  const [maxVenue,      setMaxVenue]      = useState("all");
  const [maxWall,       setMaxWall]       = useState("all");
  const [maxWindow,     setMaxWindow]     = useState("all");
  const maxWallActive = maxDiscipline === "boulder" && maxVenue !== "outdoor";
  useEffect(() => {
    if (!maxWallActive && maxWall !== "all") setMaxWall("all");
  }, [maxWallActive, maxWall]);

  const allClimbs = useMemo(
    () => activities.filter(a => a.type === "climbing"),
    [activities]
  );

  // ── Headline metrics ──
  // sessions      = distinct dates with at least one climb logged
  // sends         = clean-send count, all-time
  // weeklyVolume  = entries logged in the last 7 days
  // avgRpe30d     = mean RPE over last 30 days (climbs with valid rpe only)
  const headline = useMemo(() => {
    const sessionDates = new Set(allClimbs.map(c => c.date));
    const sends        = allClimbs.filter(isCleanSend).length;
    const last7 = clamberFilter(allClimbs, 7);
    const last30 = clamberFilter(allClimbs, 30);
    const rpes = last30
      .map(c => Number(c.rpe))
      .filter(n => isFinite(n) && n > 0);
    const avgRpe = rpes.length
      ? rpes.reduce((s, x) => s + x, 0) / rpes.length
      : null;
    return {
      sessions:     sessionDates.size,
      sends,
      weeklyVolume: last7.length,
      totalClimbs:  allClimbs.length,
      avgRpe30d:    avgRpe,
      hasData:      allClimbs.length > 0,
    };
  }, [allClimbs]);

  // ── Session volume (v-sum) ──
  // For each session date, sum the grade ranks of all sent climbs (clean
  // send + rest; attempts excluded). Stacked by discipline so a mixed
  // session reads as bands rather than a single number — boulder vs
  // rope contributions are visible at a glance. The "v-sum" name comes
  // from bouldering convention (sum of V-grades) but the math
  // generalises to YDS via gradeRank, so the same chart serves both.
  // Most recent 60 sessions to keep the bar count readable on phones.
  const sessionVolume = useMemo(() => {
    const sent = allClimbs.filter(wasSent);
    if (sent.length === 0) return { rows: [], disciplines: [] };
    // date -> discipline -> v-sum
    const byDate = {};
    const discSet = new Set();
    for (const c of sent) {
      const r = gradeRank(c.grade);
      if (r < 0) continue;
      if (!byDate[c.date]) byDate[c.date] = {};
      const slot = byDate[c.date];
      slot[c.discipline] = (slot[c.discipline] || 0) + r;
      discSet.add(c.discipline);
    }
    const sortedDates = Object.keys(byDate).sort();
    const recent = sortedDates.slice(-60);
    const disciplines = [...discSet];
    const rows = recent.map(date => {
      const row = { date: date.slice(5) };  // MM-DD for axis density
      let total = 0;
      for (const d of disciplines) {
        const v = byDate[date][d] || 0;
        row[d] = v;
        total += v;
      }
      row.__total = total;
      return row;
    });
    return { rows, disciplines };
  }, [allClimbs]);

  // ── Grade pyramid ──
  // Group clean sends by grade for the selected discipline + window
  // + venue + wall. Returns rows ordered easiest→hardest so the bar
  // chart reads as a visual pyramid (lots at the bottom, fewer at the
  // top). Venue/wall default to "all"; legacy entries without a venue
  // field are treated as indoor (the historical default before the
  // venue picker existed) so they still show up under indoor filters.
  const pyramid = useMemo(() => {
    const windowDef = WINDOWS.find(w => w.key === pyramidWindow);
    const climbs = clamberFilter(allClimbs, windowDef.days)
      .filter(c => c.discipline === pyramidDiscipline)
      .filter(c => {
        if (pyramidVenue === "all") return true;
        const v = c.venue || "indoor";  // legacy fallback
        return v === pyramidVenue;
      })
      .filter(c => {
        if (!wallFilterActive || pyramidWall === "all") return true;
        return c.wall === pyramidWall;
      })
      .filter(isCleanSend);
    const counts = {};
    for (const c of climbs) {
      if (!c.grade) continue;
      counts[c.grade] = (counts[c.grade] || 0) + 1;
    }
    const allGrades = pyramidDiscipline === "boulder" ? V_GRADES : YDS_GRADES;
    const rows = allGrades
      .filter(g => counts[g])
      .map(g => ({ grade: g, count: counts[g], rank: gradeRank(g) }))
      .sort((a, b) => a.rank - b.rank);
    return { rows, total: climbs.length };
  }, [allClimbs, pyramidDiscipline, pyramidVenue, pyramidWall, wallFilterActive, pyramidWindow]);

  // ── Max sends by ascent style ──
  // For each clean-send style (onsight / flash / redpoint), find the
  // hardest grade you've achieved within the current filter set and
  // surface it alongside its date and venue/wall context. Lifetime PRs
  // when the window is "All"; window-bounded PRs otherwise. Returns
  // null entries for styles with no qualifying sends so the UI can
  // render placeholder rows rather than dropping them silently.
  const maxByStyle = useMemo(() => {
    const windowDef = WINDOWS.find(w => w.key === maxWindow);
    const filtered = clamberFilter(allClimbs, windowDef.days)
      .filter(c => c.discipline === maxDiscipline)
      .filter(c => {
        if (maxVenue === "all") return true;
        const v = c.venue || "indoor";
        return v === maxVenue;
      })
      .filter(c => {
        if (!maxWallActive || maxWall === "all") return true;
        return c.wall === maxWall;
      });
    const out = {};
    for (const style of MAX_STYLES) {
      const matches = filtered.filter(c => c.ascent === style && c.grade);
      if (matches.length === 0) {
        out[style] = { grade: null, count: 0, date: null, climb: null };
        continue;
      }
      // Pick the climb with the highest gradeRank — ties broken by
      // most recent date so the "when did you do it" caption favors
      // the freshest send.
      const sorted = [...matches].sort((a, b) => {
        const dr = gradeRank(b.grade) - gradeRank(a.grade);
        if (dr !== 0) return dr;
        return (b.date || "").localeCompare(a.date || "");
      });
      const top = sorted[0];
      out[style] = {
        grade: top.grade,
        count: matches.length,
        date: top.date,
        climb: top,
      };
    }
    return out;
  }, [allClimbs, maxDiscipline, maxVenue, maxWall, maxWallActive, maxWindow]);

  // ── Hardest send over time ──
  // For each ISO Monday week-key, find the max grade rank among clean
  // sends in that week, per discipline. Returns a Recharts-shaped row
  // array with one boulder/top_rope/lead column per week.
  const hardestSend = useMemo(() => {
    const cleanSends = allClimbs.filter(isCleanSend);
    if (cleanSends.length === 0) return { rows: [], disciplines: [] };

    // discipline -> week -> { grade, rank }
    const byDisc = {};
    const allWeeks = new Set();
    for (const c of cleanSends) {
      const wk = weekKey(c.date);
      const r  = gradeRank(c.grade);
      if (r < 0) continue;
      allWeeks.add(wk);
      if (!byDisc[c.discipline]) byDisc[c.discipline] = {};
      const cur = byDisc[c.discipline][wk];
      if (!cur || r > cur.rank) {
        byDisc[c.discipline][wk] = { grade: c.grade, rank: r };
      }
    }
    const sortedWeeks = [...allWeeks].sort();
    const disciplines = Object.keys(byDisc);
    const rows = sortedWeeks.map(wk => {
      const row = { week: wk.slice(5) };  // MM-DD
      for (const d of disciplines) {
        const e = byDisc[d][wk];
        row[`${d}_rank`]  = e ? e.rank : null;
        row[`${d}_grade`] = e ? e.grade : null;
      }
      return row;
    });
    return { rows, disciplines };
  }, [allClimbs]);

  // ── Ascent style mix ──
  // Counts per style across all climbs. Returned ordered as the
  // ASCENT_STYLES catalogue (onsight → attempt).
  const styleMix = useMemo(() => {
    const counts = {};
    for (const c of allClimbs) {
      if (!c.ascent) continue;
      counts[c.ascent] = (counts[c.ascent] || 0) + 1;
    }
    const total = allClimbs.length || 1;
    const rows = ASCENT_STYLES
      .filter(s => counts[s.key])
      .map(s => ({
        key: s.key,
        label: s.label,
        count: counts[s.key],
        pct: Math.round((counts[s.key] / total) * 100),
      }));
    return { rows, total: allClimbs.length };
  }, [allClimbs]);

  // ── Empty state ──
  if (!headline.hasData) {
    return (
      <div style={{ padding: "16px 20px", maxWidth: 720, margin: "0 auto" }}>
        <Sect title="Climbing">
          <Card>
            <div style={{ color: C.muted, fontSize: 13, lineHeight: 1.6 }}>
              No climbs logged yet. Use the Log a climb card on the Fingers tab
              to start a record — discipline, grade, ascent style, and RPE.
              Once you have a few entries, this view will fill in with a grade
              pyramid, hardest-send progression, and style mix.
            </div>
          </Card>
        </Sect>
      </div>
    );
  }

  // ── Render ──
  return (
    <div style={{ padding: "16px 20px", maxWidth: 720, margin: "0 auto" }}>
      <Sect title="Climbing">
        {/* Headline metrics */}
        <Card>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <Stat label="Sessions"      value={headline.sessions} />
            <Stat label="Clean sends"   value={headline.sends} />
            <Stat label="Last 7 days"   value={`${headline.weeklyVolume} climb${headline.weeklyVolume === 1 ? "" : "s"}`} />
            <Stat label="Avg RPE (30d)" value={headline.avgRpe30d != null ? headline.avgRpe30d.toFixed(1) : "—"} />
          </div>
          <div style={{ marginTop: 10, fontSize: 11, color: C.muted, lineHeight: 1.5 }}>
            "Clean sends" counts onsight, flash, and redpoint — the route went
            without taking weight. {headline.totalClimbs - headline.sends} entries
            ({headline.totalClimbs > 0 ? Math.round(((headline.totalClimbs - headline.sends) / headline.totalClimbs) * 100) : 0}%)
            were rests or attempts and aren't included in send-grade metrics.
          </div>
        </Card>

        {/* Session volume (v-sum). Stacked bars, one per session date,
            split by discipline color. Hidden when there are <2 sessions
            since a single bar is just a number. */}
        {sessionVolume.rows.length > 1 && (
          <Card>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Session volume (v-sum)</div>
            <div style={{ fontSize: 12, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>
              Sum of grade ranks per session — quantity × quality in one number.
              Sends and rest-completions count; attempts don't. Stacked by
              discipline so mixed sessions read as bands.
            </div>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={sessionVolume.rows} margin={{ top: 6, right: 14, bottom: 24, left: 0 }}>
                <CartesianGrid stroke={C.border} strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fill: C.muted, fontSize: 10 }}
                  angle={-30} textAnchor="end" interval="preserveStartEnd" />
                <YAxis tick={{ fill: C.muted, fontSize: 11 }} width={32} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ background: C.bg, border: `1px solid ${C.border}`, fontSize: 12 }}
                  formatter={(v, name) => [v, disciplineMeta(name).label]}
                />
                {sessionVolume.disciplines.map(d => (
                  <Bar key={d} dataKey={d} stackId="vsum"
                    fill={DISCIPLINE_COLORS[d] || C.muted}
                    isAnimationActive={false} />
                ))}
              </BarChart>
            </ResponsiveContainer>
            <div style={{ display: "flex", gap: 12, justifyContent: "center", marginTop: 4, fontSize: 11, color: C.muted, flexWrap: "wrap" }}>
              {sessionVolume.disciplines.map(d => (
                <span key={d} style={{ color: DISCIPLINE_COLORS[d] || C.muted, fontWeight: 600 }}>
                  ■ {disciplineMeta(d).label}
                </span>
              ))}
            </div>
          </Card>
        )}

        {/* Grade pyramid */}
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, flexWrap: "wrap", gap: 8 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Grade pyramid</div>
            <div style={{ display: "flex", gap: 4 }}>
              {WINDOWS.map(w => (
                <button key={w.key} onClick={() => setPyramidWindow(w.key)} style={{
                  padding: "3px 9px", borderRadius: 12, fontSize: 11, cursor: "pointer", border: "none", fontWeight: 600,
                  background: pyramidWindow === w.key ? C.purple : C.border,
                  color:      pyramidWindow === w.key ? "#fff" : C.muted,
                }}>{w.label}</button>
              ))}
            </div>
          </div>
          {/* Discipline (boulder / top rope / lead) — sticky single-select. */}
          <div style={{ display: "flex", gap: 4, marginBottom: 6, flexWrap: "wrap" }}>
            {CLIMB_DISCIPLINES.map(d => (
              <button key={d.key} onClick={() => setPyramidDiscipline(d.key)} style={{
                padding: "4px 10px", borderRadius: 12, fontSize: 12, cursor: "pointer", border: "none", fontWeight: 600,
                background: pyramidDiscipline === d.key ? DISCIPLINE_COLORS[d.key] : C.border,
                color:      pyramidDiscipline === d.key ? "#fff" : C.muted,
              }}>{d.emoji} {d.label}</button>
            ))}
          </div>

          {/* Venue (all / indoor / outdoor) — defaults to "all" so the
              filter is opt-in. Legacy entries without a venue field
              are treated as indoor by the pyramid useMemo so they
              don't disappear when the indoor filter is on. */}
          <div style={{ display: "flex", gap: 4, marginBottom: 6, flexWrap: "wrap" }}>
            {[{ key: "all", label: "All venues", emoji: "" }, ...VENUES].map(v => {
              const active = pyramidVenue === v.key;
              return (
                <button key={v.key} onClick={() => setPyramidVenue(v.key)} style={{
                  padding: "3px 9px", borderRadius: 12, fontSize: 11, cursor: "pointer", border: "none", fontWeight: 600,
                  background: active ? C.purple : C.border,
                  color:      active ? "#fff" : C.muted,
                }}>{v.emoji ? `${v.emoji} ` : ""}{v.label}</button>
              );
            })}
          </div>

          {/* Wall (commercial / moonboard / kilter) — only meaningful
              for indoor boulders. Hidden otherwise; the useEffect
              above auto-resets pyramidWall to "all" when this row
              disappears so a hidden selection can't silently exclude
              data on a later visit. */}
          {wallFilterActive && (
            <div style={{ display: "flex", gap: 4, marginBottom: 12, flexWrap: "wrap" }}>
              {[{ key: "all", label: "All walls", emoji: "" }, ...BOULDER_WALLS].map(w => {
                const active = pyramidWall === w.key;
                return (
                  <button key={w.key} onClick={() => setPyramidWall(w.key)} style={{
                    padding: "3px 9px", borderRadius: 12, fontSize: 11, cursor: "pointer", border: "none", fontWeight: 600,
                    background: active ? C.purple : C.border,
                    color:      active ? "#fff" : C.muted,
                  }}>{w.emoji ? `${w.emoji} ` : ""}{w.label}</button>
                );
              })}
            </div>
          )}

          {pyramid.rows.length === 0 ? (
            <div style={{ color: C.muted, fontSize: 12, padding: "12px 0" }}>
              No clean sends match these filters. Widen the window or
              loosen the venue / wall filter above.
            </div>
          ) : (
            <>
              {/* True centered pyramid with per-tier coaching status.
                  Replaces the prior horizontal bar chart. See
                  model/gradePyramid.js for Power Company Climbing's
                  project / consolidate / cleanup / base ATB logic. */}
              <PyramidChart
                rows={pyramid.rows}
                fill={DISCIPLINE_COLORS[pyramidDiscipline]}
              />
              <div style={{ marginTop: 6, fontSize: 11, color: C.muted, textAlign: "right" }}>
                {pyramid.total} clean send{pyramid.total === 1 ? "" : "s"} total
              </div>
            </>
          )}
        </Card>

        {/* Max sends — hardest grade per ascent style. Same filter
            shape as the pyramid (discipline / venue / wall / window)
            but independent state so a "lifetime max on lead" view
            can co-exist with "boulder pyramid, last 90 days" above. */}
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, flexWrap: "wrap", gap: 8 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Max sends</div>
            <div style={{ display: "flex", gap: 4 }}>
              {WINDOWS.map(w => (
                <button key={w.key} onClick={() => setMaxWindow(w.key)} style={{
                  padding: "3px 9px", borderRadius: 12, fontSize: 11, cursor: "pointer", border: "none", fontWeight: 600,
                  background: maxWindow === w.key ? C.purple : C.border,
                  color:      maxWindow === w.key ? "#fff" : C.muted,
                }}>{w.label}</button>
              ))}
            </div>
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>
            Hardest clean-send grade by ascent style within the current filter. Lifetime PR when the window is All; window-bounded PR otherwise.
          </div>

          {/* Discipline */}
          <div style={{ display: "flex", gap: 4, marginBottom: 6, flexWrap: "wrap" }}>
            {CLIMB_DISCIPLINES.map(d => (
              <button key={d.key} onClick={() => setMaxDiscipline(d.key)} style={{
                padding: "4px 10px", borderRadius: 12, fontSize: 12, cursor: "pointer", border: "none", fontWeight: 600,
                background: maxDiscipline === d.key ? DISCIPLINE_COLORS[d.key] : C.border,
                color:      maxDiscipline === d.key ? "#fff" : C.muted,
              }}>{d.emoji} {d.label}</button>
            ))}
          </div>

          {/* Venue */}
          <div style={{ display: "flex", gap: 4, marginBottom: 6, flexWrap: "wrap" }}>
            {[{ key: "all", label: "All venues", emoji: "" }, ...VENUES].map(v => {
              const active = maxVenue === v.key;
              return (
                <button key={v.key} onClick={() => setMaxVenue(v.key)} style={{
                  padding: "3px 9px", borderRadius: 12, fontSize: 11, cursor: "pointer", border: "none", fontWeight: 600,
                  background: active ? C.purple : C.border,
                  color:      active ? "#fff" : C.muted,
                }}>{v.emoji ? `${v.emoji} ` : ""}{v.label}</button>
              );
            })}
          </div>

          {/* Wall — indoor boulder only */}
          {maxWallActive && (
            <div style={{ display: "flex", gap: 4, marginBottom: 12, flexWrap: "wrap" }}>
              {[{ key: "all", label: "All walls", emoji: "" }, ...BOULDER_WALLS].map(w => {
                const active = maxWall === w.key;
                return (
                  <button key={w.key} onClick={() => setMaxWall(w.key)} style={{
                    padding: "3px 9px", borderRadius: 12, fontSize: 11, cursor: "pointer", border: "none", fontWeight: 600,
                    background: active ? C.purple : C.border,
                    color:      active ? "#fff" : C.muted,
                  }}>{w.emoji ? `${w.emoji} ` : ""}{w.label}</button>
                );
              })}
            </div>
          )}

          {/* Per-style rows — onsight / flash / redpoint. Empty styles
              render as muted placeholders rather than disappearing so
              the user can see "no onsights yet on this discipline." */}
          {MAX_STYLES.map((style, i) => {
            const entry = maxByStyle[style];
            const meta = ASCENT_STYLES.find(s => s.key === style);
            const has = entry.grade != null;
            return (
              <div key={style} style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "10px 0",
                borderTop: i === 0 ? `1px solid ${C.border}` : `1px solid ${C.border}`,
              }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: has ? C.text : C.muted }}>
                    {meta?.label || style}
                  </div>
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
                    {has
                      ? `${entry.count} send${entry.count === 1 ? "" : "s"}${entry.date ? " · last on " + entry.date : ""}`
                      : "No sends yet in this filter"}
                  </div>
                </div>
                <div style={{
                  fontSize: 22, fontWeight: 800,
                  color: has ? C.text : C.muted,
                  fontFamily: "'Courier New', monospace",
                  letterSpacing: 0.5,
                }}>
                  {entry.grade || "—"}
                </div>
              </div>
            );
          })}
        </Card>

        {/* Hardest send over time */}
        {hardestSend.rows.length > 1 && (
          <Card>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Hardest send by week</div>
            <div style={{ fontSize: 12, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>
              Best clean-send grade each week, per discipline. Rest sends and
              attempts excluded.
            </div>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={hardestSend.rows} margin={{ top: 6, right: 14, bottom: 24, left: 0 }}>
                <CartesianGrid stroke={C.border} strokeDasharray="3 3" />
                <XAxis dataKey="week" tick={{ fill: C.muted, fontSize: 10 }}
                  angle={-30} textAnchor="end" interval="preserveStartEnd" />
                <YAxis tick={{ fill: C.muted, fontSize: 11 }} width={36}
                  label={{ value: "rank", angle: -90, position: "insideLeft", fill: C.muted, fontSize: 10 }} />
                <Tooltip
                  contentStyle={{ background: C.bg, border: `1px solid ${C.border}`, fontSize: 12 }}
                  formatter={(v, name, ctx) => {
                    const disc = name.replace("_rank", "");
                    const grade = ctx?.payload?.[`${disc}_grade`];
                    return [grade || "—", disciplineMeta(disc).label];
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 11, paddingTop: 4 }} iconType="line" iconSize={10}
                  formatter={(name) => disciplineMeta(name.replace("_rank", "")).label} />
                {hardestSend.disciplines.map(d => (
                  <Line
                    key={d}
                    type="monotone"
                    dataKey={`${d}_rank`}
                    name={`${d}_rank`}
                    stroke={DISCIPLINE_COLORS[d] || C.muted}
                    strokeWidth={2}
                    dot={{ r: 3 }}
                    connectNulls
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </Card>
        )}

        {/* Ascent style mix */}
        {styleMix.rows.length > 0 && (
          <Card>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Ascent style mix</div>
            <div style={{ fontSize: 12, color: C.muted, marginBottom: 12, lineHeight: 1.5 }}>
              Where your climbing time goes. Heavy redpoint share = working
              your limit; heavy onsight/flash share = volume + mileage.
            </div>
            {/* Stacked horizontal bar — single 100%-width bar split by style. */}
            <div style={{
              display: "flex", height: 22, borderRadius: 6, overflow: "hidden",
              border: `1px solid ${C.border}`, marginBottom: 12,
            }}>
              {styleMix.rows.map(r => (
                <div key={r.key} title={`${r.label}: ${r.count} (${r.pct}%)`}
                  style={{
                    flex: r.count, background: ASCENT_COLORS[r.key] || C.muted,
                    minWidth: 2,
                  }}
                />
              ))}
            </div>
            {/* Legend rows. */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 14px" }}>
              {styleMix.rows.map(r => (
                <div key={r.key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                  <span style={{
                    display: "inline-block", width: 10, height: 10, borderRadius: 2,
                    background: ASCENT_COLORS[r.key] || C.muted,
                  }} />
                  <span style={{ color: C.text, fontWeight: 600 }}>{r.label}</span>
                  <span style={{ color: C.muted }}>{r.count} · {r.pct}%</span>
                </div>
              ))}
            </div>
          </Card>
        )}
      </Sect>
    </div>
  );
}

// Small stat tile for the headline grid. Number-forward, label small +
// muted underneath. Mirrors the metrics row in WorkoutTab so the visual
// language is consistent across the app.
function Stat({ label, value }) {
  return (
    <div style={{
      background: C.bg, borderRadius: 8, padding: "10px 14px",
      border: `1px solid ${C.border}`,
    }}>
      <div style={{ fontSize: 11, color: C.muted }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: C.text }}>{value}</div>
    </div>
  );
}
