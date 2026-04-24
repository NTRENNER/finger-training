// ─────────────────────────────────────────────────────────────
// TRENDS VIEW
// ─────────────────────────────────────────────────────────────
// The "Trends" tab — four sub-views toggled by a domain pill at the
// top:
//
//   Fingers  — best-daily-load line per hand × target duration,
//              with PR star markers. Driven by the rep history
//              passed in as a prop.
//
//   Workout  — max weight per session per exercise, for the
//              strength-training log stored in localStorage under
//              LS_WORKOUT_LOG_KEY. PR markers same as Fingers.
//
//   Body     — body weight over time from LS_BW_LOG_KEY, with a
//              current/change summary card.
//
//   Climbing — weekly volume stacked by discipline + hardest send
//              per family (V-grade boulder, YDS rope) on a dual-axis
//              line chart.
//
// Data sources are intentionally mixed: Fingers and Climbing receive
// their data via props (history, activities) because those domains are
// also consumed by other views. Workout and Body read directly from
// localStorage because those logs are local-only and only consumed by
// these two trend views.

import React, { useMemo, useState } from "react";
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from "recharts";
import { C } from "../ui/theme.js";
import { Card, Label } from "../ui/components.js";
import { fmt1, toDisp } from "../ui/format.js";
import { effectiveLoad } from "../model/prescription.js";
import { loadLS, LS_BW_LOG_KEY, LS_WORKOUT_LOG_KEY } from "../lib/storage.js";
import { gradeRank, weekKey } from "../lib/climbing-grades.js";

// Reference target durations for the Fingers view's filter pills.
// Mirrors TARGET_OPTIONS in App.js — kept locally so this module
// doesn't reach back into App.js for a single constant.
const TARGET_OPTIONS = [
  { label: "Power",    seconds: 7   },
  { label: "Strength", seconds: 45  },
  { label: "Capacity", seconds: 120 },
];

