// ─────────────────────────────────────────────────────────────
// ANALYSIS VIEW
// ─────────────────────────────────────────────────────────────
// The "Analysis" tab — Force-Duration chart, Critical Force estimate
// cards, Endurance Improvement % vs baseline, gap-narrowing tracker,
// CF Over Time chart, and the per-grip Next Session Focus
// recommendations driven by the v2 coaching engine.
//
// All state comes in via props: history, freshMap, threeExpPriors,
// liveEstimate, gripEstimates, etc. No localStorage access, no BLE,
// no live session state — pure read-and-render.
//
// Cross-cutting App config (GOAL_CONFIG, RM_GRIPS) is passed in as
// props so this module stays decoupled from App.js's constant block;
// pure model helpers (ZONE5, classifyZone5, dominantZone5,
// computeZoneCoverage) are imported directly from the model layer.

import React, { useMemo, useState } from "react";
import {
  ResponsiveContainer, LineChart, Line, ComposedChart, Scatter,
  BarChart, Bar,
  XAxis, YAxis, Tooltip, CartesianGrid, Legend,
  ReferenceLine, ReferenceArea,
} from "recharts";
import { C } from "../ui/theme.js";
import { Card } from "../ui/components.js";
import {
  ZONE5, classifyZone5, dominantZone5,
  computeZoneCoverage,
} from "../model/zones.js";
import { KG_TO_LBS, fmt1, fmtW, toDisp } from "../ui/format.js";
import { POWER_MAX, STRENGTH_MAX, ZONE_REF_T } from "../model/zones.js";
import { PHYS_MODEL_DEFAULT } from "../model/fatigue.js";
import {
  fitCF, fitCFWithSuccessFloor,
} from "../model/monod.js";
import {
  THREE_EXP_LAMBDA_DEFAULT, fitThreeExpAmps, predForceThreeExp,
  buildThreeExpPriors,
} from "../model/threeExp.js";
import {
  sessionCompartmentAUC,
  prescribedLoad,
  empiricalPrescription, prescriptionPotential,
} from "../model/prescription.js";
import { coachingRecommendation, coachingRationale } from "../model/coaching.js";
import {
  AUC_T_MIN, AUC_T_MAX,
  PERSONAL_RESPONSE_MIN_SESSIONS,
  computePersonalResponse,
} from "../model/personal-response.js";
import { computeLimiterZone } from "../model/limiter.js";
import { OneRMPRCard } from "./analysis/OneRMPRCard.js";
import { EnergySystemBreakdownCard } from "./analysis/EnergySystemBreakdownCard.js";

// ─────────────────────────────────────────────────────────────
// ZONE_DETAILS — shared recommendation metadata used by both the
// pooled/selGrip-scoped `recommendation` useMemo and the per-grip
// `gripRecs` useMemo so the title/color/caption shown for "Train
// Power / Strength / Endurance" stay consistent between scopes.
// ─────────────────────────────────────────────────────────────
const ZONE_DETAILS = {
  power: {
    title: "Train Power", color: C.red,
    caption: "short, high-force efforts that develop W′, the finite anaerobic reserve above your CF asymptote.",
  },
  strength: {
    title: "Train Strength", color: C.orange,
    caption: "mid-duration max hangs that lift the force ceiling — and with it, CF.",
  },
  endurance: {
    title: "Train Endurance", color: C.blue,
    caption: "sustained threshold holds that raise CF as a fraction of your existing ceiling.",
  },
};

// Per-grip color used wherever Micro and Crusher are charted side-by-
// side (F-D scatter overlays, AUC-PR cards, CF-over-time chart).
// Single source of truth so the legend, scatter dots, line strokes,
// and PR badges all agree without five identical inline declarations.
// Falls back to C.blue at call sites that pass an unknown grip key.
const GRIP_COLORS = { Micro: "#e05560", Crusher: C.orange, Prime: "#7c5cbf" };

// Pure helper: given a {CF, W} fit and personalResponse map, compute the
// projected ΔAUC for each protocol and return the rec payload. Separate
// from the React memos so it can be called once per grip.
function buildRecFromFit(fit, personalResponse, unit) {
  if (!fit) return null;
  const { CF, W } = fit;
  const gains = {};
  for (const [key, resp] of Object.entries(personalResponse)) {
    const dCF = CF * resp.cf;
    const dW  = W  * resp.w;
    const gainKg = dCF * (AUC_T_MAX - AUC_T_MIN) + dW * Math.log(AUC_T_MAX / AUC_T_MIN);
    gains[key] = toDisp(gainKg, unit);
  }
  const bestKey = Object.entries(gains).reduce((a, b) => b[1] > a[1] ? b : a)[0];
  const d = ZONE_DETAILS[bestKey];
  const responseSource = {};
  for (const key of Object.keys(personalResponse)) {
    responseSource[key] = {
      source: personalResponse[key].source,
      n:      personalResponse[key].n,
    };
  }
  return {
    key:     bestKey,
    title:   d.title,
    color:   d.color,
    insight: `Largest projected AUC gain from ${d.caption}`,
    gains,
    aucGain: gains[bestKey],
    responseSource,
  };
}

