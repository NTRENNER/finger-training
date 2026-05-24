// ─────────────────────────────────────────────────────────────
// ANALYSIS VIEW
// ─────────────────────────────────────────────────────────────
// The "Analysis" tab. Top-to-bottom render order:
//
//   1. Force-Duration chart (the source of truth — three-exp fit
//      over recent reps, optional bootstrap band, click-a-dot
//      session detail modal).
//   2. Per-grip Curve Improvement summary (zone-bucketed % gain
//      vs personal baseline).
//   3. Total Capacity (AUC) trajectory — % vs baseline with a
//      3-session rolling-mean trend line. Optional ×BW normalize.
//   4. Force Curves history overlay (per-session three-exp curves
//      stacked so you can see the shape evolve over time).
//   5. OneRMPRCard — recent PR snapshots per grip.
//   6. Recovery Trend — gap (observed − predicted) between rep 1
//      and rep 2 at the target time, robust to rep 1 lengthening.
//   7. Strength Balance — Crusher (open hand) vs Micro (crimp)
//      ratio at 10s, classified against the user's own baseline.
//   8. Curve Coverage — per-zone data freshness + annual session
//      pace (the diagnostic that anchors the page).
//
// State comes in via props: history, freshMap (built in
// useRepHistory), activities, bodyWeight. threeExpPriors are
// memoized locally from history. No localStorage access for
// primary state, no BLE, no live session state — pure
// read-and-render over the rep array.
//
// Cross-cutting App config (GOAL_CONFIG, RM_GRIPS) is passed in as
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
// recharts imports moved out with ForceDurationCard / ForceCurvesOverlayCard
// (May 2026 BACKLOG #156). AnalysisView no longer renders any chart
// directly — child cards own their own chart machinery.
import { C } from "../ui/theme.js";
import { Card } from "../ui/components.js";
import { KG_TO_LBS, toDisp } from "../ui/format.js";
import { loadLS, saveLS, LS_BW_LOG_KEY, LS_BW_NORMALIZE_KEY } from "../lib/storage.js";
import { STRENGTH_MAX, ZONE6 } from "../model/zones.js";
import {
  predForceThreeExp,
  buildThreeExpPriors,
} from "../model/threeExp.js";
import {
  fitAmpsForPts, improvementForAmps,
  buildGlobalBaseline,
} from "../model/baselines.js";
import { RepCurveChart } from "./cards/RepCurveChart.jsx";
import { buildRepCurveBundle } from "../model/repCurveData.js";
import { prescription, effectiveLoad } from "../model/prescription.js";
import { computeLimiterZone } from "../model/limiter.js";
import { OneRMPRCard } from "./analysis/OneRMPRCard.js";
import { CurveCoverageCard } from "./analysis/CurveCoverageCard.js";
import { StrengthBalanceCard } from "./analysis/StrengthBalanceCard.js";
// EnduranceCeilingCard dropped May 2026 — the F(180s)/F(5s) ratio is
// invariant to proportional strength gains (so it reads "NEEDS WORK"
// even while the user is measurably getting stronger), the literature
// benchmark bands aren't validated against personal performance, and
// the underlying curve shape is already visible on the F-D chart and
// the 3-min hold weight is shown on the Strength Balance card.
import { CapacityTrajectoryCard } from "./analysis/CapacityChartCards.js";
import { RecoveryTrendCard, RecoveryObservedTrendCard } from "./analysis/RecoveryTrendCard.jsx";
import { GRIP_COLORS } from "../ui/grip-colors.js";
import { ForceDurationCard } from "./analysis/ForceDurationCard.jsx";
import { CurveImprovementCard } from "./analysis/CurveImprovementCard.jsx";
import { ForceCurvesOverlayCard } from "./analysis/ForceCurvesOverlayCard.jsx";
import { useAucHistoryByGrip } from "../hooks/useAucHistoryByGrip.js";
import { useGripFits } from "../hooks/useGripFits.js";
import { useHistoryOverlay } from "../hooks/useHistoryOverlay.js";

