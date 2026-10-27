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
//   • Grip coverage selector — the three device rings select the grip
//     and show whether each curve has current evidence across six domains.
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
//   • Start Session button and a compact per-workout set selector.
//   • BwPrompt — dismissible weekly body-weight reminder.
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
// The prescribed sequence remains the default. A compact selector can
// repeat it for up to five work sets; experimental protocols are disclosed
// only when the user's history first makes them available.
//
// ClimbingLogCard was hosted on this view between May 2026 (when the
// dedicated Climbing tab was retired) and late May 2026 (when the
// Climb tab was re-extracted). It now lives in src/views/ClimbView.js;
// activities still flow through SetupView for SessionPlanCard's
// today-climb fatigue read, but the capture UI no longer sits here.

import React, { useMemo } from "react";

import { C } from "../ui/theme.js";
import { Btn, PageFrame } from "../ui/components.jsx";

import { BwPrompt } from "./BodyWeightEntry.jsx";

import { buildThreeExpPriors } from "../model/threeExp.js";
import { SessionPlanCard } from "./cards/SessionPlanCard.jsx";
import { GripCoverageSelector } from "./cards/GripCoverageSelector.jsx";

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
  volumeExperiment = null,
  onStartVolumeExperiment,
  volumeReady = true,
}) {
  const handleGrip = (g) => setConfig(c => ({ ...c, grip: g }));

  const threeExpPriors = useMemo(() => buildThreeExpPriors(history), [history]);

  const plannerHeader = (
    <GripCoverageSelector
      history={history}
      grips={GRIP_PRESETS}
      value={config.grip}
      onChange={handleGrip}
    />
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
      {/* Single unified session-pick surface — RPE slider on top, six
          clickable zone tiles, session details below. Replaces the
          previously-separate ContinuousPickCard + PrescribedLoadCard
          renders. This consolidated path keeps the slider, recommended pick, and
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
        adjustLoadForFatigue={config.adjustLoadForFatigue === true}
        onAdjustLoadChange={(v) => setConfig(c => ({ ...c, adjustLoadForFatigue: v }))}
        onCookedChange={(v) => setConfig(c => ({ ...c, cooked: v }))}
        climbingFocus={climbingFocus}
        onNavigateToSettings={onNavigateToSettings}
        volumeExperiment={volumeExperiment}
        onStartVolumeExperiment={onStartVolumeExperiment}
        volumeReady={volumeReady}
        availableGrips={GRIP_PRESETS}
      />

      <BwPrompt unit={unit} onSave={onBwSave} />
    </PageFrame>
  );
}
