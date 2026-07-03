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
  buildRepsVariantSeries,
} from "../model/workout-volume.js";
import {
  loadLS, saveLS, LS_WORKOUT_LOG_KEY, LS_BW_LOG_KEY, LS_BW_NORMALIZE_KEY,
  ROTATION_PIN_KEY,
} from "../lib/storage.js";
import { bwOnDate, toDisp } from "../ui/format.js";
import { migrateExerciseId, buildExerciseDefIndex } from "../model/exerciseIds.js";
import { useLSValue } from "../hooks/useLSValue.js";

// Locally re-declared to match WorkoutTab's storage key (which is
// defined inline there, not exported). Keeping the string literal
// in sync between the two is a small cost for view independence.
const LS_WORKOUT_PLAN_KEY = "ft_workout_plan";

// For one exercise id, walk wLog chronologically and produce
// [{date, top, volume, sessionBw}] points, one per session that
// contained the exercise with at least one done set. Skips rotation-
// pin marker sessions and skips sessions where the exercise had no
// usable data.
//
// `sessionBw` is the bodyweight that prevailed on that session's
// date (via bwOnDate over the BW log). Falls back to `currentBw`
// when no on-or-before entry exists. Stored on each point so the
// × BW chart view divides each session's value by the BW from THAT
// session — a March top-set at 165 lb is normalized by 165, even
// if the user weighs 175 today.
//
// UNIT NOTE: both bwLog entries and the `currentBw` prop are in KG,
// but per-set `weight` values are in DISPLAY units (lbs or kg as the
// user types them). The volume helpers add bw + weight directly, so
// we must convert sessionBw to display units BEFORE handing it in,
// otherwise a 71 kg user with 75 lbs added would get effectiveLoad
// = 71 + 75 = 146 instead of the correct 156.5 + 75 = 231.5.
function buildExerciseSeries(wLog, exId, exDef, currentBw, bwLog, unit) {
  if (!Array.isArray(wLog)) return [];
  const out = [];
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
    // Per-session BW: prefer the log entry on or before this date,
    // fall back to the user's current BW (so brand-new BW logs that
    // postdate old sessions still produce sane numerators). Convert
    // kg → display units so the volume math is unit-consistent.
    const sessionBwKg = bwOnDate(bwLog, s.date)?.kg ?? currentBw ?? null;
    const sessionBw = sessionBwKg != null ? toDisp(sessionBwKg, unit) : null;
    const top = sessionExerciseTopWeight(sets, sessionBw, exDef);
    const vol = sessionExerciseVolume(sets, sessionBw, exDef);
    if (top <= 0 && vol <= 0) continue;
    out.push({ date: s.date, top, volume: vol, workout: s.workout, sessionBw });
  }
  return out;
}

// Reps/variant progression card — for exercises whose progression is
// leverage + reps rather than load (TRX Row's rung ladder, circlesOnly
// exercises like the ab wheel / TRX hamstring curl). Renders total
// done reps per session as a single-axis line; the header carries the
// current variant rung and the ladder move since the first session.
// The weight-based ExerciseCard takes over automatically once a
// session logs real weight (see the cards memo).
function RepsExerciseCard({ ex, series }) {
  if (!series || series.length === 0) return null;
  const first = series[0];
  const last  = series[series.length - 1];
  const dReps = last.reps - first.reps;
  const ladderMoved = first.variant && last.variant && first.variant !== last.variant;
  const data = series.map(p => ({ ...p }));
  return (
    <Card style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{ex.name}</div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
            {series.length} session{series.length === 1 ? "" : "s"} · leverage / reps progression
            {ex.unilateral ? " · unilateral" : ""}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 11, color: C.muted }}>current rung</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.purple }}>
            {last.variant || "—"}
          </div>
          <div style={{ fontSize: 11, color: C.muted }}>
            {last.reps} reps last session
          </div>
          {series.length > 1 && (
            <div style={{ fontSize: 11, color: ladderMoved || dReps > 0 ? C.green : dReps < 0 ? C.red : C.muted }}>
              {ladderMoved
                ? `${first.variant} → ${last.variant} since ${first.date}`
                : `${dReps > 0 ? "+" : ""}${dReps} reps since ${first.date}`}
            </div>
          )}
        </div>
      </div>

      <div style={{ width: "100%", height: 160 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 5, right: 12, left: -8, bottom: 0 }}>
            <CartesianGrid stroke={C.border} strokeDasharray="3 3" />
            <XAxis
              dataKey="date"
              stroke={C.muted}
              tick={{ fontSize: 10, fill: C.muted }}
              tickFormatter={(d) => d?.slice(5) || ""}
            />
            <YAxis
              stroke={C.purple}
              tick={{ fontSize: 10, fill: C.purple }}
              width={30}
              allowDecimals={false}
            />
            <Tooltip
              contentStyle={{ background: C.bg, border: `1px solid ${C.border}`, fontSize: 12 }}
              labelStyle={{ color: C.muted }}
              formatter={(value, name, entry) => [
                `${value} reps${entry?.payload?.variant ? ` · ${entry.payload.variant}` : ""}`,
                "total reps",
              ]}
            />
            <Line
              type="monotone"
              dataKey="reps"
              stroke={C.purple}
              strokeWidth={2}
              dot={{ r: 3, fill: C.purple }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div style={{ fontSize: 10, color: C.muted, marginTop: 6 }}>
        Total done reps per session. Chart switches to weight once you log added load.
      </div>
    </Card>
  );
}

