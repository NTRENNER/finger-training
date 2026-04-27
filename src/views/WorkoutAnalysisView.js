// ─────────────────────────────────────────────────────────────
// WORKOUT ANALYSIS (LIFTS) VIEW
// ─────────────────────────────────────────────────────────────
// Top-level "Lifts" tab — long-term progression view for the
// strength side of training, separate from the finger Analysis tab
// (which is Tindeq-only) and from the Workout tab (which is the
// active session / plan editor).
//
// One Card per exercise, each showing a dual-axis line chart:
//   * left axis (blue): top weight per session
//   * right axis (orange): total volume per session
// Plus a small header row with current values and Δ vs first session.
//
// Data source: wLog (loaded by App, passed in). Only exercises that
// (a) have logWeight=true on their exDef and (b) have at least one
// session with a done set are rendered — empty exercises are skipped
// so the page doesn't show a wall of empty cards.

import React, { useMemo, useState } from "react";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from "recharts";
import { C } from "../ui/theme.js";
import { Card, Sect } from "../ui/components.js";
import {
  sessionExerciseTopWeight, sessionExerciseVolume, isBodyweightAdditive,
} from "../model/workout-volume.js";
import { loadLS, LS_WORKOUT_LOG_KEY, ROTATION_PIN_KEY } from "../lib/storage.js";

// Locally re-declared to match WorkoutTab's storage key (which is
// defined inline there, not exported). Keeping the string literal
// in sync between the two is a small cost for view independence.
const LS_WORKOUT_PLAN_KEY = "ft_workout_plan";

// Throwaway ID-migration map (mirror of the one in WorkoutTab) so a
// stale local plan or wLog with old `ohp` / `hammer_curls` keys still
// resolves to the modern exercise definitions. Same logic as in
// WorkoutTab.js — duplicated here so this view stays self-contained.
const ID_MIGRATIONS = { ohp: "kb_press", hammer_curls: "bicep_curls" };
const migrateId = (id) => ID_MIGRATIONS[id] || id;

// Build a flat lookup of every known exercise definition from the
// workout plan. First definition encountered for an id wins.
function buildExDefIndex(plan) {
  const index = {};
  for (const wk of Object.values(plan || {})) {
    for (const ex of (wk?.exercises || [])) {
      if (!ex?.id) continue;
      if (index[ex.id]) continue;
      index[ex.id] = ex;
    }
  }
  return index;
}

// For one exercise id, walk wLog chronologically and produce
// [{date, top, volume}] points, one per session that contained the
// exercise with at least one done set. Skips rotation-pin marker
// sessions and skips sessions where the exercise had no usable data.
function buildExerciseSeries(wLog, exId, exDef, bw) {
  if (!Array.isArray(wLog)) return [];
  const out = [];
  // Sort by date ASC (then completedAt ASC) so the chart reads
  // left-to-right oldest-to-newest. wLog can be in any order in
  // localStorage; we never rely on insertion order.
  const sorted = [...wLog].sort((a, b) => {
    const ad = a?.date || "";
    const bd = b?.date || "";
    if (ad !== bd) return ad.localeCompare(bd);
    return (a?.completedAt || "").localeCompare(b?.completedAt || "");
  });
  for (const s of sorted) {
    if (!s || s.workout === ROTATION_PIN_KEY) continue;
    const sets = s?.exercises?.[exId]?.sets;
    if (!Array.isArray(sets) || sets.length === 0) continue;
    if (!sets.some(set => set && set.done)) continue;
    const top = sessionExerciseTopWeight(sets, bw, exDef);
    const vol = sessionExerciseVolume(sets, bw, exDef);
    if (top <= 0 && vol <= 0) continue;
    out.push({ date: s.date, top, volume: vol, workout: s.workout });
  }
  return out;
}