// ─────────────────────────────────────────────────────────────
// WORKOUT (strength training log) sub-view
// ─────────────────────────────────────────────────────────────
function WorkoutTrendsView({ unit = "lbs", defaultWorkouts = {} }) {
  // Always read fresh from localStorage. The dependency array is
  // empty by design — workout log changes happen elsewhere and we
  // refresh on tab change rather than on every render.
  const wLog = useMemo(() => loadLS(LS_WORKOUT_LOG_KEY) || [], []); // eslint-disable-line react-hooks/exhaustive-deps

  // All exercises that have logged weight data. defaultWorkouts is
  // passed in so we can pretty-print the human-readable name.
  const exerciseOptions = useMemo(() => {
    const seen = new Map(); // id → name
    for (const session of wLog) {
      for (const [id, data] of Object.entries(session.exercises || {})) {
        if (data.sets && data.sets.some(s => s.weight && s.done)) {
          if (!seen.has(id)) {
            let name = id.replace(/_/g, " ");
            for (const wk of Object.values(defaultWorkouts)) {
              const ex = (wk.exercises || []).find(e => e.id === id);
              if (ex && ex.name) { name = ex.name; break; }
            }
            seen.set(id, name);
          }
        }
      }
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }, [wLog, defaultWorkouts]);

  const [selEx, setSelEx] = useState(null);
  const activeEx = selEx && exerciseOptions.find(e => e.id === selEx) ? selEx : (exerciseOptions[0]?.id || null);

  const chartData = useMemo(() => {
    if (!activeEx) return [];
    const points = [];
    for (const session of wLog) {
      const exData = session.exercises?.[activeEx];
      if (!exData?.sets) continue;
      const weights = exData.sets
        .filter(s => s.done && s.weight)
        .map(s => parseFloat(s.weight))
        .filter(w => !isNaN(w) && w > 0);
      if (!weights.length) continue;
      const maxW = Math.max(...weights);
      const dispW = unit === "kg" ? Math.round(maxW / 2.205 * 10) / 10 : maxW;
      points.push({ date: session.date, max: dispW, workout: session.workout });
    }
    points.sort((a, b) => a.date < b.date ? -1 : 1);
    let pr = -Infinity;
    return points.map(p => {
      const isPR = p.max > pr;
      if (isPR) pr = p.max;
      return { ...p, isPR };
    });
  }, [wLog, activeEx, unit]);

  const currentPR = useMemo(() => [...chartData].filter(d => d.isPR).slice(-1)[0], [chartData]);

  if (!exerciseOptions.length) return (
    <div style={{ textAlign: "center", color: C.muted, marginTop: 60, fontSize: 14 }}>
      Complete a workout session to see strength trends.
    </div>
  );

  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        {exerciseOptions.map(ex => (
          <button key={ex.id} onClick={() => setSelEx(ex.id)} style={{
            padding: "6px 14px", borderRadius: 20, cursor: "pointer", fontWeight: 600, border: "none", fontSize: 12,
            background: activeEx === ex.id ? C.blue : C.border,
            color: activeEx === ex.id ? "#fff" : C.muted,
          }}>{ex.name}</button>
        ))}
      </div>

      {currentPR && (
        <Card style={{ marginBottom: 12, borderColor: C.yellow + "55" }}>
          <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
            <span style={{ fontSize: 18 }}>🏆</span>
            <div>
              <Label>Personal Record</Label>
              <span style={{ fontSize: 22, fontWeight: 800, color: C.yellow }}>
                {currentPR.max} {unit}
              </span>
              <div style={{ fontSize: 11, color: C.muted }}>{currentPR.date}</div>
            </div>
          </div>
        </Card>
      )}

      {chartData.length < 2 ? (
        <Card>
          <div style={{ color: C.muted, fontSize: 13, textAlign: "center", padding: "16px 0" }}>
            Log 2+ sessions with this exercise to see a trend line.
          </div>
        </Card>
      ) : (
        <Card>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 4 }}>
            Max weight per session · {exerciseOptions.find(e => e.id === activeEx)?.name}
          </div>
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 10 }}>
            <span style={{ color: C.yellow }}>★</span> = personal record
          </div>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
              <XAxis dataKey="date" tick={{ fill: C.muted, fontSize: 10 }} />
              <YAxis tick={{ fill: C.muted, fontSize: 11 }} unit={` ${unit}`} />
              <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, color: C.text }} />
              <Line
                type="monotone"
                dataKey="max"
                stroke={C.blue}
                strokeWidth={2}
                name="Max weight"
                connectNulls
                dot={(props) => {
                  const { cx, cy, payload } = props;
                  if (!payload.isPR) return (
                    <circle key={`dot-${cx}-${cy}`} cx={cx} cy={cy} r={2.5} fill={C.blue} opacity={0.6} />
                  );
                  return (
                    <g key={`pr-${cx}-${cy}`}>
                      <circle cx={cx} cy={cy} r={7} fill={C.yellow} opacity={0.2} />
                      <circle cx={cx} cy={cy} r={4} fill={C.yellow} />
                      <text x={cx} y={cy - 12} textAnchor="middle" fill={C.yellow} fontSize={9} fontWeight="bold">PR</text>
                    </g>
                  );
                }}
              />
            </LineChart>
          </ResponsiveContainer>
        </Card>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// BODY WEIGHT sub-view
