// ─────────────────────────────────────────────────────────────
// SETUP VIEW
// ─────────────────────────────────────────────────────────────
// The "Setup" tab — pick a grip, see the coaching recommendation,
// review prescribed loads per zone, set body weight, connect Tindeq,
// and start the session.
//
// Bundles the cards that only ever render here:
//   BwPrompt           — stale-body-weight nudge.
//   SessionPlannerCard — zone picker + within/between-set sliders +
//                        predicted fatigue curve. Takes GOAL_CONFIG
//                        as a prop so it doesn't reach back into App.js.
//   ZoneCoverageCard   — rolling 30-day session count by zone.
//
// Cross-cutting App config (GOAL_CONFIG, GRIP_PRESETS) is passed in
// as props so this module stays decoupled from App.js's constant block.

import React, { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer, LineChart, Line,
  XAxis, YAxis, Tooltip, CartesianGrid,
  ReferenceLine,
} from "recharts";

import { C } from "../ui/theme.js";
import { Card, Btn, Sect } from "../ui/components.js";
import { fmt0, fmtW, toDisp, fromDisp } from "../ui/format.js";

import { loadLS, LS_BW_LOG_KEY, LS_WORKOUT_LOG_KEY } from "../lib/storage.js";
import { WarmupView } from "./WarmupView.js";

import { computeZoneCoverage } from "../model/zones.js";
import { computeLimiterZone } from "../model/limiter.js";
import { predictRepTimes } from "../model/fatigue.js";
import {
  AUC_T_MIN, AUC_T_MAX, computePersonalResponse,
} from "../model/personal-response.js";
import { buildThreeExpPriors } from "../model/threeExp.js";
import {
  empiricalPrescription, prescribedLoad, prescriptionPotential,
  estimateRefWeight,
} from "../model/prescription.js";
import {
  coachingRecommendation, coachingRationale,
} from "../model/coaching.js";
import { TRAINING_FOCUS } from "../model/training-focus.js";

// ─────────────────────────────────────────────────────────────
// BW PROMPT — stale-body-weight nudge
// ─────────────────────────────────────────────────────────────

