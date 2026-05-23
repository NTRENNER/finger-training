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
import {
  loadLS, saveLS,
  LS_PYRAMID_PROJECT_KEY, LS_PYRAMID_WARMUP_KEY,
} from "../lib/storage.js";
import {
  inferProjectGrade, inferFlashGrade, projectFromFlash,
} from "../model/gradePyramid.js";

// Gap between flash grade and project grade. The "+3 grades" coaching
// heuristic — project = what you couldn't reasonably send today.
const FLASH_TO_PROJECT_GAP = 3;

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

  // ── Pyramid settings — pinned project + warmup floor (per discipline) ──
  // Both persist across navigations. Keyed by discipline because a
  // boulderer projecting V6 and onsighting 5.11a needs different pins
  // for boulder vs lead.
  const [pinnedProjectMap, setPinnedProjectMap] = useState(
    () => loadLS(LS_PYRAMID_PROJECT_KEY) || {}
  );
  const [warmupFloorMap, setWarmupFloorMap] = useState(
    () => loadLS(LS_PYRAMID_WARMUP_KEY) || {}
  );
  const pinnedProject     = pinnedProjectMap[pyramidDiscipline] || null;
  const warmupFloorGrade  = warmupFloorMap[pyramidDiscipline]   || null;
  const warmupFloorRank   = warmupFloorGrade ? gradeRank(warmupFloorGrade) : null;

  const updatePinnedProject = (grade) => {
    const next = { ...pinnedProjectMap };
    if (grade) next[pyramidDiscipline] = grade;
    else delete next[pyramidDiscipline];
    setPinnedProjectMap(next);
    saveLS(LS_PYRAMID_PROJECT_KEY, next);
  };
  const updateWarmupFloor = (grade) => {
    const next = { ...warmupFloorMap };
    if (grade) next[pyramidDiscipline] = grade;
    else delete next[pyramidDiscipline];
    setWarmupFloorMap(next);
    saveLS(LS_PYRAMID_WARMUP_KEY, next);
  };

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
  // Boulder-only: sum of V-grade ranks per session date for clean sends
  // + rest-completions. The v-sum concept is bouldering convention and
  // doesn't carry the same meaning across YDS rope grades (a 5.12a
  // attempt and a V5 boulder are different units of work). Restricting
  // to boulder keeps the chart's semantic clean — a single-discipline
  // volume tracker rather than a stacked mixed-units bar.
  //
  // Most recent 60 sessions to keep the bar count readable on phones.
  const sessionVolume = useMemo(() => {
    const sent = allClimbs.filter(c => c.discipline === "boulder" && wasSent(c));
    if (sent.length === 0) return { rows: [], disciplines: [] };
    const byDate = {};
    for (const c of sent) {
      const r = gradeRank(c.grade);
      if (r < 0) continue;
      byDate[c.date] = (byDate[c.date] || 0) + r;
    }
    const sortedDates = Object.keys(byDate).sort();
    const recent = sortedDates.slice(-60);
    const rows = recent.map(date => ({
      date: date.slice(5),  // MM-DD for axis density
      boulder: byDate[date] || 0,
      __total: byDate[date] || 0,
    }));
    return { rows, disciplines: ["boulder"] };
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

  // ── Warmup partition ──
  // Split the filtered pyramid rows into (display, warmup) based on the
  // per-discipline warmup floor. Floor is inclusive — a floor of V3
  // excludes V0/V1/V2/V3 from the chart. Aggregated warmup counts
  // surface as a caption below the pyramid so the climber can see
  // their warmup mileage without it inflating the base tier.
  const pyramidPartition = useMemo(() => {
    if (warmupFloorRank == null) {
      return { displayRows: pyramid.rows, warmupRows: [], warmupSends: 0 };
    }
    const display = [];
    const warmups = [];
    for (const r of pyramid.rows) {
      if (r.rank <= warmupFloorRank) warmups.push(r);
      else display.push(r);
    }
    return {
      displayRows: display,
      warmupRows: warmups,
      warmupSends: warmups.reduce((s, r) => s + r.count, 0),
    };
  }, [pyramid.rows, warmupFloorRank]);

  // ── Flash stats ──
  // Per-grade { flashes, total } in the same filter set as the pyramid.
  // "Flashes" = onsight + flash ascents (first-try sends). "Total" =
  // every climb logged at that grade — clean sends, rests, attempts.
  // Including attempts in the denominator stops a one-shot lucky V6
  // from claiming flash status when most V6 attempts came up short.
  const flashStats = useMemo(() => {
    const windowDef = WINDOWS.find(w => w.key === pyramidWindow);
    const climbs = clamberFilter(allClimbs, windowDef.days)
      .filter(c => c.discipline === pyramidDiscipline)
      .filter(c => {
        if (pyramidVenue === "all") return true;
        const v = c.venue || "indoor";
        return v === pyramidVenue;
      })
      .filter(c => {
        if (!wallFilterActive || pyramidWall === "all") return true;
        return c.wall === pyramidWall;
      });
    const byGrade = {};
    for (const c of climbs) {
      if (!c.grade) continue;
      if (!byGrade[c.grade]) byGrade[c.grade] = { flashes: 0, total: 0 };
      byGrade[c.grade].total += 1;
      if (c.ascent === "flash" || c.ascent === "onsight") {
        byGrade[c.grade].flashes += 1;
      }
    }
    const allGrades = pyramidDiscipline === "boulder" ? V_GRADES : YDS_GRADES;
    return allGrades
      .filter(g => byGrade[g])
      .map(g => ({ grade: g, rank: gradeRank(g), ...byGrade[g] }));
  }, [allClimbs, pyramidDiscipline, pyramidVenue, pyramidWall, wallFilterActive, pyramidWindow]);

  // Flash grade: highest where flash rate ≥ 50% with ≥3 encounters.
  // Returns null until enough data accumulates — the UI falls back to
  // the legacy send-anchored inference in that case.
  const inferredFlash = useMemo(
    () => inferFlashGrade(flashStats),
    [flashStats]
  );

  // Flash-anchored project: walk up gradesList by FLASH_TO_PROJECT_GAP
  // from the flash grade. Falls back to the legacy send-anchored
  // inference when no flash grade can be determined yet.
  const gradesList = pyramidDiscipline === "boulder" ? V_GRADES : YDS_GRADES;
  const flashAnchoredProject = useMemo(
    () => projectFromFlash(inferredFlash, FLASH_TO_PROJECT_GAP, gradesList),
    [inferredFlash, gradesList]
  );
  const legacyInferredProject = useMemo(
    () => inferProjectGrade(pyramidPartition.displayRows),
    [pyramidPartition.displayRows]
  );

  // Effective project — priority: explicit pin > flash-anchored > legacy.
  const inferredProject = flashAnchoredProject || legacyInferredProject;
  const effectiveProject = pinnedProject || inferredProject;
  const effectiveProjectRank = effectiveProject ? gradeRank(effectiveProject) : null;
  // Anchor mode flips to 'flash' as soon as we have a flash grade,
  // regardless of whether the user pinned the project — the pinned
  // grade still anchors the tier ranks, but the tier labels/bands
  // come from the flash-anchored set (Project / Push / Consolidate /
  // Volume) because the climber has shown enough data to use the
  // forward-looking interpretation.
  const pyramidAnchorMode = inferredFlash ? "flash" : "send";

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

        {/* Boulder session volume (v-sum). One bar per boulder session
            date. Boulder-only by design — the v-sum concept is a
            bouldering convention and mixing rope grades in via gradeRank
            blurs the unit. Renders as soon as any boulder session
            exists so a single early bar is still visible (it tells you
            the chart works and gives you a baseline to beat). */}
        {sessionVolume.rows.length >= 1 && (
          <Card>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Boulder session volume (v-sum)</div>
            <div style={{ fontSize: 12, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>
              Sum of V-grade ranks per boulder session — quantity × quality
              in one number. Sends and rest-completions count; attempts don't.
              Lead and top rope are excluded (v-sum is a boulder convention).
            </div>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={sessionVolume.rows} margin={{ top: 6, right: 14, bottom: 24, left: 0 }}>
                <CartesianGrid stroke={C.border} strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fill: C.muted, fontSize: 10 }}
                  angle={-30} textAnchor="end" interval="preserveStartEnd" />
                <YAxis tick={{ fill: C.muted, fontSize: 11 }} width={32} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ background: C.bg, border: `1px solid ${C.border}`, fontSize: 12 }}
                  formatter={(v) => [v, "v-sum"]}
                />
                <Bar dataKey="boulder"
                  fill={DISCIPLINE_COLORS.boulder || C.orange}
                  isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
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

          {/* Pyramid settings: project pin + warmup floor (per discipline).
              Pin overrides auto-inference. With enough data, the auto
              project is flash + 3 grades (forward-looking project =
              what you're trying, not the hardest you've sent). Warmup
              floor excludes easy-mileage grades so the base tier
              reflects real climbing. */}
          <PyramidSettings
            discipline={pyramidDiscipline}
            pinnedProject={pinnedProject}
            inferredProject={inferredProject}
            inferredFlash={inferredFlash}
            warmupFloorGrade={warmupFloorGrade}
            onPinProject={updatePinnedProject}
            onSetWarmupFloor={updateWarmupFloor}
          />

          {pyramidPartition.displayRows.length === 0 ? (
            <div style={{ color: C.muted, fontSize: 12, padding: "12px 0" }}>
              {pyramid.rows.length === 0
                ? "No clean sends match these filters. Widen the window or loosen the venue / wall filter above."
                : `All ${pyramid.total} clean send${pyramid.total === 1 ? "" : "s"} are in your warmup zone (≤ ${warmupFloorGrade}). Lower the warmup floor to see them in the pyramid.`}
            </div>
          ) : (
            <>
              {/* True centered pyramid with per-tier coaching status.
                  Replaces the prior horizontal bar chart. See
                  model/gradePyramid.js for Power Company Climbing's
                  project / consolidate / cleanup / base ATB logic.
                  anchorMode = 'flash' once enough flash data exists. */}
              <PyramidChart
                rows={pyramidPartition.displayRows}
                fill={DISCIPLINE_COLORS[pyramidDiscipline]}
                projectGrade={effectiveProject}
                projectRank={effectiveProjectRank}
                anchorMode={pyramidAnchorMode}
              />
              <div style={{ marginTop: 6, fontSize: 11, color: C.muted, textAlign: "right" }}>
                {pyramid.total} clean send{pyramid.total === 1 ? "" : "s"} total
                {pyramidPartition.warmupSends > 0
                  ? ` · ${pyramidPartition.warmupSends} warmup${pyramidPartition.warmupSends === 1 ? "" : "s"} at ${pyramidPartition.warmupRows.map(r => r.grade).join(", ")} (hidden)`
                  : ""}
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

// Per-discipline pyramid settings — pinned project grade + warmup
// floor, with the auto-inferred flash grade surfaced as a read-only
// hint so the user understands what's anchoring the pyramid.
//
// Both pins are compact <select>s in a single flex row. Empty string
// = unset (use auto / no floor); upstream maps that to LS deletion.
//
// The warmup floor list is clamped to grades strictly below the active
// project. A floor at or above the project would either exclude the
// project tier (silly) or do nothing useful.
//
// Why no flash pin: the user picked auto-only flash inference. If
// that changes, add a flash pin here next to project.
function PyramidSettings({
  discipline, pinnedProject, inferredProject, inferredFlash,
  warmupFloorGrade, onPinProject, onSetWarmupFloor,
}) {
  const allGrades = discipline === "boulder" ? V_GRADES : YDS_GRADES;
  const activeProject = pinnedProject || inferredProject;
  const projectRank = activeProject ? gradeRank(activeProject) : null;
  const warmupOptions = projectRank != null
    ? allGrades.filter(g => gradeRank(g) < projectRank)
    : allGrades;

  const selectStyle = {
    padding: "3px 6px", borderRadius: 6, fontSize: 11,
    background: C.bg, color: C.text, border: `1px solid ${C.border}`,
    cursor: "pointer",
  };

  return (
    <div style={{ marginBottom: 12, fontSize: 11, color: C.muted }}>
      {/* Flash anchor hint — surfaces what's driving the auto project. */}
      <div style={{ marginBottom: 6 }}>
        Flash anchor: {inferredFlash
          ? <span style={{ color: C.text, fontWeight: 600 }}>{inferredFlash}</span>
          : <span style={{ fontStyle: "italic" }}>not yet (need 3+ climbs at ≥50% flash rate)</span>
        }
        {inferredFlash && (
          <span style={{ color: C.muted }}> · project auto = flash + {FLASH_TO_PROJECT_GAP}</span>
        )}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <span>Project:</span>
        <select
          value={pinnedProject || ""}
          onChange={(e) => onPinProject(e.target.value || null)}
          style={selectStyle}
          title="Pin a project grade. Auto = flash + 3 once enough data exists, else the highest grade with ≥2 clean sends."
        >
          <option value="">Auto{inferredProject ? ` (${inferredProject})` : ""}</option>
          {allGrades.map(g => (
            <option key={g} value={g}>{g}</option>
          ))}
        </select>

        <span style={{ marginLeft: 8 }}>Warmups ≤</span>
        <select
          value={warmupFloorGrade || ""}
          onChange={(e) => onSetWarmupFloor(e.target.value || null)}
          style={selectStyle}
          title="Hide easy grades from the pyramid. Sends at or below this grade are tallied separately as warmups."
        >
          <option value="">None</option>
          {warmupOptions.map(g => (
            <option key={g} value={g}>{g}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
