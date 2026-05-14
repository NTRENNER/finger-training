// ─────────────────────────────────────────────────────────────
// SETUP VIEW — curve-trust layout (May 2026)
// ─────────────────────────────────────────────────────────────
// The "Setup" tab. Under the curve-trust philosophy, the F-D curve
// is the source of truth for what to train next. The continuous
// engine (coachingRecommendationContinuous in src/model/coaching.js)
// returns a specific (T, load) prescription rather than snapping to
// one of six fixed zone reference times.
//
// Layout (top to bottom):
//   • Adaptive Warm-up entry card
//   • ClimbingLogCard (collapsed full climb logger — discipline /
//     grade / ascent / wall / RPE; merged here from the retired
//     Climbing tab so all climbing capture lives on Fingers)
//   • SessionRPECard (appears when today has ≥1 climb logged; lets
//     the user confirm or override the derived session fatigue from
//     per-climb RPEs — drives the externalLoadModifier on the
//     next finger-training prescription)
//   • BwPrompt
//   • Grip Type pills (still per-grip; the curve is grip-scoped)
//   • ContinuousPickCard — the primary recommendation:
//       "Train at 92s @ 38 lbs · L 38 / R 37" with optional
//       protocol fine-tune (hangs + rest defaults derived from T).
//       Auto-applies to session config so Start Session uses it.
//   • PrescribedLoadCard — all 6 zones, L/R, anchored prescription
//       (shared with Analysis via src/views/cards/PrescribedLoadCard.js;
//       gated on a grip being selected)
//   • Tindeq Connect slot
//   • Start Session button (single set; multi-set was retired)
//
// Moved to Analysis (May 2026):
//   • CurveCoverageCard — per-zone data freshness. Reference view
//     now lives alongside the F-D chart and PrescribedLoadCard.
//
// Removed in this rewrite:
//   • SessionPlannerCard — 6-zone picker + within/between-set
//     sliders + fatigue chart. Replaced by ContinuousPick.
//   • Coaching Prescription card (per-hand 6-zone L/R grid).
//     Replaced by PrescribedLoadCard's unified single-source layout.
//   • ZoneCoverageCard (Zone Workout Summary). Pure descriptive
//     card not driven by the curve; cut under "all in on curve."
//   • Training Focus inline picker.
//
// Multi-set machinery is fully removed from the data model + runner
// (May 2026). Sessions are single-set; the runner reads
// config.targetTime / config.repsPerSet / config.restTime directly.

import React, { useMemo, useState } from "react";

import { C } from "../ui/theme.js";
import { Card, Btn } from "../ui/components.js";
import { fmt0, toDisp, fromDisp } from "../ui/format.js";

import { loadLS, LS_BW_LOG_KEY, LS_WORKOUT_LOG_KEY } from "../lib/storage.js";
import { today } from "../util.js";
import { WarmupView } from "./WarmupView.js";

import {
  CLIMB_DISCIPLINES, ASCENT_STYLES, BOULDER_WALLS, VENUES,
  gradesFor, defaultGradeFor,
} from "../lib/climbing-grades.js";

// (ZONE_KEYS + lockout imports removed — CurveCoverageCard moved to Analysis.)
// (coachingRecommendationContinuous, computeSessionFatigue, ymdLocal moved
// into SessionPlanCard with the recommended-pick / per-zone-tile
// consolidation. buildThreeExpPriors stays — SetupView still memoizes the
// per-grip priors and threads them through to SessionPlanCard.)
import { buildThreeExpPriors } from "../model/threeExp.js";
import { SessionPlanCard } from "./cards/SessionPlanCard.js";