// ─────────────────────────────────────────────────────────────
function BodyWeightTrendsView({ unit = "lbs" }) {
  const bwLog = useMemo(() => loadLS(LS_BW_LOG_KEY) || [], []); // eslint-disable-line react-hooks/exhaustive-deps
  const chartData = useMemo(() =>
    bwLog.map(e => ({ date: e.date, weight: Math.round(toDisp(e.kg, unit) * 10) / 10 })),
    [bwLog, unit]
  );
  const latest = chartData[chartData.length - 1];
  const first  = chartData[0];
  const delta  = latest && first && chartData.length > 1
    ? Math.round((latest.weight - first.weight) * 10) / 10
    : null;

  if (!chartData.length) return (
    <div style={{ textAlign: "center", color: C.muted, marginTop: 60, fontSize: 14 }}>
      Update your body weight in Settings to start tracking it here.
    </div>
  );

  return (
    <div>
      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        <Card style={{ flex: 1 }}>
          <Label>Current</Label>
          <div style={{ fontSize: 22, fontWeight: 800, color: C.text }}>
            {latest?.weight} <span style={{ fontSize: 13, fontWeight: 400, color: C.muted }}>{unit}</span>
          </div>
          <div style={{ fontSize: 11, color: C.muted }}>{latest?.date}</div>
        </Card>
        {delta != null && (
          <Card style={{ flex: 1 }}>
            <Label>Change</Label>
            <div style={{ fontSize: 22, fontWeight: 800, color: delta < 0 ? C.green : delta > 0 ? C.orange : C.muted }}>
              {delta > 0 ? "+" : ""}{delta} <span style={{ fontSize: 13, fontWeight: 400, color: C.muted }}>{unit}</span>
            </div>
            <div style={{ fontSize: 11, color: C.muted }}>since {first?.date}</div>
          </Card>
        )}
      </div>

      {chartData.length < 2 ? (
        <Card>
          <div style={{ color: C.muted, fontSize: 13, textAlign: "center", padding: "16px 0" }}>
            Log your weight again after updating it in Settings to see a trend line.
          </div>
        </Card>
      ) : (
        <Card>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 10 }}>Body weight over time</div>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
              <XAxis dataKey="date" tick={{ fill: C.muted, fontSize: 10 }} />
              <YAxis
                tick={{ fill: C.muted, fontSize: 11 }}
                unit={` ${unit}`}
                domain={["auto", "auto"]}
              />
              <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, color: C.text }} />
              <Line
                type="monotone"
                dataKey="weight"
                stroke={C.purple}
                strokeWidth={2}
                name={`Weight (${unit})`}
                dot={{ r: 4, fill: C.purple }}
                activeDot={{ r: 6 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </Card>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// CLIMBING TRENDS sub-view
// ─────────────────────────────────────────────────────────────
// Weekly volume (stacked by discipline) + hardest-send line for
// boulder (V-scale) and rope (YDS). Attempts drop off the
// hardest-send line because they aren't sends.
function ClimbingTrendsView({ activities = [] }) {
  const climbs = useMemo(
    () => activities.filter(a => a.type === "climbing" && a.date),
    [activities]
  );

  // Weekly aggregate: volume by discipline + hardest send per family.
  const weekly = useMemo(() => {
    const weeks = new Map(); // weekKey -> { week, boulder, top_rope, lead, hardestV, hardestYDS, sends, total }
    for (const c of climbs) {
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

  // Flatten hardest-grade into chart-friendly numeric series.
  const chart = useMemo(() => weekly.map(w => ({
    week:         w.week,
    boulder:      w.boulder,
    top_rope:     w.top_rope,
    lead:         w.lead,
    hardestV:     w.hardestV?.rank ?? null,
    hardestVLbl:  w.hardestV?.label ?? "",
    hardestYDS:   w.hardestYDS?.rank ?? null,
    hardestYDSLbl: w.hardestYDS?.label ?? "",
    sendRate:     w.total > 0 ? Math.round((w.sends / w.total) * 100) : 0,
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

  if (climbs.length === 0) {
    return (
      <div style={{ textAlign: "center", color: C.muted, marginTop: 60, fontSize: 14 }}>
        Log a climb in the Climbing tab to start tracking climbing trends.
      </div>
    );
  }

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

// ─────────────────────────────────────────────────────────────
// TRENDS VIEW (top-level wrapper)
// ─────────────────────────────────────────────────────────────
// Domain pill at the top toggles between Fingers / Workout / Body /
// Climbing. Fingers is the default. Each domain renders a different
// sub-view component above.
//
// Props:
//   history          — finger-training rep history (Fingers domain)
//   activities       — climbing log entries (Climbing domain)
//   unit             — "lbs" or "kg" display unit
//   defaultWorkouts  — passed through to WorkoutTrendsView for
//                      pretty-printing exercise names from session log
export function TrendsView({ history, unit = "lbs", activities = [], defaultWorkouts = {} }) {
  const [domain, setDomain] = useState("fingers"); // "fingers" | "workout" | "body" | "climbing"
  const [sel,     setSel]     = useState(45);
  const [selHand, setSelHand] = useState("");   // "" = both
  const [selGrip, setSelGrip] = useState("");   // "" = all grips

  const grips = useMemo(() => [...new Set(history.map(r => r.grip).filter(Boolean))].sort(), [history]);

  const data = useMemo(() => {
    const byDate = {};
    for (const r of history.filter(r =>
      r.target_duration === sel &&
      effectiveLoad(r) > 0 &&
      (!selGrip || r.grip === selGrip)
    )) {
      const d = r.date || "";
      if (!byDate[d]) byDate[d] = { date: d, L: null, R: null };
      const load = toDisp(effectiveLoad(r), unit);
      if (r.hand === "L") byDate[d].L = Math.max(byDate[d].L ?? 0, load);
      if (r.hand === "R") byDate[d].R = Math.max(byDate[d].R ?? 0, load);
    }
    // Sort chronologically, then flag PR points
    const sorted = Object.values(byDate).sort((a, b) => a.date < b.date ? -1 : 1);
    let maxL = -Infinity, maxR = -Infinity;
    return sorted.map(d => {
      const isPR_L = d.L != null && d.L > maxL;
      const isPR_R = d.R != null && d.R > maxR;
      if (isPR_L) maxL = d.L;
      if (isPR_R) maxR = d.R;
      return { ...d, isPR_L, isPR_R };
    });
  }, [history, sel, selGrip, unit]);

  // Latest PR values for summary display
  const latestPR = useMemo(() => {
    const prsL = data.filter(d => d.isPR_L);
    const prsR = data.filter(d => d.isPR_R);
    return {
      L: prsL.length ? prsL[prsL.length - 1] : null,
      R: prsR.length ? prsR[prsR.length - 1] : null,
    };
  }, [data]);

  const lines = selHand === "L" ? [{ key: "L", color: C.blue,   name: "Left"  }]
              : selHand === "R" ? [{ key: "R", color: C.orange, name: "Right" }]
              : [{ key: "L", color: C.blue, name: "Left" }, { key: "R", color: C.orange, name: "Right" }];

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
      <h2 style={{ margin: "0 0 16px", fontSize: 22 }}>Trends</h2>

      {/* Domain toggle: Fingers / Workout / Body / Climbing */}
      <div style={{ display: "flex", background: C.border, borderRadius: 24, padding: 3, marginBottom: 20, gap: 2 }}>
        {[["fingers", "🖐 Fingers"], ["workout", "🏋️ Workout"], ["body", "⚖️ Body"], ["climbing", "🧗 Climbing"]].map(([key, label]) => (
          <button key={key} onClick={() => setDomain(key)} style={{
            flex: 1, padding: "8px 0", borderRadius: 20, border: "none", cursor: "pointer",
            fontWeight: 700, fontSize: 12,
            background: domain === key ? C.blue : "transparent",
            color: domain === key ? "#fff" : C.muted,
            transition: "background 0.15s",
          }}>{label}</button>
        ))}
      </div>

      {domain === "workout"  && <WorkoutTrendsView unit={unit} defaultWorkouts={defaultWorkouts} />}
      {domain === "body"     && <BodyWeightTrendsView unit={unit} />}
      {domain === "climbing" && <ClimbingTrendsView activities={activities} />}
      {domain === "fingers"  && <>

      {/* Filters */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        {["L","R"].map(h => (
          <button key={h} onClick={() => setSelHand(selHand === h ? "" : h)} style={{
            padding: "6px 18px", borderRadius: 20, cursor: "pointer", fontWeight: 600, border: "none",
            background: selHand === h ? C.purple : C.border,
            color: selHand === h ? "#fff" : C.muted,
          }}>{h === "L" ? "Left" : "Right"}</button>
        ))}
        {TARGET_OPTIONS.map(o => (
          <button key={o.seconds} onClick={() => setSel(o.seconds)} style={{
            padding: "6px 18px", borderRadius: 20, cursor: "pointer", fontWeight: 600, border: "none",
            background: sel === o.seconds ? C.blue : C.border,
            color: sel === o.seconds ? "#fff" : C.muted,
          }}>{o.label}</button>
        ))}
      </div>
      {grips.length > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
          <button onClick={() => setSelGrip("")} style={{
            padding: "4px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer", border: "none",
            background: !selGrip ? C.orange : C.border,
            color: !selGrip ? "#fff" : C.muted,
          }}>All Grips</button>
          {grips.map(g => (
            <button key={g} onClick={() => setSelGrip(selGrip === g ? "" : g)} style={{
              padding: "4px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer", border: "none",
              background: selGrip === g ? C.orange : C.border,
              color: selGrip === g ? "#fff" : C.muted,
            }}>{g}</button>
          ))}
        </div>
      )}

      {data.length === 0 ? (
        <div style={{ textAlign: "center", color: C.muted, marginTop: 60 }}>
          No data for this filter yet.
        </div>
      ) : (
        <>
          {/* PR summary */}
          {(latestPR.L || latestPR.R) && (
            <Card style={{ marginBottom: 12, borderColor: C.yellow + "55" }}>
              <div style={{ display: "flex", gap: 24, alignItems: "center" }}>
                <span style={{ fontSize: 18 }}>🏆</span>
                {latestPR.L && (selHand === "" || selHand === "L") && (
                  <div>
                    <Label>Left PR</Label>
                    <span style={{ fontSize: 22, fontWeight: 800, color: C.yellow }}>
                      {fmt1(latestPR.L.L)} {unit}
                    </span>
                    <div style={{ fontSize: 11, color: C.muted }}>{latestPR.L.date}</div>
                  </div>
                )}
                {latestPR.R && (selHand === "" || selHand === "R") && (
                  <div>
                    <Label>Right PR</Label>
                    <span style={{ fontSize: 22, fontWeight: 800, color: C.yellow }}>
                      {fmt1(latestPR.R.R)} {unit}
                    </span>
                    <div style={{ fontSize: 11, color: C.muted }}>{latestPR.R.date}</div>
                  </div>
                )}
              </div>
            </Card>
          )}

          <Card>
            <div style={{ fontSize: 13, color: C.muted, marginBottom: 4 }}>
              Best daily load · {TARGET_OPTIONS.find(o => o.seconds === sel)?.label}
              {selGrip ? ` · ${selGrip}` : ""}
            </div>
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 10 }}>
              <span style={{ color: C.yellow }}>★</span> = personal record
            </div>
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={data}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis dataKey="date" tick={{ fill: C.muted, fontSize: 10 }} />
                <YAxis tick={{ fill: C.muted, fontSize: 11 }} unit={` ${unit}`} />
                <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, color: C.text }} />
                <Legend />
                {lines.map(l => (
                  <Line
                    key={l.key}
                    type="monotone"
                    dataKey={l.key}
                    stroke={l.color}
                    strokeWidth={2}
                    name={l.name}
                    connectNulls
                    dot={(props) => {
                      const { cx, cy, payload } = props;
                      const isPR = l.key === "L" ? payload.isPR_L : payload.isPR_R;
                      const val  = payload[l.key];
                      if (val == null) return null;
                      if (!isPR) return (
                        <circle key={`dot-${cx}-${cy}`} cx={cx} cy={cy} r={2.5} fill={l.color} opacity={0.6} />
                      );
                      return (
                        <g key={`pr-${cx}-${cy}`}>
                          <circle cx={cx} cy={cy} r={7} fill={C.yellow} opacity={0.2} />
                          <circle cx={cx} cy={cy} r={4} fill={C.yellow} />
                          <text x={cx} y={cy - 12} textAnchor="middle" fill={C.yellow} fontSize={9} fontWeight="bold">PR</text>
                        </g>
                      );
                    }}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </Card>
        </>
      )}
      </>}
    </div>
  );
}
