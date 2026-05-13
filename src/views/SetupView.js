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

import React, { useEffect, useMemo, useState } from "react";

import { C } from "../ui/theme.js";
import { Card, Btn } from "../ui/components.js";
import { fmt0, fmtW, toDisp, fromDisp } from "../ui/format.js";

import { loadLS, LS_BW_LOG_KEY, LS_WORKOUT_LOG_KEY } from "../lib/storage.js";
import { today } from "../util.js";
import { WarmupView } from "./WarmupView.js";

import {
  CLIMB_DISCIPLINES, ASCENT_STYLES, BOULDER_WALLS, VENUES,
  gradesFor, defaultGradeFor,
} from "../lib/climbing-grades.js";

// (ZONE_KEYS + lockout imports removed — CurveCoverageCard moved to Analysis.)
import { buildThreeExpPriors } from "../model/threeExp.js";
import { coachingRecommendationContinuous } from "../model/coaching.js";
import { computeSessionFatigue } from "../model/climbingFatigue.js";
import { ymdLocal } from "../util.js";
import { PrescribedLoadCard } from "./cards/PrescribedLoadCard.js";

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
// SESSION RPE CARD — confirm/override the derived session fatigue
// ─────────────────────────────────────────────────────────────
// Appears when today has ≥1 climb logged. Shows the per-climb-RPE
// derived session fatigue 1-10 (model/climbingFatigue.js formula)
// and lets the user override with a single slider. Confirming
// writes the override to every today's climb row via onSetSessionRPE,
// which App.js fans out as a session_rpe update + cloud push.
//
// Why the override matters: one max-effort attempt at RPE 9 leaves
// you fresh, an hour of moderate RPE 7 volume leaves you cooked.
// The formula handles the obvious cases but human judgment captures
// things the math can't (sleep, food, route reading load).
function SessionRPECard({ activities, onSetSessionRPE }) {
  const today = ymdLocal();
  const todaysClimbs = useMemo(
    () => (activities || []).filter(a => a?.type === "climbing" && a.date === today),
    [activities, today]
  );

  // Existing override (Phase B) on any of today's rows wins over
  // the derived value, mirroring how the engine reads them.
  const existingOverride = useMemo(() => {
    for (const a of todaysClimbs) {
      const sr = Number(a.session_rpe);
      if (Number.isFinite(sr) && sr >= 1 && sr <= 10) return Math.round(sr);
    }
    return null;
  }, [todaysClimbs]);

  const derived = useMemo(
    () => computeSessionFatigue(activities, today),
    [activities, today]
  );

  // User's working value while editing. Starts at the existing
  // override if set, otherwise the derived default.
  const initial = existingOverride ?? derived ?? 5;
  const [val, setVal] = useState(initial);
  // Reset working value when today's climbs change (new climb logged,
  // override committed, etc.). Cheap to just re-pin to the latest.
  useEffect(() => { setVal(initial); }, [initial]);

  if (todaysClimbs.length === 0) return null;

  const dirty = val !== initial;
  const status = existingOverride != null
    ? `Set to ${existingOverride}`
    : `Derived from ${todaysClimbs.length} climb${todaysClimbs.length === 1 ? "" : "s"}`;

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>Session RPE — today</div>
        <div style={{ fontSize: 32, fontWeight: 800, color: C.purple, lineHeight: 1 }}>
          {val}<span style={{ fontSize: 12, color: C.muted, fontWeight: 400, marginLeft: 2 }}>/10</span>
        </div>
      </div>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 10 }}>
        {status}. How shot are you now? Drives how much the engine scales finger
        training in the next 48h.
      </div>
      <input
        type="range" min="1" max="10" step="1"
        value={val}
        onChange={e => setVal(Number(e.target.value))}
        style={{ width: "100%", accentColor: C.purple, marginBottom: 8 }}
      />
      {dirty && (
        <Btn
          onClick={() => onSetSessionRPE(today, val)}
          color={C.green}
          style={{ width: "100%" }}
        >
          {existingOverride != null ? "Update" : "Confirm"} Session RPE
        </Btn>
      )}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────
