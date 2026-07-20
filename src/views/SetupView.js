// ──────────────────────────────────────────────────────────────
// SETUP VIEW — curve-trust layout (May 2026)
// ──────────────────────────────────────────────────────────────
// The "Setup" tab. Under the curve-trust philosophy, the F-D curve
// is the source of truth for what to train next. The continuous
// engine (coachingRecommendationContinuous in src/model/coaching.js)
// returns a specific (T, load) prescription rather than snapping
// to one of six fixed zone reference times.
//
// Layout (top to bottom):
//   • Grip Type pills — per-grip; the curve is grip-scoped.
//   • SessionPlanCard — the unified plan surface. It hosts:
//       - The recommended (T, load) pick from the continuous engine
//       - A 6-zone tile grid with anchored loads (was PrescribedLoadCard)
//       - The "how cooked today?" slider feeding adaptive RPE
//       - A per-session climb-fatigue confirm/override (was
//         SessionRPECard) when today has ≥1 climb logged
//       - Climbing-focus pill that surfaces non-balanced focus
//     Replaces three previously separate cards (ContinuousPickCard,
//     PrescribedLoadCard, SessionRPECard).
//   • Tindeq Connect slot
//   • Start Session button — single set; multi-set was retired.
//   • BwPrompt — inline body-weight nudge, pinned to the bottom to
//     match the Workout tab.
//
// Moved to Analysis (May 2026):
//   • CurveCoverageCard — per-zone data freshness + annual session
//     pace. Belongs with the diagnostic view, not the prescription.
//
// Removed entirely:
//   • SessionPlannerCard — 6-zone picker + within/between-set
//     sliders + fatigue chart. The continuous engine replaced it.
//   • Coaching Prescription card (per-hand 6-zone L/R grid).
//     Folded into SessionPlanCard's tile grid.
//   • ZoneCoverageCard (Zone Workout Summary). Pure descriptive
//     card not driven by the curve; cut under "all in on curve."
//   • Training Focus inline picker. Replaced by climbing-focus
//     selector at the App level.
//   • PrescribedLoadCard.js (the standalone component) — merged
//     into SessionPlanCard as the tile grid.
//
// Multi-set machinery is fully removed from the data model + runner
// (May 2026). Sessions are single-set; the runner reads
// config.targetTime / config.repsPerSet / config.restTime directly.
//
// ClimbingLogCard was hosted on this view between May 2026 (when the
// dedicated Climbing tab was retired) and late May 2026 (when the
// Climb tab was re-extracted). It now lives in src/views/ClimbView.js;
// activities still flow through SetupView for SessionPlanCard's
// today-climb fatigue read, but the capture UI no longer sits here.

import React, { useMemo, useState } from "react";

import { C } from "../ui/theme.js";
import { Card, Btn } from "../ui/components.js";
import { fmt0, toDisp, fromDisp } from "../ui/format.js";

import { loadLS, saveLS, LS_BW_LOG_KEY, LS_WORKOUT_LOG_KEY, LS_DELOAD_WEEK_KEY } from "../lib/storage.js";
import { useLSValue } from "../hooks/useLSValue.js";
import { today } from "../util.js";

import { buildThreeExpPriors } from "../model/threeExp.js";
import { computeDeload, buildDeloadGuidance, DELOAD_WEEK_DAYS } from "../model/deload.js";
import { SessionPlanCard } from "./cards/SessionPlanCard.js";
import { TendonCard } from "./cards/TendonCard.jsx";
import { maxTestStaleness, MAX_TEST_TARGET_S, MAX_TEST_ATTEMPTS } from "../model/peakForce.js";
import { DeloadBanner } from "./cards/DeloadBanner.jsx";