// One Card for one exercise. Header shows current top weight + Δ
// vs first session. Body is a dual-axis line chart.
function ExerciseCard({ ex, series, unit }) {
  if (series.length === 0) return null;
  const first = series[0];
  const last  = series[series.length - 1];
  const dTop  = last.top - first.top;
  const dVol  = last.volume - first.volume;
  const additive = isBodyweightAdditive(ex);
  const sessionCount = series.length;

  // Recharts wants numeric Y values. Use rounded ints for nicer ticks.
  const data = series.map(p => ({ ...p, top: Math.round(p.top), volume: Math.round(p.volume) }));

  return (
    <Card style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{ex.name}</div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
            {sessionCount} session{sessionCount === 1 ? "" : "s"}
            {additive ? " · bodyweight + added" : ""}
            {ex.unilateral ? " · unilateral (top side)" : ""}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 11, color: C.muted }}>top</div>
          <div style={{ fontSize: 17, fontWeight: 700, color: C.blue }}>
            {Math.round(last.top)} <span style={{ fontSize: 11, color: C.muted, fontWeight: 400 }}>{unit}</span>
          </div>
          {sessionCount > 1 && (
            <div style={{ fontSize: 11, color: dTop > 0 ? C.green : dTop < 0 ? C.red : C.muted }}>
              {dTop > 0 ? "+" : ""}{Math.round(dTop)} {unit} since {first.date}
            </div>
          )}
        </div>
      </div>

      <div style={{ width: "100%", height: 180 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 5, right: 12, left: -8, bottom: 0 }}>
            <CartesianGrid stroke={C.border} strokeDasharray="3 3" />
            <XAxis
              dataKey="date"
              stroke={C.muted}
              tick={{ fontSize: 10, fill: C.muted }}
              tickFormatter={(d) => d?.slice(5) || ""}  // MM-DD
            />
            <YAxis
              yAxisId="left"
              stroke={C.blue}
              tick={{ fontSize: 10, fill: C.blue }}
              width={36}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              stroke={C.orange}
              tick={{ fontSize: 10, fill: C.orange }}
              width={42}
            />
            <Tooltip
              contentStyle={{ background: C.bg, border: `1px solid ${C.border}`, fontSize: 12 }}
              labelStyle={{ color: C.muted }}
              formatter={(value, name) => {
                if (name === "Top weight") return [`${value} ${unit}`, name];
                if (name === "Volume")     return [`${value} ${unit}·reps`, name];
                return [value, name];
              }}
            />
            <Legend
              wrapperStyle={{ fontSize: 11, paddingTop: 4 }}
              iconType="line"
              iconSize={10}
            />
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="top"
              name="Top weight"
              stroke={C.blue}
              strokeWidth={2}
              dot={{ r: 3, fill: C.blue }}
              isAnimationActive={false}
            />
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="volume"
              name="Volume"
              stroke={C.orange}
              strokeWidth={2}
              strokeDasharray="4 3"
              dot={{ r: 3, fill: C.orange }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {sessionCount > 1 && (
        <div style={{ display: "flex", gap: 16, marginTop: 8, fontSize: 11, color: C.muted }}>
          <div>
            <span style={{ color: C.orange }}>● </span>
            volume: {Math.round(last.volume)} {unit}·reps
            {dVol !== 0 && (
              <span style={{ color: dVol > 0 ? C.green : C.red, marginLeft: 6 }}>
                ({dVol > 0 ? "+" : ""}{Math.round(dVol)})
              </span>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

export function WorkoutAnalysisView({ bodyWeight = null, unit = "lbs", defaultWorkouts = {} }) {
  // Load wLog + plan once on mount. Each tab navigation away unmounts
  // this view, so on next mount we re-read fresh from localStorage —
  // no need for a sync effect or shared App-level state.
  const [wLog] = useState(() => {
    const raw = loadLS(LS_WORKOUT_LOG_KEY) || [];
    return raw.map(s => {
      if (!s?.exercises) return s;
      const migrated = {};
      let changed = false;
      for (const [exId, exData] of Object.entries(s.exercises)) {
        const newId = migrateId(exId);
        if (newId !== exId) changed = true;
        if (migrated[newId]) continue;
        migrated[newId] = exData;
      }
      return changed ? { ...s, exercises: migrated } : s;
    });
  });

  const [plan] = useState(() => {
    // Load stored plan with same id-migration; fall back to defaults
    // if no stored plan exists yet (fresh install). We don't apply
    // the full metadata-merge here — the analysis only reads
    // unilateral/bodyweightAdditive flags, and DEFAULT_WORKOUTS as a
    // fallback already has the canonical values.
    const stored = loadLS(LS_WORKOUT_PLAN_KEY);
    const source = stored || defaultWorkouts;
    if (!source) return {};
    const out = {};
    for (const [key, wk] of Object.entries(source)) {
      out[key] = {
        ...wk,
        exercises: (wk?.exercises || []).map(ex => {
          const newId = migrateId(ex.id);
          return newId !== ex.id ? { ...ex, id: newId } : ex;
        }),
      };
    }
    return out;
  });

  const exIndex = useMemo(() => buildExDefIndex(plan), [plan]);

  // For each exercise in the plan with logWeight=true, build its
  // series. Sort the result by latest-session date DESC so the most
  // recently trained lifts surface first — matches "what did I just
  // do" intent better than a fixed alphabetical or workout-grouped
  // ordering would.
  const cards = useMemo(() => {
    const items = [];
    for (const [exId, exDef] of Object.entries(exIndex)) {
      if (!exDef?.logWeight) continue;
      const series = buildExerciseSeries(wLog, exId, exDef, bodyWeight);
      if (series.length === 0) continue;
      items.push({ exDef, series, lastDate: series[series.length - 1].date });
    }
    items.sort((a, b) => (b.lastDate || "").localeCompare(a.lastDate || ""));
    return items;
  }, [exIndex, wLog, bodyWeight]);

  return (
    <div style={{ padding: "16px 20px", maxWidth: 720, margin: "0 auto" }}>
      <Sect title="Lift Progression">
        {cards.length === 0 ? (
          <Card>
            <div style={{ color: C.muted, fontSize: 13 }}>
              No completed lifting sets yet. Log a session in the Workout tab and your
              progression will appear here.
            </div>
          </Card>
        ) : (
          cards.map(({ exDef, series }) => (
            <ExerciseCard key={exDef.id} ex={exDef} series={series} unit={unit} />
          ))
        )}
      </Sect>
    </div>
  );
}