// CONTINUOUS PICK CARD — the new primary prescription surface
// ─────────────────────────────────────────────────────────────
// The continuous engine returns a specific (T, load) pair anywhere
// in [5s, 240s]. This card surfaces it and lets the user fine-tune
// the protocol (number of hangs, rest between hangs) before starting.
// Sets default to 1 and setRest to 0 — the workout flow assumes
// single-set sessions.
//
// Defaults for hangs/rest are derived from zoneOf(T_star), so a
// short-T pick (max strength territory) gets the longer-rest /
// fewer-hangs profile, and a long-T pick (endurance) gets shorter
// rest. The user can override via the customize toggle.
//
// onApplyPlan auto-fires whenever the recommendation changes, so the
// session config below the card always reflects the current pick.
// The Start Session button at the bottom of SetupView then launches
// straight into the recommended session — single-tap go.
function ContinuousPickCard({
  history, grip, freshMap, threeExpPriors,
  activities = [],
  GOAL_CONFIG, unit, onApplyPlan,
  hand = "Both",  // session config's selected hand — drives the total-time math
}) {
  const rec = useMemo(
    () => grip
      ? coachingRecommendationContinuous(history, grip, { freshMap, threeExpPriors, activities })
      : null,
    [history, grip, freshMap, threeExpPriors, activities]
  );

  // Derive default protocol from T_star.
  //
  // REPS — continuous linear interpolation in T:
  //   reps(T) = round(6 - (T - 5) / 117.5), clamped to [4, 6]
  // Endpoints: T = 5s → 6 hangs (max strength territory),
  //            T = 240s → 4 hangs (endurance). Mid-T (~70-180s) → 5.
  // Smooth function of T matches the curve-trust philosophy: a 29s
  // pick and a 31s pick give the same rep count; no surprise jumps
  // at zone boundaries.
  //
  // REST — flat 20s between reps, always (user preference, May 2026).
  // The earlier per-zone lookup gave 60-180s depending on the zone.
  // The user trains short rests across the board (Grip Gains style),
  // so the default is constant and simpler. Override via the always-
  // visible rest slider if a longer rest is wanted for a specific
  // session. (The altMode L↔R interleaving the runner used to support
  // when restTime ≥ targetTime was retired with the multi-set model
  // in the same May 2026 wave — Both-mode now does the full L set
  // first, then the full R set. See useSessionRunner.)
  const zoneCfg = rec ? GOAL_CONFIG[rec.zone] : null;
  const defaultReps = rec
    ? Math.max(4, Math.min(6, Math.round(6 - (rec.T - 5) / 117.5)))
    : 5;
  const defaultRest = 20;

  const [reps, setReps] = useState(defaultReps);
  const [rest, setRest] = useState(defaultRest);
  // `userOverride` flips on any time the user touches a protocol
  // slider. While true, the auto-reset on T/zone changes won't
  // clobber the user's manual choice. (No UI toggle exposes this —
  // it's purely state management for the always-visible sliders.)
  const [userOverride, setUserOverride] = useState(false);

  // When the recommendation changes (new grip, new history), reset
  // reps/rest to the new zone's defaults — unless the user has
  // explicitly overridden in this session.
  useEffect(() => {
    if (!userOverride) {
      setReps(defaultReps);
      setRest(defaultRest);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec?.T, rec?.zone]);

  // Switching grips clears the override so fresh defaults flow
  // back in. Avoids carrying a stale Crusher rest into Micro.
  useEffect(() => {
    setUserOverride(false);
  }, [grip]);

  // Auto-apply to session config so Start Session uses the pick.
  // Fires whenever the resolved plan changes (T, reps, rest, grip).
  useEffect(() => {
    if (!rec) return;
    onApplyPlan({
      goal: rec.zone,
      targetTime: rec.T,
      repsPerSet: reps,
      restTime: rest,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec?.T, rec?.zone, reps, rest]);

  if (!grip) {
    return (
      <Card style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>Recommended Session</div>
        <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
          Pick a grip above to see your continuous prescription.
        </div>
      </Card>
    );
  }

  if (!rec) {
    return (
      <Card style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>Recommended Session</div>
        <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
          Need at least 2 reps on this grip to fit a curve. Run a
          probe session at any duration to get started — the engine
          will pick a target as soon as the curve has data to anchor.
        </div>
      </Card>
    );
  }

  const cfg = zoneCfg ?? { color: C.blue, label: "—", emoji: "🎯" };

  // Why-text: explain the AUC-gain pick. Three axes drive the score —
  // adaptation room (limiter / at ceiling), staleness, and recency.
  // Surface whichever is doing the heavy lifting for this T so the
  // user can see the rationale matches the F-D chart visually.
  const whyParts = [];
  const room = rec.room ?? (1 - (rec.localRatio ?? 1));
  if (rec.adaptBoost != null && rec.adaptBoost > 1.15) {
    const pct = Math.round(room * 100);
    whyParts.push(`reps near here fall ~${pct}% below the curve — biggest AUC-gain opportunity`);
  } else if (rec.adaptBoost != null && rec.adaptBoost > 1.05) {
    whyParts.push("reps near here sit slightly below the curve");
  } else if (rec.adaptBoost != null && rec.adaptBoost < 0.85) {
    whyParts.push("you're at or above the curve everywhere — picked here on staleness alone");
  }
  if (rec.staleStatus === "stale") {
    whyParts.push(`${rec.zone.replace(/_/g, " ")} zone is past its detraining window — re-anchor the curve here`);
  } else if (rec.staleStatus === "never") {
    whyParts.push(`never trained at this duration — exploring it anchors the curve`);
  } else if (rec.staleStatus === "warning") {
    whyParts.push(`${rec.zone.replace(/_/g, " ")} zone is approaching stale — keep it fresh`);
  }
  if (rec.recency != null && rec.recency < 0.5) {
    whyParts.push("zone partially recovered — lighter dose is fine");
  }
  if (rec.ext != null && rec.ext < 0.85) {
    const pct = Math.round((1 - rec.ext) * 100);
    whyParts.push(`recent climbing ~${pct}% scale-down on this zone`);
  }
  if (whyParts.length === 0) {
    whyParts.push("curve is well-calibrated locally; this T scores best on staleness × recency");
  }
  const whyText = whyParts.join(" · ");

  const loadL = rec.loadByHand?.L;
  const loadR = rec.loadByHand?.R;
  const zoneLabel = zoneCfg?.label ?? rec.zone;

  return (
    <Card style={{ marginBottom: 16, border: `1px solid ${cfg.color}66` }}>
      {/* Header — recommendation summary */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>
          Recommended Session · {grip}
        </div>
        <div style={{
          fontSize: 10, fontWeight: 700, letterSpacing: 0.3,
          padding: "2px 8px", borderRadius: 10,
          background: cfg.color + "22", color: cfg.color,
        }}>
          {cfg.emoji} {zoneLabel} range
        </div>
      </div>

      {/* The big number — T_star + load */}
      <div style={{
        display: "flex", alignItems: "baseline", gap: 16,
        padding: "14px 16px", marginTop: 8, marginBottom: 10,
        background: C.bg, borderRadius: 10,
      }}>
        <div style={{ flex: 1, textAlign: "center" }}>
          <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5 }}>Target</div>
          <div style={{ fontSize: 32, fontWeight: 800, color: cfg.color, lineHeight: 1 }}>
            {rec.T}<span style={{ fontSize: 14, color: C.muted, marginLeft: 2 }}>s</span>
          </div>
        </div>
        <div style={{ flex: 1, textAlign: "center" }}>
          <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5 }}>Load</div>
          <div style={{ fontSize: 32, fontWeight: 800, color: C.blue, lineHeight: 1 }}>
            {fmtW(rec.loadKg, unit)}<span style={{ fontSize: 12, color: C.muted, marginLeft: 4 }}>{unit}</span>
          </div>
          {(loadL != null || loadR != null) && (
            <div style={{ fontSize: 10, color: C.muted, marginTop: 4 }}>
              {loadL != null && <>L {fmtW(loadL, unit)}</>}
              {loadL != null && loadR != null && " · "}
              {loadR != null && <>R {fmtW(loadR, unit)}</>}
            </div>
          )}
        </div>
      </div>

      {/* Why-text */}
      <div style={{
        fontSize: 12, color: C.muted, lineHeight: 1.5,
        padding: "8px 10px", background: cfg.color + "0d",
        border: `1px solid ${cfg.color}33`, borderRadius: 8,
        marginBottom: 12,
      }}>
        <span style={{ color: cfg.color, fontWeight: 700 }}>Why: </span>
        {whyText}
      </div>

      {/* Protocol summary strip — current reps/rest at a glance.
          The "Time" cell is elapsed clock time including rests
          (formerly labeled "Total" in seconds, which read as
          time-under-tension). Doubled for Both-mode since the
          runner does the full L set then the full R set; suffix
          " (both)" makes the doubling visible at a glance. */}
      {(() => {
        const perHandSec = reps * rec.T + (reps - 1) * rest;
        const both = hand === "Both";
        const totalSec = both ? perHandSec * 2 : perHandSec;
        const m = Math.floor(totalSec / 60);
        const s = totalSec % 60;
        const timeStr = `~${m}:${String(s).padStart(2, "0")}${both ? " (both)" : ""}`;
        return (
      <div style={{
        display: "flex", gap: 6, marginBottom: 12,
        background: C.bg, borderRadius: 10, padding: "10px 14px", alignItems: "center",
      }}>
        {[
          { label: "Hangs", value: reps },
          { label: "Rest",  value: `${rest}s` },
          { label: "Time",  value: timeStr },
        ].map(({ label, value }, i, arr) => (
          <React.Fragment key={label}>
            <div style={{ textAlign: "center", flex: 1 }}>
              <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: cfg.color }}>{value}</div>
            </div>
            {i < arr.length - 1 && <div style={{ color: C.border, fontSize: 16 }}>·</div>}
          </React.Fragment>
        ))}
      </div>
        );
      })()}

      {/* Protocol options — always visible. Defaults track the
          recommendation; sliders override locally and stick until
          the user picks a different grip. */}
      <div style={{ display: "flex", gap: 16, marginBottom: 6 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.muted, marginBottom: 4 }}>
            <span>Hangs</span><span style={{ fontWeight: 700, color: C.text }}>{reps}</span>
          </div>
          <input type="range" min={2} max={12} value={reps}
            onChange={e => { setReps(Number(e.target.value)); setUserOverride(true); }}
            style={{ width: "100%", accentColor: cfg.color }} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.muted, marginBottom: 4 }}>
            <span>Rest</span><span style={{ fontWeight: 700, color: C.text }}>{rest}s</span>
          </div>
          <input type="range" min={5} max={300} step={5} value={rest}
            onChange={e => { setRest(Number(e.target.value)); setUserOverride(true); }}
            style={{ width: "100%", accentColor: cfg.color }} />
        </div>
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────
// SETUP VIEW
// ─────────────────────────────────────────────────────────────