// Inline body-weight prompt — shown in session setup when BW is stale
// (>3 days). Exported because WorkoutTab also renders it before its
// session log so users get the same nudge regardless of entry tab.
export function BwPrompt({ unit = "lbs", onSave }) {
  const bwLog  = loadLS(LS_BW_LOG_KEY) || [];
  const latest = bwLog.length ? bwLog[bwLog.length - 1] : null;
  const daysSince = latest
    ? Math.floor((Date.now() - new Date(latest.date).getTime()) / 864e5)
    : Infinity;

  const [editing,  setEditing]  = useState(false);
  const [inputVal, setInputVal] = useState(() =>
    latest ? fmt0(toDisp(latest.kg, unit)) : ""
  );

  // Only show if stale or never set
  if (daysSince < 3) return null;

  const save = () => {
    // Integer precision — body weight doesn't need decimal accuracy
    const kg = fromDisp(Math.round(parseFloat(inputVal)), unit);
    if (!isNaN(kg) && kg > 0) { onSave(kg); setEditing(false); }
  };

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
      padding: "10px 14px", borderRadius: 10, marginBottom: 14,
      background: C.card, border: `1px solid ${C.border}`,
    }}>
      <span style={{ fontSize: 16 }}>⚖️</span>
      {!editing ? (
        <>
          <span style={{ flex: 1, fontSize: 13, color: C.muted }}>
            {latest
              ? <>Still <b style={{ color: C.text }}>{fmt0(toDisp(latest.kg, unit))} {unit}</b>?</>
              : <span>Body weight not set</span>}
          </span>
          <button onClick={() => setEditing(true)} style={{
            padding: "5px 12px", borderRadius: 8, border: "none", cursor: "pointer",
            background: C.border, color: C.text, fontSize: 12, fontWeight: 600,
          }}>{latest ? "Update" : "Set"}</button>
          {latest && (
            <button onClick={() => onSave(latest.kg)} style={{
              padding: "5px 12px", borderRadius: 8, border: "none", cursor: "pointer",
              background: C.green + "33", color: C.green, fontSize: 12, fontWeight: 600,
            }}>✓ Yes</button>
          )}
        </>
      ) : (
        <>
          <input
            type="number"
            inputMode="numeric"
            step={1}
            min={30}
            max={500}
            value={inputVal}
            onChange={e => setInputVal(e.target.value)}
            onKeyDown={e => e.key === "Enter" && save()}
            autoFocus
            style={{
              flex: 1, background: C.bg, border: `1px solid ${C.border}`,
              borderRadius: 6, color: C.text, fontSize: 14, padding: "5px 8px",
            }}
          />
          <span style={{ fontSize: 12, color: C.muted }}>{unit}</span>
          <button onClick={save} style={{
            padding: "5px 12px", borderRadius: 8, border: "none", cursor: "pointer",
            background: C.blue, color: "#000", fontSize: 12, fontWeight: 700,
          }}>Save</button>
          <button onClick={() => setEditing(false)} style={{
            padding: "5px 8px", borderRadius: 8, border: "none", cursor: "pointer",
            background: C.border, color: C.muted, fontSize: 12,
          }}>✕</button>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// SESSION PLANNER CARD
// ─────────────────────────────────────────────────────────────
// Zone picker + within/between-set sliders + a small predicted
// fatigue chart. Only consumed by SetupView, but kept as its own
// component because it owns its own form state.

function SessionPlannerCard({ liveEstimate, onApplyPlan, recommendedZone = null, recommendedGrip = null, recommendedLabel = "recommended", recommendedScope = null, recommendedRationale = "", GOAL_CONFIG = {} }) {
  // Default goal to the recommended zone when we know it; fall back to strength
  const initGoal = (recommendedZone && GOAL_CONFIG[recommendedZone]) ? recommendedZone : "strength";
  const [goal,    setGoal]    = useState(initGoal);
  const [numReps, setNumReps] = useState(GOAL_CONFIG[initGoal].repsDefault);
  const [rest,    setRest]    = useState(GOAL_CONFIG[initGoal].restDefault);
  const [numSets,  setNumSets]  = useState(GOAL_CONFIG[initGoal].setsDefault);
  const [setRestS, setSetRestS] = useState(GOAL_CONFIG[initGoal].setRestDefault);

  const handleGoal = (g) => {
    setGoal(g);
    setNumReps(GOAL_CONFIG[g].repsDefault);
    setRest(GOAL_CONFIG[g].restDefault);
    setNumSets(GOAL_CONFIG[g].setsDefault);
    setSetRestS(GOAL_CONFIG[g].setRestDefault);
  };

  // Follow `recommendedZone` when it changes (e.g. user picked a
  // different Training Focus in Settings, or switched grip). Without
  // this, `goal` stayed stuck at whatever was recommended on first
  // mount, and the "Why X" header drifted out of sync with the
  // actually-recommended zone shown by the pill.
  useEffect(() => {
    if (recommendedZone && GOAL_CONFIG[recommendedZone] && recommendedZone !== goal) {
      handleGoal(recommendedZone);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recommendedZone]);

  const gc = GOAL_CONFIG[goal];
  const firstRepTime = gc.refTime;

  const repTimes = useMemo(
    () => predictRepTimes({ numReps, firstRepTime, restSeconds: rest }),
    [numReps, firstRepTime, rest]
  );

  const chartData = repTimes.map((t, i) => ({ rep: i + 1, time: t }));
  const tail = repTimes.length > 1 ? Math.round((repTimes[repTimes.length - 1] / firstRepTime) * 100) : 100;

  // Total session volume: sum of all predicted hold times across all sets
  const totalVolume = Math.round(repTimes.reduce((s, t) => s + t, 0) * numSets);

  return (
    <Card style={{ marginBottom: 16, border: `1px solid ${gc.color}40` }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>🗓 Session Planner</div>
          {recommendedScope && (
            <div style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>
              Recommendation for <span style={{ color: C.text, fontWeight: 600 }}>{recommendedScope}</span>
            </div>
          )}
        </div>
        {recommendedGrip && (
          <div style={{
            fontSize: 10, fontWeight: 700, letterSpacing: 0.3,
            padding: "2px 8px", borderRadius: 10,
            background: gc.color + "22", color: gc.color,
          }}>
            {recommendedGrip}
          </div>
        )}
      </div>

      {/* Goal picker */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        {Object.entries(GOAL_CONFIG).map(([key, g]) => {
          const isRec = key === recommendedZone;
          return (
            <button key={key} onClick={() => handleGoal(key)} style={{
              flex: 1, padding: "8px 4px", borderRadius: 10, cursor: "pointer",
              background: goal === key ? g.color : C.border,
              color: goal === key ? "#fff" : C.muted,
              fontWeight: 700, fontSize: 12, transition: "all 0.15s",
              border: isRec ? `2px solid ${g.color}` : "2px solid transparent",
              position: "relative",
            }}>
              {isRec && (
                <div style={{
                  position: "absolute", top: -8, left: "50%", transform: "translateX(-50%)",
                  fontSize: 9, fontWeight: 700, background: g.color, color: "#fff",
                  padding: "1px 5px", borderRadius: 6, whiteSpace: "nowrap",
                }}>
                  {recommendedLabel}
                </div>
              )}
              <div style={{ fontSize: 16 }}>{g.emoji}</div>
              <div style={{ marginTop: 2 }}>{g.label}</div>
            </button>
          );
        })}
      </div>

      {/* Coaching rationale — explains WHY this zone was recommended,
          combining the gap diagnostic with recency/external-load/focus
          context. Only shown when there's something meaningful to say
          (rationale string non-empty). */}
      {recommendedRationale && (
        <div style={{
          fontSize: 11, color: C.muted, marginBottom: 12,
          padding: "8px 10px", background: C.bg, borderRadius: 8,
          border: `1px solid ${gc.color}33`, lineHeight: 1.5,
        }}>
          <span style={{ color: gc.color, fontWeight: 700 }}>Why {gc.label}: </span>
          {recommendedRationale}
        </div>
      )}

      {/* Prescription summary strip */}
      <div style={{
        display: "flex", gap: 6, marginBottom: 14,
        background: C.bg, borderRadius: 10, padding: "10px 14px", alignItems: "center",
      }}>
        {[
          { label: "First rep",  value: `${firstRepTime}s` },
          { label: "Reps",       value: numReps },
          { label: "Sets",       value: numSets },
          { label: "Rep rest",   value: `${rest}s` },
          { label: "Set rest",   value: `${setRestS}s` },
        ].map(({ label, value }, i, arr) => (
          <React.Fragment key={label}>
            <div style={{ textAlign: "center", flex: 1 }}>
              <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: gc.color }}>{value}</div>
            </div>
            {i < arr.length - 1 && <div style={{ color: C.border, fontSize: 16 }}>·</div>}
          </React.Fragment>
        ))}
      </div>

      {/* Sliders — within-set structure */}
      <Sect title="Within Set">
        <div style={{ display: "flex", gap: 16, marginBottom: 4 }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.muted, marginBottom: 4 }}>
              <span>Reps</span><span style={{ fontWeight: 700, color: C.text }}>{numReps}</span>
            </div>
            <input type="range" min={2} max={12} value={numReps} onChange={e => setNumReps(Number(e.target.value))}
              style={{ width: "100%", accentColor: gc.color }} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.muted, marginBottom: 4 }}>
              <span>Rep rest</span><span style={{ fontWeight: 700, color: C.text }}>{rest}s</span>
            </div>
            <input type="range" min={5} max={300} step={5} value={rest} onChange={e => setRest(Number(e.target.value))}
              style={{ width: "100%", accentColor: gc.color }} />
          </div>
        </div>
      </Sect>

      {/* Sliders — between-set structure */}
      <Sect title="Between Sets">
        <div style={{ display: "flex", gap: 16, marginBottom: 4 }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.muted, marginBottom: 4 }}>
              <span>Sets</span><span style={{ fontWeight: 700, color: C.text }}>{numSets}</span>
            </div>
            <input type="range" min={1} max={8} value={numSets} onChange={e => setNumSets(Number(e.target.value))}
              style={{ width: "100%", accentColor: gc.color }} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.muted, marginBottom: 4 }}>
              <span>Set rest</span><span style={{ fontWeight: 700, color: C.text }}>{setRestS}s</span>
            </div>
            <input type="range" min={60} max={1800} step={60} value={setRestS} onChange={e => setSetRestS(Number(e.target.value))}
              style={{ width: "100%", accentColor: gc.color }} />
          </div>
        </div>
      </Sect>

      {/* Sets rationale */}
      <div style={{
        background: gc.color + "12", borderLeft: `3px solid ${gc.color}`,
        borderRadius: "0 8px 8px 0", padding: "8px 12px", marginBottom: 14,
        fontSize: 12, color: C.muted, lineHeight: 1.6,
      }}>
        {gc.setsRationale}
      </div>

      {/* Predicted fatigue curve (within one set) */}
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>
        Predicted hold time per rep · tail at <b style={{ color: gc.color }}>{tail}%</b>
        &nbsp;· total volume ~<b style={{ color: gc.color }}>{totalVolume}s</b> across {numSets} set{numSets !== 1 ? "s" : ""}
      </div>
      <ResponsiveContainer width="100%" height={130}>
        <LineChart data={chartData} margin={{ top: 4, right: 12, bottom: 24, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
          <XAxis dataKey="rep" tick={{ fill: C.muted, fontSize: 11 }}
            label={{ value: "Rep (within set)", position: "insideBottom", offset: -14, fill: C.muted, fontSize: 11 }} />
          <YAxis tick={{ fill: C.muted, fontSize: 10 }} unit="s" width={34} domain={[0, firstRepTime * 1.15]} />
          <ReferenceLine y={firstRepTime} stroke={C.border} strokeDasharray="4 2" />
          <Tooltip
            contentStyle={{ background: C.card, border: `1px solid ${C.border}`, fontSize: 12 }}
            formatter={(val) => [`${val}s`, "Hold"]}
          />
          <Line dataKey="time" stroke={gc.color} strokeWidth={2.5}
            dot={{ fill: gc.color, r: 4, strokeWidth: 0 }} name="Hold" />
        </LineChart>
      </ResponsiveContainer>

      {/* CTA */}
      <Btn
        onClick={() => onApplyPlan({
          goal,
          targetTime: firstRepTime, repsPerSet: numReps, restTime: rest,
          numSets, setRestTime: setRestS,
        })}
        color={gc.color}
        style={{ width: "100%", marginTop: 12, padding: "12px 0", borderRadius: 10, fontSize: 14, fontWeight: 700 }}
      >
        Use This Plan →
      </Btn>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────
// ZONE COVERAGE CARD
// Rolling 30-day count of Power / Strength / Endurance sessions.
// ─────────────────────────────────────────────────────────────

// Zone Workout Summary — neutral 30-day volume breakdown. Does NOT
// prescribe training: the SessionPlanner owns the recommendation
// (per-grip Monod cross-zone residual). This card is purely a log.
// computeZoneCoverage still returns .recommended because the planner
// uses it as a fallback when there's too little failure data for the
// curve-residual signal; we just don't display that prescription here.
function ZoneCoverageCard({ history, activities = [] }) {
  const coverage = useMemo(() => computeZoneCoverage(history, activities),
    [history, activities]); // eslint-disable-line react-hooks/exhaustive-deps

  if (coverage.total === 0) return null;

  const zones = [
    { key: "power",     label: "⚡ Power",     val: coverage.power,     color: "#e05560" },
    { key: "strength",  label: "💪 Strength",  val: coverage.strength,  color: "#e07a30" },
    { key: "endurance", label: "🏔️ Endurance",  val: coverage.endurance, color: "#3b82f6" },
  ];
  const maxVal = Math.max(coverage.power, coverage.strength, coverage.endurance, 1);

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>Zone Workout Summary</div>
        <div style={{ fontSize: 11, color: C.muted }}>last 30 days · {coverage.total} sessions</div>
      </div>
      {zones.map(({ key, label, val, color }) => (
        <div key={key} style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
            <div style={{ fontSize: 12, color: C.muted, display: "flex", alignItems: "center", gap: 6 }}>
              {label}
            </div>
            <div style={{ fontSize: 12, fontWeight: 600, color: C.muted }}>{val}</div>
          </div>
          <div style={{ height: 6, background: C.border, borderRadius: 3, overflow: "hidden" }}>
            <div style={{
              height: "100%", borderRadius: 3,
              width: `${(val / maxVal) * 100}%`,
              background: color,
              opacity: 0.85,
            }} />
          </div>
        </div>
      ))}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────
// SETUP VIEW
// ─────────────────────────────────────────────────────────────

export function SetupView({ config, setConfig, onStart, history, freshMap = null, unit = "lbs", onBwSave = () => {}, liveEstimate = null, gripEstimates = {}, activities = [], onLogActivity = () => {}, connectSlot = null, GOAL_CONFIG = {}, GRIP_PRESETS = [], trainingFocus = "balanced", onTrainingFocusChange = () => {}, bodyWeight = null }) {

  // Warm-up sub-state — when true, the entire SetupView is replaced by
  // the WarmupView until the user closes it. Adaptive Warm-up lives on
  // the Fingers tab because it's a finger-training prep tool (uses the
  // grippers and your force curves), not a strength-training session.
  const [warmupActive, setWarmupActive] = useState(false);

  const handleGrip = (g) => setConfig(c => ({ ...c, grip: g }));

  // Note: model-prescribed first-rep loads are computed inline in the
  // Prescribed Load card below, where we show all three zones at once
  // (F = CF + W'/refTime(zone)). The fallback chain there is:
  //   1. per-hand × per-grip failure fit (most specific)
  //   2. per-hand, any-grip failure fit (more data, less specific)
  //   3. historical weighted-average weight at similar target time

  // (Level/journey progress vars removed — the Setup-page summary card
  // that consumed these now lives on the Journey tab. nextLevelTarget,
  // calcLevel, getBestLoad are still used elsewhere in the app.)

  // Fatigue-adjusted load index for the prescribed-load card (computed once
  // per history change, then reused across the multiple prescribedLoad calls
  // in the card below). Uses the user's back-fit dose constant when there's
  // enough within-set data; otherwise falls back to the population prior.
  // Stable fingerprint so the 60-step grid search inside fitDoseK
  // doesn't re-run on every history reference change (Supabase syncs,
  // unrelated state updates that touch the App-level history array).
  // Keyed on length + last rep's id + last rep's date — captures the
  // dominant "new rep added" case. Edits to old reps will use the
  // stale k until the next session, which is fine since k varies
  // gently with sample size and the fatigue model isn't sensitive to
  // small k shifts (CV² minimum is broad — see fitDoseK).
  // freshMap is now provided by App via prop so the in-workout
  // startSession path uses the SAME memoized fatigue map (with the
  // user-fitted doseK) — without that sharing, the Setup-card
  // prescription and the in-workout "Rep 1 suggested weight" disagreed
  // by 1-2 lbs because startSession was falling back to DEF_DOSE_K.
  // Three-exp prior memo stays local to SetupView since it isn't
  // currently consumed elsewhere.
  const threeExpPriors = useMemo(() => buildThreeExpPriors(history), [history]); // eslint-disable-line react-hooks/exhaustive-deps

  // Engine recommendation, computed once and shared between the
  // Session Planner card (which uses it for the recommended-zone
  // pill + Why box) and the Coaching Prescription card (which
  // contrasts it with the raw curve gap so the two views read as
  // complementary information instead of competing claims).
  const coachRec = useMemo(
    () => (config.grip
      ? coachingRecommendation(history, config.grip, {
          freshMap, threeExpPriors,
          activities,
          trainingFocus,
        })
      : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [history, config.grip, freshMap, threeExpPriors, activities, trainingFocus]
  );

  // Resolve the active focus once for the picker card. Falls back to
  // the Balanced entry for unknown / missing keys so the panel always
  // has something to render even if the LS-stored value drifts.
  const currentFocus = TRAINING_FOCUS[trainingFocus] ?? TRAINING_FOCUS.balanced;

  // ── Adaptive Warm-up takeover ──
  // When the user taps "Generate" on the warm-up entry card below, the
  // entire SetupView is replaced by WarmupView until they close it.
  // wLog is read fresh from localStorage rather than threaded through
  // App state — keeps the warm-up decoupled from WorkoutTab's lifecycle.
  if (warmupActive) {
    const wLog = loadLS(LS_WORKOUT_LOG_KEY) || [];
    return (
      <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
        <WarmupView
          history={history}
          wLog={wLog}
          bodyWeightKg={bodyWeight}
          onClose={() => setWarmupActive(false)}
        />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
      <h2 style={{ margin: "0 0 20px", fontSize: 22, fontWeight: 700 }}>Session Setup</h2>

      {/* ── Adaptive Warm-up entry point ──
          Force-curve-derived hangs + cross-loaded pullups generated on
          the fly. Lives on Fingers (not Workout) because it's a finger-
          training prep tool, not a strength-training session. Nothing
          here gets logged as training data — pure prescription. */}
      <Card style={{ marginBottom: 16, border: `1px solid ${C.purple}40` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 2 }}>Adaptive Warm-up</div>
            <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.4 }}>
              Force-curve-derived hangs + cross-loaded pullups. Same feel every session, never near failure.
            </div>
          </div>
          <button
            onClick={() => setWarmupActive(true)}
            style={{
              background: C.purple, color: "#fff", border: "none", borderRadius: 8,
              padding: "10px 18px", fontSize: 13, fontWeight: 700, cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            Generate
          </button>
        </div>
      </Card>

      {/* Training Focus picker — same selector as Settings, surfaced
          here so the user can see and adjust the bias right where the
          coaching prescription is generated. The description below
          the pills explains both the climbing style and the per-zone
          weighting effect, so a tap on a focus key gives immediate
          feedback about how recommendations will shift. The full
          version (with radio rows + extra context) still lives in
          Settings; this is the in-flow micro-version. */}
      <Card>
        {/* Card title in the 14/700 normal-case style that matches
            Zone Workout Summary, Coaching prescription, etc. — Sect's
            11px uppercase variant is reserved for subsections inside
            a multi-section Card. */}
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>Training Focus</div>
        <div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
            {Object.entries(TRAINING_FOCUS).map(([key, focus]) => {
              const selected = trainingFocus === key;
              return (
                <button
                  key={key}
                  onClick={() => onTrainingFocusChange(key)}
                  style={{
                    padding: "6px 12px", borderRadius: 16,
                    fontSize: 12, fontWeight: 600, cursor: "pointer",
                    background: selected ? C.blue : C.border,
                    color:      selected ? "#fff" : C.muted,
                    border: "none",
                    transition: "background 0.15s",
                  }}
                >
                  {focus.label}
                </button>
              );
            })}
          </div>
          <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.55 }}>
            <div style={{ marginBottom: 6 }}>
              <span style={{ color: C.text, fontWeight: 700 }}>{currentFocus.label}:</span>{" "}
              {currentFocus.description}
            </div>
            <div style={{ fontStyle: "italic" }}>
              {currentFocus.coachingImpact}
            </div>
          </div>
        </div>
      </Card>

      <Card>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>Grip Type</div>
        <div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
            {GRIP_PRESETS.map(g => (
              <button
                key={g}
                onClick={() => handleGrip(g)}
                style={{
                  padding: "6px 14px", borderRadius: 20, fontSize: 13,
                  cursor: "pointer", fontWeight: 500,
                  // C.blue (app's primary-accent color) for the selected
                  // grip pill — orange is reserved for the gap-color
                  // semantics (negative gap = "you're outpacing the
                  // curve") and using it here as a generic "active"
                  // marker leaked that meaning into an unrelated UI.
                  background: config.grip === g ? C.blue : C.border,
                  color: config.grip === g ? "#fff" : C.muted,
                  border: "none",
                }}
              >
                {g}
              </button>
            ))}
          </div>
        </div>
      </Card>

      {/* Zone Workout Summary — neutral 30-day volume breakdown (no prescription) */}
      {/* (Level / journey card removed from setup — lives on the Journey tab now.) */}

      {(history.length > 0 || activities.length > 0) && <ZoneCoverageCard history={history} activities={activities} />}

      {/* Session Planner — always shown; defaults to the limiter zone
          (Monod cross-zone residual: the zone that falls farthest
          below the curve fit on the other two zones' rep-1 failures
          in the last 30 days), falling back to coverage when failure
          data is too sparse for the cross-zone fit. Matches the
          Analysis tab's precedence so the two views never disagree. */}
      {(() => {
        // Coaching engine v2: pick the next zone based on
        //   gap × intensity_match × recency × external_load
        // Falls back to the legacy heuristic chain when there's no grip
        // selected or no scoreable zones (cold start with no data).
        const gripFit = config.grip && gripEstimates[config.grip];
        const fitForRec = gripFit ?? liveEstimate;
        const scopeLabel = gripFit ? config.grip : (config.grip ? `${config.grip} (pooled)` : "overall");

        let zone = null;
        let label = "recommended";
        let rationale = "";
        let recommendedGrip = null;

        // coachRec lifted above the JSX so the Coaching Prescription
        // card below can also read it for the balanced-vs-goal-adjusted
        // contrast in its widestGap callout.
        if (coachRec) {
          zone = coachRec.zone;
          recommendedGrip = config.grip;
          // Label captures the dominant reason (gap > 10% → "biggest gap",
          // else fall through to "recommended" as a neutral default).
          label = coachRec.gap > 0.10 ? "biggest gap" : "recommended";
          rationale = coachingRationale(coachRec);
        } else {
          // Legacy fallback: limiter → coverage → ΔAUC.
          const limiter = computeLimiterZone(history);
          recommendedGrip = limiter?.grip ?? null;
          if (fitForRec && fitForRec.CF > 0) {
            const { CF, W } = fitForRec;
            const response = computePersonalResponse(history);
            let bestKey = null, bestGain = -Infinity;
            for (const [key, resp] of Object.entries(response)) {
              const gain = CF * resp.cf * (AUC_T_MAX - AUC_T_MIN)
                         + W  * resp.w  * Math.log(AUC_T_MAX / AUC_T_MIN);
              if (gain > bestGain) { bestGain = gain; bestKey = key; }
            }
            zone = bestKey;
            label = "biggest gain (cold start)";
          } else if (limiter?.zone) {
            zone = limiter.zone;
            label = "limiter";
          } else {
            const cov = computeZoneCoverage(history, activities);
            if (cov.total > 0) {
              zone = cov.recommended;
              label = "least trained";
            }
          }
        }

        return (
          <SessionPlannerCard
            GOAL_CONFIG={GOAL_CONFIG}
            liveEstimate={fitForRec}
            recommendedZone={zone}
            recommendedGrip={recommendedGrip}
            recommendedLabel={label}
            recommendedScope={scopeLabel}
            recommendedRationale={rationale}
            onApplyPlan={({ goal, targetTime, repsPerSet, restTime, numSets, setRestTime }) =>
              setConfig(c => ({ ...c, goal, targetTime, repsPerSet, restTime, numSets, setRestTime }))
            }
          />
        );
      })()}

      {/* Prescribed load — appears once a grip is selected. Shows loads
          for ALL THREE zones side-by-side so the user doesn't have to
          guess which target time the card is reflecting. Load for each
          zone = CF + W'/refTime(zone). Load is CONSTANT across all reps
          of a set: rep 1 hits target, rep 2+ fall short as compartments
          drain. Source label reflects whichever fit (per-grip / cross-
          grip / history) backs the primary zone column. */}
      {config.grip && (() => {
        // Coaching prescription: empirical-first (anchored to user's
        // most recent rep 1 outcome at this exact scope), with the
        // curve-derived "potential" shown alongside as a diagnostic
        // ceiling. The GAP between train-at and potential is the
        // training opportunity — biggest gap = weakest compartment
        // relative to the rest of the user's physiology.
        //
        // Three sources of truth per cell:
        //   - TRAIN AT: empirical or curve-fallback (the load to use)
        //   - POTENTIAL: curve ceiling (Monod or three-exp consensus)
        //   - GAP: (potential − train_at) / train_at as percentage
        //
        // Reliability tiers gate the potential display:
        //   well-supported → show numeric potential confidently
        //   marginal → show potential with "models disagree" caveat
        //   extrapolation → don't show numeric, suggest training the zone

        const cellFor = (hand, t) => {
          // Empirical-first: anchored to user's most recent rep 1
          const emp = empiricalPrescription(history, hand, config.grip, t, { threeExpPriors });
          let trainAt, source;
          if (emp != null) {
            trainAt = emp;
            source = "empirical";
          } else {
            // Cold start: fall back to the curve. Try per-grip first,
            // then cross-grip, then historical average.
            const v1 = prescribedLoad(history, hand, config.grip, t, freshMap, { threeExpPriors });
            if (v1 != null) { trainAt = v1; source = "curve-grip"; }
            else {
              const v2 = prescribedLoad(history, hand, null, t, freshMap, { threeExpPriors });
              if (v2 != null) { trainAt = v2; source = "curve-global"; }
              else {
                const v3 = estimateRefWeight(history, hand, config.grip, t);
                if (v3 != null) { trainAt = v3; source = "history"; }
                else return { trainAt: null, source: null, potential: null };
              }
            }
          }
          // Potential ceiling — curve-derived, with reliability tier.
          const potential = prescriptionPotential(history, hand, config.grip, t, {
            freshMap, threeExpPriors,
          });
          return { trainAt, source, potential };
        };

        const zones = ["power", "strength", "endurance"].map(zoneKey => {
          const t = GOAL_CONFIG[zoneKey].refTime;
          const L = cellFor("L", t);
          const R = cellFor("R", t);
          return { key: zoneKey, cfg: GOAL_CONFIG[zoneKey], t, L, R };
        });
        const anyLoaded = zones.some(z => z.L.trainAt != null || z.R.trainAt != null);
        if (!anyLoaded) return null;

        // Find the widest reliable gap across all (zone, hand) cells —
        // that's the recommendation engine's "biggest leverage" pointer.
        let widestGap = null;
        for (const z of zones) {
          for (const [handLabel, cell] of [["L", z.L], ["R", z.R]]) {
            if (!cell.potential || !cell.trainAt) continue;
            if (cell.potential.reliability === "extrapolation") continue;
            const gap = (cell.potential.value - cell.trainAt) / cell.trainAt;
            if (widestGap == null || gap > widestGap.gap) {
              widestGap = { zoneKey: z.key, zoneLabel: z.cfg.label, hand: handLabel, gap, cell };
            }
          }
        }

        // Label + color helpers.
        //
        // gap = (potential − train_at) / train_at. We render it not
        // as a signed number (which made "-12%" read like a warning)
        // but as one of two phrased badges:
        //
        //   "room +X%"  → positive gap: curve thinks you can lift more
        //                 than you're being prescribed. Action: push
        //                 harder here. Color escalates with magnitude:
        //                 muted → yellow → orange → red as the gap
        //                 widens, because a big room-to-grow signal is
        //                 a clear "do something about this" prompt.
        //   "ahead +X%" → negative gap: your demonstrated work is
        //                 already exceeding the curve's prediction.
        //                 This is the win state — your physiology
        //                 has outpaced what the failure-driven fit
        //                 has captured. Color: green (positive signal).
        //   "on target" → |gap| < 5%. Well-calibrated. Muted.
        //
        // Earlier convention used signed text ("gap -12%") and inverted
        // the color logic (green for positive room-to-grow, orange for
        // "ahead"). That was technically defensible — green = "training
        // opportunity direction" — but read backwards to most users
        // because negative numbers in orange feel like alarms. New
        // version flips both: positive numbers + words on every cell,
        // green for the genuinely-good "ahead" state.
        // Signed-percent — kept for the widestGap callout above the
        // cells, which reads as a sentence ("Power — +12% headroom").
        const fmtPct = (g) => `${g >= 0 ? "+" : ""}${Math.round(g * 100)}%`;
        const labelFor = (g) => {
          if (Math.abs(g) < 0.05) return "on target";
          const pct = Math.round(Math.abs(g) * 100);
          return g > 0 ? `room +${pct}%` : `ahead +${pct}%`;
        };
        const gapColor = (g) => {
          if (Math.abs(g) < 0.05) return C.muted;
          if (g >= 0.20) return C.red;
          if (g >= 0.10) return C.orange;
          if (g >  0)    return C.yellow;
          return C.green;  // any negative gap = ahead of curve = good
        };

        // All-zones-exceeding detector: when every (zone × hand) cell
        // has reliable potential AND actual > potential by ≥3%, the
        // model's curve has collectively been outpaced and the per-cell
        // numbers stop being useful as individual training prompts.
        // Surface a single recalibration-pending banner instead.
        let allCells = 0;
        let exceedingCells = 0;
        for (const z of zones) {
          for (const cell of [z.L, z.R]) {
            if (!cell.potential || !cell.trainAt) continue;
            if (cell.potential.reliability === "extrapolation") continue;
            allCells++;
            const g = (cell.potential.value - cell.trainAt) / cell.trainAt;
            if (g < -0.03) exceedingCells++;
          }
        }
        const allZonesExceeding = allCells >= 4 && exceedingCells === allCells;

        return (
          <Card style={{ borderColor: C.blue }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 2 }}>
              Coaching prescription · {config.grip}
            </div>
            {/* Subtitle clarifies this card is the DETAILED per-hand
                reference — the Analysis tab's "Next Session Focus"
                cards show the actionable per-grip summary. Same data,
                two scopes; the headers now state which is which so
                users don't read them as competing recommendations. */}
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 10 }}>
              Per-hand reference · the Analysis tab's <b>Next Session Focus</b> shows the per-grip summary.
            </div>

            {/* All-zones-exceeding banner: when every reliable cell
                is meaningfully above its modeled potential, individual
                "ahead +X%" badges stop being actionable signals (they
                just say "everything is great" everywhere). One banner
                tells the real story — your physiology has outrun the
                model and the curve needs new failure data to catch up. */}
            {allZonesExceeding && (
              <div style={{
                padding: "10px 12px", marginBottom: 12,
                background: C.green + "1a",
                border: `1px solid ${C.green}80`,
                borderRadius: 8, fontSize: 12, lineHeight: 1.5, color: C.text,
              }}>
                <div style={{ fontWeight: 700, color: C.green, marginBottom: 3 }}>
                  Curve recalibration pending
                </div>
                Your performance has outpaced the model in every zone.
                The curve will catch up as new failure data comes in —
                push to genuine failure on a probe session to give the
                fit a fresh ceiling to work with.
              </div>
            )}

            {widestGap && widestGap.gap > 0.10 && (() => {
              // Two complementary perspectives shown side by side:
              //   1. Largest raw curve gap — what a "balanced athlete"
              //      view of the data points at. Pure (potential − train_at)
              //      / train_at, no goal weighting.
              //   2. Goal-adjusted recommendation — what the engine
              //      actually picks, which factors in recency, residual
              //      fit, intensity match, external load, and the user's
              //      Training Focus from Settings.
              //
              // When they agree, the second line collapses to "matches
              // above" for brevity. When they differ, the user sees both
              // signals + understands why they diverge instead of treating
              // them as competing claims.
              const recZone = coachRec?.zone;
              const recLabel = recZone ? GOAL_CONFIG[recZone]?.label : null;
              const focusKey = coachRec?.trainingFocus;
              const focusLabel = focusKey && focusKey !== "balanced"
                ? TRAINING_FOCUS[focusKey]?.label
                : null;
              const matches = recZone && recZone === widestGap.zoneKey;
              return (
                <div style={{ fontSize: 12, color: C.text, background: widestGap.cell.cfg?.color + "20" || C.bg,
                              border: `1px solid ${gapColor(widestGap.gap)}66`, borderRadius: 8,
                              padding: "10px 12px", marginBottom: 10 }}>
                  <div>
                    <span style={{ fontWeight: 700, color: gapColor(widestGap.gap) }}>Balanced · largest curve gap:</span>{" "}
                    {widestGap.zoneLabel} — <b>{fmtPct(widestGap.gap)}</b> headroom{" "}
                    ({widestGap.zoneKey === "power" ? "fast (PCr)" : widestGap.zoneKey === "strength" ? "middle (glycolytic)" : "slow (oxidative)"} compartment).
                  </div>
                  {recZone && (
                    <div style={{ marginTop: 6 }}>
                      <span style={{ fontWeight: 700, color: GOAL_CONFIG[recZone]?.color }}>
                        {focusLabel ? `Per your ${focusLabel} focus` : "Goal-adjusted pick"}:
                      </span>{" "}
                      {matches
                        ? <>matches above — the Session Planner picks <b>{recLabel}</b>.</>
                        : <>Session Planner picks <b>{recLabel}</b>: your actual reps there fall below the curve, so this will have the biggest impact.</>}
                    </div>
                  )}
                  {!recZone && (
                    <div style={{ marginTop: 6, fontStyle: "italic", color: C.muted }}>
                      The Session Planner above weighs this against recency, residual fit, and your training focus before picking — see its Why box for the final call.
                    </div>
                  )}
                </div>
              );
            })()}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
              {zones.map(({ key, cfg, t, L, R }) => {
                const isActive = config.goal === key;
                return (
                  <div
                    key={key}
                    style={{
                      padding: "10px 12px",
                      background: isActive ? cfg.color + "22" : C.bg,
                      border: `1px solid ${isActive ? cfg.color : C.border}`,
                      borderRadius: 10,
                    }}
                  >
                    <div style={{ fontSize: 11, fontWeight: 700, color: cfg.color, marginBottom: 2 }}>
                      {cfg.emoji} {cfg.label}
                    </div>
                    <div style={{ fontSize: 10, color: C.muted, marginBottom: 8 }}>
                      target {t}s
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      {[["L", L], ["R", R]].map(([handLabel, cell]) => {
                        const sourceMark = cell.source === "curve-global" ? "°"
                                         : cell.source === "history" ? "ʰ"
                                         : cell.source === "curve-grip" ? "*"
                                         : "";
                        const sourceTitle = cell.source === "curve-global"
                            ? `Cold start: not enough recent ${config.grip} data on ${handLabel} at ${t}s, falling back to cross-grip curve.`
                          : cell.source === "history"
                            ? `Cold start: no model fit available, using historical average on ${handLabel} ${config.grip} at ${t}s.`
                          : cell.source === "curve-grip"
                            ? `Cold start: no recent rep 1 at this target, using ${config.grip} curve fit on ${handLabel}.`
                            : `Empirical: anchored to your most recent rep 1 on ${handLabel} ${config.grip} at ${t}s, with RPE 10 progression.`;
                        const pot = cell.potential;
                        const gap = (pot && cell.trainAt && pot.reliability !== "extrapolation")
                          ? (pot.value - cell.trainAt) / cell.trainAt : null;
                        return (
                          <div key={handLabel} style={{ flex: 1 }}>
                            <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5 }}>{handLabel}</div>
                            <div style={{ fontSize: 16, fontWeight: 700, color: C.blue }} title={sourceTitle}>
                              {cell.trainAt != null ? `${fmtW(cell.trainAt, unit)}` : "—"}
                              {sourceMark && (
                                <span style={{ fontSize: 11, color: C.yellow, marginLeft: 2 }}>
                                  {sourceMark}
                                </span>
                              )}
                            </div>
                            {pot && pot.reliability !== "extrapolation" && (
                              <div style={{ fontSize: 9, color: C.muted, marginTop: 3 }}>
                                pot {pot.reliability === "marginal"
                                  ? `${fmtW(pot.lower, unit)}–${fmtW(pot.upper, unit)}`
                                  : fmtW(pot.value, unit)}
                                {pot.reliability === "marginal" && (
                                  <span title="Monod and three-exp models disagree at this duration — treat the range as the credible band, not a precise number." style={{ color: C.yellow, marginLeft: 2 }}>
                                    ?
                                  </span>
                                )}
                              </div>
                            )}
                            {pot && pot.reliability === "extrapolation" && (
                              <div style={{ fontSize: 9, color: C.muted, marginTop: 3, fontStyle: "italic" }} title={`No failure data within ±50% of ${t}s — the curve is extrapolating. Train this zone to anchor it.`}>
                                pot ?
                              </div>
                            )}
                            {gap != null && (
                              <div style={{ fontSize: 9, fontWeight: 600, color: gapColor(gap), marginTop: 2 }}
                                   title={`train-at ${fmtW(cell.trainAt, unit)} vs potential ${fmtW(pot.value, unit)}. ${gap > 0.10 ? "Push harder here — the curve says you have room." : gap < -0.03 ? "You're outperforming the curve at this zone — model will catch up as new failure data comes in." : "Well-calibrated."}`}>
                                {labelFor(gap)}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
            {/* Potential/Gap key — placed below the cells so the data
                lands first and the labels read as a confirming legend.
                Each term gets its own row so the bolded label always
                starts a fresh line at the left margin instead of
                tucking in after the previous sentence's period. */}
            <div style={{ fontSize: 11, color: C.muted, marginTop: 10, fontStyle: "italic", lineHeight: 1.5 }}>
              <div>
                <b style={{ color: C.text, fontStyle: "normal" }}>Potential</b> = what the curve says you could support if your physiology were balanced.
              </div>
              <div style={{ marginTop: 4 }}>
                <b style={{ color: C.text, fontStyle: "normal" }}>Room +X%</b> = the curve says you can lift more — a training opportunity worth pushing into.
              </div>
              <div style={{ marginTop: 4 }}>
                <b style={{ color: C.green, fontStyle: "normal" }}>Ahead +X%</b> = your demonstrated work is exceeding the curve's prediction. The model will catch up as you generate more failure data.
              </div>
            </div>
            <div style={{ fontSize: 10, color: C.muted, marginTop: 8, display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <span>
                <span style={{ color: C.muted }}>* = curve fallback (no recent rep 1) · ° = cross-grip · ʰ = historical avg · ? = uncertain potential</span>
              </span>
              <span>values in {unit}</span>
            </div>
          </Card>
        );
      })()}

      <BwPrompt unit={unit} onSave={onBwSave} />

      {/* Tindeq Connect slot — rendered just above the Start button */}
      {connectSlot}

      <Btn
        onClick={onStart}
        disabled={!config.grip}
        style={{ width: "100%", padding: "16px 0", fontSize: 17, borderRadius: 12 }}
      >
        {config.grip ? "Start Session →" : "Select a grip to start"}
      </Btn>
    </div>
  );
}