// One Card for one exercise. Header shows current top weight + Δ
// vs first session. Body is a dual-axis line chart.
//
// When `normalizeOn`, every numeric value (chart points, header,
// Δ vs first, footer volume) is divided by the per-session BW
// stored on each series point. Falls back to absolute units for
// any series point missing sessionBw — the chart and the unit
// labels still render coherently.
function ExerciseCard({ ex, series, unit, normalizeOn }) {
  if (series.length === 0) return null;

  // Decide effective values per point. In × BW mode we render the
  // series as multiples of the session's BW (e.g. 1.21x); in
  // Absolute mode we render raw lbs/kg.
  const norm = (v, bw) => (normalizeOn && bw > 0) ? v / bw : v;
  const dispUnit = normalizeOn ? "× BW" : unit;
  // Tooltip / header formatting: ratios get a single decimal,
  // absolutes round to nearest integer (matches the prior look).
  const fmt = (v) => normalizeOn ? v.toFixed(2) : Math.round(v).toString();

  const projected = series.map(p => ({
    ...p,
    top:    norm(p.top, p.sessionBw),
    volume: norm(p.volume, p.sessionBw),
  }));

  const first = projected[0];
  const last  = projected[projected.length - 1];
  const dTop  = last.top - first.top;
  const dVol  = last.volume - first.volume;
  const additive = isBodyweightAdditive(ex);
  const sessionCount = projected.length;

  // Recharts data: in absolute mode round to ints for nicer ticks;
  // in × BW mode preserve two decimals so the curve doesn't snap
  // to flat lines on small ratio differences.
  const data = projected.map(p => ({
    ...p,
    top:    normalizeOn ? Math.round(p.top * 100) / 100    : Math.round(p.top),
    volume: normalizeOn ? Math.round(p.volume * 100) / 100 : Math.round(p.volume),
  }));

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
            {fmt(last.top)} <span style={{ fontSize: 11, color: C.muted, fontWeight: 400 }}>{dispUnit}</span>
          </div>
          {sessionCount > 1 && (
            <div style={{ fontSize: 11, color: dTop > 0 ? C.green : dTop < 0 ? C.red : C.muted }}>
              {dTop > 0 ? "+" : ""}{fmt(dTop)} {dispUnit} since {first.date}
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
                if (name === "Top weight") return [`${value} ${dispUnit}`, name];
                if (name === "Volume")     return [`${value} ${normalizeOn ? "× BW·reps" : `${unit}·reps`}`, name];
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
            volume: {fmt(last.volume)} {normalizeOn ? "× BW·reps" : `${unit}·reps`}
            {dVol !== 0 && (
              <span style={{ color: dVol > 0 ? C.green : C.red, marginLeft: 6 }}>
                ({dVol > 0 ? "+" : ""}{fmt(dVol)})
              </span>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

export function WorkoutAnalysisView({ bodyWeight = null, unit = "lbs", defaultWorkouts = {} }) {
  // Absolute / × BW units toggle — shared LS key with the Fingers
  // sub-tab, so flipping it on either side stays consistent when
  // the user switches between them via the AnalysisContainer pills.
  const [normalizeOn, setNormalizeOn] = useState(() => loadLS(LS_BW_NORMALIZE_KEY) === true);
  const toggleNormalize = () => {
    setNormalizeOn(v => {
      const next = !v;
      saveLS(LS_BW_NORMALIZE_KEY, next);
      return next;
    });
  };

  // BW log — live via useLSValue so entries logged after mount (or
  // merged in by a cloud pull while this tab is open) reach the ×BW
  // charts. Raw snapshots are referentially stable between writes.
  const bwLogRaw = useLSValue(LS_BW_LOG_KEY);
  const bwLog = useMemo(() => bwLogRaw || [], [bwLogRaw]);

  // wLog + plan — live LS reads with the exercise-id migration applied
  // in memos keyed on the raw snapshots. These used to be mount-time
  // useState reads justified by "tab navigation remounts this view",
  // which broke as soon as anything rewrote LS while the tab WAS
  // mounted (manual cloud pull). The migration here is a pure rename
  // pass — no LS writes — so recomputing per write is safe.
  const wLogStored = useLSValue(LS_WORKOUT_LOG_KEY);
  const wLog = useMemo(() => {
    const raw = wLogStored || [];
    return raw.map(s => {
      if (!s?.exercises) return s;
      const migrated = {};
      let changed = false;
      for (const [exId, exData] of Object.entries(s.exercises)) {
        const newId = migrateExerciseId(exId);
        if (newId !== exId) changed = true;
        if (migrated[newId]) continue;
        migrated[newId] = exData;
      }
      return changed ? { ...s, exercises: migrated } : s;
    });
  }, [wLogStored]);

  const planStored = useLSValue(LS_WORKOUT_PLAN_KEY);
  const plan = useMemo(() => {
    // Stored plan with the same id-migration; fall back to defaults
    // if no stored plan exists yet (fresh install). We don't apply
    // the full metadata-merge here — the analysis only reads
    // unilateral/bodyweightAdditive flags, and DEFAULT_WORKOUTS as a
    // fallback already has the canonical values.
    const source = planStored || defaultWorkouts;
    if (!source) return {};
    const out = {};
    for (const [key, wk] of Object.entries(source)) {
      out[key] = {
        ...wk,
        exercises: (wk?.exercises || []).map(ex => {
          const newId = migrateExerciseId(ex.id);
          return newId !== ex.id ? { ...ex, id: newId } : ex;
        }),
      };
    }
    return out;
  }, [planStored, defaultWorkouts]);

  const exIndex = useMemo(() => buildExerciseDefIndex(plan), [plan]);

  // For each exercise in the plan with logWeight=true, build its
  // series. Sort the result by latest-session date DESC so the most
  // recently trained lifts surface first — matches "what did I just
  // do" intent better than a fixed alphabetical or workout-grouped
  // ordering would.
  const cards = useMemo(() => {
    const items = [];
    // Rotation-pin markers are skipped inside buildExerciseSeries;
    // the reps builder is model-pure, so pre-filter here.
    const realSessions = Array.isArray(wLog)
      ? wLog.filter(s => s?.workout !== ROTATION_PIN_KEY)
      : [];
    for (const [exId, exDef] of Object.entries(exIndex)) {
      // Weight chart owns any exercise with actual weighted history.
      // Exercises that progress by leverage/reps (variant ladders,
      // circlesOnly) get a reps card until real weight appears —
      // before this, TRX Row (logWeight but every set weightless on
      // the leverage rungs) never rendered at all (July 2026).
      const chartable = exDef?.logWeight || exDef?.circlesOnly || Array.isArray(exDef?.variants);
      if (!chartable) continue;
      if (exDef?.logWeight) {
        const series = buildExerciseSeries(wLog, exId, exDef, bodyWeight, bwLog, unit);
        if (series.length > 0) {
          items.push({ kind: "weight", exDef, series, lastDate: series[series.length - 1].date });
          continue;
        }
      }
      const repsSeries = buildRepsVariantSeries(realSessions, exId, exDef);
      if (repsSeries.length === 0) continue;
      items.push({ kind: "reps", exDef, series: repsSeries, lastDate: repsSeries[repsSeries.length - 1].date });
    }
    items.sort((a, b) => (b.lastDate || "").localeCompare(a.lastDate || ""));
    return items;
  }, [exIndex, wLog, bodyWeight, bwLog, unit]);

  return (
    <div style={{ padding: "16px 20px", maxWidth: 720, margin: "0 auto" }}>
      {/* Absolute / × BW units toggle. Same two-pill segmented
          control as the Fingers sub-tab; both share LS_BW_NORMALIZE_KEY
          so the choice flows between them. Hidden when no BW is set,
          since the × BW divisor would be missing. */}
      {bodyWeight > 0 && (
        <div style={{ display: "flex", gap: 4, marginBottom: 12, justifyContent: "flex-end" }}>
          {[{ key: false, label: "Absolute" }, { key: true, label: "× BW" }].map(opt => (
            <button key={String(opt.key)} onClick={() => normalizeOn !== opt.key && toggleNormalize()} style={{
              padding: "4px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer", border: "none", fontWeight: 600,
              background: normalizeOn === opt.key ? C.purple : C.border,
              color:      normalizeOn === opt.key ? "#fff"   : C.muted,
            }}>{opt.label}</button>
          ))}
        </div>
      )}

      <Sect title="Lift Progression">
        {cards.length === 0 ? (
          <Card>
            <div style={{ color: C.muted, fontSize: 13 }}>
              No completed lifting sets yet. Log a session in the Workout tab and your
              progression will appear here.
            </div>
          </Card>
        ) : (
          cards.map(({ kind, exDef, series }) => (
            kind === "reps"
              ? <RepsExerciseCard key={exDef.id} ex={exDef} series={series} />
              : <ExerciseCard key={exDef.id} ex={exDef} series={series} unit={unit} normalizeOn={normalizeOn} />
          ))
        )}
      </Sect>
    </div>
  );
}