export function AnalysisView({
  history, unit = "lbs", bodyWeight = null,
  activities = [], liveEstimate = null, gripEstimates = {},
  freshMap = null,
  // Cross-cutting App config — passed in rather than imported so this
  // module doesn't reach back into App.js for view-level constants.
  GOAL_CONFIG = {},
  RM_GRIPS = [],
  trainingFocus = "balanced",
}) {
  // Hand-filter state retired (the L/R/Both buttons were removed —
  // see the FilterCard comment near render). Kept as a const so the
  // many `(!selHand || r.hand === selHand)` checks scattered through
  // the file still compile and behave as "no hand filter applied."
  // Cleaner refactor would inline-strip every reference, but this
  // is a minimum-diff change that's trivially reversible.
  const selHand = "";
  const [selGrip,   setSelGrip]   = useState("");
  const [relMode,   setRelMode]   = useState(false); // relative strength toggle

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

  const failures  = reps.filter(r => r.failed);
  const successes = reps.filter(r => !r.failed);

  const maxDur = Math.max(...reps.map(r => r.actual_time_s), STRENGTH_MAX + 60);

  // Per-grip three-exp priors. Used by the gap-narrowing tracker and
  // the prescription-potential calculation (since three-exp is now the
  // primary potential value when well-supported). Same memo as in
  // SetupView; could be lifted to App if it becomes hot.
  const threeExpPriors = useMemo(() => buildThreeExpPriors(history), [history]);

  // ── Critical Force estimation via Monod-Scherrer linearization ──
  // Failure-only fit on RAW force (no freshMap, no success-floor). This
  // is intentionally the "what your failures actually show" curve, not
  // the "what your prescription engine wants to push you to" curve.
  //
  // Why not use the prescription fit (with success-floor + freshMap)?
  // We tried it. Hard success-floor constraints + Monod's hyperbolic
  // shape can't satisfy both "your high-force short-duration successes"
  // AND "your moderate-force middle-duration failures" because Monod
  // doesn't have enough flexibility — the success-floor wins and the
  // resulting curve overshoots the failure cluster by 5-30 kg in the
  // middle, making the chart misleading. The failure-only fit shows
  // the data honestly; the prescription engine separately uses the
  // empirical-first path (anchored to recent rep 1) which produces
  // the right next-session loads without forcing the chart to lie.
  //
  // The dots above the curve = above-curve performance (strong zone).
  // Dots below the curve = below-curve performance (limiter zone).
  // That's the visual diagnosis Nathan called out as "where the magic
  // happens" — and it only works if the curve is honest about the data.
  const cfEstimate = useMemo(() => {
    if (failures.length < 2) return null;
    const pts = failures.map(r => ({ x: 1 / r.actual_time_s, y: r.avg_force_kg }));
    return fitCF(pts);
  }, [failures]);

  // ── Curve improvement % vs baseline ──
  // Reference durations for each zone come from ZONE_REF_T (the
  // canonical model reference). Previously this used hardcoded
  // {10, 45, 180} which drifted from the rest of the app when Power
  // moved 10→7 and Endurance moved 180→120. The whole app now
  // evaluates the F-D curve at the same three timepoints the user
  // actually trains at, so this card's % deltas reflect "how much
  // stronger am I at the times I train."
  const REF = {
    power:     ZONE_REF_T.power,
    strength:  ZONE_REF_T.strength,
    endurance: ZONE_REF_T.endurance,
  };

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

  // Reusable: compute {power, strength, endurance, total} Δ% from a
  // current set of three-exp amps vs a reference set. Same shape as
  // the old improvementForFit but operating on amps arrays instead
  // of {CF, W} fit objects.
  const improvementForAmps = (curAmps, refAmps) => {
    if (!curAmps || !refAmps) return null;
    const pct = (t) => {
      const cur = predForceThreeExp(curAmps, t);
      const ref = predForceThreeExp(refAmps, t);
      if (ref <= 0) return null;
      return Math.round((cur / ref - 1) * 100);
    };
    const p = pct(REF.power);
    const s = pct(REF.strength);
    const e = pct(REF.endurance);
    if (p == null || s == null || e == null) return null;
    return { power: p, strength: s, endurance: e, total: Math.round((p + s + e) / 3) };
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
    const allFails = (history || [])
      .filter(r => r.failed && r.avg_force_kg > 0 && r.avg_force_kg < 500 && r.actual_time_s > 0)
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
    const out = {};
    const byGrip = {};
    for (const r of history) {
      if (!r.failed || !r.grip) continue;
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
    const out = {};
    const byGrip = {};
    for (const r of history) {
      if (!r.failed || !r.grip) continue;
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

  // Per-grip improvement — each grip's current three-exp fit vs its
  // own per-grip three-exp baseline. Only emitted for grips that have
  // both, so the card never shows a misleading cross-muscle comparison.
  const gripImprovement = useMemo(() => {
    const out = {};
    for (const [grip, amps] of Object.entries(grip3xEstimates)) {
      const ref = gripBaselines[grip];
      if (!ref) continue;
      const imp = improvementForAmps(amps, ref.amps);
      if (imp) out[grip] = { ...imp, baselineDate: ref.date };
    }
    return out;
  }, [gripBaselines, grip3xEstimates]); // eslint-disable-line react-hooks/exhaustive-deps


  // ── Per-hand × per-grip baselines (three-exp) ──
  // Same seeding logic as gripBaselines but scoped to a single hand
  // on a single grip. Threshold: ≥5 failures across ≥3 distinct
  // durations per (grip, hand). The grip-aware prior in fitAmpsForPts
  // anchors the fast amplitude even when these per-(hand,grip) sets
  // are sparse; under Monod the small-N W' variance was the source
  // of phantom Power regressions on whichever combo started above
  // the pooled mean.
  const perHandGripBaselines = useMemo(() => {
    const out = {};
    const byKey = {};
    for (const r of history) {
      if (!r.failed || !r.grip || !r.hand || r.hand === "Both") continue;
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

  // Progress toward unlocking a per-grip (or per-grip × hand) baseline.
  // Returns {failures, distinctDurations, ready} so UI placeholders can
  // show "3 of 5 failures · 2 of 3 durations" instead of the static
  // "need ≥5 failures across ≥3 target durations" — the user can see
  // exactly how close they are to a stable comparison being unlocked.
  // Hand is optional; pass null/undefined to count across both hands.
  const FAIL_THRESHOLD = 5;
  const DUR_THRESHOLD  = 3;
  const baselineProgress = (grip, hand = null) => {
    let failures = 0;
    const durs = new Set();
    for (const r of history) {
      if (!r.failed || r.grip !== grip) continue;
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

  // ── Per-hand / per-grip CF & W' breakdown ──
  // Groups failure reps by grip × hand, fits Monod (F = CF + W'/T) for
  // each group, and reports CF and W' alongside their delta vs that
  // same (grip,hand)'s own baseline snapshot (see perHandGripBaselines
  // above for why per-hand-per-grip, not pooled). When a combo doesn't
  // yet qualify for a stable baseline, we still emit the row but with
  // cfPct=null so the UI can show current CF without a misleading Δ%.
  // Kept for future per-hand diagnostic use; the Per-Hand CF card that
  // consumed this was removed because it duplicated the Critical Force
  // Estimate cards' per-grip view.
  // eslint-disable-next-line no-unused-vars
  const perHandImprovement = useMemo(() => {
    const groups = {};
    for (const r of history) {
      if (!r.failed || !r.grip || !r.hand || r.hand === "Both") continue;
      if (r.avg_force_kg <= 0 || r.actual_time_s <= 0) continue;
      const key = `${r.grip}|${r.hand}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(r);
    }
    const result = {};
    for (const [key, reps] of Object.entries(groups)) {
      if (reps.length < 2) continue;
      const curPts = reps.map(r => ({ x: 1 / r.actual_time_s, y: r.avg_force_kg }));
      const cur    = fitCF(curPts);
      if (!cur) continue;
      const [grip, hand] = key.split("|");
      const ref = perHandGripBaselines[key];
      const cfPct = ref && ref.CF > 0 ? Math.round((cur.CF / ref.CF - 1) * 100) : null;
      const wPct  = ref && ref.W  > 0 ? Math.round((cur.W  / ref.W  - 1) * 100) : null;
      result[key] = {
        grip, hand, n: reps.length,
        cf: cur.CF, w: cur.W,
        cfPct, wPct,
        baselineDate: ref?.date ?? null,
        hasBaseline: !!ref,
      };
    }
    return Object.keys(result).length > 0 ? result : null;
  }, [history, perHandGripBaselines]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 120s capacity over time ──
  // For each training date, refit three-exp on all failures up to that
  // date (per grip when multiple grips exist) and record F(120s) —
  // the predicted sustainable force at 2 minutes. This is the closest
  // three-exp analog to Critical Force and tracks slow/oxidative
  // compartment progress. F(120s) is grip-scoped so Micro (~10 kg CF)
  // and Crusher (~25 kg CF) don't contaminate each other's trend lines.
  // baselineByGrip records the FIRST computed F(120s) per grip so the
  // chart can anchor a reference line to session 1.
  const cumulativeDataByGrip = useMemo(() => {
    const byGrip = {};
    const relevantFails = selGrip
      ? failures  // already filtered to selGrip above
      : history.filter(r =>
          r.failed && r.grip &&
          r.avg_force_kg > 0 && r.avg_force_kg < 500 &&
          r.actual_time_s > 0
        );
    for (const r of relevantFails) {
      const g = r.grip || selGrip || "?";
      if (!byGrip[g]) byGrip[g] = [];
      byGrip[g].push(r);
    }
    const grips = Object.keys(byGrip).filter(g => byGrip[g].length >= 2);
    if (grips.length === 0) return null;
    const allDates = [...new Set(relevantFails.map(r => r.date))].sort();
    const rows = [];
    const baselineByGrip = {};
    for (const date of allDates) {
      const row = { date };
      let any = false;
      for (const grip of grips) {
        const upTo = byGrip[grip].filter(r => r.date <= date);
        if (upTo.length < 2) continue;
        const prior = threeExpPriors?.get ? threeExpPriors.get(grip) : null;
        if (!prior) continue;
        const pts = upTo.map(r => ({ T: r.actual_time_s, F: r.avg_force_kg }));
        const lambda = THREE_EXP_LAMBDA_DEFAULT / Math.max(upTo.length, 1);
        const amps = fitThreeExpAmps(pts, { prior, lambda });
        if (!(amps[0] + amps[1] + amps[2] > 0)) continue;
        const f120 = predForceThreeExp(amps, 120);
        if (!(f120 > 0)) continue;
        const displayed = toDisp(f120, unit);
        row[`${grip}_f120`] = displayed;
        if (baselineByGrip[grip] == null) baselineByGrip[grip] = displayed;
        any = true;
      }
      if (any) rows.push(row);
    }
    return rows.length >= 2 ? { rows, grips, baselineByGrip } : null;
  }, [failures, history, selHand, selGrip, unit, threeExpPriors]); // eslint-disable-line react-hooks/exhaustive-deps


  // Note: AUC values used to live here (aucEstimate / aucBaseline /
  // aucHistory) backing a dedicated "Climbing Endurance · AUC" card.
  // That card was removed because the Endurance Improvement card
  // already shows each grip's Total % (which IS the AUC % gain) and
  // the CF & W' Over Time chart already shows trajectory. AUC math
  // still lives in computeAUC and is used by the recommendation
  // engine and ΔAUC ranking.

  // Fitted force-duration curve points for overlay.
  const F_D_T_MIN = 5;

  // Per-grip Monod curves + dots, used in the F-D chart when no grip
  // filter is active. Pooling Micro and Crusher onto one chart conflates
  // two different muscles (FDP pinch vs FDS crush) — the cross-muscle
  // amplitude difference dominates and the user can't see what's
  // happening to each grip individually. When ≥2 grips have ≥2
  // failures (and no selGrip), splitMode renders both.
  const fdSplitData = useMemo(() => {
    if (selGrip) return null;
    const byGrip = {};
    for (const r of history) {
      if (!r.grip) continue;
      if (selHand && r.hand !== selHand) continue;
      if (!(r.avg_force_kg > 0 && r.avg_force_kg < 500)) continue;
      if (!(r.actual_time_s > 0)) continue;
      if (!byGrip[r.grip]) byGrip[r.grip] = { failures: [], successes: [] };
      const bucket = r.failed ? "failures" : "successes";
      // Successes only count toward the chart when they hit target —
      // partial holds without a fail flag are ambiguous (matches the
      // existing prescribedLoad scope).
      if (bucket === "successes" && !(r.target_duration > 0 && r.actual_time_s >= r.target_duration)) continue;
      byGrip[r.grip][bucket].push(r);
    }
    const grips = Object.keys(byGrip).filter(g => byGrip[g].failures.length >= 2);
    if (grips.length < 2) return null;
    const tMax = Math.max(maxDur, F_D_T_MIN + 10);
    const out = {};
    for (const grip of grips) {
      const fail = byGrip[grip].failures;
      const succ = byGrip[grip].successes;
      const fit = fitCFWithSuccessFloor(
        fail.map(r => ({ x: 1 / r.actual_time_s, y: r.avg_force_kg })),
        succ.map(r => ({ x: 1 / r.actual_time_s, y: r.avg_force_kg })),
      );
      if (!fit) continue;
      const curve = Array.from({ length: 80 }, (_, i) => {
        const t = F_D_T_MIN + ((tMax - F_D_T_MIN) / 79) * i;
        return { x: t, y: toDisp(Math.max(fit.CF + fit.W / t, fit.CF), unit) };
      });
      out[grip] = {
        fit,
        curve,
        failures: fail.map(r => ({ x: r.actual_time_s, y: toDisp(r.avg_force_kg, unit), date: r.date, grip: r.grip })),
        successes: succ.map(r => ({ x: r.actual_time_s, y: toDisp(r.avg_force_kg, unit), date: r.date, grip: r.grip })),
      };
    }
    return Object.keys(out).length >= 2 ? out : null;
  }, [history, selHand, selGrip, maxDur, unit]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Gap-narrowing tracker over time ──
  // For each session date, compute the gap between empirical (what user
  // actually trained at) and potential (curve-derived ceiling) per zone,
  // using only data UP TO that date. Series shows whether the user is
  // closing the gap in each compartment over time — the real "am I
  // building toward potential" progress signal, much more actionable
  // than absolute CF over time.
  //
  // Scope: requires a grip filter (cross-grip gap is meaningless).
  // When selHand is set, computes per-hand. When unset, pools both hands
  // (the curve fit is grip-scoped, the empirical anchor is most-recent
  // rep 1 across both hands).
  const gapHistory = useMemo(() => {
    if (!selGrip) return null;
    const targets = [
      { key: "power",     T: GOAL_CONFIG.power.refTime,     color: GOAL_CONFIG.power.color },
      { key: "strength",  T: GOAL_CONFIG.strength.refTime,  color: GOAL_CONFIG.strength.color },
      { key: "endurance", T: GOAL_CONFIG.endurance.refTime, color: GOAL_CONFIG.endurance.color },
    ];
    // Snapshot dates: every distinct date the user trained this grip
    // (with the active hand filter applied if any). Keeps the chart
    // sparse but representative.
    const handFn = (r) => !selHand || r.hand === selHand;
    const datesSet = new Set();
    for (const r of history) {
      if (r.grip !== selGrip || !handFn(r) || !r.date) continue;
      if (!(r.actual_time_s > 0)) continue;
      datesSet.add(r.date);
    }
    const dates = [...datesSet].sort();
    if (dates.length < 2) return null;
    const rows = [];
    for (const date of dates) {
      const upTo = history.filter(r => (r.date || "") <= date);
      const row = { date };
      for (const { key, T } of targets) {
        let bestGap = null;
        const handsToCheck = selHand ? [selHand] : ["L", "R"];
        for (const h of handsToCheck) {
          const trainAt = empiricalPrescription(upTo, h, selGrip, T, { threeExpPriors });
          const pot = prescriptionPotential(upTo, h, selGrip, T, { threeExpPriors });
          if (trainAt == null || !pot || pot.reliability === "extrapolation") continue;
          // Flipped sign: positive = outperforming model, negative = headroom to grow
          const gap = (trainAt - pot.value) / pot.value;
          if (bestGap == null || gap > bestGap) bestGap = gap;
        }
        row[`${key}_gap`] = bestGap != null ? Math.round(bestGap * 100) : null;
      }
      // Only include rows where at least one zone had a computable gap
      if (targets.some(({key}) => row[`${key}_gap`] != null)) rows.push(row);
    }
    return rows.length >= 2 ? rows : null;
  }, [history, selHand, selGrip, threeExpPriors]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Three-exp F-D fit (governing model — see src/model/threeExp.js) ──
  // threeExpPriors memoized earlier in AnalysisView so gapHistory,
  // prescriptionPotential, and the chart curve all share one fit basis.

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
  // no direct analog to Monod's CF. The closest physiologically meaningful
  // "long-duration sustainable force" reference is F(180s) — well past
  // the glycolytic dominance window (τ₂=30s drained 6× over) where the
  // slow oxidative compartment carries essentially the whole load. Used
  // as the dashed horizontal reference on the F-D chart, replacing the
  // CF line that came from Monod.
  const threeExpRef180 = useMemo(() => {
    if (!threeExpFit) return null;
    return predForceThreeExp(threeExpFit.amps, 180);
  }, [threeExpFit]);

  // Train RMSE on the failure points for both models — directional
  // signal of fit quality. NOTE: this is training RMSE not holdout, so
  // it's biased optimistic for both; the relative comparison between
  // the two models on the SAME data is still meaningful. Holdout
  // validation lives in the offline sim (validate_three_exp_v3.js).
  const modelRMSE = useMemo(() => {
    if (failures.length < 2 || !cfEstimate || !threeExpFit) return null;
    let mErr = 0, eErr = 0;
    for (const r of failures) {
      const T = r.actual_time_s, F = r.avg_force_kg;
      const mPred = cfEstimate.CF + cfEstimate.W / T;
      const ePred = predForceThreeExp(threeExpFit.amps, T);
      mErr += (mPred - F) ** 2;
      eErr += (ePred - F) ** 2;
    }
    return {
      monod:    Math.sqrt(mErr / failures.length),
      threeExp: Math.sqrt(eErr / failures.length),
      n:        failures.length,
    };
  }, [failures, cfEstimate, threeExpFit]);

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
    const zoneMap = {
      power:     { x1: 0,            x2: POWER_MAX,    color: C.red,    label: "Limiter: Power"    },
      strength:  { x1: POWER_MAX,    x2: STRENGTH_MAX, color: C.orange, label: "Limiter: Strength" },
      endurance: { x1: STRENGTH_MAX, x2: maxDur + 10,  color: C.blue,   label: "Limiter: Endurance" },
    };
    return zoneMap[lim.zone] || null;
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

  // Scatter data — recalculated when relMode toggles
  const successDotsRel = successes.map(r => ({
    x: r.actual_time_s,
    y: useRel ? r.avg_force_kg / bodyWeight : toDisp(r.avg_force_kg, unit),
    date: r.date, grip: r.grip,
  }));
  const failureDotsRel = failures.map(r => ({
    x: r.actual_time_s,
    y: useRel ? r.avg_force_kg / bodyWeight : toDisp(r.avg_force_kg, unit),
    date: r.date, grip: r.grip,
  }));
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
  const zones = useMemo(() => {
    const zoneStats = (lo, hi) => {
      const z = reps.filter(r => {
        const t = r.target_duration > 0 ? r.target_duration : r.actual_time_s;
        return t >= lo && t < hi;
      });
      const f = z.filter(r => {
        if (r.target_duration > 0) return r.actual_time_s < r.target_duration;
        return r.failed;
      }).length;
      return { total: z.length, failures: f, successes: z.length - f,
               failRate: z.length > 0 ? f / z.length : null };
    };
    return {
      power:     { ...zoneStats(0, POWER_MAX),                label: "Power",     color: C.red,    desc: "0–20s",    system: "Phosphocreatine",  tau: `τ₁ ≈ ${PHYS_MODEL_DEFAULT.tauR.fast}s`   },
      strength:  { ...zoneStats(POWER_MAX, STRENGTH_MAX),     label: "Strength",  color: C.orange, desc: "20–120s",  system: "Glycolytic",       tau: `τ₂ ≈ ${PHYS_MODEL_DEFAULT.tauR.medium}s` },
      endurance: { ...zoneStats(STRENGTH_MAX, Infinity),      label: "Endurance",  color: C.blue,   desc: "120s+",    system: "Oxidative",        tau: `τ₃ ≈ ${PHYS_MODEL_DEFAULT.tauR.slow}s`   },
    };
  }, [reps]);

  // ── Personal response calibration ──
  // Fits CF/W′ response rates per zone from the user's own history and
  // shrinks toward PROTOCOL_RESPONSE. Used by the recommendation engine
  // instead of the raw prior so the engine's "what grows AUC fastest"
  // adapts to this climber's actual measured response.
  const personalResponse = useMemo(
    () => computePersonalResponse(history),
    [history]
  );

  // ── Unified training recommendation ──
  // Primary signal: marginal AUC gain. For each protocol (power /
  // strength / capacity), take the PERSONAL response rates (prior if
  // thin data, blended with observed otherwise), project ΔCF and ΔW′
  // at current parameter values, and integrate to a projected ΔAUC
  // over the climbing-relevant 10–120s window. Pick the protocol with
  // the largest projected ΔAUC.
  //
  // Secondary: Monod cross-zone residual (limiter) and zone coverage,
  // kept as diagnostics alongside the ΔAUC ranking so users can see
  // where the curve is lopsided and which zones are under-trained.
  const recommendation = useMemo(() => {
    // Limiter (curve shape) — kept as secondary diagnostic
    const limiter = computeLimiterZone(history);
    const limiterKey  = limiter?.zone ?? null;
    const limiterGrip = limiter?.grip ?? null;

    // Coverage (training distribution) — kept as tertiary diagnostic
    const coverage = computeZoneCoverage(history, activities);
    const coverageKey = coverage.total > 0 ? coverage.recommended : null;

    // Primary path: coaching engine v2 (gap × intensity × recency ×
    // external) when a grip is selected. For the no-grip-selected case
    // there's no meaningful single recommendation (gap requires a grip
    // scope), so we fall back to the legacy ΔAUC ranking on liveEstimate.
    if (selGrip) {
      const coach = coachingRecommendation(history, selGrip, {
        freshMap, threeExpPriors, activities, trainingFocus,
      });
      if (coach) {
        const d = ZONE_DETAILS[coach.zone];
        // Compute per-zone gap landscape for the bars
        const zones = ["power", "strength", "endurance"];
        const zoneGaps = {};
        for (const zoneKey of zones) {
          const t = GOAL_CONFIG[zoneKey].refTime;
          let bestGap = null;
          for (const h of ["L", "R"]) {
            const trainAt = empiricalPrescription(history, h, selGrip, t, { threeExpPriors })
                         ?? prescribedLoad(history, h, selGrip, t, freshMap, { threeExpPriors });
            const pot = prescriptionPotential(history, h, selGrip, t, { freshMap, threeExpPriors });
            if (trainAt == null || !pot || pot.reliability === "extrapolation") continue;
            const gap = (pot.value - trainAt) / trainAt;
            if (bestGap == null || gap > bestGap) bestGap = gap;
          }
          zoneGaps[zoneKey] = bestGap;
        }
        return {
          key: coach.zone, title: d.title, color: d.color,
          rationale: coachingRationale(coach),
          coach, zoneGaps,
          limiterKey, limiterGrip, coverageKey,
          agree: !limiterKey || limiterKey === coach.zone,
          coverageZoneLabel: coverageKey ? ZONE_DETAILS[coverageKey].title.replace("Train ", "") : null,
        };
      }
    }

    // Fallback path: legacy ΔAUC ranking on the pooled / available fit.
    // Used when no grip is selected (pooled recommendation across grips)
    // or when the coaching engine has no scoreable zones for the picked
    // grip yet (cold start with no recent reps at this scope).
    const gripFit = selGrip ? gripEstimates[selGrip] : null;
    const fitForRec = gripFit ?? liveEstimate ?? cfEstimate;
    if (!fitForRec) {
      const fallbackKey = limiterKey ?? coverageKey;
      if (!fallbackKey) return null;
      const d = ZONE_DETAILS[fallbackKey];
      return {
        key: fallbackKey,
        title: d.title, color: d.color,
        insight: `Need 2+ failures across different durations to rank protocols by projected AUC gain. For now: ${d.caption}`,
        gains: null, aucGain: null, zoneGaps: null,
        limiterKey, limiterGrip, coverageKey,
        agree: true, responseSource: null,
        coverageZoneLabel: coverageKey ? ZONE_DETAILS[coverageKey].title.replace("Train ", "") : null,
      };
    }
    const base = buildRecFromFit(fitForRec, personalResponse, unit);
    const agree = !limiterKey || limiterKey === base.key;
    return {
      ...base, zoneGaps: null,
      limiterKey, limiterGrip, coverageKey, agree,
      coverageZoneLabel: coverageKey ? ZONE_DETAILS[coverageKey].title.replace("Train ", "") : null,
    };
  }, [liveEstimate, gripEstimates, selGrip, history, activities, unit, personalResponse, freshMap, threeExpPriors]); // eslint-disable-line react-hooks/exhaustive-deps

  // Per-grip recommendations — one rec per grip with enough data for
  // a coaching call. Uses the v2 coaching engine: gap × intensity ×
  // recency × external_load. The card shows the recommended zone, the
  // coaching rationale, and per-zone gap bars (so the user sees the
  // full landscape of opportunities, not just the winner).
  const gripRecs = useMemo(() => {
    const zones = ["power", "strength", "endurance"];
    const out = {};
    for (const [grip, fit] of Object.entries(gripEstimates)) {
      const coach = coachingRecommendation(history, grip, {
        freshMap, threeExpPriors, activities, trainingFocus,
      });
      if (!coach) continue;
      // Compute per-zone gaps so the bars can show the whole landscape.
      const zoneGaps = {};
      for (const zoneKey of zones) {
        const t = GOAL_CONFIG[zoneKey].refTime;
        let bestGap = null;
        for (const h of ["L", "R"]) {
          const trainAt = empiricalPrescription(history, h, grip, t, { threeExpPriors })
                       ?? prescribedLoad(history, h, grip, t, freshMap, { threeExpPriors });
          const pot = prescriptionPotential(history, h, grip, t, { freshMap, threeExpPriors });
          if (trainAt == null || !pot || pot.reliability === "extrapolation") continue;
          const gap = (pot.value - trainAt) / trainAt;
          if (bestGap == null || gap > bestGap) bestGap = gap;
        }
        zoneGaps[zoneKey] = bestGap;
      }
      const d = ZONE_DETAILS[coach.zone];
      out[grip] = {
        grip,
        key:       coach.zone,
        title:     d.title,
        color:     d.color,
        rationale: coachingRationale(coach),
        coach,
        zoneGaps,
        CF: fit.CF, W: fit.W, n: fit.n,
      };
    }
    return out;
  }, [gripEstimates, history, freshMap, threeExpPriors, activities, GOAL_CONFIG, trainingFocus]);

  const unexplored = Object.entries(zones)
    .filter(([, z]) => z.total === 0)
    .map(([, z]) => z.label);

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
      <h2 style={{ margin: "0 0 4px", fontSize: 22 }}>Force-Duration Analysis</h2>
      <p style={{ margin: "0 0 16px", fontSize: 13, color: C.muted, lineHeight: 1.5 }}>
        Where failures fall on the fatigue curve reveals which energy system is your limiter — and what to train next.
      </p>

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
        {grips.length > 0 && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={() => setSelGrip("")} style={{
              padding: "4px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer", border: "none",
              background: !selGrip ? C.orange : C.border, color: !selGrip ? "#fff" : C.muted,
            }}>All Grips</button>
            {grips.map(g => (
              <button key={g} onClick={() => setSelGrip(g)} style={{
                padding: "4px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer", border: "none",
                background: selGrip === g ? C.orange : C.border, color: selGrip === g ? "#fff" : C.muted,
              }}>{g}</button>
            ))}
          </div>
        )}
      </Card>

      {/* F-D chart hoisted to the top of AnalysisView — most important
          visual on this view. Empty-state placeholder still appears
          below in the {reps.length === 0 ? ...} block. */}
      {reps.length > 0 && (<>
        {/* ── Force-Duration scatter ── */}
        <Card style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4, flexWrap: "wrap", gap: 6 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Force vs. Duration</div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {/* Grip selection lives on the filter card above (All Grips /
                  Micro / Crusher) — no duplicate toggle here. Only the
                  display-mode (Absolute / × Bodyweight) toggle stays in
                  the chart header since it's chart-specific. */}
              {bodyWeight != null && ["Absolute", "Relative"].map(mode => (
                <button key={mode} onClick={() => setRelMode(mode === "Relative")} style={{
                  padding: "3px 10px", borderRadius: 12, fontSize: 11, cursor: "pointer", border: "none", fontWeight: 600,
                  background: (mode === "Relative") === relMode ? C.purple : C.border,
                  color: (mode === "Relative") === relMode ? "#fff" : C.muted,
                }}>{mode}</button>
              ))}
            </div>
          </div>
          {(() => {
            const splitMode = !!fdSplitData;
            return (
              <div style={{ display: "flex", gap: 16, fontSize: 11, color: C.muted, marginBottom: 10, flexWrap: "wrap" }}>
                <span><span style={{ color: C.green }}>●</span> Completed</span>
                <span><span style={{ color: C.red }}>●</span> Auto-failed</span>
                {!splitMode && threeExpCurveDataRel.length > 0 && <span title="Three-exp model: governing F-D curve. Sum of three exponentials with depletion-tau basis (PCr/glycolytic/oxidative)."><span style={{ color: C.purple }}>―</span> F-D curve (3-exp)</span>}
                {!splitMode && threeExpRef180 != null && <span title="Three-exp prediction at T=180s — the slow/oxidative compartment dominates here. The closest analog to a 'sustainable force' reference."><span style={{ color: C.purple }}>╌</span> 3-min sustainable</span>}
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
                  echoes the SessionPlanner recommendation. */}
              <ReferenceArea x1={0}            x2={POWER_MAX}    fill={C.red}    fillOpacity={limiterZoneBounds?.x1 === 0            ? 0.22 : 0.07} />
              <ReferenceArea x1={POWER_MAX}    x2={STRENGTH_MAX} fill={C.orange} fillOpacity={limiterZoneBounds?.x1 === POWER_MAX    ? 0.22 : 0.07} />
              <ReferenceArea x1={STRENGTH_MAX} x2={maxDur + 10}  fill={C.blue}   fillOpacity={limiterZoneBounds?.x1 === STRENGTH_MAX ? 0.22 : 0.07} />
              {/* Single-fit overlays only when NOT in per-grip split mode.
                  In split mode they'd be ambiguous (which grip's CF? which
                  3-exp? which 90% band?). Per-grip rendering takes over. */}
              {/* 3-min sustainable reference from three-exp at T=180s
                  (replaces the Monod CF asymptote, since three-exp has
                  no true asymptote — it decays to 0). At 180s the slow
                  oxidative compartment dominates; this is the closest
                  physiological analog to "what you can sustain". */}
              {!fdSplitData && threeExpRef180 != null && (
                <ReferenceLine
                  y={useRel ? threeExpRef180 / bodyWeight : toDisp(threeExpRef180, unit)}
                  stroke={C.purple} strokeDasharray="6 3" strokeWidth={1.5}
                  label={{ value: `3-min ${fmtForce(threeExpRef180)} ${forceUnit}`, position: "insideTopRight", fill: C.purple, fontSize: 10 }}
                />
              )}
              {/* Primary curve — three-exp F-D. Bold purple solid; this
                  is the curve the rest of the engine optimizes against. */}
              {!fdSplitData && threeExpCurveDataRel.length > 0 && (
                <Line data={threeExpCurveDataRel} dataKey="y" stroke={C.purple}
                      strokeWidth={2} dot={false}
                      legendType="none" isAnimationActive={false} />
              )}
              {!fdSplitData && (
                <Scatter data={successDotsRel} dataKey="y" fill={C.green} opacity={0.85} name="Completed" />
              )}
              {!fdSplitData && (
                <Scatter data={failureDotsRel} dataKey="y" fill={C.red} opacity={0.95} name="Auto-failed" />
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
                  const data = fdSplitData[grip];
                  // Three-exp PRIMARY curve — bold solid grip color. This
                  // is the curve the engine optimizes against; Monod
                  // (above) is just for visual comparison. Also emits a
                  // per-grip "3-min sustainable" reference line so split
                  // mode shows the same overlays as single-grip mode.
                  if (threeExpPriors && threeExpPriors.get) {
                    const prior = threeExpPriors.get(grip);
                    const failures = (history || []).filter(r =>
                      r.failed && r.grip === grip
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
                  // Dots: red fill for failures, green for completes — same
                  // semantic as single-fit mode. The grip identity is read
                  // from position relative to its own colored curve.
                  const failRel = data.failures.map(d => ({
                    x: d.x,
                    y: useRel && bodyWeight > 0 ? d.y / (bodyWeight * (unit === "lbs" ? KG_TO_LBS : 1)) : d.y,
                    grip, date: d.date,
                  }));
                  const succRel = data.successes.map(d => ({
                    x: d.x,
                    y: useRel && bodyWeight > 0 ? d.y / (bodyWeight * (unit === "lbs" ? KG_TO_LBS : 1)) : d.y,
                    grip, date: d.date,
                  }));
                  elements.push(
                    <Scatter key={`${grip}-fail`} data={failRel} dataKey="y"
                      fill={C.red} stroke={color} strokeWidth={1.5} opacity={0.95} />
                  );
                  elements.push(
                    <Scatter key={`${grip}-succ`} data={succRel} dataKey="y"
                      fill={C.green} stroke={color} strokeWidth={1.5} opacity={0.85} />
                  );
                }
                return elements;
              })()}
            </ComposedChart>
          </ResponsiveContainer>
          {/* Zone labels */}
          <div style={{ display: "flex", justifyContent: "space-around", marginTop: 4, fontSize: 10, color: C.muted }}>
            <span style={{ color: C.red }}>⚡ Power &lt;20s</span>
            <span style={{ color: C.orange }}>💪 Strength 20–120s</span>
            <span style={{ color: C.blue }}>🔄 Endurance 120s+</span>
          </div>
          {/* Model-fit diagnostic — training RMSE for the three-exp curve.
              Biased optimistic (training not holdout) but useful for
              tracking whether the fit is degrading over time. */}
          {modelRMSE && (
            <div style={{ marginTop: 8, padding: "6px 8px", background: C.bg, borderRadius: 6, fontSize: 10, color: C.muted, lineHeight: 1.5 }}>
              <span style={{ color: C.purple, fontWeight: 600 }}>Fit diagnostic</span>
              {" · 3-exp RMSE "}
              <span style={{ color: C.text, fontWeight: 600 }}>
                {modelRMSE.threeExp.toFixed(2)} kg
              </span>
              {" · N="}{modelRMSE.n}
              {" · "}
              <span style={{ fontStyle: "italic" }}>
                training fit, not holdout
              </span>
            </div>
          )}
        </Card>
      </>)}

      {/* ── 1RM PR tracker ── */}
      <OneRMPRCard activities={activities} rmGrips={RM_GRIPS} unit={unit} />

      {/* ── Curve Improvement summary ──
          (Was "Endurance Improvement" — renamed because the headline
          isn't endurance, it's the average of three F-D curve point
          improvements at ZONE_REF_T's power/strength/endurance times
          — currently 7s / 45s / 120s. The blue Endurance cell is the
          one true endurance signal; Power and Strength are the other
          two reference points on the same curve.)
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
            <div style={{ display: "flex", gap: 8 }}>
              {[
                { label: "⚡ Power",     val: imp.power,     color: C.red    },
                { label: "💪 Strength",  val: imp.strength,  color: C.orange },
                { label: "🏔️ Endurance",  val: imp.endurance, color: C.blue   },
              ].map(({ label, val, color }) => (
                <div key={label} style={{
                  flex: 1, background: C.bg, borderRadius: 10, padding: "8px 6px", textAlign: "center",
                  border: `1px solid ${color}30`,
                }}>
                  <div style={{ fontSize: 10, color: C.muted, marginBottom: 3 }}>{label}</div>
                  <div style={{ fontSize: 17, fontWeight: 800, color: val >= 0 ? color : C.red }}>
                    {val >= 0 ? "+" : ""}{val}%
                  </div>
                </div>
              ))}
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
        const perGripMode = !selGrip && Object.keys(gripEstimates).length >= 2;
        const gripImpEntries = Object.entries(gripImprovement);

        // When a grip filter is active, cfEstimate is scoped to that
        // grip AND to selHand (via the `failures` filter). Comparing
        // it against a baseline of a different scope produces an
        // apples-to-oranges comparison. We have three baselines to
        // pick from, listed by tightness:
        //   1. perHandGripBaselines[grip|hand]  — exact scope match
        //   2. gripBaselines[grip]               — pools hands, per-grip
        //   3. (fall through to early-days)
        //
        // To keep the comparison apples-to-apples, the LHS (current
        // fit) is recomputed at the SAME scope as whichever baseline
        // we end up using, instead of always using the hand-scoped
        // cfEstimate. Without this, a (Micro, Left) current vs
        // (Micro pooled-hands) baseline still mixes hand asymmetry
        // into the Δ% — same flavor as the cross-muscle artifact,
        // just smaller.
        let scopedImp = null;
        let scopedBaselineDate = null;
        let scopedScopeLabel = null;
        if (selGrip) {
          const phgKey = selHand && selHand !== "Both" ? `${selGrip}|${selHand}` : null;
          const phgRef = phgKey ? perHandGripBaselines[phgKey] : null;
          const gRef   = gripBaselines[selGrip];
          const lBase  = perHandGripBaselines[`${selGrip}|L`];
          const rBase  = perHandGripBaselines[`${selGrip}|R`];
          if (phgRef) {
            // Tightest match: current3xAmps (already hand+grip scoped
            // via the `failures` filter) vs per-(hand,grip) baseline.
            scopedImp = improvementForAmps(current3xAmps, phgRef.amps);
            scopedBaselineDate = phgRef.date;
            scopedScopeLabel = `${selGrip} · ${selHand === "L" ? "Left" : "Right"}`;
          } else if (!selHand && lBase && rBase) {
            // "Both" mode AND both per-hand baselines exist → display
            // the AVERAGE of per-hand improvements rather than a
            // pooled-fit comparison. The pooled approach used here
            // before produced delta %s that looked like Right + Left
            // because pooled-fit shrinkage relaxes asymmetrically
            // between the small-N baseline and the larger-N current
            // (both push higher than per-hand fits, but by different
            // amounts). The average is the user's intuitive reading
            // ("what's my typical improvement across both hands") and
            // is internally consistent with the per-hand cells.
            const buildHandPts = (hand) => history
              .filter(r => r.failed && r.grip === selGrip && r.hand === hand)
              .filter(r => r.avg_force_kg > 0 && r.avg_force_kg < 500 && r.actual_time_s > 0)
              .map(r => ({ T: r.actual_time_s, F: r.avg_force_kg }));
            const lAmps = fitAmpsForPts(buildHandPts("L"), selGrip);
            const rAmps = fitAmpsForPts(buildHandPts("R"), selGrip);
            const lImp = lAmps ? improvementForAmps(lAmps, lBase.amps) : null;
            const rImp = rAmps ? improvementForAmps(rAmps, rBase.amps) : null;
            if (lImp && rImp) {
              scopedImp = {
                power:     Math.round((lImp.power     + rImp.power)     / 2),
                strength:  Math.round((lImp.strength  + rImp.strength)  / 2),
                endurance: Math.round((lImp.endurance + rImp.endurance) / 2),
                total:     Math.round((lImp.total     + rImp.total)     / 2),
              };
              // Use the EARLIER of the two baseline dates as the "since"
              // label so the reader sees the start of meaningful tracking.
              scopedBaselineDate = lBase.date < rBase.date ? lBase.date : rBase.date;
              scopedScopeLabel = `${selGrip} · avg of Left + Right`;
            } else if (gRef && grip3xEstimates[selGrip]) {
              // Per-hand fits unavailable for some reason — fall back to
              // pooled. Same fallback as the no-per-hand-baseline path.
              scopedImp = improvementForAmps(grip3xEstimates[selGrip], gRef.amps);
              scopedBaselineDate = gRef.date;
              scopedScopeLabel = `${selGrip} (pooled fit)`;
            }
          } else if (gRef && grip3xEstimates[selGrip]) {
            // Fallback: per-(hand,grip) baseline doesn't exist yet for
            // both hands (e.g., one hand under-trained), but the grip-
            // pooled baseline does. Use the grip-pooled CURRENT amps
            // (pools both hands) so both sides of the comparison live
            // in the same scope.
            scopedImp = improvementForAmps(grip3xEstimates[selGrip], gRef.amps);
            scopedBaselineDate = gRef.date;
            scopedScopeLabel = `${selGrip} (pooled fit · awaiting per-hand baseline)`;
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
                  {Object.keys(gripEstimates).filter(g => !gripImprovement[g]).map(grip => {
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
                  Need ≥5 failures across ≥3 target durations <i>per grip</i> to seed a stable per-grip baseline. Until then the three-exp fit can't separate the fast / medium / slow compartments cleanly enough for the per-zone Δ% to be meaningful.
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

      {/* ── 120s capacity over time ── */}
      {cumulativeDataByGrip && (() => {
        const { rows, grips, baselineByGrip } = cumulativeDataByGrip;
        return (
          <Card style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>120s Capacity Over Time</div>
            <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>
              Three-exp predicted force at 2 minutes, per grip — refit after every failure.
              Dashed line = first session baseline.
            </div>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={rows} margin={{ top: 6, right: 14, bottom: 28, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis dataKey="date" tick={{ fill: C.muted, fontSize: 9 }} angle={-30} textAnchor="end" interval="preserveStartEnd"
                  label={{ value: "Date", position: "insideBottom", offset: -18, fill: C.muted, fontSize: 11 }} />
                <YAxis tick={{ fill: C.muted, fontSize: 11 }} width={46}
                  label={{ value: unit, angle: -90, position: "insideLeft", fill: C.muted, fontSize: 11 }} />
                <Tooltip
                  contentStyle={{ background: C.card, border: `1px solid ${C.border}`, fontSize: 12 }}
                  formatter={(val, name) => [fmt1(val) + " " + unit, name]}
                />
                {grips.map(g => (
                  <Line key={g} dataKey={`${g}_f120`} stroke={GRIP_COLORS[g] || C.blue}
                    strokeWidth={2} dot={false} name={g} connectNulls />
                ))}
                {grips.map(g => baselineByGrip[g] != null && (
                  <ReferenceLine key={`${g}-base`} y={baselineByGrip[g]}
                    stroke={GRIP_COLORS[g] || C.blue} strokeDasharray="4 3" strokeOpacity={0.5}
                    label={{ value: `${g} start`, position: "insideTopRight", fill: GRIP_COLORS[g] || C.blue, fontSize: 9 }}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
            <div style={{ display: "flex", gap: 16, justifyContent: "center", fontSize: 10, color: C.muted, marginTop: 4, flexWrap: "wrap" }}>
              {grips.map(g => (
                <span key={g}><span style={{ color: GRIP_COLORS[g] || C.blue }}>━</span> {g}</span>
              ))}
              <span><span style={{ color: C.muted, opacity: 0.6 }}>╌</span> start baseline</span>
            </div>
          </Card>
        );
      })()}

      {/* ── Performance vs. Model, over time ──
          Flipped-sign gap chart: positive = outperforming the model's
          prediction, negative = headroom still to capture. Rising lines
          mean adaptation is delivering. Zones persistently below zero
          have room to grow — focus there.

          Only renders when a grip filter is set (cross-grip comparison
          doesn't mean anything physiologically). */}
      {gapHistory && gapHistory.length >= 2 && (
        <Card style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Performance vs. Model — {selGrip}{selHand ? ` · ${selHand === "L" ? "Left" : "Right"}` : ""}</div>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>
            How much you're outperforming (+) or underperforming (−) the model's prediction per zone. Rising lines mean adaptation is delivering. Zones below zero have headroom left — focus there.
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={gapHistory} margin={{ top: 6, right: 14, bottom: 28, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
              <XAxis dataKey="date" tick={{ fill: C.muted, fontSize: 9 }} angle={-30} textAnchor="end" interval="preserveStartEnd"
                label={{ value: "Date", position: "insideBottom", offset: -18, fill: C.muted, fontSize: 11 }} />
              <ReferenceLine y={0} stroke={C.border} strokeWidth={1.5} />
              <YAxis tick={{ fill: C.muted, fontSize: 11 }} width={42} unit="%"
                label={{ value: "vs. model", angle: -90, position: "insideLeft", fill: C.muted, fontSize: 11 }} />
              <Tooltip
                contentStyle={{ background: C.card, border: `1px solid ${C.border}`, fontSize: 12 }}
                formatter={(val, name) => [val == null ? "—" : `${val >= 0 ? "+" : ""}${val}%`, name]}
              />
              <Line dataKey="power_gap"     stroke={GOAL_CONFIG.power.color}     strokeWidth={2} dot={{ r: 3 }} connectNulls name="⚡ Power" />
              <Line dataKey="strength_gap"  stroke={GOAL_CONFIG.strength.color}  strokeWidth={2} dot={{ r: 3 }} connectNulls name="💪 Strength" />
              <Line dataKey="endurance_gap" stroke={GOAL_CONFIG.endurance.color} strokeWidth={2} dot={{ r: 3 }} connectNulls name="🏔️ Endurance" />
            </LineChart>
          </ResponsiveContainer>
          <div style={{ display: "flex", justifyContent: "space-around", marginTop: 4, fontSize: 10, color: C.muted }}>
            <span style={{ color: GOAL_CONFIG.power.color }}>⚡ Power</span>
            <span style={{ color: GOAL_CONFIG.strength.color }}>💪 Strength</span>
            <span style={{ color: GOAL_CONFIG.endurance.color }}>🏔️ Endurance</span>
          </div>
        </Card>
      )}

      {/* Per-Hand Critical Force card removed — duplicated info from
          the Critical Force Estimate cards below. */}

      {reps.length === 0 ? (
        <Card>
          <div style={{ textAlign: "center", padding: "32px 0", color: C.muted }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📊</div>
            <div>No session data yet for this selection.</div>
            <div style={{ fontSize: 12, marginTop: 8 }}>Run a few sessions on this grip / hand to start building a force-duration curve.</div>
          </div>
        </Card>
      ) : (<>


        {/* ── Critical Force card ──
            When no grip filter is active AND ≥2 grips have fits, render
            one card per grip (Micro, Crusher) so each muscle's CF / W′
            and curve shape are read independently. Otherwise fall back
            to the pooled / selGrip-scoped single card. */}
        {(() => {
          // Shared renderer for the CF/W′/curve-shape body of the card.
          const renderCFBody = (fit) => {
            const ratio = fit.CF > 0 ? fit.W / fit.CF : 0;
            const pct   = Math.min(100, Math.max(0, (ratio / 120) * 100));
            const { shape, color: sc, caption } =
              ratio < 30  ? { shape: "CF-dominant (Flat)",    color: C.blue,   caption: "Your curve is flat — CF is high relative to W′. Your sustainable force is well developed; your finite anaerobic reserve is small." } :
              ratio < 80  ? { shape: "Balanced",              color: C.green,  caption: "CF and W′ are roughly proportional — neither the aerobic asymptote nor the anaerobic reserve dominates the curve." } :
                            { shape: "W′-dominant (Steep)",   color: C.orange, caption: "Your curve is steep — W′ is large relative to CF. Your short-burst capacity is well developed; your sustainable asymptote is lower." };
            return (
              <>
                <div style={{ display: "flex", gap: 0, marginBottom: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>Critical Force (CF)</div>
                    <div style={{ fontSize: 32, fontWeight: 800, color: C.purple, lineHeight: 1 }}>
                      {fmtW(fit.CF, unit)}
                    </div>
                    <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>{unit} · max sustainable</div>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>Anaerobic Capacity (W′)</div>
                    <div style={{ fontSize: 32, fontWeight: 800, color: C.orange, lineHeight: 1 }}>
                      {fmtW(fit.W, unit)}·s
                    </div>
                    <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>{unit}·s · finite reserve above CF</div>
                  </div>
                </div>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.muted, marginBottom: 5 }}>
                    <span>Curve Shape</span>
                    <span style={{ color: sc, fontWeight: 700 }}>{shape}</span>
                  </div>
                  <div style={{ position: "relative", height: 8, borderRadius: 4, overflow: "hidden",
                    background: "linear-gradient(to right, #3b82f6, #22c55e, #e07a30)" }}>
                    <div style={{
                      position: "absolute", top: "50%", left: `${pct}%`,
                      transform: "translate(-50%, -50%)",
                      width: 14, height: 14, borderRadius: 7,
                      background: "#fff", border: `2px solid ${sc}`,
                      boxShadow: "0 0 4px rgba(0,0,0,0.4)",
                    }} />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: C.muted, marginTop: 3 }}>
                    <span>Flat (CF dominant)</span><span>Steep (W′ dominant)</span>
                  </div>
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 6, lineHeight: 1.5 }}>
                    {caption} See <b>Next Session Focus</b> above for what to train next.
                  </div>
                </div>
                <div style={{ fontSize: 12, color: C.muted, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
                  Estimated from {fit.n} failure point{fit.n !== 1 ? "s" : ""}. Accuracy improves as failures span multiple time domains — try power hangs (5–10s) and capacity hangs (2+ min) to sharpen the curve.
                </div>
              </>
            );
          };

          const perGripMode = !selGrip && Object.keys(gripEstimates).length >= 2;
          if (perGripMode) {
            return (
              <>
                {Object.entries(gripEstimates).map(([grip, fit]) => (
                  <Card key={grip} style={{ marginBottom: 16 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
                      <div style={{ fontSize: 14, fontWeight: 700 }}>Critical Force Estimate</div>
                      <div style={{ fontSize: 11, color: C.muted, fontWeight: 600 }}>{grip}</div>
                    </div>
                    {renderCFBody(fit)}
                  </Card>
                ))}
              </>
            );
          }

          if (cfEstimate) {
            return (
              <Card style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>Critical Force Estimate</div>
                  {selGrip && (
                    <div style={{ fontSize: 11, color: C.muted, fontWeight: 600 }}>{selGrip}</div>
                  )}
                </div>
                {renderCFBody(cfEstimate)}
              </Card>
            );
          }

          return (
            <Card style={{ marginBottom: 16, border: `1px solid ${C.yellow}30` }}>
              <div style={{ fontSize: 13, color: C.yellow, marginBottom: 6 }}>
                {failures.length === 0 ? "⚠ Critical Force requires failure data" : "⚠ Need 2+ failures at different durations to fit the curve"}
              </div>
              <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
                {failures.length === 0
                  ? "The shape of your force-duration curve is defined by reps that end in auto-failure. Completed reps set the floor; failed reps define the curve."
                  : "You have failure data in one time domain. Add failures at a shorter or longer duration to fit the Monod-Scherrer curve and estimate Critical Force."}
              </div>
            </Card>
          );
        })()}

        {/* The Climbing Endurance chart card lived here. Removed because
            the Endurance Improvement card below already shows each grip's
            Total % (= AUC % gain) and CF & W' Over Time already shows
            the trajectory of the underlying fit parameters. */}

        {/* ── Per-compartment AUC (dose delivered per energy system, per session) ── */}
        {(() => {
          // Group selected reps by session_id; fall back to date
          const bySession = new Map();
          for (const r of reps) {
            const key = r.session_id || r.date;
            if (!bySession.has(key)) bySession.set(key, { key, date: r.date, reps: [] });
            bySession.get(key).reps.push(r);
          }
          const sessions = [...bySession.values()]
            .sort((a, b) => a.date.localeCompare(b.date))
            .slice(-10)
            .map(s => {
              const auc = sessionCompartmentAUC(s.reps);
              const dom = dominantZone5(s.reps);
              return {
                label: s.date.slice(5), // "MM-DD"
                Fast: Math.round(auc.fast),
                Medium: Math.round(auc.medium),
                Slow: Math.round(auc.slow),
                total: Math.round(auc.total),
                n: s.reps.length,
                reps: s.reps,
                dom,
              };
            });
          if (sessions.length === 0) return null;
          const last = sessions[sessions.length - 1];
          const pct = (v) => last.total > 0 ? Math.round((v / last.total) * 100) : 0;
          // Build the last-session zone distribution (count of reps per ZONE5 bucket)
          const lastZoneCounts = ZONE5.map(z => ({
            ...z,
            count: last.reps.filter(r => classifyZone5(r.actual_time_s)?.key === z.key).length,
          }));
          const lastTotalReps = lastZoneCounts.reduce((s, z) => s + z.count, 0);
          return (
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Per-Compartment Dose (AUC)</div>
              <div style={{ fontSize: 11, color: C.muted, marginBottom: 12, lineHeight: 1.5 }}>
                Training dose delivered to each energy system per session. Dose = load × A<sub>i</sub> × τ<sub>Di</sub> · (1 − e<sup>−t/τ<sub>Di</sub></sup>).
                Units: kg·s.
              </div>
              <div style={{ height: 180 }}>
                <ResponsiveContainer>
                  <BarChart data={sessions} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke={C.border} strokeDasharray="3 3" />
                    <XAxis dataKey="label" stroke={C.muted} tick={{ fontSize: 10 }} />
                    <YAxis stroke={C.muted} tick={{ fontSize: 10 }} />
                    <Tooltip
                      contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12 }}
                      labelStyle={{ color: C.muted }}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="Fast"   stackId="a" fill="#e05560" />
                    <Bar dataKey="Medium" stackId="a" fill="#e07a30" />
                    <Bar dataKey="Slow"   stackId="a" fill="#3b82f6" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              {/* Last-session breakdown */}
              <div style={{
                display: "grid", gridTemplateColumns: "1fr 1fr 1fr",
                gap: 8, marginTop: 12, paddingTop: 10, borderTop: `1px solid ${C.border}`,
              }}>
                <div>
                  <div style={{ fontSize: 10, color: C.muted, letterSpacing: 0.5 }}>FAST · PCR</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: "#e05560" }}>{last.Fast}</div>
                  <div style={{ fontSize: 10, color: C.muted }}>{pct(last.Fast)}% · τ 15s</div>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: C.muted, letterSpacing: 0.5 }}>MEDIUM · GLYCO</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: "#e07a30" }}>{last.Medium}</div>
                  <div style={{ fontSize: 10, color: C.muted }}>{pct(last.Medium)}% · τ 90s</div>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: C.muted, letterSpacing: 0.5 }}>SLOW · OXID</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: "#3b82f6" }}>{last.Slow}</div>
                  <div style={{ fontSize: 10, color: C.muted }}>{pct(last.Slow)}% · τ 600s</div>
                </div>
              </div>
              <div style={{ fontSize: 11, color: C.muted, marginTop: 8, fontStyle: "italic" }}>
                Last session: {last.n} rep{last.n !== 1 ? "s" : ""}, {last.total} kg·s total dose.
                {last.dom && <> · landed in <span style={{ color: last.dom.color, fontWeight: 700, fontStyle: "normal" }}>{last.dom.label}</span></>}
              </div>

              {/* ── Last-session zone distribution (5-zone classifier) ── */}
              {lastTotalReps > 0 && (
                <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${C.border}` }}>
                  <div style={{ fontSize: 10, color: C.muted, letterSpacing: 0.5, marginBottom: 6, textTransform: "uppercase" }}>
                    Landed Zones · last session
                  </div>
                  <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", marginBottom: 6 }}>
                    {lastZoneCounts.map(z => z.count > 0 && (
                      <div
                        key={z.key}
                        title={`${z.label}: ${z.count} rep${z.count !== 1 ? "s" : ""}`}
                        style={{
                          flex: z.count,
                          background: z.color,
                        }}
                      />
                    ))}
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, fontSize: 10, color: C.muted }}>
                    {lastZoneCounts.filter(z => z.count > 0).map(z => (
                      <span key={z.key} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 2, background: z.color, display: "inline-block" }} />
                        {z.short} · {z.count}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </Card>
          );
        })()}

        {/* ── Energy system breakdown ── */}
        <EnergySystemBreakdownCard zones={zones} />

        {/* ── Unified training recommendation ──
            When no grip filter is active AND ≥2 grips have fits, render
            a separate card per grip so Micro (FDP) and Crusher (FDS)
            each get their own verdict — they are independent muscles
            with independent force-duration curves, so pooling hides
            the real story. Otherwise fall back to the single pooled /
            selGrip-scoped card with the limiter/coverage diagnostics. */}
        {(() => {
          // Helper — render per-zone gap bars. Replaces the old projected-ΔAUC
          // bars to match the gap-driven coaching engine: the recommended zone
          // is the one with the largest gap × intensity × recency × external,
          // and the bars show each zone's gap so the user sees the full
          // landscape of training opportunities, not just the winner.
          const renderGainsBars = (rec) => rec.zoneGaps && (
            <div style={{
              background: C.bg, borderRadius: 8, padding: "8px 10px",
              marginBottom: 10, fontSize: 11,
            }}>
              <div style={{ color: C.muted, letterSpacing: 0.4, textTransform: "uppercase", fontSize: 10, marginBottom: 6 }}>
                Per-zone reading
              </div>
              {(() => {
                // Find max absolute gap for bar scaling.
                // Sign convention: gap > 0 = under potential (room to grow,
                // training opportunity); gap < 0 = over potential (already
                // exceeding the model — a good state). We render both as
                // positive numbers with directional words ("room" / "ahead")
                // so the page never has unsigned-negative numbers in zone
                // colors that read as alarms when they actually mean wins.
                const maxAbs = Math.max(0.05, ...Object.values(rec.zoneGaps).filter(v => v != null).map(v => Math.abs(v)));
                return [
                  { k: "power",     lbl: "Power",    col: C.red },
                  { k: "strength",  lbl: "Strength", col: C.orange },
                  { k: "endurance", lbl: "Endurance", col: C.blue },
                ].map(r => {
                  const v = rec.zoneGaps[r.k];
                  const pct = v == null ? 0 : Math.min(100, Math.max(0, (Math.abs(v) / maxAbs) * 100));
                  const isBest = r.k === rec.key;
                  // Bar color: zone color for "room to grow" (action zone),
                  // green for "ahead of model" (already exceeding — good).
                  const barColor = v == null ? C.muted : (v >= 0 ? r.col : C.green);
                  // Label: "X% room" if under potential (training opportunity);
                  // "X% ahead" if over potential (outperforming the model).
                  const label = v == null ? "—"
                              : v >= 0 ? `${Math.round(v * 100)}% room`
                              : `${Math.round(Math.abs(v) * 100)}% ahead`;
                  const labelColor = v == null ? C.muted
                                   : v < 0 ? C.green
                                   : isBest ? r.col
                                   : C.muted;
                  return (
                    <div key={r.k} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <span style={{ width: 62, color: r.col, fontWeight: isBest ? 700 : 400 }}>
                        {r.lbl}
                      </span>
                      <div style={{ flex: 1, height: 6, background: C.border, borderRadius: 3, overflow: "hidden" }}>
                        <div style={{ height: "100%", width: `${pct}%`, background: barColor, borderRadius: 3, transition: "width 0.3s", opacity: v == null ? 0.4 : 1 }} />
                      </div>
                      <span style={{ width: 72, textAlign: "right", color: labelColor, fontWeight: isBest ? 700 : 400, fontSize: 10 }}>
                        {label}
                      </span>
                    </div>
                  );
                });
              })()}
              {rec.responseSource && (() => {
                const calibrated = Object.entries(rec.responseSource).filter(([, s]) => s.source === "blended");
                if (calibrated.length === 0) {
                  return (
                    <div style={{ fontSize: 10, color: C.muted, marginTop: 6, fontStyle: "italic" }}>
                      Using population prior. Response rates will calibrate to your own data after {PERSONAL_RESPONSE_MIN_SESSIONS}+ sessions per zone.
                    </div>
                  );
                }
                const labels = { power: "Power", strength: "Strength", endurance: "Endurance" };
                const parts = calibrated.map(([k, s]) => `${labels[k]} (${Math.round(s.n)})`).join(", ");
                return (
                  <div style={{ fontSize: 10, color: C.muted, marginTop: 6 }}>
                    <span style={{ color: C.green }}>●</span> Calibrated from your history: {parts}.
                    {calibrated.length < 3 && " Others still on prior."}
                  </div>
                );
              })()}
            </div>
          );

          // Per-grip split mode: one card per grip with its own verdict.
          // perGripMode triggers as soon as any grip has coaching data —
          // even a single grip gets its own coaching card rather than
          // falling through to the legacy ΔAUC engine in `recommendation`.
          // Eliminates the inconsistency where a user with only one grip
          // worth of data saw a Monod-driven recommendation while
          // multi-grip users saw the gap-driven coaching engine.
          const perGripMode = !selGrip && Object.keys(gripRecs).length >= 1;
          if (perGripMode) {
            return (
              <>
                {Object.values(gripRecs).map((rec, i, arr) => (
                  <Card key={rec.grip} style={{ marginBottom: 16, border: `1px solid ${rec.color}40` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                      <div style={{ fontSize: 11, color: rec.color, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                        Next Session Focus
                      </div>
                      <div style={{ fontSize: 11, color: C.muted, fontWeight: 600 }}>
                        {rec.grip}
                      </div>
                    </div>
                    <div style={{ fontSize: 22, fontWeight: 800, color: rec.color, marginBottom: 10 }}>
                      {rec.title}
                    </div>
                    <div style={{ fontSize: 13, color: C.text, marginBottom: 14, lineHeight: 1.6 }}>
                      {rec.rationale || `Largest gap to potential at ${GOAL_CONFIG[rec.key]?.label || rec.key} for ${rec.grip}.`}
                    </div>
                    {renderGainsBars(rec)}
                    <div style={{ fontSize: 10, color: C.muted, marginTop: 4 }}>
                      CF {fmtW(rec.CF, unit)} {unit} · W′ {fmtW(rec.W, unit)} {unit}·s · {rec.n} failure{rec.n !== 1 ? "s" : ""}
                    </div>
                    {/* Footnote on the LAST card only — points back at
                        Setup's Coaching prescription for the per-hand
                        breakdown. Same data, two scopes; clarifying
                        which is which keeps users from reading them as
                        competing recommendations. */}
                    {i === arr.length - 1 && (
                      <div style={{ fontSize: 11, color: C.muted, marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.border}` }}>
                        Per-grip summary · the Setup tab's <b>Coaching prescription</b> shows the per-hand reference loads.
                      </div>
                    )}
                  </Card>
                ))}
              </>
            );
          }

          // Single-card mode — pooled fit, or user has picked a specific
          // grip. Shows the full limiter/coverage diagnostics panel.
          if (!recommendation) {
            return (
              <Card style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.5 }}>
                  🔬 Train close to your limit in at least one time domain so the auto-failure system can record a failure point. That unlocks personalized training recommendations.
                </div>
              </Card>
            );
          }
          return (
            <Card style={{ marginBottom: 16, border: `1px solid ${recommendation.color}40` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                <div style={{ fontSize: 11, color: recommendation.color, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                  Next Session Focus
                </div>
                {selGrip && (
                  <div style={{ fontSize: 11, color: C.muted, fontWeight: 600 }}>{selGrip}</div>
                )}
              </div>
              <div style={{ fontSize: 22, fontWeight: 800, color: recommendation.color, marginBottom: 10 }}>
                {recommendation.title}
              </div>
              <div style={{ fontSize: 13, color: C.text, marginBottom: 14, lineHeight: 1.6 }}>
                {recommendation.rationale || recommendation.insight}
              </div>
              {renderGainsBars(recommendation)}
              {/* Secondary diagnostics */}
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {recommendation.limiterKey && recommendation.agree && (
                  <div style={{ fontSize: 11, color: C.muted, display: "flex", gap: 6, alignItems: "flex-start" }}>
                    <span style={{ color: C.green, fontWeight: 700, flexShrink: 0 }}>✓ Shape:</span>
                    <span>
                      Curve-shape diagnostic agrees — this zone also falls farthest below its own Monod curve
                      {recommendation.limiterGrip ? <> on <b>{recommendation.limiterGrip}</b></> : null}.
                    </span>
                  </div>
                )}
                {recommendation.limiterKey && !recommendation.agree && (
                  <div style={{ fontSize: 11, color: C.muted, display: "flex", gap: 6, alignItems: "flex-start" }}>
                    <span style={{ color: C.yellow, fontWeight: 700, flexShrink: 0 }}>⚡ Shape:</span>
                    <span>
                      Curve-shape diagnostic points elsewhere
                      {recommendation.limiterGrip ? <> (<b>{recommendation.limiterGrip}</b>)</> : null},
                      but AUC ranks this protocol as the biggest capacity win. Growing area dominates balancing shape.
                    </span>
                  </div>
                )}
                {recommendation.coverageKey && recommendation.coverageKey === recommendation.key && (
                  <div style={{ fontSize: 11, color: C.muted, display: "flex", gap: 6, alignItems: "flex-start" }}>
                    <span style={{ color: C.green, fontWeight: 700, flexShrink: 0 }}>✓ Coverage:</span>
                    <span>Session count agrees — this is also your least-trained zone in the last 30 days.</span>
                  </div>
                )}
              </div>
            </Card>
          );
        })()}

        {/* Unexplored zones notice */}
        {unexplored.length > 0 && (
          <Card style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, color: C.yellow, marginBottom: 6 }}>
              📍 Unexplored: <b>{unexplored.join(", ")}</b>
            </div>
            <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
              Data from {unexplored.join(" and ").toLowerCase()} hangs would complete your profile and reveal hidden limiters. A single session to failure in each zone is enough to start.
            </div>
          </Card>
        )}

      </>)}
    </div>
  );
}
