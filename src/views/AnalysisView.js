// ─────────────────────────────────────────────────────────────
// ANALYSIS VIEW
// ─────────────────────────────────────────────────────────────
// The "Analysis" tab — Force-Duration chart, Total Capacity (AUC)
// trajectory, Critical Force estimate cards, per-grip Curve
// Improvement, the shared PrescribedLoadCard, and CurveCoverageCard
// (per-zone data freshness + annual session pace).
//
// All state comes in via props: history, freshMap (built in
// useRepHistory), activities, bodyWeight. threeExpPriors are
// memoized locally from history. No localStorage access for primary
// state, no BLE, no live session state — pure read-and-render
// over the rep array.
//
// Cross-cutting App config (GOAL_CONFIG, RM_GRIPS) is passed in as
// props so this module stays decoupled from App.js's constant block;
// pure model helpers are imported directly from the model layer.

import React, { useMemo, useState } from "react";
import {
  ResponsiveContainer, LineChart, Line, ComposedChart, Scatter,
  XAxis, YAxis, Tooltip, CartesianGrid,
  ReferenceLine, ReferenceArea,
} from "recharts";
import { C } from "../ui/theme.js";
import { Card } from "../ui/components.js";
import { KG_TO_LBS, fmt1, fmtW, toDisp, bwOnDate } from "../ui/format.js";
import { loadLS, saveLS, LS_BW_LOG_KEY, LS_BW_NORMALIZE_KEY } from "../lib/storage.js";
import { STRENGTH_MAX, ZONE_REF_T, ZONE_KEYS, ZONE6 } from "../model/zones.js";
import {
  THREE_EXP_LAMBDA_DEFAULT, fitThreeExpAmps, predForceThreeExp,
  buildThreeExpPriors, computeAUCThreeExp,
} from "../model/threeExp.js";
// (prescription import gone — PrescribedLoadCard moved to ./cards/.)
// (lockout helpers — getZoneStaleness, getRollingSessionPace,
//  ANNUAL_SESSION_GOAL, LOCKOUT_WINDOW_DAYS — moved to
//  ./analysis/CurveCoverageCard.js along with their only consumer in
//  the May 2026 decomp pass.)
import { RepCurveChart } from "./cards/RepCurveChart.jsx";
import { buildRepCurveBundle } from "../model/repCurveData.js";
import { prescription } from "../model/prescription.js";
// (PrescribedLoadCard removed May 2026 — Setup's SessionPlanCard
// renders the same six-zone tile grid plus the active session pick,
// so showing it again on Analysis was redundant. The component file
// was deleted with this commit.)
// (computePersonalResponse import removed — fed the now-gone Train block)
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
import { RecoveryTrendCard } from "./analysis/RecoveryTrendCard.jsx";
// (EnergySystemBreakdownCard import removed — card dropped under curve-trust)

// Per-grip color used wherever Micro and Crusher are charted side-by-
// side (F-D scatter overlays, AUC-PR cards, CF-over-time chart).
// Single source of truth so the legend, scatter dots, line strokes,
// and PR badges all agree without five identical inline declarations.
// Falls back to C.blue at call sites that pass an unknown grip key.
const GRIP_COLORS = { Micro: "#e05560", Crusher: C.orange, Prime: "#7c5cbf" };

// (buildRecFromFit removed under curve-trust — the per-grip Train
// cards it backed are gone; Setup's ContinuousPickCard is the
// prescription surface now.)

// PrescribedLoadCard lives in ./cards/PrescribedLoadCard.js — same
// component is rendered on both Setup (under the Recommended Session)
// and Analysis (under the F-D chart). Single source, two render sites.

// (CurveCoverageCard extracted to ./analysis/CurveCoverageCard.js
//  in the May 2026 AnalysisView decomp pass.)

