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
//   • BwPrompt — dismissible weekly body-weight reminder.
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
import { Btn, PageFrame } from "../ui/components.js";

import { loadLS, saveLS, LS_WORKOUT_LOG_KEY, LS_DELOAD_WEEK_KEY } from "../lib/storage.js";
import { BwPrompt } from "./BodyWeightEntry.jsx";
import { today } from "../util.js";

import { buildThreeExpPriors } from "../model/threeExp.js";
import { deloadStatus, buildDeloadGuidance, DELOAD_WEEK_DAYS } from "../model/deload.js";
import { SessionPlanCard } from "./cards/SessionPlanCard.js";
import { TendonCard } from "./cards/TendonCard.jsx";
import { DeloadBanner } from "./cards/DeloadBanner.jsx";

// ────────────────────────────────────────────────────────────────
// SETUP VIEW
// ────────────────────────────────────────────────────────────────

export function SetupView({
  config, setConfig, onStart, history,
  freshMap = null,
  // Per-grip β fatigue model from user_settings. Passed through to
  // SessionPlanCard so the slider's scale-down preview matches what
  // the runner will actually prescribe.
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
  // Cross-grip recovery decline (personal taus), with lifting and
  // climbing volume as severity context. The lifting log lives in
  // localStorage in exactly the shape computeDeload expects, and the
  // climb log arrives as a prop. Evaluated as of the real current date
  // so the staleness guard works. Detect/explain/propose only — the
  // accepted "deload week" is a volume-cap reminder, not a silent load
  // scale-down.
  const todayStr = today();
  const recoveryStatus = useMemo(
    () => deloadStatus(history, loadLS(LS_WORKOUT_LOG_KEY) || [], { today: todayStr, activities }),
    [history, todayStr, activities]
  );
  const deloadState = recoveryStatus.deload;

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

  const plannerHeader = (
      <section aria-label="Grip selection" style={{ marginBottom: 24 }}>
        <h2 style={{ margin: "0 0 20px", fontSize: 26, fontWeight: 750 }}>Select a Device to Begin</h2>
        <div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
            {GRIP_PRESETS.map(g => (
              <button
                key={g}
                onClick={() => handleGrip(g)}
                aria-pressed={config.grip === g}
                style={{
                  padding: "12px 4px", borderRadius: 12, fontSize: 16, minWidth: 0,
                  cursor: "pointer", fontWeight: 650,
                  background: config.grip === g ? C.blue : C.border,
                  color: config.grip === g ? "#fff" : C.text,
                  border: "none", minHeight: 52,
                }}
              >
                {g}
              </button>
            ))}
          </div>
        </div>
      </section>
  );

  const plannerFooter = (
    <section aria-label="Start your session" style={{ marginTop: 24, paddingTop: 20, borderTop: `1px solid ${C.border}` }}>
      {connectSlot}
      <Btn
        onClick={onStart}
        disabled={!config.grip}
        style={{ width: "100%", padding: "16px 0", fontSize: 17, borderRadius: 12 }}
      >
        Start Session →
      </Btn>
    </section>
  );

  return (
    <PageFrame style={{ padding: "20px 16px" }}>
      {/* The recovery gauge itself moved to Analysis → Fingers in
          September 2026. It is a diagnostic, not a pre-session decision:
          it does not change a single prescribed load, and it read green
          for five months straight, so on the first screen of the app it
          was mostly furniture for a new user. What stays here is the
          escalation path — the banner below, which surfaces only when
          there is actually something to act on before you pull. */}
      <DeloadBanner
        deload={deloadState}
        softening={recoveryStatus.level === "yellow"}
        softeningWhy={deloadState?.why || null}
        guidance={guidance}
        weekActive={weekActive}
        dayOfWeek={weekDay}
        onStartWeek={startDeloadWeek}
        onEndWeek={endDeloadWeek}
      />

      {/* Single unified session-pick surface — RPE slider on top, six
          clickable zone tiles, session details below. Replaces the
          previously-separate ContinuousPickCard + PrescribedLoadCard
          renders. The PrescribedLoadCard component still exists for
          Analysis (retrospective what-if), but Setup goes through this
          consolidated path so the slider, the recommended pick, and the
          per-zone tiles all live in one box and stay in sync. */}
      <SessionPlanCard
        plannerHeader={plannerHeader}
        plannerFooter={plannerFooter}
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
        climbingFocus={climbingFocus}
        onNavigateToSettings={onNavigateToSettings}
      />

      {/* Abrahangs-inspired low-intensity finger loading — a submaximal
          adjunct, cloud-synced and kept entirely separate from the
          muscular reps model. */}
      <div style={{ marginTop: 16 }}>
        <TendonCard />
      </div>

      <BwPrompt unit={unit} onSave={onBwSave} />
    </PageFrame>
  );
}