// ────────────────────────────────────────────────────────────────
// BW PROMPT — stale-body-weight nudge
// ────────────────────────────────────────────────────────────────
// Inline body-weight prompt — shown in session setup when BW is stale
// (>3 days). Exported because WorkoutTab also renders it before its
// session log so users get the same nudge regardless of entry tab.
export function BwPrompt({ unit = "lbs", onSave }) {
  // Live subscription — replaces a loadLS call that re-parsed the
  // whole BW log JSON on EVERY render and still went stale between
  // renders (a cloud pull rewriting the log didn't re-render this).
  // Now onSave's write path lands back here immediately, so the
  // "Still X lbs?" line and the loggedToday gate update on the spot.
  const bwLog  = useLSValue(LS_BW_LOG_KEY) || [];
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

  // "Logged today" gates the ✓ Yes button: once the latest log entry
  // is today's date, the button grays out to "Logged today" so the
  // user gets visual confirmation that their tap registered (without
  // this, the prompt re-rendered the same "Still 157 lbs?" view with
  // no visible change, leading to repeated clicks). Update stays
  // available for actually changing the weight today.
  const loggedToday = !!latest && latest.date === today();

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
            <button
              onClick={loggedToday ? undefined : () => onSave(latest.kg)}
              disabled={loggedToday}
              title={loggedToday ? "Already logged today — tap Update to change" : "Confirm today's weight"}
              style={{
                padding: "5px 12px", borderRadius: 8, border: "none",
                cursor: loggedToday ? "default" : "pointer",
                background: loggedToday ? C.border : C.green + "33",
                color:      loggedToday ? C.muted : C.green,
                fontSize: 12, fontWeight: 600,
                opacity: loggedToday ? 0.7 : 1,
              }}
            >
              {loggedToday ? "✓ Logged today" : "✓ Yes"}
            </button>
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


// ────────────────────────────────────────────────────────────────
// SETUP VIEW
// ────────────────────────────────────────────────────────────────

export function SetupView({
  config, setConfig, onStart, history,
  freshMap = null,
  // Per-grip β fatigue model from user_settings. Passed through to
  // SessionPlanCard so the slider's scale-down preview matches what
  // the runner will actually prescribe.
  fatigueModel = null,
  unit = "lbs",
  onBwSave = () => {},
  // activities is still consumed (SessionPlanCard reads today's climb
  // log for adaptive RPE). Climb capture moved to the Climb tab in
  // late May 2026; SetupView no longer owns the logging surface, so
  // onLogActivity isn't accepted here anymore.
  activities = [],
  connectSlot = null,
  GOAL_CONFIG = {}, GRIP_PRESETS = [],
  // Cloud-synced training-goal bias for the coaching engine
  // ("balanced" default; bouldering / power_endurance / endurance).
  // Threaded to SessionPlanCard which passes it to the engine.
  climbingFocus = "balanced",
  // Tab-switch callback used by SessionPlanCard's focus pill to jump
  // to Settings when the user wants to change their climbing focus.
  onNavigateToSettings,
}) {
  const handleGrip = (g) => setConfig(c => ({ ...c, grip: g }));

  const threeExpPriors = useMemo(() => buildThreeExpPriors(history), [history]);

  // ── Deload detection + weekly plan ──
  // Cross-grip recovery decline (personal taus) + lifting-volume
  // context. The lifting log lives in localStorage in exactly the
  // shape computeDeload expects. Evaluated as of the real current date
  // so the staleness guard works. Detect/explain/propose only — the
  // accepted "deload week" is a volume-cap reminder, not a silent load
  // scale-down.
  const todayStr = today();
  const deloadState = useMemo(
    () => computeDeload(history, loadLS(LS_WORKOUT_LOG_KEY) || [], { today: todayStr }),
    [history, todayStr]
  );

  // Accepted deload-week state (device-local). Active for DELOAD_WEEK_DAYS.
  const [deloadWeek, setDeloadWeek] = useState(() => loadLS(LS_DELOAD_WEEK_KEY) || null);
  const dayDiff = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
  const weekDay = deloadWeek?.start ? dayDiff(deloadWeek.start, todayStr) + 1 : 0;
  const weekActive = !!deloadWeek?.start && weekDay >= 1 && weekDay <= DELOAD_WEEK_DAYS;

  // Guidance text: during an accepted week use the stored severity;
  // otherwise the live detector's severity. Null when neither applies.
  const guidance = useMemo(() => {
    const sev = weekActive ? deloadWeek.severity : (deloadState.deload ? deloadState.severity : null);
    return sev ? buildDeloadGuidance(sev, history, { today: todayStr }) : null;
  }, [weekActive, deloadWeek, deloadState, history, todayStr]);

  const startDeloadWeek = () => {
    const next = { start: todayStr, severity: deloadState.severity };
    saveLS(LS_DELOAD_WEEK_KEY, next);
    setDeloadWeek(next);
  };
  const endDeloadWeek = () => {
    saveLS(LS_DELOAD_WEEK_KEY, null);
    setDeloadWeek(null);
  };

  // Peak-test cadence for the selected grip — drives the "peak test due"
  // launcher below. maxTestStaleness keys on a MEASURED peak (Tindeq), so a
  // grip whose last max reading is overdue (or never) surfaces the button.
  const maxTest = useMemo(
    () => config.grip
      ? maxTestStaleness(history.filter(r => r?.grip === config.grip), todayStr)
      : null,
    [history, config.grip, todayStr]
  );

  // Launch a target-less max test: a 3s, best-of-MAX_TEST_ATTEMPTS
  // max-strength preset started through startSession's override path so
  // the SessionPlanCard's onApplyPlan can't clobber it. Reps log with
  // target_duration = 3 + the Tindeq peak, so the Peak Force card and the
  // cadence pick them up with no special tagging.
  const startMaxTest = () => {
    onStart({
      ...config,
      goal: "max_strength",
      targetTime: MAX_TEST_TARGET_S,
      repsPerSet: MAX_TEST_ATTEMPTS,
      restTime: 150,
      hand: "Both",
      ladderLoadByHand: null,
    });
  };

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
      <h2 style={{ margin: "0 0 20px", fontSize: 22, fontWeight: 700 }}>Session Setup</h2>

      <DeloadBanner
        deload={deloadState}
        guidance={guidance}
        weekActive={weekActive}
        dayOfWeek={weekDay}
        onStartWeek={startDeloadWeek}
        onEndWeek={endDeloadWeek}
      />

      {/* Grip Type — still per-grip, the curve is grip-scoped. The
          heading doubles as the call-to-action: it reads "Select a grip
          to start" (blue) until a grip is picked, then reverts to the
          neutral "Grip Type" label. */}
      <Card>
        <div style={{
          fontSize: 14, fontWeight: 700, marginBottom: 12,
          color: config.grip ? C.text : C.blue,
        }}>
          {config.grip ? "Grip Type" : "Select a grip to start"}
        </div>
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
        cooked={config.cooked}
        onCookedChange={(v) => setConfig(c => ({ ...c, cooked: v }))}
        fatigueModel={fatigueModel}
        climbingFocus={climbingFocus}
        onNavigateToSettings={onNavigateToSettings}
        onStartMaxTest={startMaxTest}
      />


      {/* Peak test launcher — the ON-DEMAND variant. When the cadence
          is due, the nudge + one-tap button live INSIDE SessionPlanCard
          (July 2026), so rendering this card too would double-nag;
          it now shows only when the reading is fresh, as a quiet
          "run one anyway" affordance. */}
      {config.grip && maxTest && !maxTest.recommended && (
        <Card style={{ marginBottom: 16, border: `1px solid ${C.border}` }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 180 }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 3 }}>
                🎯 Peak test · {config.grip}
              </div>
              <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.45 }}>
                Last max reading {maxTest.staleDays}d ago.{" "}
                {MAX_TEST_ATTEMPTS}×{MAX_TEST_TARGET_S}s max pulls per hand, full rest — warm up first, Tindeq connected so it captures peak.
              </div>
            </div>
            <Btn color={C.blue} onClick={startMaxTest}>Start peak test</Btn>
          </div>
        </Card>
      )}

      {/* Curve Coverage moved to Analysis tab — it's a per-zone
          reference view, not a session-prep input, so it lives with
          the F-D chart and Prescribed Load card instead of bloating
          the Setup flow. */}

      {/* Tindeq Connect slot — rendered just above the Start button */}
      {connectSlot}

      {/* Start gating: a grip must be picked. Cookedness defaults to 0
          (fresh); the user only adjusts it on days they're not fresh,
          so it's no longer a precondition for starting. */}
      <Btn
        onClick={onStart}
        disabled={!config.grip}
        style={{ width: "100%", padding: "16px 0", fontSize: 17, borderRadius: 12 }}
      >
        Start Session →
      </Btn>

      {/* Abrahangs-inspired low-intensity finger loading — a submaximal
          adjunct, cloud-synced and kept entirely separate from the
          muscular reps model. */}
      <div style={{ marginTop: 16 }}>
        <TendonCard />
      </div>

      {/* Bodyweight quick-log — pinned to the bottom of the page to
          match the Workout tab's placement. Tied to the finger-session
          prescription (× BW normalization on Analysis, additive load on
          weighted hangs), so it stays on Fingers rather than Climb. */}
      <div style={{ marginTop: 16 }}>
        <BwPrompt unit={unit} onSave={onBwSave} />
      </div>
    </div>
  );
}