export function AnalysisView({
  history, unit = "lbs", bodyWeight = null,
  activities = [],
  freshMap = null,
  // Cross-cutting App config — passed in rather than imported so this
  // module doesn't reach back into App.js for view-level constants.
  GOAL_CONFIG = {},
  RM_GRIPS = [],
}) {
  // Grip filter — null/"" means "Both grips pooled" (default view).
  // The hand-filter sibling state (selHand) was retired with the L/R/Both
  // buttons; per-hand views now happen at the per-card level (Strength
  // Balance, Hand Asymmetry) rather than via a tab-level filter.
  const [selGrip,   setSelGrip]   = useState("");

  // Click-to-expand state for the F-D chart. Clicking any rep dot
  // opens a modal showing the RepCurveChart for that rep's session.
  // null = no modal open.
  // Per-grip three-exp priors — hoisted above selectedSession so the
  // session-detail modal's prescription() call can use the curve-fit
  // path. Used by the gap-narrowing tracker and prescription-potential
  // calculation too. Could be lifted to App if it becomes hot.
  const threeExpPriors = useMemo(() => buildThreeExpPriors(history), [history]);

  const [selectedSessionId, setSelectedSessionId] = useState(null);
  const handleDotClick = (data) => {
    if (data?.session_id) setSelectedSessionId(data.session_id);
  };

  // Build per-hand bundles for the selected session. Mixed-hand
  // sessions get one bundle per hand so the chart doesn't artifactually
  // concatenate L+R into one apparent set. Target/used weight pulled
  // from prescription() run on history strictly before this session.
  const selectedSession = useMemo(() => {
    if (!selectedSessionId) return null;
    const sessReps = history.filter(r => r.session_id === selectedSessionId);
    if (sessReps.length === 0) return null;
    const sortedAll = [...sessReps].sort(
      (a, b) => (a.set_num ?? 1) - (b.set_num ?? 1) || (a.rep_num ?? 0) - (b.rep_num ?? 0)
    );
    const sessDate = sortedAll[0].date;
    const grip = sortedAll[0].grip;
    const targetDuration = sortedAll[0].target_duration;
    const restS = sortedAll[0].rest_s ?? 20;
    const presentHands = Array.from(new Set(sortedAll.map(r => r.hand).filter(h => h === "L" || h === "R")));
    const hands = presentHands.length > 0 ? presentHands : [sortedAll[0].hand || "L"];
    const priorHistory = history.filter(r => r.date < sessDate);
    return {
      meta: { date: sessDate, grip, targetDuration, restS },
      perHand: hands.map(handKey => {
        const handReps = sortedAll.filter(r => r.hand === handKey);
        const handRep1 = handReps[0];
        if (!handRep1) return null;
        // Pass freshMap + threeExpPriors so prescription() uses its
        // curve-fit path rather than the over-extrapolating anchored-
        // linear fallback. Same fix as HistoryView.
        //
        // referenceDate = sessDate so the 30-day anchor lookback
        // matches what was visible at SESSION time, not today. Without
        // this, old sessions reconstruct against today-30d and fall
        // through to the conservative unanchored-curve prediction —
        // the modal would show much lower targets than were actually
        // displayed during the live session.
        const target = prescription(priorHistory, handKey, grip, targetDuration,
          { freshMap, threeExpPriors, referenceDate: sessDate });
        return {
          handKey,
          handRep1,
          target: target?.value ?? null,
          bundle: buildRepCurveBundle({
            history, grip, hand: handKey,
            numReps: handReps.length,
            firstRepTime: handRep1.actual_time_s,
            restSeconds: handRep1.rest_s ?? restS,
            actualReps: handReps,
            targetDuration,
            beforeDate: sessDate,
          }),
        };
      }).filter(Boolean),
    };
  }, [selectedSessionId, history, freshMap, threeExpPriors]);

  // BW normalization toggle. When ON, every metric surface (F-D chart,
  // AUC trajectory, Curve Improvement, Hand Asymmetry) renders in
  // bodyweight-relative units. Per-session-date BW (via bwOnDate +
  // bwLog) is used so historical points get divided by the BW from
  // THAT date, not just current BW — the honest comparison. The
  // per-chart relMode that used to live on the F-D card has been
  // promoted to this single global state.
  const [normalizeOn, setNormalizeOn] = useState(() => loadLS(LS_BW_NORMALIZE_KEY) === true);
  const toggleNormalize = () => {
    setNormalizeOn(v => {
      const next = !v;
      saveLS(LS_BW_NORMALIZE_KEY, next);
      return next;
    });
  };
  const relMode = normalizeOn;  // alias retained so existing relMode reads keep working

  // ── Force Curves History overlay state ──
  // Single-slider redesign (May 2026). `historyGrip` is the grip
  // we're comparing (one at a time — multiple curves get unreadable).
  // `historyNowIdx` is the index into the per-grip sorted training-
  // date list for the "Now" curve. The "Past" curve is anchored
  // to the SHARED baseline (gripBaselines[grip].amps) — same anchor
  // the Capacity % vs baseline chart and the Curve Improvement card
  // already use — so all three surfaces agree on what's-vs-what.
  // (Previous two-slider design used the cumulative-fit-at-first-
  // date as past, which fit on degenerate single-duration windows
  // and disagreed wildly with Curve Improvement. Fixed here.)
  const [historyGrip, setHistoryGrip] = useState(null);
  const [historyNowIdx, setHistoryNowIdx] = useState(null);
  // Pooled vs per-hand toggle. Pooled fits the whole grip's data into
  // one curve (matches Capacity %); per-hand shows L and R separately
  // so asymmetry shows up — useful when one hand is clearly leading
  // the other. Default to pooled because (a) it matches the most-
  // glanced page-level cards and (b) the curve is less busy.
  const [historyViewMode, setHistoryViewMode] = useState("pooled");

  // BW log loaded once on mount; the cloud-reconcile path in App.js
  // hydrates this from Supabase on sign-in, so by the time the view
  // mounts the log reflects every device's history.
  const bwLog = useMemo(() => loadLS(LS_BW_LOG_KEY) || [], []);

  const grips = useMemo(() =>
    [...new Set(history.map(r => r.grip).filter(Boolean))].sort(),
    [history]
  );

  // All reps with usable force + time data for the selected filters.
  // L+R are always pooled at the view level — the F-D chart shows an
  // at-a-glance picture, and per-hand views happen inside the cards
  // that genuinely need them (Strength Balance, Hand Asymmetry).
  const reps = useMemo(() => history.filter(r =>
    (!selGrip || r.grip === selGrip) &&
    r.avg_force_kg > 0 && r.avg_force_kg < 500 &&
    r.actual_time_s > 0
  ), [history, selGrip]);

  // Train-to-failure model (May 2026): every rep with a valid
  // actual_time_s is a failure data point. The legacy success/failure
  // dichotomy is kept here only for backward compat with downstream
  // consumers that destructure both names — the chart's red/green
  // visual distinction was retired when we switched the F-D chart to
  // hand-based coloring (commit pending) — `successes` is gone, all
  // reps flow through `failures` as (T, F) data points.
  const failures = reps;

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
  // here didn't agree with the curve they saw on the F-D chart, AND
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
      failures.map(r => ({ T: r.actual_time_s, F: r.avg_force_kg })),
      selGrip,
      threeExpPriors,
    ),
    [failures, selGrip, threeExpPriors]
  );

  // Pooled three-exp baseline — earliest window of ≥3 failures across
  // ≥2 distinct durations, fit grip-agnostic. The two halves of the
  // Δ% live in the same model so the Curve Improvement headline
  // agrees with the F-D chart.
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
    gripBaselines, grip3xEstimates, gripHandFits,
    perHandGripBaselines, gripImprovement, handAsymmetry,
  } = useGripFits({ history, threeExpPriors, grips });

  // (baselineProgress + FAIL_THRESHOLD/DUR_THRESHOLD moved into
  // CurveImprovementCard along with the inline Curve Improvement
  // JSX block — that was the only consumer.)

  // (perHandImprovement Monod useMemo removed — was eslint-disabled
  // dead code from the deleted Per-Hand CF card. Its modern analog
  // is the Hand Asymmetry rows below the F-D chart, which compute
  // per-grip L/R gaps from three-exp fits at T=30s.)

  // Note: 120s capacity over time chart removed — superseded by
  // aucHistoryByGrip (Total Capacity over time), which integrates the
  // whole curve from 5 to 180s rather than reading a single F(120)
  // slice. The Performance vs. Model chart already covers per-zone
  // progress more meaningfully.

  // Note: AUC values used to live here (aucEstimate / aucBaseline /
  // aucHistory) backing a dedicated "Climbing Endurance · AUC" card.
  // That card was removed because the Endurance Improvement card
  // already shows each grip's Total % (which IS the AUC % gain) and
  // the CF & W' Over Time chart already shows trajectory. AUC math
  // still lives in computeAUC and is used by the recommendation
  // engine and ΔAUC ranking.

  // Fitted force-duration curve points for overlay.
  const F_D_T_MIN = 5;

  // Per-grip split-mode flag for the F-D chart. When no grip filter
  // is active and ≥2 grips have ≥2 data points each, we render per-
  // grip three-exp curves + dots side-by-side. Pooling Micro and
  // Crusher onto one chart conflates two different muscles (FDP pinch
  // vs FDS crush) — the cross-muscle amplitude difference dominates
  // and the user can't see what's happening to each grip individually.
  //
  // Output is `{ [grip]: true }` for grips that qualify, or null. The
  // shape used to be `{ [grip]: { fit, curve, failures, successes } }`
  // back when this also computed a per-grip Monod fit for the chart;
  // the actual curves drawn are now three-exp via fitThreeExpAmps in
  // the chart render block, so all this hook needs to do is gate
  // splitMode on/off.
  const fdSplitData = useMemo(() => {
    if (selGrip) return null;
    const byGrip = {};
    for (const r of history) {
      if (!r.grip) continue;
      if (!(r.avg_force_kg > 0 && r.avg_force_kg < 500)) continue;
      if (!(r.actual_time_s > 0)) continue;
      byGrip[r.grip] = (byGrip[r.grip] || 0) + 1;
    }
    const qualifyingGrips = Object.entries(byGrip)
      .filter(([, count]) => count >= 2)
      .map(([grip]) => grip);
    if (qualifyingGrips.length < 2) return null;
    return Object.fromEntries(qualifyingGrips.map(g => [g, true]));
  }, [history, selGrip]);

  // F-D curve stroke color. When a grip is selected (single-curve mode)
  // we tint the curve and its 3-min sustainable reference with the
  // grip's own color so the chart palette stays consistent with the
  // All-Grips split-mode view (where each grip already has its own
  // colored curve). Falls back to the neutral purple when no grip is
  // selected — there's no single grip to tint to.
  const curveColor = selGrip ? (GRIP_COLORS[selGrip] || C.purple) : C.purple;

  // ── Gap-narrowing tracker over time ──
  // ── Total AUC over time, per-grip ──
  // Single number per grip per training date: ∫ F(t) dt over [5, 180]s
  // under the three-exp curve fit on that grip's failures up to that
  // date. Captures total work capacity in a single scalar — more
  // actionable than three zone lines for the "am I getting bigger
  // overall?" question. Same integration window the badges ladder uses,
  // so the chart and the badge progression are reading the same metric.
  //
  // Scope: per-grip lines, never pooled (pooling FDP-pinch and FDS-crush
  // hides each muscle's individual trajectory and inflates the headline
  // when only one is moving). Returns the union of all dates across
  // grips, with each grip's column filled where it has a fit.
  // Per-grip "Curve Improvement %" trajectory. Extracted to a
  // dedicated hook in late May 2026 (BACKLOG #156 partial pass) so
  // the 120 lines of fit + smoothing logic don't visually crowd the
  // AnalysisView render. Same memo deps as before.
  const aucHistoryByGrip = useAucHistoryByGrip({
    history, grips, gripBaselines, threeExpPriors, bwLog,
  });

  // ── Three-exp F-D fit (governing model — see src/model/threeExp.js) ──
  // threeExpPriors memoized earlier in AnalysisView so the F-D chart
  // curve and any per-grip three-exp consumers share one fit basis.

  // Three-exp fit for the current selGrip scope. Uses the
  // same `failures` array that backs cfEstimate, so the fits are
  // directly comparable. When no grip is selected, fitAmpsForPts
  // falls back to a no-shrinkage fit (which validation showed
  // loses to Monod by ~3% on aggregate, fine as a degenerate case).
  const threeExpFit = useMemo(() => {
    if (failures.length < 2) return null;
    const pts = failures.map(r => ({ T: r.actual_time_s, F: r.avg_force_kg }));
    const amps = fitAmpsForPts(pts, selGrip, threeExpPriors);
    if (!amps) return null;
    return { amps };
  }, [failures, selGrip, threeExpPriors]);

  // Predicted curve for chart overlay — same T grid as curveData so the
  // two lines align visually.
  const threeExpCurveData = useMemo(() => {
    if (!threeExpFit) return [];
    const tMax = Math.max(maxDur, F_D_T_MIN + 10);
    return Array.from({ length: 80 }, (_, i) => {
      const t = F_D_T_MIN + ((tMax - F_D_T_MIN) / 79) * i;
      const f = predForceThreeExp(threeExpFit.amps, t);
      return { x: t, y: toDisp(Math.max(f, 0), unit) };
    });
  }, [threeExpFit, maxDur, unit]);

  // Three-exp doesn't have a true asymptote (decays to 0), so there is
  // no direct analog to Monod's CF. The closest "long-duration
  // sustainable force" reference is F(180s) — well past the medium
  // component's dominance window (τ₂=30s drained 6× over) where the
  // slow component carries essentially the whole load. Used as the
  // dashed horizontal reference on the F-D chart, replacing the CF
  // line that came from Monod.
  const threeExpRef180 = useMemo(() => {
    if (!threeExpFit) return null;
    return predForceThreeExp(threeExpFit.amps, 180);
  }, [threeExpFit]);

  // (modelRMSE training-RMSE diagnostic was here. Removed — vestigial
  // from the three-exp-vs-Monod validation phase. Training RMSE is
  // biased optimistic and the curve quality is judged by eye on the
  // F-D scatter anyway. Honest holdout validation still lives in the
  // offline sim (validate_three_exp_v3.js).)

  // (Per-hand L vs R overlay curves were here. Removed — added visual
  // noise to the F-D chart without enough insight to justify it. Per-
  // hand asymmetry is surfaced more clearly on the Per-Hand CF card
  // below the chart.)


  // Limiter zone (the zone that falls farthest below the F-D curve
  // predicted by the other two zones). Drives the saturated background
  // highlight on the F-D chart — visual echo of the SessionPlanner's
  // recommendation, so the chart and the planner tell the same story.
  const limiterZoneBounds = useMemo(() => {
    const lim = computeLimiterZone(history);
    if (!lim) return null;
    // Derive bounds from ZONE6 directly so the 6-zone schema stays
    // the single source of truth for boundaries and colors.
    const z = ZONE6.find(zz => zz.key === lim.zone);
    if (!z) return null;
    return {
      x1: z.min,
      x2: z.max === Infinity ? maxDur + 10 : z.max,
      color: z.color,
      label: `Limiter: ${z.label}`,
    };
  }, [history, maxDur]);

  // ── Relative strength helpers ──
  // useRel gates the absolute-vs-relative rendering path that
  // builds leftDotsRel / rightDotsRel / threeExpCurveDataRel /
  // maxForceRel below. The narrower fmtForce/forceUnit helpers
  // and the HAND_COLORS palette moved into ForceDurationCard
  // (the only place that consumes them).
  const useRel = relMode && bodyWeight != null && bodyWeight > 0;

  // Scatter data — split by hand under the train-to-failure model.
  // The previous green/red split (Completed / Auto-failed) was a
  // vestige of the success/failure dichotomy that the data model
  // no longer carries. Coloring by hand (L = blue, R = yellow)
  // adds a useful per-hand signal at a glance and pairs with the
  // Hand Asymmetry card below the chart. Reps with no hand or
  // hand="Both" (legacy data) drop into the L bucket as a quiet
  // default — rare and not worth a third bar.
  const buildDot = (r) => ({
    x: r.actual_time_s,
    y: useRel ? r.avg_force_kg / bodyWeight : toDisp(r.avg_force_kg, unit),
    date: r.date, grip: r.grip, hand: r.hand,
    // session_id lets click handlers gather the full session's reps to
    // pop up the RepCurveChart for that workout.
    session_id: r.session_id,
    target_duration: r.target_duration,
    rest_s: r.rest_s,
  });
  const leftDotsRel  = failures.filter(r => r.hand !== "R").map(buildDot);
  const rightDotsRel = failures.filter(r => r.hand === "R").map(buildDot);
  const threeExpCurveDataRel = threeExpCurveData.map(d => ({
    x: d.x,
    y: useRel && bodyWeight > 0 ? d.y / (bodyWeight * (unit === "lbs" ? KG_TO_LBS : 1)) : d.y,
  }));
  const maxForceRel = Math.max(
    ...(useRel
      ? reps.map(r => r.avg_force_kg / bodyWeight)
      : reps.map(r => toDisp(r.avg_force_kg, unit))),
    useRel ? 0.5 : 40
  );

  // ── Zone breakdown (power / strength / capacity) ──
  // Buckets each rep by target_duration (what zone it was *training*),
  // not actual_time_s, so a failed Endurance-target hang that broke at
  // 60s still counts as a Endurance failure. Without this, Endurance
  // failures are structurally impossible when the target sits exactly
  // on the zone boundary (120s). Falls back to actual_time_s when a
  // rep has no target_duration (legacy data).
  //
  // Failure detection is computed live from actual_time_s < target_duration
  // to match the red/green rendering in History. The stored r.failed flag
  // only flips on auto-failure (Tindeq force-drop); manually-ended short
  // hangs leave r.failed=false even though the rep clearly failed.
  // (Per-zone `zones` memo + personalResponse memo removed —
  // both fed the now-gone Energy System Breakdown card and Train
  // block. recommendation / gripRecs / unexplored also gone.
  // The Setup tab's ContinuousPickCard is the prescription surface
  // now; the F-D chart + Curve Improvement + Curve Coverage cover
  // the diagnostic ground.)

  // Force Curves History overlay + Strength Balance history. Bundled
  // into useHistoryOverlay — balanceHistory derives entirely from
  // historyOverlay so keeping them paired collapses the dep chain.
  // See src/hooks/useHistoryOverlay.js for the per-memo notes.
  const { historyOverlay, balanceHistory } = useHistoryOverlay({
    history, grips, gripBaselines, perHandGripBaselines, threeExpPriors,
  });

  // (overlayActiveGrip / overlayDates / overlayLast / overlayNowI
  // moved into ForceCurvesOverlayCard — only that card consumed them.
  // ScatterTooltip likewise moved into ForceDurationCard.)

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
      {/* Click-to-expand session detail modal — triggered by tapping
          any dot on the F-D scatter. Renders one RepCurveChart per
          hand (so mixed-hand sessions don't artifactually splice L+R
          into one apparent set), each with its own target/used load
          caption and previous-session overlay. */}
      {selectedSession && selectedSession.perHand.length > 0 && (
        <div
          onClick={() => setSelectedSessionId(null)}
          style={{
            position: "fixed", inset: 0, zIndex: 100,
            background: "rgba(0,0,0,0.7)",
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: 16,
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: C.card ?? "#1a1a1a", borderRadius: 12,
              padding: 16, maxWidth: 520, width: "100%",
              maxHeight: "90vh", overflowY: "auto",
              border: `1px solid ${C.border}`,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700 }}>
                  {selectedSession.meta.grip}
                  <span style={{ marginLeft: 8, fontSize: 12, color: C.muted, fontWeight: 400 }}>
                    {selectedSession.meta.date} · target {selectedSession.meta.targetDuration}s · {selectedSession.meta.restS}s rest
                  </span>
                </div>
              </div>
              <button
                onClick={() => setSelectedSessionId(null)}
                style={{
                  background: "none", border: "none", color: C.muted,
                  fontSize: 20, cursor: "pointer", padding: "0 4px",
                }}
                aria-label="Close"
              >×</button>
            </div>
            {selectedSession.perHand.map(h => (
              <div key={h.handKey} style={{ marginBottom: selectedSession.perHand.length > 1 ? 14 : 0 }}>
                {selectedSession.perHand.length > 1 && (
                  <div style={{
                    fontSize: 10, fontWeight: 700, letterSpacing: 1,
                    color: h.handKey === "L" ? C.blue : C.orange,
                    marginBottom: 4,
                  }}>
                    {h.handKey === "L" ? "LEFT" : "RIGHT"}
                  </div>
                )}
                <RepCurveChart
                  forecasted={h.bundle.forecasted}
                  actual={h.bundle.actual}
                  prevSession={h.bundle.prevSession}
                  asymptoticHold={h.bundle.asymptoticHold}
                  targetS={h.bundle.targetS}
                  targetWeightKg={h.target}
                  usedWeightKg={effectiveLoad(h.handRep1) || null}
                  unit={unit}
                  height={220}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      <h2 style={{ margin: "0 0 4px", fontSize: 22 }}>Force-Duration Analysis</h2>
      <p style={{ margin: "0 0 16px", fontSize: 13, color: C.muted, lineHeight: 1.5 }}>
        Where reps fall relative to your force-duration curve shows which timescale is your limiter — and what to train next.
      </p>

      {/* Bodyweight logging lives on the Setup tab now (next to the
          climb logger). Analysis stays focused on viewing — the only
          BW-related control here is the Absolute / × BW units toggle
          inside the filter card below. */}

      {/* Filters */}
      <Card style={{ marginBottom: 16 }}>
        {/* Filter card: grip pills (left) + Absolute / × BW units
            toggle (right). Renders if EITHER grips exist OR a BW is
            set — previously gated on grips alone, which hid the units
            toggle for users with BW but no Tindeq reps.

            No hand selector: page-level hand filtering was retired
            because it added a confusing default state (a stale "L"
            selection used to silently hide Micro reps logged as R).
            Per-hand views happen inside the specific cards that need
            them (Strength Balance, Hand Asymmetry, the F-D chart's
            optional L/R overlay); the page as a whole is hand-pooled. */}
        {(grips.length > 0 || bodyWeight > 0) && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {grips.length > 0 && (
                <button onClick={() => setSelGrip("")} style={{
                  padding: "4px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer", border: "none",
                  background: !selGrip ? C.orange : C.border, color: !selGrip ? "#fff" : C.muted,
                }}>All Grips</button>
              )}
              {grips.map(g => (
                <button key={g} onClick={() => setSelGrip(g)} style={{
                  padding: "4px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer", border: "none",
                  background: selGrip === g ? C.orange : C.border, color: selGrip === g ? "#fff" : C.muted,
                }}>{g}</button>
              ))}
            </div>
            {/* Absolute / × BW units toggle. Hidden when no BW is set,
                since × BW would be inert without a divisor. */}
            {bodyWeight > 0 && (
              <div style={{ display: "flex", gap: 4 }}>
                {[{ key: false, label: "Absolute" }, { key: true, label: "× BW" }].map(opt => (
                  <button key={String(opt.key)} onClick={() => normalizeOn !== opt.key && toggleNormalize()} style={{
                    padding: "4px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer", border: "none", fontWeight: 600,
                    background: normalizeOn === opt.key ? C.purple : C.border,
                    color:      normalizeOn === opt.key ? "#fff"   : C.muted,
                  }}>{opt.label}</button>
                ))}
              </div>
            )}
          </div>
        )}
      </Card>

      {/* F-D chart hoisted to the top of AnalysisView — most important
          visual on this view. Empty-state placeholder still appears
          below in the {reps.length === 0 ? ...} block. */}
      {reps.length > 0 && (<>
        {/* ── Force-Duration scatter ──
            Display mode (Absolute vs × BW) is driven by the global
            normalize toggle in the page header — the per-card pill that
            used to live here was retired so all four metric surfaces
            switch in lockstep. Card body extracted to ForceDurationCard
            (May 2026 BACKLOG #156 fourth pass); AnalysisView wires the
            data props in. */}
        <ForceDurationCard
          unit={unit}
          bodyWeight={bodyWeight}
          useRel={useRel}
          normalizeOn={normalizeOn}
          fdSplitData={fdSplitData}
          threeExpCurveDataRel={threeExpCurveDataRel}
          threeExpRef180={threeExpRef180}
          limiterZoneBounds={limiterZoneBounds}
          curveColor={curveColor}
          leftDotsRel={leftDotsRel}
          rightDotsRel={rightDotsRel}
          maxDur={maxDur}
          maxForceRel={maxForceRel}
          handAsymmetry={handAsymmetry}
          history={history}
          threeExpPriors={threeExpPriors}
          handleDotClick={handleDotClick}
        />
        {/* (Inline F-D card render block was here — ~280 lines covering
            the title + legend + ComposedChart + per-grip split-mode
            curves/dots + zone labels + Hand Asymmetry rows. Now in
            src/views/analysis/ForceDurationCard.jsx.) */}

        {/* (PrescribedLoadCard removed from Analysis — was redundant
            with the SessionPlanCard on Setup which renders the same
            six-zone tile grid plus the recommendation. Analysis keeps
            the F-D chart for the visual prescription story; the
            tabular per-zone view lives on Setup where it informs the
            actual session pick.) */}

        {/* ── Curve Improvement summary ──
            (Was "Endurance Improvement" — renamed because the headline
            isn't endurance, it's the average of three F-D curve point
            improvements at ZONE_REF_T's power/strength/endurance times
            — currently 7s / 45s / 120s. The blue Endurance cell is the
            one true endurance signal; Power and Strength are the other
            two reference points on the same curve.)
            Rendered right under the F-D chart as the per-zone summary
            of "where are the gains coming from" — the chart shows the
            shape, this card shows the deltas. The CapacityTrajectory
            % trend follows immediately so the reader can pivot from
            "where" (zones) to "when" (over time).
            Card extracted to CurveImprovementCard (May 2026 BACKLOG
            #156 fifth pass). The three branch modes (perGripMode,
            selGrip-with-baseline, pooled fallback) and their early-days
            placeholders all live in the component now. */}
        <CurveImprovementCard
          improvement={improvement}
          gripImprovement={gripImprovement}
          grip3xEstimates={grip3xEstimates}
          gripBaselines={gripBaselines}
          global3xBaseline={global3xBaseline}
          selGrip={selGrip}
          history={history}
        />

        <CapacityTrajectoryCard
          aucHistoryByGrip={aucHistoryByGrip}
          normalizeOn={normalizeOn}
        />

        {/* (StrengthBalanceCard moved to the bottom of Analysis — see
            the closing block. The user's preferred reading order is:
            chart → per-zone deltas → time trend → exploratory overlays
            → 1RM PRs → recovery → hand asymmetry → curve coverage.) */}

        {/* ── Force Curves History — vs baseline overlay ──
            Baseline three-exp curve (dashed, muted) overlaid against
            the cumulative fit at any post-baseline date (solid, grip
            color). Per-T deltas underneath show where on the curve
            the gains/losses landed. Card extracted to
            ForceCurvesOverlayCard (May 2026 BACKLOG #156 sixth pass);
            overlayActiveGrip/Dates/Last/NowI derivations live in the
            component since they're only consumed there. */}
        <ForceCurvesOverlayCard
          historyOverlay={historyOverlay}
          maxDur={maxDur}
          unit={unit}
          selGrip={selGrip}
          historyGrip={historyGrip}
          setHistoryGrip={setHistoryGrip}
          historyNowIdx={historyNowIdx}
          setHistoryNowIdx={setHistoryNowIdx}
          historyViewMode={historyViewMode}
          setHistoryViewMode={setHistoryViewMode}
        />

        {/* (CurveCoverageCard moved to the bottom of Analysis — see
            the closing block. Lives last so the freshness rundown
            anchors the page rather than interrupting the metric
            stack mid-scroll.) */}
      </>)}

      {/* ── 1RM PR tracker ── */}
      <OneRMPRCard activities={activities} rmGrips={RM_GRIPS} unit={unit} />

      {reps.length === 0 ? (
        <Card>
          <div style={{ textAlign: "center", padding: "32px 0", color: C.muted }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📊</div>
            <div>No session data yet for this selection.</div>
            <div style={{ fontSize: 12, marginTop: 8 }}>Run a few sessions on this grip / hand to start building a force-duration curve.</div>
          </div>
        </Card>
      ) : (<>

        {/* (Critical Force Estimate, Climbing Endurance chart, Train
            block, and the absolute-kg·s Capacity card all removed under
            the three-exp / curve-trust direction. The absolute AUC was
            redundant — magnitude is already visible on the F-D chart
            and Strength Balance card, and the kg·s unit on the chart
            axis was opaque. The % vs baseline trajectory tells the
            actual training-progress story.) */}

        {/* Recovery dynamics over time — paired cards.
            Observed trend (this card) reads the direct, easy-to-feel
            signal: raw rep 2 / rep 1 ratio smoothed over 3 sessions.
            "How fragmented are my sets over time?" Confounded by
            rep 1 lengthening as the user gets stronger.
            Gap trend (below) factors that confound out by comparing
            against the personalized recovery model. "Is my recovery
            side underperforming what my taus predict?" Two views of
            the same underlying signal, intentionally kept separate. */}
        <RecoveryObservedTrendCard history={history} grips={grips} />
        <RecoveryTrendCard history={history} grips={grips} />

        {/* Hand asymmetry — second-to-last per user preference. The
            crusher-vs-micro ratio is more "explore when curious" than
            "check every session," so it lives near the bottom rather
            than competing with the metric stack up top. */}
        <StrengthBalanceCard
          gripHandFits={gripHandFits}
          balanceHistory={balanceHistory}
          unit={unit}
        />

        {/* Curve Coverage — per-zone data freshness + annual pace.
            Anchors the bottom of Analysis: it's a "how good is your
            data" rundown rather than a training-signal card, so it
            reads naturally as the final summary of the page. */}
        <CurveCoverageCard history={history} />

        {/* (Per-Compartment Dose AUC chart + Energy System Breakdown
            card removed under curve-trust — both were zone-keyed
            descriptive surfaces that pre-dated the continuous engine.
            The F-D chart, Total Capacity AUC over time, Curve
            Improvement, and Curve Coverage cards all cover the same
            diagnostic ground more cleanly. The dose-decomposition
            math also leaned on mechanistic-flavored language that
            doesn't survive the phenomenological-model framing.) */}

      </>)}
    </div>
  );
}