// ─────────────────────────────────────────────────────────────
// BW PROMPT — stale-body-weight nudge
// ─────────────────────────────────────────────────────────────
// Inline body-weight prompt — shown in session setup when BW is stale
// (>3 days). Exported because WorkoutTab also renders it before its
// session log so users get the same nudge regardless of entry tab.
export function BwPrompt({ unit = "lbs", onSave }) {
  const bwLog  = loadLS(LS_BW_LOG_KEY) || [];
  const latest = bwLog.length ? bwLog[bwLog.length - 1] : null;

  const [editing,  setEditing]  = useState(false);
  const [inputVal, setInputVal] = useState(() =>
    latest ? fmt0(toDisp(latest.kg, unit)) : ""
  );

  // Always render — used to auto-hide when the last log was within
  // the past 3 days, but the card now sits next to ClimbingLogCard
  // as a permanent quick-log surface. The Update button (or ✓ Yes
  // confirm-current shortcut) is the right call to action whether
  // the log is fresh or stale.

  const save = () => {
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
// CLIMBING RPE QUICK-LOG
// ─────────────────────────────────────────────────────────────
// Single-card climb logger — captures everything the user might
// want for one climbing entry: discipline + grade + ascent style
// + wall (boulder only) + RPE.
//
// Merged from the legacy split between ClimbingTab's full logger
// (discipline / grade / ascent / wall) and SetupView's RPE quick-
// log into one card on the Fingers tab when the standalone
// Climbing tab was retired (May 2026). RPE is preserved because
// the lockout system reads it as a climbing-dose signal.
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

function ClimbingLogCard({ activities = [], onLog }) {
  const [open, setOpen]             = useState(false);
  const [discipline, setDiscipline] = useState("boulder");
  const [venue, setVenue]           = useState("indoor");
  const [grade, setGrade]           = useState(defaultGradeFor("boulder"));
  const [ascent, setAscent]         = useState("flash");
  const [wall, setWall]             = useState("commercial");
  const [rpe, setRpe]               = useState(7);
  const [logged, setLogged]         = useState(false);

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

  const handleSave = () => {
    const entry = {
      date: today(), type: "climbing",
      discipline, venue, grade, ascent, rpe,
    };
    if (showWall) entry.wall = wall;
    onLog(entry);
    setLogged(true);
    setOpen(false);
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


// ─────────────────────────────────────────────────────────────
// SETUP VIEW
// ─────────────────────────────────────────────────────────────

export function SetupView({
  config, setConfig, onStart, history,
  freshMap = null,
  // Per-zone learned fatigue gains (App-level memo). Passed straight
  // through to PrescribedLoadCard so the slider's scale-down matches
  // what the runner will actually prescribe.
  personalGains = null,
  unit = "lbs",
  onBwSave = () => {},
  activities = [], onLogActivity = () => {},
  connectSlot = null,
  GOAL_CONFIG = {}, GRIP_PRESETS = [],
  bodyWeight = null, tindeq = null,
}) {
  const [warmupActive, setWarmupActive] = useState(false);

  const handleGrip = (g) => setConfig(c => ({ ...c, grip: g }));

  const threeExpPriors = useMemo(() => buildThreeExpPriors(history), [history]);

  // Adaptive Warm-up takeover — replaces SetupView until closed.
  if (warmupActive) {
    const wLog = loadLS(LS_WORKOUT_LOG_KEY) || [];
    return (
      <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
        <WarmupView
          history={history}
          wLog={wLog}
          bodyWeightKg={bodyWeight}
          tindeq={tindeq}
          unit={unit}
          onClose={() => setWarmupActive(false)}
        />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
      <h2 style={{ margin: "0 0 20px", fontSize: 22, fontWeight: 700 }}>Session Setup</h2>

      {/* Adaptive Warm-up entry point */}
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

      {/* Quick-log row: climbing entry + bodyweight side-by-side.
          Both are session-adjacent inputs that don't belong in the
          main session-config flow but want easy access from Setup
          (climbing for the lockout system, BW for the Analysis tab's
          × BW normalization). BwPrompt has its own staleness guard
          (returns null if logged within the last 3 days) so it auto-
          collapses when the log is fresh. */}
      <ClimbingLogCard activities={activities} onLog={onLogActivity} />
      {/* SessionRPECard ("Session RPE — today") removed May 2026 — its
          only purpose was overriding the per-climb RPE aggregation, and
          the new "How cooked today?" slider on SessionPlanCard captures
          the same intent in a more general / persisted-for-learning way.
          The session_rpe field on activities is still respected by
          climbingFatigue.computeSessionFatigue if it's set elsewhere. */}
      <BwPrompt unit={unit} onSave={onBwSave} />

      {/* Grip Type — still per-grip, the curve is grip-scoped */}
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

      {/* Single unified session-pick surface — RPE slider on top, six
          clickable zone tiles, session details below. Replaces the
          previously-separate ContinuousPickCard + PrescribedLoadCard
          renders. The PrescribedLoadCard component still exists for
          Analysis (retrospective what-if), but Setup goes through this
          consolidated path so the slider, the recommended pick, and the
          per-zone tiles all live in one box and stay in sync. */}
      <SessionPlanCard
        history={history}
        grip={config.grip}
        hand={config.hand}
        freshMap={freshMap}
        threeExpPriors={threeExpPriors}
        activities={activities}
        GOAL_CONFIG={GOAL_CONFIG}
        unit={unit}
        onApplyPlan={(plan) => setConfig(c => ({ ...c, ...plan }))}
        perceivedRpe={config.perceivedRpe ?? 1}
        onPerceivedRpeChange={(v) => setConfig(c => ({ ...c, perceivedRpe: v }))}
        personalGains={personalGains}
      />


      {/* Curve Coverage moved to Analysis tab — it's a per-zone
          reference view, not a session-prep input, so it lives with
          the F-D chart and Prescribed Load card instead of bloating
          the Setup flow. */}

      {/* (BwPrompt moved up to live alongside the climb logger so all
          quick-log inputs sit together near the top of Setup.) */}

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