export function AnalysisView({
  history, unit = "lbs", bodyWeight = null,
  activities = [],
  freshMap = null,
  // Per-grip β fatigue model from user_settings.settings.fatigue_model.
  // Currently unused on this surface — the PrescribedLoadCard render was
  // removed from Analysis because SessionPlanCard on Setup renders the
  // same tiles. Kept on the prop signature for future Analysis-side
  // diagnostics (β trajectory, cooked-vs-residual scatter).
  // eslint-disable-next-line no-unused-vars
  fatigueModel = null,
  // Cross-cutting App config — passed in rather than imported so this
  // module doesn't reach back into App.js for view-level constants.
  GOAL_CONFIG = {},
  RM_GRIPS = [],
}) {
  // Hand-filter state retired (the L/R/Both buttons were removed —
  // see the FilterCard comment near render). Kept as a const so the
  // many `(!selHand || r.hand === selHand)` checks scattered through
  // the file still compile and behave as "no hand filter applied."
  // Cleaner refactor would inline-strip every reference, but this
  // is a minimum-diff change that's trivially reversible.
  const selHand = "";
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
        const target = prescription(priorHistory, handKey, grip, targetDuration,
          { freshMap, threeExpPriors });
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
  // selHand === "" means Both — pool L+R for the F-D chart's at-a-glance
  // view. Per-hand prescriptions still iterate L and R explicitly elsewhere.
  const reps = useMemo(() => history.filter(r =>
    (!selHand || r.hand === selHand) &&
    (!selGrip || r.grip === selGrip) &&
    r.avg_force_kg > 0 && r.avg_force_kg < 500 &&
    r.actual_time_s > 0
  ), [history, selHand, selGrip]);

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
  // Reference durations for each zone come from ZONE_REF_T (the
  // canonical model reference). Now built from ZONE_KEYS so the
  // 6-zone schema flows through here automatically: this card's
  // % deltas reflect "how much stronger am I at the times I train"
  // across the full force-time landscape (max strength → endurance).
  const REF = useMemo(
    () => Object.fromEntries(ZONE_KEYS.map(k => [k, ZONE_REF_T[k]])),
    []
  );

  // Migrated from Monod (CF + W'/T) to the three-exp basis in March
  // 2026 — see commit migrating this card. The rest of the app moved
  // to three-exp during Phases A–D; leaving this card on Monod meant
  // the headline % the user saw here didn't agree with the curve they
  // saw on the F-D chart, AND the Power column in particular was
  // dominated by W' fit noise (small-N Monod fits over-estimate W',
  // which inflates F at short T, producing phantom regressions). The
  // three-exp basis with a grip-prior anchors the fast amplitude even
  // when failures are sparse, so the Power column behaves.

  // Three-exp fit helper: pulls the grip-aware prior from
  // threeExpPriors and applies adaptive lambda shrinkage so small-N
  // fits don't run away. Returns [a, b, c] amps or null. Same
  // pattern coaching.js uses for its per-hand fits — keeps both
  // surfaces honest about where small-sample data is being smoothed.
  const fitAmpsForPts = (pts, grip) => {
    if (!pts || pts.length < 1) return null;
    const prior = (grip && threeExpPriors && threeExpPriors.get)
      ? (threeExpPriors.get(grip) ?? [0, 0, 0])
      : [0, 0, 0];
    const hasPrior = (prior[0] + prior[1] + prior[2]) > 0;
    const lambda = hasPrior ? THREE_EXP_LAMBDA_DEFAULT / Math.max(pts.length, 1) : 0;
    const amps = fitThreeExpAmps(pts, { prior, lambda });
    if (!amps || (amps[0] + amps[1] + amps[2]) <= 0) return null;
    return amps;
  };

  // Reusable: compute per-zone Δ% from a current set of three-exp
  // amps vs a reference set. Returns one key per ZONE_KEY plus a
  // `total` field that uses the AUC ratio — the integrated area
  // under the curve from 5s to 180s.
  //
  // The `total` was previously a simple average of the per-zone
  // deltas, which evaluated F(T) at six discrete sample points
  // and averaged them. That gave a different headline number from
  // the Total Capacity (AUC) chart (which integrates over the
  // continuous curve), and the discrepancy was confusing — same
  // curves, two summary numbers, two different answers.
  // Switching `total` to the AUC ratio makes the headline match
  // the chart. Per-zone Δ% remains a useful landscape view of
  // where the curve grew vs shrunk.
  const improvementForAmps = (curAmps, refAmps) => {
    if (!curAmps || !refAmps) return null;
    const pct = (t) => {
      const cur = predForceThreeExp(curAmps, t);
      const ref = predForceThreeExp(refAmps, t);
      if (ref <= 0) return null;
      return Math.round((cur / ref - 1) * 100);
    };
    const result = {};
    for (const k of ZONE_KEYS) {
      const v = pct(REF[k]);
      if (v == null) return null;
      result[k] = v;
    }
    // AUC-based total — matches the Total Capacity (AUC) chart's
    // headline metric. Falls back to the zone-average if either
    // AUC is non-positive (degenerate fit).
    const curAUC = computeAUCThreeExp(curAmps);
    const refAUC = computeAUCThreeExp(refAmps);
    if (curAUC > 0 && refAUC > 0) {
      result.total = Math.round((curAUC / refAUC - 1) * 100);
    } else {
      const sum = ZONE_KEYS.reduce((s, k) => s + result[k], 0);
      result.total = Math.round(sum / ZONE_KEYS.length);
    }
    return result;
  };

  // Three-exp current fit on the filtered failures — this is the
  // role cfEstimate (Monod) used to play here, but now scoped to
  // the same {hand, grip} filter the user has set on this view.
  const current3xAmps = useMemo(
    () => fitAmpsForPts(failures.map(r => ({ T: r.actual_time_s, F: r.avg_force_kg })), selGrip),
    [failures, selGrip, threeExpPriors] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Pooled three-exp baseline — re-derived from the same earliest-
  // window seed logic the App-level Monod baseline uses (≥3 failures
  // across ≥2 distinct durations, dated to the earliest rep in the
  // seed window). Computed locally rather than loaded from the
  // App.js Monod snapshot so the comparison is purely three-exp on
  // both sides; the two halves of the Δ% live in the same model.
  const global3xBaseline = useMemo(() => {
    // Train-to-failure model: every rep with valid actual_time_s is a
    // (T, F) data point. Drop the legacy r.failed filter.
    const allFails = (history || [])
      .filter(r => r.avg_force_kg > 0 && r.avg_force_kg < 500 && r.actual_time_s > 0)
      .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    const acc = [];
    const durs = new Set();
    for (const r of allFails) {
      acc.push(r);
      durs.add(r.target_duration);
      if (acc.length >= 3 && durs.size >= 2) {
        const amps = fitAmpsForPts(
          acc.map(x => ({ T: x.actual_time_s, F: x.avg_force_kg })),
          null  // pooled across grips → no per-grip prior
        );
        if (amps) return { date: acc[0].date, amps };
        return null;
      }
    }
    return null;
  }, [history, threeExpPriors]); // eslint-disable-line react-hooks/exhaustive-deps

  const improvement = useMemo(
    () => improvementForAmps(current3xAmps, global3xBaseline?.amps),
    [current3xAmps, global3xBaseline] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Per-grip baselines (three-exp). For each grip, find the earliest
  // window of failure reps (≥5 reps, ≥3 distinct target durations)
  // and fit a three-exp basis from just that grip's reps. Mirrors the
  // global seeding logic but scoped per-grip; tighter thresholds (5/3
  // vs 3/2 globally) preserve the historical "small fits are noisy"
  // damping. The grip-aware prior shrinkage from fitAmpsForPts further
  // anchors the fast amplitude, which under Monod was the main source
  // of phantom Power regressions at low N.
  const gripBaselines = useMemo(() => {
    // Train-to-failure model: every rep with valid actual_time_s is a
    // (T, F) data point. Drop the legacy r.failed filter.
    const out = {};
    const byGrip = {};
    for (const r of history) {
      if (!r.grip) continue;
      if (!(r.avg_force_kg > 0 && r.avg_force_kg < 500)) continue;
      if (!(r.actual_time_s > 0)) continue;
      if (!byGrip[r.grip]) byGrip[r.grip] = [];
      byGrip[r.grip].push(r);
    }
    for (const [grip, reps] of Object.entries(byGrip)) {
      reps.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
      const acc = [];
      const durs = new Set();
      for (const r of reps) {
        acc.push(r);
        durs.add(r.target_duration);
        if (acc.length >= 5 && durs.size >= 3) {
          const amps = fitAmpsForPts(
            acc.map(x => ({ T: x.actual_time_s, F: x.avg_force_kg })),
            grip
          );
          if (amps) out[grip] = { date: acc[0].date, amps };
          break;
        }
      }
    }
    return out;
  }, [history, threeExpPriors]); // eslint-disable-line react-hooks/exhaustive-deps

  // Per-grip CURRENT three-exp amps — the "now" side of the per-grip
  // improvement comparison. Pulls every failure on that grip and fits
  // a three-exp basis with the grip's prior. (The Monod equivalent
  // was App.js's `gripEstimates`, but we want both sides of the Δ%
  // to live in the same model.)
  const grip3xEstimates = useMemo(() => {
    // Train-to-failure model: every rep with valid actual_time_s is a
    // (T, F) data point. Drop the legacy r.failed filter.
    const out = {};
    const byGrip = {};
    for (const r of history) {
      if (!r.grip) continue;
      if (!(r.avg_force_kg > 0 && r.avg_force_kg < 500)) continue;
      if (!(r.actual_time_s > 0)) continue;
      if (!byGrip[r.grip]) byGrip[r.grip] = [];
      byGrip[r.grip].push(r);
    }
    for (const [grip, reps] of Object.entries(byGrip)) {
      const amps = fitAmpsForPts(
        reps.map(r => ({ T: r.actual_time_s, F: r.avg_force_kg })),
        grip
      );
      if (amps) out[grip] = amps;
    }
    return out;
  }, [history, threeExpPriors]); // eslint-disable-line react-hooks/exhaustive-deps

  // Per-grip × per-hand three-exp fits. Used by the Strength Balance
  // and Endurance Ceiling cards below. Falls back to a pooled fit on
  // the grip when a hand doesn't have enough samples. Doubles as a
  // grip-level "is this grip fitable at all?" gate (≥3 total reps).
  const gripHandFits = useMemo(() => {
    const out = {};
    for (const grip of grips) {
      const gripReps = (history || []).filter(r =>
        r.grip === grip &&
        r.avg_force_kg > 0 && r.avg_force_kg < 500 &&
        r.actual_time_s > 0
      );
      if (gripReps.length < 3) continue;
      const entry = {};
      for (const hand of ["L", "R"]) {
        const pts = gripReps.filter(r => r.hand === hand)
          .map(r => ({ T: r.actual_time_s, F: r.avg_force_kg }));
        if (pts.length >= 2) {
          const amps = fitAmpsForPts(pts, grip);
          if (amps) entry[hand] = amps;
        }
      }
      const pooledAmps = fitAmpsForPts(
        gripReps.map(r => ({ T: r.actual_time_s, F: r.avg_force_kg })),
        grip
      );
      if (pooledAmps) entry.pooled = pooledAmps;
      if (entry.pooled || entry.L || entry.R) out[grip] = entry;
    }
    return out;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, grips, threeExpPriors]);

  // gripImprovement is defined AFTER perHandGripBaselines (below)
  // because it now depends on per-hand baselines for the averaged
  // delta path. See the const further down for the actual definition.

  // ── Per-hand × per-grip baselines (three-exp) ──
  // Same seeding logic as gripBaselines but scoped to a single hand
  // on a single grip. Threshold: ≥5 failures across ≥3 distinct
  // durations per (grip, hand). The grip-aware prior in fitAmpsForPts
  // anchors the fast amplitude even when these per-(hand,grip) sets
  // are sparse; under Monod the small-N W' variance was the source
  // of phantom Power regressions on whichever combo started above
  // the pooled mean.
  const perHandGripBaselines = useMemo(() => {
    // Train-to-failure model: every rep with valid actual_time_s is a
    // (T, F) data point. Drop the legacy r.failed filter.
    const out = {};
    const byKey = {};
    for (const r of history) {
      if (!r.grip || !r.hand || r.hand === "Both") continue;
      if (!(r.avg_force_kg > 0 && r.avg_force_kg < 500)) continue;
      if (!(r.actual_time_s > 0)) continue;
      const key = `${r.grip}|${r.hand}`;
      if (!byKey[key]) byKey[key] = [];
      byKey[key].push(r);
    }
    for (const [key, reps] of Object.entries(byKey)) {
      reps.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
      const acc = [];
      const durs = new Set();
      for (const r of reps) {
        acc.push(r);
        durs.add(r.target_duration);
        if (acc.length >= 5 && durs.size >= 3) {
          const grip = key.split("|")[0];
          const amps = fitAmpsForPts(
            acc.map(x => ({ T: x.actual_time_s, F: x.avg_force_kg })),
            grip
          );
          if (amps) out[key] = { date: acc[0].date, amps };
          break;
        }
      }
    }
    return out;
  }, [history, threeExpPriors]); // eslint-disable-line react-hooks/exhaustive-deps

  // Per-grip improvement — when both per-hand baselines exist for a
  // grip, compute per-hand improvements (L vs L-baseline, R vs R-
  // baseline) and AVERAGE the per-zone deltas. Otherwise fall back to
  // a pooled-fit comparison (current pooled fit vs pooled baseline)
  // for grips that don't have a complete per-hand baseline yet.
  //
  // Uses POOLED current fit vs POOLED baseline so the headline `total`
  // and per-zone Δ%s use the same calc as the Capacity (AUC) chart's
  // most-recent point. Previously this averaged per-hand improvements,
  // which produced a different number from the chart for grips with
  // L/R asymmetry — confusing when a user compares the two surfaces.
  // The chart, this card, and the Capacity-Improvement sub-rows now
  // all read off the same fit pair (pooled current, pooled baseline)
  // so the numbers tie out everywhere.
  const gripImprovement = useMemo(() => {
    const out = {};
    for (const grip of Object.keys(grip3xEstimates)) {
      const pooledRef = gripBaselines[grip];
      if (!pooledRef) continue;
      const imp = improvementForAmps(grip3xEstimates[grip], pooledRef.amps);
      if (imp) out[grip] = { ...imp, baselineDate: pooledRef.date };
    }
    return out;
  }, [gripBaselines, grip3xEstimates]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Per-grip hand asymmetry diagnostic ──
  // For each grip with both L and R three-exp fits, compute the
  // asymmetry between hands at a representative duration (30s — middle
  // of the curve, exercises both fast + middle components). The point
  // of this card is to surface the limiter you don't normally see:
  // most prescription paths are already per-hand, but the user has no
  // single number telling them "your weaker hand is X% behind your
  // stronger hand on grip Y." That's the gap this fills.
  const ASYM_REF_T = 30;
  const handAsymmetry = useMemo(() => {
    const out = [];
    for (const grip of Object.keys(grip3xEstimates)) {
      // Build per-hand three-exp current fits using the same
      // train-to-failure data path everyone else uses.
      const buildHandPts = (hand) => history
        .filter(r => r.grip === grip && r.hand === hand)
        .filter(r => r.avg_force_kg > 0 && r.avg_force_kg < 500 && r.actual_time_s > 0)
        .map(r => ({ T: r.actual_time_s, F: r.avg_force_kg }));
      const lPts = buildHandPts("L");
      const rPts = buildHandPts("R");
      if (lPts.length < 2 || rPts.length < 2) continue;
      const lAmps = fitAmpsForPts(lPts, grip);
      const rAmps = fitAmpsForPts(rPts, grip);
      if (!lAmps || !rAmps) continue;

      const lForce = predForceThreeExp(lAmps, ASYM_REF_T);
      const rForce = predForceThreeExp(rAmps, ASYM_REF_T);
      if (!(lForce > 0) || !(rForce > 0)) continue;

      const stronger = lForce >= rForce ? "L" : "R";
      const weaker   = stronger === "L" ? "R" : "L";
      const strongerForce = Math.max(lForce, rForce);
      const weakerForce   = Math.min(lForce, rForce);
      const asymPct = (strongerForce - weakerForce) / strongerForce;

      out.push({
        grip,
        L: lForce, R: rForce,
        stronger, weaker, asymPct,
      });
    }
    return out.sort((a, b) => b.asymPct - a.asymPct);
  }, [history, grip3xEstimates]); // eslint-disable-line react-hooks/exhaustive-deps

  // Progress toward unlocking a per-grip (or per-grip × hand) baseline.
  // Returns {failures, distinctDurations, ready} so UI placeholders can
  // show "3 of 5 failures · 2 of 3 durations" instead of the static
  // "need ≥5 failures across ≥3 target durations" — the user can see
  // exactly how close they are to a stable comparison being unlocked.
  // Hand is optional; pass null/undefined to count across both hands.
  const FAIL_THRESHOLD = 5;
  const DUR_THRESHOLD  = 3;
  const baselineProgress = (grip, hand = null) => {
    // Train-to-failure model: every rep with valid actual_time_s is a
    // (T, F) failure data point. Drop the legacy r.failed filter.
    let failures = 0;
    const durs = new Set();
    for (const r of history) {
      if (r.grip !== grip) continue;
      if (hand && r.hand !== hand) continue;
      if (!(r.avg_force_kg > 0 && r.avg_force_kg < 500)) continue;
      if (!(r.actual_time_s > 0)) continue;
      failures += 1;
      if (r.target_duration) durs.add(r.target_duration);
    }
    return {
      failures,
      distinctDurations: durs.size,
      ready: failures >= FAIL_THRESHOLD && durs.size >= DUR_THRESHOLD,
    };
  };

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
      if (selHand && r.hand !== selHand) continue;
      if (!(r.avg_force_kg > 0 && r.avg_force_kg < 500)) continue;
      if (!(r.actual_time_s > 0)) continue;
      byGrip[r.grip] = (byGrip[r.grip] || 0) + 1;
    }
    const qualifyingGrips = Object.entries(byGrip)
      .filter(([, count]) => count >= 2)
      .map(([grip]) => grip);
    if (qualifyingGrips.length < 2) return null;
    return Object.fromEntries(qualifyingGrips.map(g => [g, true]));
  }, [history, selHand, selGrip]);

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
  const aucHistoryByGrip = useMemo(() => {
    // Per-grip date-keyed map of AUC values (and % vs baseline).
    // We compute BOTH the raw % and the BW-normalized % in one pass
    // and let the render pick which to show based on normalizeOn —
    // toggling the pill should not retrigger the expensive curve fits.
    //
    // BW-normalized math: dividing both numerator and denominator by
    // their respective BWs gives
    //   pct_bw = (abs/sessionBW) / (baseAUC/baseBW) − 1
    //          = (abs/baseAUC) × (baseBW/sessionBW) − 1
    // which collapses to pct_raw whenever sessionBW == baseBW.
    const perGrip = {};            // grip -> Map<date, { abs, pct, pctBW }>
    const baselineByGrip = {};     // grip -> { auc, bw }
    const datesUnion = new Set();
    for (const g of grips) {
      const gripFails = (history || []).filter(r =>
        r.grip === g &&
        r.avg_force_kg > 0 && r.avg_force_kg < 500 && r.actual_time_s > 0
      );
      if (gripFails.length < 3) continue;
      const datesSet = new Set();
      for (const r of gripFails) if (r.date) datesSet.add(r.date);
      const dates = [...datesSet].sort();
      if (dates.length < 2) continue;
      // Baseline AUC + the BW that prevailed at the baseline date.
      // bwOnDate returns the most-recent-on-or-before entry, so a
      // baseline dated before the first BW log just yields null and
      // pctBW falls back to the raw pct in the render.
      const base = gripBaselines[g];
      if (base?.amps) {
        const baseAUC = computeAUCThreeExp(base.amps);
        const baseBwEntry = base.date ? bwOnDate(bwLog, base.date) : null;
        baselineByGrip[g] = { auc: baseAUC, bw: baseBwEntry?.kg ?? null };
      }
      const seriesMap = new Map();
      for (const date of dates) {
        const upToFails = gripFails.filter(r => (r.date || "") <= date);
        if (upToFails.length < 3) continue;
        const amps = fitAmpsForPts(
          upToFails.map(r => ({ T: r.actual_time_s, F: r.avg_force_kg })),
          g
        );
        if (!amps) continue;
        const abs = computeAUCThreeExp(amps);
        if (!(abs > 0)) continue;
        const baseAUC = baselineByGrip[g]?.auc;
        const baseBW  = baselineByGrip[g]?.bw;
        const sessionBW = bwOnDate(bwLog, date)?.kg ?? null;
        const pct = baseAUC && baseAUC > 0
          ? Math.round((abs / baseAUC - 1) * 100)
          : null;
        const pctBW = (baseAUC && baseAUC > 0 && baseBW > 0 && sessionBW > 0)
          ? Math.round((abs / baseAUC * baseBW / sessionBW - 1) * 100)
          : pct;  // fall back to raw pct if any BW is missing
        seriesMap.set(date, { abs: Math.round(abs), pct, pctBW });
        datesUnion.add(date);
      }
      if (seriesMap.size >= 2) perGrip[g] = seriesMap;
    }
    if (Object.keys(perGrip).length === 0) return null;
    // Per-grip 3-point centered rolling mean over each grip's own
    // ordered session-date series (NOT over the union — gaps between
    // grips' training days should not smear one grip into another's
    // schedule). Endpoints fall back to 2-point means. Grips with <3
    // sessions skip smoothing entirely; their smoothed series stays
    // null so the line simply doesn't render.
    const smoothedByGrip = {};  // grip -> Map<date, { pctSm, pctBWSm }>
    for (const g of Object.keys(perGrip)) {
      const entries = [...perGrip[g].entries()].sort(
        (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
      );
      const sm = new Map();
      const n = entries.length;
      if (n >= 3) {
        for (let i = 0; i < n; i++) {
          const lo = Math.max(0, i - 1);
          const hi = Math.min(n - 1, i + 1);
          let pSum = 0, pCnt = 0, bSum = 0, bCnt = 0;
          for (let j = lo; j <= hi; j++) {
            const v = entries[j][1];
            if (v.pct   != null) { pSum += v.pct;   pCnt++; }
            if (v.pctBW != null) { bSum += v.pctBW; bCnt++; }
          }
          sm.set(entries[i][0], {
            pctSm:   pCnt > 0 ? Math.round(pSum / pCnt) : null,
            pctBWSm: bCnt > 0 ? Math.round(bSum / bCnt) : null,
          });
        }
      }
      smoothedByGrip[g] = sm;
    }
    const dates = [...datesUnion].sort();
    const absRows = [];
    const pctRows = [];
    const pctRowsBW = [];
    for (const date of dates) {
      const aRow = { date };
      const pRow = { date };
      const pBwRow = { date };
      for (const g of Object.keys(perGrip)) {
        const v = perGrip[g].get(date);
        const sv = smoothedByGrip[g]?.get(date);
        aRow[`${g}_abs`]      = v ? v.abs   : null;
        pRow[`${g}_pct`]      = v ? v.pct   : null;
        pRow[`${g}_pct_sm`]   = sv ? sv.pctSm   : null;
        pBwRow[`${g}_pct`]    = v ? v.pctBW : null;
        pBwRow[`${g}_pct_sm`] = sv ? sv.pctBWSm : null;
      }
      absRows.push(aRow);
      pctRows.push(pRow);
      pctRowsBW.push(pBwRow);
    }
    return {
      grips: Object.keys(perGrip),
      absRows,
      pctRows,
      pctRowsBW,
      hasPct: Object.values(baselineByGrip).some(v => v.auc > 0),
    };
  }, [history, grips, gripBaselines, threeExpPriors, bwLog]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Three-exp F-D fit (governing model — see src/model/threeExp.js) ──
  // threeExpPriors memoized earlier in AnalysisView so the F-D chart
  // curve and any per-grip three-exp consumers share one fit basis.

  // Three-exp fit for the current (selHand, selGrip) scope. Uses the
  // same `failures` array that backs cfEstimate, so the fits are
  // directly comparable. When no grip is selected, we can't pick a
  // prior — fall back to no-shrinkage fit (which validation showed
  // loses to Monod by ~3% on aggregate, fine as a degenerate case).
  const threeExpFit = useMemo(() => {
    if (failures.length < 2) return null;
    const pts = failures.map(r => ({ T: r.actual_time_s, F: r.avg_force_kg }));
    const prior = selGrip ? (threeExpPriors.get(selGrip) || [0,0,0]) : [0,0,0];
    const lambda = selGrip ? THREE_EXP_LAMBDA_DEFAULT / Math.max(failures.length, 1) : 0;
    const amps = fitThreeExpAmps(pts, { prior, lambda });
    if (amps[0] + amps[1] + amps[2] <= 0) return null;
    return { amps, prior, lambda };
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
  const useRel = relMode && bodyWeight != null && bodyWeight > 0;
  // Convert a kg force value to the display value (abs or relative)
  const fmtForce = (kg) => {
    if (kg == null) return "—";
    if (useRel) return fmt1(kg / bodyWeight);     // unitless ratio
    return fmtW(kg, unit);
  };
  const forceUnit = useRel ? "× BW" : unit;

  // Scatter data — split by hand under the train-to-failure model.
  // The previous green/red split (Completed / Auto-failed) was a
  // vestige of the success/failure dichotomy that the data model
  // no longer carries. Coloring by hand (L = blue, R = yellow)
  // adds a useful per-hand signal at a glance and pairs with the
  // Hand Asymmetry card below the chart. Reps with no hand or
  // hand="Both" (legacy data) drop into the L bucket as a quiet
  // default — rare and not worth a third bar.
  const HAND_COLORS = { L: C.blue, R: C.yellow };
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

  // ── Force Curves History overlay data ──
  // For each grip with a baseline AND ≥1 post-baseline fitable date,
  // expose: the baseline amps (anchored, same as gripBaselines so
  // this card agrees with Capacity % and Curve Improvement) plus
  // a sorted post-baseline date list with cumulative amps per date.
  //
  // Cumulative fits use the same `up-to-date` logic as the AUC
  // history chart so the "Now" curve moves forward in time
  // monotonically as more reps come in.
  //
  // Why anchor on gripBaselines instead of "first fitable date":
  // gripBaselines requires ≥5 reps spanning ≥3 distinct target
  // durations, which avoids the degenerate single-duration window
  // fit. Using "first fitable date" (≥3 cumulative reps) often gave
  // a baseline fit on 3–4 long-hold-only reps, which extrapolates
  // wildly at short T and made the deltas disagree with Curve
  // Improvement by 10%+ in either direction.
  const historyOverlay = useMemo(() => {
    const byGrip = {};   // grip -> { baselineAmps, baselineDate, dates: [], ampsByDate: Map<date, [a,b,c]> }
    for (const g of grips) {
      const baseline = gripBaselines[g];
      if (!baseline?.amps) continue;     // no baseline → can't anchor
      const gripReps = (history || []).filter(r =>
        r.grip === g &&
        r.avg_force_kg > 0 && r.avg_force_kg < 500 && r.actual_time_s > 0
      );
      if (gripReps.length < 3) continue;
      // Restrict the Now slider to dates AT or AFTER the baseline
      // date. Earlier dates produce a partial cumulative fit that
      // would compare a single-duration window against the well-
      // constrained baseline — apples-to-oranges deltas.
      const datesSet = new Set();
      for (const r of gripReps) {
        if (r.date && r.date >= baseline.date) datesSet.add(r.date);
      }
      const allDates = [...datesSet].sort();
      const ampsByDate = new Map();
      const validDates = [];
      for (const date of allDates) {
        const upTo = gripReps.filter(r => (r.date || "") <= date);
        if (upTo.length < 3) continue;
        const amps = fitAmpsForPts(
          upTo.map(r => ({ T: r.actual_time_s, F: r.avg_force_kg })),
          g
        );
        if (!amps) continue;
        ampsByDate.set(date, amps);
        validDates.push(date);
      }
      if (validDates.length === 0) continue;

      // Per-hand fits. For each hand with its own qualifying baseline
      // (≥5 reps × ≥3 distinct durations from perHandGripBaselines),
      // compute the cumulative hand-only fit at each pooled-valid
      // date. Date entries where the hand doesn't have enough
      // samples-up-to-that-date are skipped (handByDate just lacks
      // that key); the render gracefully drops the line in that
      // case.
      const perHand = {};
      for (const hand of ["L", "R"]) {
        const handBaseline = perHandGripBaselines[`${g}|${hand}`];
        if (!handBaseline?.amps) continue;
        const handReps = gripReps.filter(r => r.hand === hand);
        const handByDate = new Map();
        for (const date of validDates) {
          const upToHand = handReps.filter(r => (r.date || "") <= date);
          // 2 is enough for a per-hand fit because the grip prior
          // shrinks small-N runs (same gate as gripHandFits).
          if (upToHand.length < 2) continue;
          const amps = fitAmpsForPts(
            upToHand.map(r => ({ T: r.actual_time_s, F: r.avg_force_kg })),
            g
          );
          if (amps) handByDate.set(date, amps);
        }
        perHand[hand] = {
          baselineAmps: handBaseline.amps,
          baselineDate: handBaseline.date,
          ampsByDate: handByDate,
        };
      }

      byGrip[g] = {
        baselineAmps: baseline.amps,
        baselineDate: baseline.date,
        dates: validDates,
        ampsByDate,
        perHand,    // { L?: {...}, R?: {...} } — empty when no per-hand baselines
      };
    }
    return byGrip;
  // fitAmpsForPts closes over threeExpPriors; explicit dep here keeps
  // memo honest. eslint can't see through the closure.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, grips, gripBaselines, perHandGripBaselines, threeExpPriors]);

  // Resolve the active grip for the history overlay. Priority:
  //   1) explicit user pick (historyGrip)
  //   2) selGrip when the global filter is set and that grip has overlay data
  //   3) first overlay-eligible grip alphabetically
  const overlayActiveGrip = useMemo(() => {
    const eligible = Object.keys(historyOverlay);
    if (eligible.length === 0) return null;
    if (historyGrip && eligible.includes(historyGrip)) return historyGrip;
    if (selGrip && eligible.includes(selGrip)) return selGrip;
    return eligible[0];
  }, [historyOverlay, historyGrip, selGrip]);

  // ── Open-hand vs Crimp dominance — personal-baseline calibration ──
  // Per-hand Crusher:Micro ratio time series, plus the user's own
  // median ratio (the "personal baseline"). The Strength Balance
  // card classifies the CURRENT ratio by its deviation from the
  // user's median, NOT against literature-anchored absolute bands.
  // Anchoring on the user's own ratio sidesteps the edge-geometry
  // problem: a very small Tindeq Micro implement pushes everyone's
  // natural ratio higher than typical-edge literature suggests, so
  // a 3.0× baseline is "your normal" for that gear — and the
  // actionable signal is whether you're drifting down (FDS catching
  // up) or up (gap widening) from YOUR normal, not from some
  // external benchmark.
  //
  // Requires per-hand cumulative fits for BOTH Crusher and Micro on
  // each date (intersection of the two grips' historyOverlay dates).
  // Returns null when fewer than 1 shared date exists; the card
  // gracefully falls back to a no-badge raw-ratio display below.
  const balanceHistory = useMemo(() => {
    const cOverlay = historyOverlay.Crusher;
    const mOverlay = historyOverlay.Micro;
    if (!cOverlay || !mOverlay) return null;
    const BAL_T = 10;
    const out = {};
    for (const hand of ["L", "R"]) {
      const cHand = cOverlay.perHand?.[hand];
      const mHand = mOverlay.perHand?.[hand];
      if (!cHand || !mHand) continue;
      const sharedDates = [...cHand.ampsByDate.keys()]
        .filter(d => mHand.ampsByDate.has(d))
        .sort();
      if (sharedDates.length === 0) continue;
      const ratios = sharedDates.map(date => {
        const cF = predForceThreeExp(cHand.ampsByDate.get(date), BAL_T);
        const mF = predForceThreeExp(mHand.ampsByDate.get(date), BAL_T);
        return cF > 0 && mF > 0 ? cF / mF : null;
      }).filter(r => r != null);
      if (ratios.length === 0) continue;
      // Personal baseline = median (robust to outlier sessions —
      // a bad-form Micro day shouldn't move your "normal" much).
      const sorted = [...ratios].sort((a, b) => a - b);
      const mid = sorted.length / 2;
      const median = sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[Math.floor(mid)];
      out[hand] = {
        current: ratios[ratios.length - 1],
        median,
        count: ratios.length,
        delta: median > 0 ? (ratios[ratios.length - 1] - median) / median : null,
      };
    }
    return Object.keys(out).length > 0 ? out : null;
  }, [historyOverlay]);

  // Active grip's post-baseline date list + clamped Now index.
  // Default to last (most-recent date) on first render; clamp into
  // range when the list grows so user scrubs survive new sessions.
  const overlayDates = overlayActiveGrip ? historyOverlay[overlayActiveGrip].dates : [];
  const overlayLast = Math.max(0, overlayDates.length - 1);
  const overlayNowI = historyNowIdx == null
    ? overlayLast
    : Math.max(0, Math.min(overlayLast, historyNowIdx));

  // Custom tooltip for scatter chart
  const ScatterTooltip = ({ active, payload, unit: tipUnit }) => {
    if (!active || !payload?.[0]) return null;
    const d = payload[0].payload;
    const u = tipUnit || unit;
    return (
      <div style={{ background: C.card, border: `1px solid ${C.border}`, padding: "8px 12px", borderRadius: 8, fontSize: 12 }}>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>{d.date}{d.grip ? ` · ${d.grip}` : ""}</div>
        <div>Duration: <b>{fmt1(d.x)}s</b></div>
        <div>Force: <b>{fmt1(d.y)} {u}</b></div>
      </div>
    );
  };

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
                  usedWeightKg={h.handRep1.weight_kg ?? null}
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
        {/* Hand selector removed: per-hand data already lives in the
            Coaching Prescription L/R columns, the Critical Force
            cards' per-hand split, and the Curve Improvement card's
            single-hand mode (selectable via the per-grip filter alone
            — Both is now an honest average of L+R per-hand fits, not
            a pooled-fit refit that inflated the displayed deltas).
            Removing the top-level filter eliminates a class of
            silent-filter bugs (e.g., 5581094 where selHand="L"
            default hid Micro reps logged as R) without losing any
            actionable per-hand information. */}
        {/* Filter card row: grip pills (left) + Absolute / × BW units
            toggle (right). Renders if EITHER grips exist OR a BW is
            set — previously gated on grips alone, which hid the units
            toggle for users with BW but no Tindeq reps. */}
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
            Display mode (Absolute vs × BW) is now driven by the global
            normalize toggle in the page header — the per-card pill that
            used to live here was retired so all four metric surfaces
            switch in lockstep. */}
        <Card style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Force vs. Duration</div>
          {(() => {
            const splitMode = !!fdSplitData;
            return (
              <div style={{ display: "flex", gap: 16, fontSize: 11, color: C.muted, marginBottom: 10, flexWrap: "wrap" }}>
                <span><span style={{ color: HAND_COLORS.L }}>●</span> Left</span>
                <span><span style={{ color: HAND_COLORS.R }}>●</span> Right</span>
                {!splitMode && threeExpCurveDataRel.length > 0 && <span title="Three-timescale F-D model: a regression fit summing three exponentials with progressively longer decay constants (≈10s / 30s / 180s). The components are labeled fast / medium / slow by timescale; treating them as specific tissue compartments would be an overclaim the fit doesn't support."><span style={{ color: curveColor }}>―</span> F-D curve (3-exp)</span>}
                {!splitMode && threeExpRef180 != null && <span title="Three-exp prediction at T=180s — well past the medium component's decay, where the slow component carries essentially the whole load. The closest model analog to a 'long-duration sustainable force' reference."><span style={{ color: curveColor }}>╌</span> 3-min sustainable</span>}
                {splitMode && Object.keys(fdSplitData).map(g => (
                  <span key={g}>
                    <span style={{ color: GRIP_COLORS[g] || C.blue }}>―</span> {g}
                    <span style={{ color: GRIP_COLORS[g] || C.blue, opacity: 0.7 }}> ╌</span> 3-min
                  </span>
                ))}
                {!splitMode && limiterZoneBounds && <span style={{ color: limiterZoneBounds.color, fontWeight: 600 }}>● {limiterZoneBounds.label}</span>}
                {useRel && <span style={{ color: C.purple }}>× bodyweight ({fmtW(bodyWeight, unit)} {unit})</span>}
              </div>
            );
          })()}
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart margin={{ top: 10, right: 16, bottom: 28, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
              <XAxis
                type="number" dataKey="x"
                domain={[0, maxDur + 10]}
                label={{ value: "Duration (s)", position: "insideBottom", offset: -16, fill: C.muted, fontSize: 11 }}
                tick={{ fill: C.muted, fontSize: 11 }}
              />
              <YAxis
                type="number"
                domain={[0, Math.ceil(maxForceRel * 1.15 / (useRel ? 0.1 : 10)) * (useRel ? 0.1 : 10)]}
                tick={{ fill: C.muted, fontSize: 11 }}
                unit={useRel ? "" : ` ${unit}`}
                width={42}
              />
              <Tooltip content={<ScatterTooltip unit={forceUnit} />} />
              {/* Zone backgrounds — neutral tint for non-limiter zones,
                  extra saturation on the limiter zone so the chart
                  echoes the SessionPlanner recommendation. Driven by
                  ZONE6 so the 6-zone schema is the single source of
                  truth for both boundaries and colors. */}
              {ZONE6.map(z => {
                const x1 = z.min;
                const x2 = z.max === Infinity ? maxDur + 10 : z.max;
                const isLimiter = limiterZoneBounds?.x1 === z.min;
                return (
                  <ReferenceArea
                    key={z.key}
                    x1={x1}
                    x2={x2}
                    fill={z.color}
                    fillOpacity={isLimiter ? 0.22 : 0.07}
                  />
                );
              })}
              {/* Single-fit overlays only when NOT in per-grip split mode.
                  In split mode they'd be ambiguous (which grip's CF? which
                  3-exp? which 90% band?). Per-grip rendering takes over. */}
              {/* 3-min sustainable reference from three-exp at T=180s
                  (replaces the Monod CF asymptote, since three-exp has
                  no true asymptote — it decays to 0). At 180s the slow
                  curve-fit component carries essentially the whole
                  load; this is the closest model analog to "what you
                  can sustain for a long hold" the three-timescale
                  fit can produce. */}
              {!fdSplitData && threeExpRef180 != null && (
                <ReferenceLine
                  y={useRel ? threeExpRef180 / bodyWeight : toDisp(threeExpRef180, unit)}
                  stroke={curveColor} strokeDasharray="6 3" strokeWidth={1.5}
                  label={{ value: `3-min ${fmtForce(threeExpRef180)} ${forceUnit}`, position: "insideTopRight", fill: curveColor, fontSize: 10 }}
                />
              )}
              {/* Primary curve — three-exp F-D. Solid line, tinted to the
                  selected grip's color when one is filtered (matches the
                  per-grip palette the All-Grips split-mode view uses);
                  falls back to neutral purple in unfiltered mode. */}
              {!fdSplitData && threeExpCurveDataRel.length > 0 && (
                <Line data={threeExpCurveDataRel} dataKey="y" stroke={curveColor}
                      strokeWidth={2} dot={false}
                      legendType="none" isAnimationActive={false} />
              )}
              {!fdSplitData && (
                <Scatter data={leftDotsRel} dataKey="y" fill={HAND_COLORS.L} opacity={0.9} name="Left" onClick={handleDotClick} style={{ cursor: "pointer" }} />
              )}
              {!fdSplitData && (
                <Scatter data={rightDotsRel} dataKey="y" fill={HAND_COLORS.R} opacity={0.9} name="Right" onClick={handleDotClick} style={{ cursor: "pointer" }} />
              )}
              {/* Per-grip split mode: one curve + one set of dots per grip.
                  Avoids the cross-muscle mudding (Micro FDP pinch ~5-10kg vs
                  Crusher FDS crush ~15-30kg on a single curve). Failure dots
                  retain their red/green meaning, but get a colored OUTLINE
                  matching the grip so you can tell which is which. */}
              {fdSplitData && (() => {
                const grips = Object.keys(fdSplitData);
                const elements = [];
                const tMax = Math.max(maxDur, F_D_T_MIN + 10);
                for (const grip of grips) {
                  const color = GRIP_COLORS[grip] || C.blue;
                  // (Per-grip dot data is now built from `history` directly
                  // below — fdSplitData[grip] is only consumed for the
                  // per-grip curve fits, not the dots.)
                  // Three-exp PRIMARY curve — bold solid grip color. This
                  // is the curve the engine optimizes against; Monod
                  // (above) is just for visual comparison. Also emits a
                  // per-grip "3-min sustainable" reference line so split
                  // mode shows the same overlays as single-grip mode.
                  if (threeExpPriors && threeExpPriors.get) {
                    const prior = threeExpPriors.get(grip);
                    // Train-to-failure model: every rep with valid
                    // actual_time_s is a (T, F) data point.
                    const failures = (history || []).filter(r =>
                      r.grip === grip
                      && r.actual_time_s > 0 && r.avg_force_kg > 0 && r.avg_force_kg < 500
                    );
                    if (prior && failures.length >= 2) {
                      const pts = failures.map(r => ({ T: r.actual_time_s, F: r.avg_force_kg }));
                      const lambda = THREE_EXP_LAMBDA_DEFAULT / Math.max(failures.length, 1);
                      const amps = fitThreeExpAmps(pts, { prior, lambda });
                      if (amps[0] + amps[1] + amps[2] > 0) {
                        const teeCurve = Array.from({ length: 80 }, (_, i) => {
                          const t = F_D_T_MIN + ((tMax - F_D_T_MIN) / 79) * i;
                          const f = predForceThreeExp(amps, t);
                          return {
                            x: t,
                            y: useRel && bodyWeight > 0
                              ? toDisp(Math.max(f, 0), unit) / (bodyWeight * (unit === "lbs" ? KG_TO_LBS : 1))
                              : toDisp(Math.max(f, 0), unit),
                          };
                        });
                        elements.push(
                          <Line key={`${grip}-tee`} data={teeCurve} dataKey="y"
                            stroke={color} strokeWidth={2} dot={false}
                            legendType="none" isAnimationActive={false} />
                        );
                        // 3-min sustainable reference for this grip — analog
                        // of the dashed horizontal line in single-grip mode.
                        const teeRef180 = predForceThreeExp(amps, 180);
                        if (teeRef180 > 0) {
                          const refY = useRel && bodyWeight > 0
                            ? teeRef180 / bodyWeight
                            : toDisp(teeRef180, unit);
                          elements.push(
                            <ReferenceLine key={`${grip}-ref180`} y={refY}
                              stroke={color} strokeDasharray="6 3" strokeWidth={1}
                              strokeOpacity={0.7}
                              label={{ value: `${grip} 3-min ${fmtForce(teeRef180)} ${forceUnit}`,
                                position: "insideRight", fill: color, fontSize: 9 }}
                            />
                          );
                        }
                      }
                    }
                  }
                  // Dots: fill by hand (L = blue, R = yellow), outline
                  // by grip color. Two-dimensional encoding — fill tells
                  // you the hand, outline tells you the grip.
                  // (Replaces the legacy red/green outcome encoding now
                  // that every rep is a failure data point.)
                  const gripReps = (history || []).filter(r =>
                    r.grip === grip
                    && r.actual_time_s > 0
                    && r.avg_force_kg > 0 && r.avg_force_kg < 500
                  );
                  const toDot = (r) => ({
                    x: r.actual_time_s,
                    y: useRel && bodyWeight > 0
                      ? r.avg_force_kg / bodyWeight
                      : toDisp(r.avg_force_kg, unit),
                    grip, date: r.date, hand: r.hand,
                    session_id: r.session_id,
                    target_duration: r.target_duration,
                    rest_s: r.rest_s,
                  });
                  const lDots = gripReps.filter(r => r.hand !== "R").map(toDot);
                  const rDots = gripReps.filter(r => r.hand === "R").map(toDot);
                  elements.push(
                    <Scatter key={`${grip}-L`} data={lDots} dataKey="y"
                      fill={HAND_COLORS.L} stroke={color} strokeWidth={1.5} opacity={0.9}
                      onClick={handleDotClick} style={{ cursor: "pointer" }} />
                  );
                  elements.push(
                    <Scatter key={`${grip}-R`} data={rDots} dataKey="y"
                      fill={HAND_COLORS.R} stroke={color} strokeWidth={1.5} opacity={0.9}
                      onClick={handleDotClick} style={{ cursor: "pointer" }} />
                  );
                }
                return elements;
              })()}
            </ComposedChart>
          </ResponsiveContainer>
          {/* Zone labels — 6-zone scheme. Wraps to two rows on narrow
              screens so all six fit cleanly. Boundaries come from ZONE6
              so labels stay in sync if the schema is tuned later. */}
          <div style={{
            display: "flex", flexWrap: "wrap", justifyContent: "center",
            gap: "4px 12px", marginTop: 6, fontSize: 10, color: C.muted,
          }}>
            {ZONE6.map(z => {
              const range = z.max === Infinity
                ? `${z.min}s+`
                : z.min === 0
                  ? `<${z.max}s`
                  : `${z.min}–${z.max}s`;
              return (
                <span key={z.key} style={{ color: z.color, whiteSpace: "nowrap" }}>
                  {z.short} {range}
                </span>
              );
            })}
          </div>
          {/* Per-grip Hand Asymmetry rows — folded in below the chart.
              Tabular companion to the L/R dot scatter above: for each
              grip with both L and R fits, shows weaker hand load + the
              asymmetry %. Below ~5% reads as 'symmetric'; above ~15%
              flags the weaker hand as the real climbing limiter on this
              grip. Computed at T=30s (middle of curve, exercises fast +
              middle components).
              Auto-hide rule (May 2026): the section only renders when at
              least one grip crosses the 5% asymmetric threshold. When
              everything is symmetric there's no signal worth surfacing,
              and silently hiding keeps the F-D chart tighter. The check
              surfaces itself again automatically if asymmetry drifts in
              (injury, asymmetric training, instrument drift), so the
              user doesn't have to remember to look for it. */}
          {handAsymmetry.some(h => h.asymPct >= 0.05) && (
            <div style={{ marginTop: 16, paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>
                Hand Asymmetry
              </div>
              {handAsymmetry.map(({ grip, L, R, stronger, weaker, asymPct }) => {
                const flagColor = asymPct >= 0.15 ? C.red
                               : asymPct >= 0.05 ? C.orange
                               : C.green;
                const flagText  = asymPct >= 0.15 ? "limiter"
                               : asymPct >= 0.05 ? "asymmetric"
                               : "symmetric";
                const pctRound  = Math.round(asymPct * 100);
                // L and R are in kg from the asymmetry useMemo. When
                // normalizeOn, render both as % of current bodyweight
                // so the per-grip strength reads in climbing units
                // (a 35% BW micro-pinch means more to a climber than
                // an absolute kg figure).
                const renderForce = (kg) => {
                  if (normalizeOn && bodyWeight > 0) {
                    return `${Math.round((kg / bodyWeight) * 100)}% BW`;
                  }
                  return `${fmtW(kg, unit)} ${unit}`;
                };
                return (
                  <div key={grip} style={{
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    padding: "8px 0",
                    borderBottom: `1px solid ${C.border}`,
                  }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: GRIP_COLORS[grip] || C.text }}>
                        {grip}
                      </div>
                      <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
                        L {renderForce(L)} · R {renderForce(R)}
                        {pctRound > 0 && (
                          <> · <b style={{ color: C.text }}>{weaker}</b> is {pctRound}% behind <b style={{ color: C.text }}>{stronger}</b></>
                        )}
                      </div>
                    </div>
                    <span style={{
                      fontSize: 10, fontWeight: 700, color: flagColor,
                      background: `${flagColor}1a`,
                      padding: "3px 8px", borderRadius: 4,
                      textTransform: "uppercase", letterSpacing: 0.5,
                      whiteSpace: "nowrap",
                    }}>
                      {flagText}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* (Fit diagnostic line removed — was a vestigial training-RMSE
              readout from the three-exp validation phase. Curve quality
              is judged by eye on the scatter above.) */}
        </Card>

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
            When no grip filter is active AND ≥2 grips have fits, split
            the card into per-grip sections so Micro (FDP) and Crusher
            (FDS) each show their own Δ% against the shared baseline. */}
        {(improvement || Object.keys(gripImprovement).length > 0) && (() => {
          // Reusable row renderer — one header + one Power/Strength/Endurance
          // row of three Δ% tiles.
          const renderRow = (label, imp) => (
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
                {label && (
                  <div style={{ fontSize: 12, fontWeight: 700, color: C.text }}>
                    {label}
                  </div>
                )}
                <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginLeft: "auto" }}>
                  <div style={{ fontSize: 26, fontWeight: 900, color: imp.total >= 0 ? C.green : C.red, lineHeight: 1 }}>
                    {imp.total >= 0 ? "+" : ""}{imp.total}%
                  </div>
                  <div style={{ fontSize: 11, color: C.muted }}>total</div>
                </div>
              </div>
              {/* 6 zone tiles. Two rows of three on narrow screens
                  (gridTemplateColumns auto-wraps via `repeat(3, ...)`).
                  Short labels (Max/Pwr/P/S/Str/S/E/End) keep tiles
                  readable on mobile. Driven by ZONE6 so labels and
                  colors come from the schema. */}
              <div style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 6,
              }}>
                {ZONE6.map(z => {
                  const val = imp[z.key];
                  if (val == null) return null;
                  return (
                    <div key={z.key} style={{
                      background: C.bg, borderRadius: 10, padding: "8px 6px", textAlign: "center",
                      border: `1px solid ${z.color}30`,
                    }}>
                      <div style={{ fontSize: 9, color: C.muted, marginBottom: 3 }}>{z.short}</div>
                      <div style={{ fontSize: 16, fontWeight: 800, color: val >= 0 ? z.color : C.red }}>
                        {val >= 0 ? "+" : ""}{val}%
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );

          // perGripMode is keyed off having multiple per-grip CURRENT fits,
          // not improvements — so users mid-data-collection see an honest
          // "early days" message instead of falling back to the pooled
          // improvement number, which would re-introduce the same cross-
          // muscle artifact (Crusher's high-CF reps inflating Micro's
          // baseline) that motivated the per-grip split in the first
          // place.
          const perGripMode = !selGrip && Object.keys(grip3xEstimates).length >= 2;
          const gripImpEntries = Object.entries(gripImprovement);

          // When a grip filter is active, pick the tightest-scope baseline:
          //   1. (grip, hand) when both selHand and the per-hand baseline exist
          //   2. (grip pooled) otherwise — matches the Capacity (AUC) chart's
          //      pooled calc so the numbers tie out across surfaces
          //
          // The previous version computed an "average of per-hand
          // improvements" for the Both case, which produced a different
          // total from the chart for grips with L/R asymmetry. The
          // headline now uses the same pooled fit as the chart, so a
          // user comparing "% vs baseline" between this card and the
          // Capacity chart sees one number, not two interpretations.
          let scopedImp = null;
          let scopedBaselineDate = null;
          let scopedScopeLabel = null;
          if (selGrip) {
            const phgKey = selHand && selHand !== "Both" ? `${selGrip}|${selHand}` : null;
            const phgRef = phgKey ? perHandGripBaselines[phgKey] : null;
            const gRef   = gripBaselines[selGrip];
            if (phgRef) {
              // Tightest match: current3xAmps (already hand+grip scoped
              // via the `failures` filter) vs per-(hand,grip) baseline.
              scopedImp = improvementForAmps(current3xAmps, phgRef.amps);
              scopedBaselineDate = phgRef.date;
              scopedScopeLabel = `${selGrip} · ${selHand === "L" ? "Left" : "Right"}`;
            } else if (gRef && grip3xEstimates[selGrip]) {
              // Pooled comparison — same calc as the Capacity (AUC)
              // chart at this grip's most-recent point.
              scopedImp = improvementForAmps(grip3xEstimates[selGrip], gRef.amps);
              scopedBaselineDate = gRef.date;
              scopedScopeLabel = `${selGrip} (pooled fit)`;
            }
          }

          return (
            <Card style={{ marginBottom: 16, border: `1px solid ${C.purple}40` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>Curve Improvement</div>
                {!perGripMode && !selGrip && global3xBaseline && (
                  <div style={{ fontSize: 11, color: C.muted }}>since {global3xBaseline.date}</div>
                )}
                {selGrip && scopedImp && (
                  <div style={{ fontSize: 11, color: C.muted }}>since {scopedBaselineDate}</div>
                )}
              </div>
              {perGripMode ? (
                gripImpEntries.length > 0 ? (
                  <>
                    {gripImpEntries.map(([grip, imp], i, arr) => (
                      <div key={grip} style={{
                        paddingBottom: i < arr.length - 1 ? 12 : 0,
                        borderBottom: i < arr.length - 1 ? `1px solid ${C.border}` : "none",
                        marginBottom: i < arr.length - 1 ? 12 : 0,
                      }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: C.text }}>{grip}</div>
                          <div style={{ fontSize: 10, color: C.muted }}>since {imp.baselineDate}</div>
                        </div>
                        {renderRow(null, imp)}
                      </div>
                    ))}
                    {/* Show an "early days" placeholder for any grip with a
                        current fit but no qualifying per-grip baseline yet,
                        so the user knows we're aware of it and waiting on
                        more data rather than silently dropping it. */}
                    {Object.keys(grip3xEstimates).filter(g => !gripImprovement[g]).map(grip => {
                      const p = baselineProgress(grip);
                      return (
                        <div key={grip} style={{
                          paddingTop: 12, marginTop: 12, borderTop: `1px solid ${C.border}`,
                          fontSize: 11, color: C.muted, lineHeight: 1.5,
                        }}>
                          <b style={{ color: C.text }}>{grip}</b>{" · "}
                          <span style={{ color: p.failures >= FAIL_THRESHOLD ? C.green : C.text }}>
                            {Math.min(p.failures, FAIL_THRESHOLD)} of {FAIL_THRESHOLD} failures
                          </span>
                          {" · "}
                          <span style={{ color: p.distinctDurations >= DUR_THRESHOLD ? C.green : C.text }}>
                            {Math.min(p.distinctDurations, DUR_THRESHOLD)} of {DUR_THRESHOLD} durations
                          </span>
                        </div>
                      );
                    })}
                  </>
                ) : (
                  <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
                    Need ≥5 failures across ≥3 target durations <i>per grip</i> to seed a stable per-grip baseline. Until then the three-exp fit can't separate the fast / medium / slow components cleanly enough for the per-zone Δ% to be meaningful.
                  </div>
                )
              ) : selGrip ? (
                scopedImp ? (
                  <>
                    <div style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>
                      {/* Subtitle phrasing depends on scope. The single-
                          hand and pooled-fit labels read naturally as
                          "X vs X baseline". The averaged-hands label
                          already names what it is, so just print it. */}
                      {scopedScopeLabel?.includes("avg")
                        ? scopedScopeLabel
                        : `${scopedScopeLabel} vs ${scopedScopeLabel} baseline`}
                    </div>
                    {renderRow(null, scopedImp)}
                  </>
                ) : (() => {
                  const handForProg = selHand && selHand !== "Both" ? selHand : null;
                  const p = baselineProgress(selGrip, handForProg);
                  const handLabel = handForProg ? (handForProg === "L" ? "Left" : "Right") : null;
                  return (
                    <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
                      Need ≥{FAIL_THRESHOLD} failures across ≥{DUR_THRESHOLD} target durations on <b>{selGrip}</b>{handLabel ? ` (${handLabel})` : ""} for a fair apples-to-apples comparison. Pooled global baseline isn't shown here — it mixes muscle groups (FDP pinch vs FDS crush) and would produce misleading Δ%.
                      <div style={{ marginTop: 6, fontSize: 11 }}>
                        Progress:{" "}
                        <span style={{ color: p.failures >= FAIL_THRESHOLD ? C.green : C.text, fontWeight: 600 }}>
                          {Math.min(p.failures, FAIL_THRESHOLD)} of {FAIL_THRESHOLD} failures
                        </span>
                        {" · "}
                        <span style={{ color: p.distinctDurations >= DUR_THRESHOLD ? C.green : C.text, fontWeight: 600 }}>
                          {Math.min(p.distinctDurations, DUR_THRESHOLD)} of {DUR_THRESHOLD} durations
                        </span>
                      </div>
                    </div>
                  );
                })()
              ) : improvement ? (
                renderRow(null, improvement)
              ) : null}
            </Card>
          );
        })()}

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
            the gains/losses landed. Single slider for "Now";
            "Baseline" is anchored to gripBaselines[grip] so this
            card agrees with Capacity % and Curve Improvement. */}
        {overlayActiveGrip && overlayDates.length >= 1 && (() => {
          const overlay = historyOverlay[overlayActiveGrip];
          const eligibleGrips = Object.keys(historyOverlay);
          const pastDate = overlay.baselineDate;
          const nowDate  = overlayDates[overlayNowI];
          const gripColor = GRIP_COLORS[overlayActiveGrip] || C.blue;

          // Per-hand only available when at least one hand has its
          // own qualifying baseline AND has a fit at the selected
          // "now" date. Falls back to pooled when toggle is "per-
          // hand" but data doesn't support it (e.g. user just
          // started training one of the hands).
          const handsWithData = ["L", "R"].filter(h =>
            overlay.perHand?.[h]?.baselineAmps &&
            overlay.perHand[h].ampsByDate.size > 0
          );
          const perHandAvailable = handsWithData.length > 0;
          const mode = (historyViewMode === "per-hand" && perHandAvailable)
            ? "per-hand"
            : "pooled";

          // Series description: one entry per curve-pair to draw.
          // Pooled mode: 1 entry (whole-grip pooled fit). Per-hand
          // mode: 1 entry per hand that has both baseline + a fit
          // at the selected Now date.
          const series = mode === "pooled"
            ? [{
                key: "pooled",
                label: "Pooled",
                pastAmps: overlay.baselineAmps,
                nowAmps:  overlay.ampsByDate.get(nowDate),
                pastColor: C.muted,
                nowColor:  gripColor,
                pastName: `Baseline (${pastDate})`,
                nowName:  `Now (${nowDate})`,
              }]
            : handsWithData
                .filter(h => overlay.perHand[h].ampsByDate.get(nowDate))
                .map(h => ({
                  key: h,
                  label: h === "L" ? "Left" : "Right",
                  pastAmps: overlay.perHand[h].baselineAmps,
                  nowAmps:  overlay.perHand[h].ampsByDate.get(nowDate),
                  // Same hand color for both past + now; the dashed
                  // pattern distinguishes baseline from current.
                  pastColor: HAND_COLORS[h],
                  nowColor:  HAND_COLORS[h],
                  pastName: `${h} baseline`,
                  nowName:  `${h} now`,
                }));

          // Curve sampling — 80 points from 5s to a reasonable max.
          // Same range the F-D chart uses (≥5s + a little headroom
          // past the long endurance reps).
          const tMin = 5;
          const tMaxLocal = Math.max(180, maxDur);
          const samples = [];
          for (let i = 0; i < 80; i++) {
            const t = tMin + ((tMaxLocal - tMin) / 79) * i;
            const row = { x: t };
            for (const s of series) {
              const fp = s.pastAmps ? predForceThreeExp(s.pastAmps, t) : null;
              const fn = s.nowAmps  ? predForceThreeExp(s.nowAmps,  t) : null;
              row[`${s.key}_past`] = fp != null ? toDisp(Math.max(fp, 0), unit) : null;
              row[`${s.key}_now`]  = fn != null ? toDisp(Math.max(fn, 0), unit) : null;
            }
            samples.push(row);
          }
          const allYs = samples.flatMap(row => series.flatMap(s =>
            [row[`${s.key}_past`] || 0, row[`${s.key}_now`] || 0]
          ));
          const yMax = Math.max(...allYs, 1);
          const yDomain = [0, Math.ceil(yMax * 1.1 / 10) * 10];

          // Per-T delta strip — fixed reference durations spanning
          // power → endurance. Deltas signed (negative = lost
          // capacity). One row per series.
          const refTs = [10, 30, 60, 120, 180];
          const deltaRows = series.map(s => ({
            key: s.key,
            label: s.label,
            color: s.nowColor,
            cells: refTs.map(t => {
              const fp = s.pastAmps ? predForceThreeExp(s.pastAmps, t) : null;
              const fn = s.nowAmps  ? predForceThreeExp(s.nowAmps,  t) : null;
              const pct = (fp && fp > 0 && fn != null)
                ? Math.round((fn / fp - 1) * 100)
                : null;
              return { t, pct };
            }),
          }));

          const sliderStyle = {
            width: "100%",
            accentColor: gripColor,
            cursor: "pointer",
          };

          // Toggle pill renderer — also used by the grip selector.
          const Pill = ({ active, disabled, onClick, color, children }) => (
            <button
              onClick={() => !disabled && onClick()}
              disabled={disabled}
              style={{
                background: active ? color : "transparent",
                color: active ? "#fff" : disabled ? C.border : C.muted,
                border: `1px solid ${active ? color : C.border}`,
                borderRadius: 4,
                padding: "4px 10px",
                fontSize: 11,
                fontWeight: 600,
                cursor: disabled ? "not-allowed" : "pointer",
                opacity: disabled ? 0.5 : 1,
              }}>{children}</button>
          );

          return (
            <Card style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4, flexWrap: "wrap", gap: 8 }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>
                  Force Curves — vs baseline
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  {/* View mode toggle: pooled / per-hand */}
                  <div style={{ display: "flex", gap: 4 }}>
                    <Pill active={mode === "pooled"} color={C.purple}
                      onClick={() => setHistoryViewMode("pooled")}>
                      Pooled
                    </Pill>
                    <Pill active={mode === "per-hand"} color={C.purple}
                      disabled={!perHandAvailable}
                      onClick={() => setHistoryViewMode("per-hand")}>
                      Per-hand
                    </Pill>
                  </div>
                  {/* Grip selector */}
                  {eligibleGrips.length > 1 && (
                    <div style={{ display: "flex", gap: 4 }}>
                      {eligibleGrips.map(g => (
                        <Pill key={g}
                          active={g === overlayActiveGrip}
                          color={GRIP_COLORS[g] || C.blue}
                          onClick={() => {
                            setHistoryGrip(g);
                            setHistoryNowIdx(null);
                          }}>
                          {g}
                        </Pill>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div style={{ fontSize: 12, color: C.muted, marginBottom: 12, lineHeight: 1.5 }}>
                {mode === "pooled"
                  ? "Dashed line is your pooled baseline curve (anchored to gripBaselines — same baseline the Capacity % and Curve Improvement cards use). Slide to compare any post-baseline date."
                  : "Per-hand mode: each hand's own baseline (dashed) vs current (solid). Reveals asymmetric progress — one hand growing while the other plateaus tells you where to spend your next session."}
              </div>

              {/* Baseline label + Now slider. Past is anchored. */}
              <div style={{ marginBottom: 10, fontSize: 11, color: C.muted }}>
                Baseline: <b style={{ color: C.muted }}>{pastDate}</b>
              </div>
              <div style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: gripColor, marginBottom: 4 }}>
                  <span>Now: <b>{nowDate}</b></span>
                  <span style={{ color: C.muted }}>{overlayDates.length} sessions since baseline</span>
                </div>
                <input type="range"
                  min={0} max={overlayLast} step={1}
                  value={overlayNowI}
                  onChange={(e) => setHistoryNowIdx(parseInt(e.target.value, 10))}
                  style={sliderStyle}
                />
              </div>

              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={samples} margin={{ top: 6, right: 14, bottom: 28, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                  <XAxis type="number" dataKey="x"
                    domain={[tMin, tMaxLocal]}
                    tick={{ fill: C.muted, fontSize: 11 }}
                    label={{ value: "Duration (s)", position: "insideBottom", offset: -16, fill: C.muted, fontSize: 11 }}
                  />
                  <YAxis domain={yDomain}
                    tick={{ fill: C.muted, fontSize: 11 }}
                    width={44} unit={` ${unit}`}
                  />
                  <Tooltip
                    contentStyle={{ background: C.card, border: `1px solid ${C.border}`, fontSize: 12 }}
                    formatter={(val, name) => [val == null ? "—" : `${fmtW(val, unit)} ${unit}`, name]}
                    labelFormatter={(t) => `${fmt1(t)}s`}
                  />
                  {series.flatMap(s => [
                    <Line key={`${s.key}_past`} dataKey={`${s.key}_past`}
                      stroke={s.pastColor} strokeWidth={2}
                      strokeDasharray="6 4" dot={false} connectNulls
                      name={s.pastName} isAnimationActive={false} />,
                    <Line key={`${s.key}_now`} dataKey={`${s.key}_now`}
                      stroke={s.nowColor} strokeWidth={3}
                      dot={false} connectNulls
                      name={s.nowName} isAnimationActive={false} />,
                  ])}
                </LineChart>
              </ResponsiveContainer>

              {/* Per-T delta strip(s). One row in pooled mode; one
                  per hand in per-hand mode with a small label. */}
              {deltaRows.map(({ key, label, color, cells }) => (
                <div key={key} style={{ marginTop: 12 }}>
                  {deltaRows.length > 1 && (
                    <div style={{ fontSize: 11, fontWeight: 600, color, marginBottom: 4 }}>
                      {label}
                    </div>
                  )}
                  <div style={{
                    display: "grid",
                    gridTemplateColumns: `repeat(${refTs.length}, 1fr)`,
                    gap: 6,
                  }}>
                    {cells.map(({ t, pct }) => {
                      const tileColor = pct == null ? C.muted
                                      : pct > 0     ? C.green
                                      : pct < 0     ? C.red
                                                    : C.muted;
                      const sign = pct == null ? "" : pct > 0 ? "+" : "";
                      return (
                        <div key={t} style={{
                          background: C.bg, border: `1px solid ${C.border}`,
                          borderRadius: 6, padding: "6px 8px", textAlign: "center",
                        }}>
                          <div style={{ fontSize: 10, color: C.muted, marginBottom: 2 }}>
                            {t}s
                          </div>
                          <div style={{ fontSize: 14, fontWeight: 700, color: tileColor }}>
                            {pct == null ? "—" : `${sign}${pct}%`}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </Card>
          );
        })()}

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

        {/* Recovery dynamics over time — per-session observed
            recovered fraction at rep 2, per grip, with a 3-session
            rolling-mean line. Pairs with the per-session
            RecoveryChart in HistoryView: that one answers "how
            well-rested was today?", this one answers "is my
            recovery improving over weeks?" */}
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
