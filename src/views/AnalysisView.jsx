import { PeakForceCard } from './analysis/PeakForceCard.jsx';
import { PotentiationSpeedCard } from './analysis/PotentiationSpeedCard.jsx';
import { isCapacityEvidenceRep, comparableCapacityHistory } from "../model/forceRecording.js";
// ──────────────────────────────────────────────────────────────
// ANALYSIS VIEW
// ──────────────────────────────────────────────────────────────
// The "Analysis" tab. Top-to-bottom render order:
//
//   1. Curve Improvement — modeled progress plus measured evidence.
//   2. Recent Performance vs Expected — calibrated pre-session comparison.
//   3. Peak Force — instantaneous observed ceiling, when available.
//
// State comes in via props: history, freshMap (built in
// useRepHistory), activities, bodyWeight. threeExpPriors are
// memoized locally from history. No localStorage access for
// primary state, no BLE, no live session state — pure
// read-and-render over the rep array.
//
// Cross-cutting App config (GOAL_CONFIG) is passed in as
// props so this module stays decoupled from App.js's constant block;
// pure model helpers are imported directly from the model layer.
//
// Cards that USED to live here and were retired May 2026:
//   • Critical Force estimate card (per-grip CF/W' numbers) — the
//     three-exp curve is the source of truth now; CF was a
//     Monod-anchored derived metric.
//   • PrescribedLoadCard — duplicated what SessionPlanCard already
//     shows on Setup; one source of prescription per surface.
//   • Endurance Ceiling card — F(180)/F(5) was invariant to
//     proportional strength gains and clustered around 21–22%
//     across grips, so it produced no actionable signal.
//   • Absolute Capacity (raw kg·s) card — % vs baseline tells the
//     training-progress story; the kg·s axis was opaque.