export function SetupView({
  config, setConfig, onStart, history,
  freshMap = null,
  unit = "lbs",
  onBwSave = () => {},
  activities = [], onLogActivity = () => {},
  onSetSessionRPE = () => {},
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
      <SessionRPECard activities={activities} onSetSessionRPE={onSetSessionRPE} />
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

      {/* Continuous Pick — the new primary recommendation surface.
          Auto-applies to session config so Start Session uses it. */}
      <ContinuousPickCard
        history={history}
        grip={config.grip}
        hand={config.hand}
        freshMap={freshMap}
        threeExpPriors={threeExpPriors}
        activities={activities}
        GOAL_CONFIG={GOAL_CONFIG}
        unit={unit}
        onApplyPlan={(plan) => setConfig(c => ({ ...c, ...plan }))}
      />

      {/* Prescribed Load — all 6 zones, both hands, for the selected
          grip. Same component / data Analysis renders; surfaced here
          too so you can see the suggestion in context across the
          whole curve before starting. Hidden until a grip is picked
          (cross-grip pooled prescriptions aren't meaningful). */}
      {config.grip && (
        <PrescribedLoadCard
          history={history}
          grip={config.grip}
          freshMap={freshMap}
          threeExpPriors={threeExpPriors}
          activities={activities}
          unit={unit}
          GOAL_CONFIG={GOAL_CONFIG}
        />
      )}

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