import React, { useMemo, useState } from "react";
import { C } from "../ui/theme.js";
import { Card } from "../ui/components.jsx";
import { CardBoundary } from "../ui/ErrorBoundary.jsx";
import { loadLS, saveLS, LS_BW_LOG_KEY, LS_BW_NORMALIZE_KEY } from "../lib/storage.js";
import { useLSValue } from "../hooks/useLSValue.js";
import { STRENGTH_MAX } from "../model/zones.js";
import {
  buildThreeExpPriors,
} from "../model/threeExp.js";
import {
  fitAmpsForPts, improvementForAmps,
  buildGlobalBaseline,
} from "../model/baselines.js";
import { effectiveLoad, buildFreshLoadMap, repKey } from "../model/prescription.js";
// EnduranceCeilingCard dropped May 2026 — the F(180s)/F(5s) ratio is
// invariant to proportional strength gains (so it reads "NEEDS WORK"
// even while the user is measurably getting stronger), the literature
// benchmark bands aren't validated against personal performance, and
// the underlying curve shape is already visible on History's F-D map and
// the 3-min hold weight is shown on the Strength Balance card.
import { PerformanceTrendCards } from "./analysis/PerformanceTrendCards.jsx";
import { CurveImprovementCard } from "./analysis/CurveImprovementCard.jsx";
import { AnalysisScopeToolbar } from "./analysis/AnalysisScopeToolbar.jsx";
import { useGripFits } from "../hooks/useGripFits.js";
import { useContinuousProgress } from "../hooks/useContinuousProgress.js";
export function AnalysisView({
  history, potentiationHistory = [], unit = "lbs", bodyWeight = null,
  activities = [],
  freshMap = null,
  // Cross-cutting App config — passed in rather than imported so this
  // module doesn't reach back into App.js for view-level constants.
  GOAL_CONFIG = {},
  // Frozen per-grip baselines + save callback, threaded down from App
  // via useUserSettings. Pass-through to useGripFits, which owns the
  // pin-on-first-seed effect. See LS_PINNED_GRIP_BASELINES_KEY for
  // the why this exists.
  pinnedGripBaselines = null,
  onSavePinnedGripBaselines = null,
  // Per-(grip, hand) pins — same contract, keyed `${grip}|${hand}`.
  pinnedPerHandBaselines = null,
  onSavePinnedPerHandBaselines = null,
  // Gate for the pin-on-first-seed write — false until both cloud
  // reconciles (user_settings + reps) have landed. See App.js.
  baselinePinReady = true,
  // Curve Improvement card's Fresh-eq basis via useGripFits.
}) {
  // Grip filter — null/"" means all grips (default view).
  const [selGrip,   setSelGrip]   = useState("");

  // Shared per-grip priors for the progress models below.
  const threeExpPriors = useMemo(() => buildThreeExpPriors(history), [history]);

  // BW normalization toggle for the Curve Improvement comparisons.
  const [normalizeOn, setNormalizeOn] = useState(() => loadLS(LS_BW_NORMALIZE_KEY) === true);
  const setNormalizePreference = next => {
    setNormalizeOn(next);
    saveLS(LS_BW_NORMALIZE_KEY, next);
  };
  const normalizationActive = normalizeOn && bodyWeight > 0;

  // ── Hand selector (June 2026) ──────────────────────
  // "pooled" (default) | "L" | "R". One global control scopes Curve
  // Improvement, Recent Performance, and Peak Force.
  // It is not persisted: per-hand fits run on half the data and are a
  // diagnostic lens, so each visit starts at the pooled view.
  const [handView, setHandView] = useState("pooled");
  // (Force Curves overlay slider state removed May 2026 — the overlay
  // merged into CurveImprovementCard, which owns its own per-grip "Now"
  // slider state internally. Each grip block scrubs independently, so
  // there's no longer a single page-level grip/index to track here.)

  // BW log — live via useLSValue, so BW entries written after mount
  // (BwPrompt, History-tab edits, the cloud reconcile / manual pull)
  // flow into the ×BW normalization without a remount. The [] fallback
  // is derived in a memo keyed on the stable raw snapshot so
  // downstream memo deps keep a stable identity.
  const bwLogRaw = useLSValue(LS_BW_LOG_KEY);
  const bwLog = useMemo(() => bwLogRaw || [], [bwLogRaw]);

  const grips = useMemo(() =>
    [...new Set(history.map(r => r.grip).filter(Boolean))].sort(),
    [history]
  );
  const scopedGrips = useMemo(
    () => selGrip ? [selGrip] : grips,
    [selGrip, grips]
  );

  // Peak records use every measured hold, independently of curve eligibility.
  const peakRecordHistory = useMemo(() => history.filter(r =>
    (!selGrip || r.grip === selGrip) && (handView === "pooled" || r.hand === handView)
  ), [history, selGrip, handView]);

  // All reps with usable force + time data for the shared grip/hand scope.
  const reps = useMemo(() => history.filter(r =>
    (!selGrip || r.grip === selGrip) &&
    (handView === "pooled" || r.hand === handView) &&
    effectiveLoad(r) > 0 &&
    r.actual_time_s > 0
  ), [history, selGrip, handView]);

  // Train-to-failure model (May 2026): every rep with a valid
  // actual_time_s is a failure data point. The legacy success/failure
  // dichotomy is kept here only for backward compat with downstream
  // consumers that destructure both names — the chart's red/green
  // old visual distinction is gone; all reps flow through `failures`
  // as (T, F) data points.
  const capacityFitMap = useMemo(() => freshMap || buildFreshLoadMap(history), [freshMap, history]);
  const failures = useMemo(() => comparableCapacityHistory(reps).filter(r =>
    isCapacityEvidenceRep(r) && capacityFitMap.get(repKey(r))?.capacityEligible !== false), [reps, capacityFitMap]);

  const maxDur = Math.max(...reps.map(r => r.actual_time_s), STRENGTH_MAX + 60);

  // (threeExpPriors hoisted to the top of the component so the
  // selectedSession useMemo can include it in its dep array without
  // tripping ESLint's no-use-before-define rule.)

  // ── F-D curve fit (three-exp on raw force) ──
  // Per-grip three-exp curves are computed inside the chart's render
  // path (and on demand in handAsymmetry / hand-scoped improvement
  // sections). The fit is failure-only on RAW force (no freshMap,
  // no success-floor): "what your reps actually show" rather than
  // "what your prescription engine wants to push you to." Above the
  // curve = above-curve performance (strong zone); below the curve =
  // below-curve performance (limiter zone). The visual diagnosis only
  // works if the curve is honest about the data.

  // ── Curve improvement % vs baseline ──
  //
  // Migrated from Monod (CF + W'/T) to the three-exp basis in March
  // 2026. The rest of the app moved to three-exp during Phases A–D;
  // leaving this card on Monod meant the headline % the user saw
  // here didn't agree with the fitted curve shown in History, AND
  // the Power column in particular was dominated by W' fit noise
  // (small-N Monod fits over-estimate W', which inflates F at short
  // T, producing phantom regressions). The three-exp basis with a
  // grip-prior anchors the fast amplitude even when failures are
  // sparse, so the Power column behaves.
  //
  // All baseline + improvement math lives in src/model/baselines.js
  // now (May 2026 decomp). The useMemos below are just memoized
  // calls into pure helpers.

  // Three-exp current fit on the filtered failures — scoped to the
  // same selGrip filter the user has set on this view.
  const current3xAmps = useMemo(
    () => fitAmpsForPts(
      failures.map(r => ({ T: r.actual_time_s, F: effectiveLoad(r) })),
      selGrip,
      threeExpPriors,
    ),
    [failures, selGrip, threeExpPriors]
  );

  // Pooled three-exp baseline — earliest window of ≥3 failures across
  // ≥2 distinct durations, fit grip-agnostic. The two halves of the
  // Δ% live in the same model so the Curve Improvement headline
  // agrees with the force-duration model.
  const global3xBaseline = useMemo(
    () => buildGlobalBaseline(history),
    [history]
  );

  const improvement = useMemo(
    () => improvementForAmps(current3xAmps, global3xBaseline?.amps),
    [current3xAmps, global3xBaseline]
  );

  // Per-grip + per-(grip, hand) three-exp derivations. Bundled into
  // a single hook (useGripFits) so the six related memos don't visually
  // crowd the AnalysisView render. See src/hooks/useGripFits.js for
  // the per-memo notes — extraction was pure relocation, no math changes.
  const {
    gripBaselines, grip3xEstimates,
    perHandGripBaselines, perHandGripEstimates, perHandGripImprovement,
    gripImprovement, gripImprovementFresh, perHandGripImprovementFresh,
  } = useGripFits({
    history, threeExpPriors, grips,
    pinnedGripBaselines, onSavePinnedGripBaselines,
    pinnedPerHandBaselines, onSavePinnedPerHandBaselines,
    allowAutoPin: baselinePinReady,
  });

  // (baselineProgress + FAIL_THRESHOLD/DUR_THRESHOLD moved into
  // CurveImprovementCard along with the inline Curve Improvement
  // JSX block — that was the only consumer.)

  // Force Curves History overlay (cumulative per-grip / per-hand fits
  // by date). See src/hooks/useHistoryOverlay.js for the per-memo notes.
  const continuousProgress = useContinuousProgress({history,grips,pinnedGripBaselines,pinnedPerHandBaselines});

  return (
    <div style={{ padding: "20px 16px" }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 22 }}>Finger progress</h2>
      <p style={{ margin: "0 0 16px", fontSize: 13, color: C.muted, lineHeight: 1.5 }}>
        See your recorded pulls and how your strength and endurance have changed.
      </p>

      {/* Bodyweight logging lives on the Setup tab now (next to the
          climb logger). Analysis stays focused on viewing — the only
          BW-related control here is the Absolute / × BW units toggle
          inside the filter card below. */}



      <AnalysisScopeToolbar
        grips={grips}
        grip={selGrip}
        onGripChange={setSelGrip}
        hand={handView}
        onHandChange={setHandView}
        normalizeOn={normalizeOn}
        onNormalizeChange={setNormalizePreference}
        canNormalize={bodyWeight > 0}
      />


      {reps.length > 0 && <>
        <CardBoundary name="Curve Improvement">
          <CurveImprovementCard
            improvement={improvement}
            gripImprovement={gripImprovement}
            grip3xEstimates={grip3xEstimates}
            gripBaselines={gripBaselines}
            global3xBaseline={global3xBaseline}
            selGrip={selGrip}
            grips={scopedGrips}
            history={history}
            historyOverlay={continuousProgress.historyOverlay}
            maxDur={maxDur}
            unit={unit}
            normalizeOn={normalizationActive}
            bodyWeight={bodyWeight}
            bwLog={bwLog}
            handView={handView}
            perHandGripImprovement={perHandGripImprovement}
            perHandGripBaselines={perHandGripBaselines}
            perHandGripEstimates={perHandGripEstimates}
            {...continuousProgress}
            comparisonHistory={continuousProgress.displayHistory}
            gripImprovementFresh={gripImprovementFresh}
            perHandGripImprovementFresh={perHandGripImprovementFresh}
          />
        </CardBoundary>
        <CardBoundary name="Performance trends">
          <PerformanceTrendCards key={`${handView}|${scopedGrips.join("|")}`} history={history} grips={scopedGrips} handView={handView} activities={activities} unit={unit} />
        </CardBoundary>
      </>}

      {peakRecordHistory.length > 0 && <CardBoundary name="Peak force">
        <PeakForceCard history={peakRecordHistory} unit={unit} grip={selGrip} handView={handView}
          normalizeOn={normalizationActive} bodyWeight={bodyWeight} bwLog={bwLog} />
      </CardBoundary>}

      <CardBoundary name="Potentiation speed">
        <PotentiationSpeedCard history={potentiationHistory} grips={scopedGrips}
          handView={handView} unit={unit} />
      </CardBoundary>

      {reps.length === 0 ? (
        <Card>
          <div style={{ textAlign: "center", padding: "32px 0", color: C.muted }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📊</div>
            <div>No session data yet for this selection.</div>
            <div style={{ fontSize: 12, marginTop: 8 }}>Run a few sessions on this grip / hand to start building a force-duration curve.</div>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
