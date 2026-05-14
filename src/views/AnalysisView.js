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
import {
  getZoneStaleness, getRollingSessionPace,
  ANNUAL_SESSION_GOAL, LOCKOUT_WINDOW_DAYS,
} from "../model/lockout.js";
import { PrescribedLoadCard } from "./cards/PrescribedLoadCard.js";
// (computePersonalResponse import removed — fed the now-gone Train block)
import { computeLimiterZone } from "../model/limiter.js";
import { OneRMPRCard } from "./analysis/OneRMPRCard.js";
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

// ─────────────────────────────────────────────────────────────
// CURVE COVERAGE CARD — per-zone data freshness + annual session pace
// ─────────────────────────────────────────────────────────────
// Moved from SetupView (May 2026) — it's a per-zone reference view
// belonging to Analysis alongside the F-D chart and PrescribedLoadCard.
// Under the curve-trust philosophy, this card surfaces where the curve
// has fresh data vs where it's extrapolating from old measurements.
// Stale zones get score-boosted in the coaching engine; never-trained
// zones tell you the curve can't be trusted there at all.
function CurveCoverageCard({ history }) {
  const staleness = useMemo(() => getZoneStaleness(history), [history]);
  const pace = useMemo(() => getRollingSessionPace(history), [history]);

  if (pace.current === 0) return null;

  const STATUS_ORDER = { stale: 0, warning: 1, never: 2, ok: 3 };
  const STATUS_LABEL = {
    stale:   { color: C.red,    text: "stale"   },
    warning: { color: C.orange, text: "soon"    },
    never:   { color: C.muted,  text: "never"   },
    ok:      { color: C.green,  text: "fresh"   },
  };
  const sortedZones = [...ZONE_KEYS].sort((a, b) => {
    const sa = STATUS_ORDER[staleness[a].status];
    const sb = STATUS_ORDER[staleness[b].status];
    if (sa !== sb) return sa - sb;
    return ZONE_KEYS.indexOf(a) - ZONE_KEYS.indexOf(b);
  });

  const counts = sortedZones.reduce((acc, k) => {
    acc[staleness[k].status] = (acc[staleness[k].status] || 0) + 1;
    return acc;
  }, {});
  const staleCount   = counts.stale   || 0;
  const warningCount = counts.warning || 0;
  const neverCount   = counts.never   || 0;

  // Pace = projection over the next 365 days at the current rate. For
  // mature users (≥1 year of history) this equals `pace.current` and
  // the second line is just confirmation; for newer users it's the
  // extrapolated forecast. Hide the projection line when the two
  // numbers match to avoid the redundant "26 of 100 next 12 months"
  // restating "26 / 100 last 12 months."
  const onPace      = pace.paceYearEnd >= ANNUAL_SESSION_GOAL;
  const paceColor   = onPace ? C.green
                    : pace.paceYearEnd >= ANNUAL_SESSION_GOAL * 0.8 ? C.orange
                    : C.red;
  const showPaceLine = pace.paceYearEnd !== pace.current;

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>Curve Coverage</div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
            Where your data is fresh
          </div>
        </div>
        <div style={{ fontSize: 11, color: C.muted, textAlign: "right" }}>
          <div>
            <b style={{ color: showPaceLine ? C.text : paceColor }}>
              {pace.current}
            </b>
            {" / "}{ANNUAL_SESSION_GOAL} last 12 months
          </div>
          {showPaceLine && (
            <div style={{ color: paceColor, marginTop: 2 }}>
              on pace for {pace.paceYearEnd} next 12 months
            </div>
          )}
        </div>
      </div>

      {(staleCount > 0 || warningCount > 0 || neverCount > 0) && (
        <div style={{
          padding: "8px 10px", marginBottom: 12,
          background: C.bg, borderRadius: 8,
          border: `1px solid ${staleCount > 0 ? C.red : warningCount > 0 ? C.orange : C.border}40`,
          fontSize: 11, color: C.muted, lineHeight: 1.5,
        }}>
          {staleCount > 0 && (
            <div>
              <span style={{ color: C.red, fontWeight: 700 }}>● {staleCount} stale data</span>
              {warningCount > 0 || neverCount > 0 ? " · " : ""}
            </div>
          )}
          {warningCount > 0 && (
            <div>
              <span style={{ color: C.orange, fontWeight: 700 }}>● {warningCount} aging</span>
              {neverCount > 0 ? " · " : ""}
            </div>
          )}
          {neverCount > 0 && (
            <div>
              <span style={{ color: C.muted, fontWeight: 700 }}>● {neverCount} never sampled</span>
            </div>
          )}
          <div style={{ marginTop: 4, fontStyle: "italic" }}>
            The curve extrapolates where data is stale or missing. The engine prioritizes those durations to keep the fit honest.
          </div>
        </div>
      )}

      <div>
        {sortedZones.map(k => {
          const s = staleness[k];
          const cfg = STATUS_LABEL[s.status];
          const window = LOCKOUT_WINDOW_DAYS[k];
          const daysText = s.days == null
            ? "never sampled"
            : s.days === 0
              ? "today"
              : s.days === 1
                ? "1 day ago"
                : `${s.days} days ago`;
          return (
            <div key={k} style={{
              display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: "6px 0",
              borderBottom: `1px solid ${C.border}`,
            }}>
              <div style={{ fontSize: 12, color: C.text }}>
                {k.replace(/_/g, " · ").replace(/\b\w/g, c => c.toUpperCase())}
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={{ fontSize: 11, color: C.muted, fontVariantNumeric: "tabular-nums" }}>
                  {daysText}
                </span>
                <span style={{
                  fontSize: 9, fontWeight: 700, color: cfg.color,
                  background: `${cfg.color}1a`,
                  padding: "2px 6px", borderRadius: 4,
                  textTransform: "uppercase", letterSpacing: 0.5,
                  whiteSpace: "nowrap",
                }}>
                  {cfg.text} · {window}d
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export function AnalysisView({
  history, unit = "lbs", bodyWeight = null,
  activities = [],
  freshMap = null,
  // Per-zone learned fatigue gains (App-level memo). Passed through
  // to PrescribedLoadCard so the analysis what-if slider reflects the
  // same calibration the live workout will use.
  personalGains = null,
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

  // Per-grip three-exp priors. Used by the gap-narrowing tracker and
  // the prescription-potential calculation (since three-exp is now the
  // primary potential value when well-supported). Same memo as in
  // SetupView; could be lifted to App if it becomes hot.
  const threeExpPriors = useMemo(() => buildThreeExpPriors(history), [history]);

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
  // Why averaged: the pooled-fit approach inflates the displayed
  // delta because shrinkage relaxes asymmetrically between the
  // small-N baseline and larger-N current — both push higher than
  // per-hand fits but by different amounts, producing numbers that
  // look like Right + Left instead of an honest average. Averaging
  // is the user's intuitive reading and stays internally consistent
  // with the per-hand cells. Same fix applied to the single-grip
  // scopedImp branch in the render below.
  const gripImprovement = useMemo(() => {
    const out = {};
    for (const grip of Object.keys(grip3xEstimates)) {
      const lBase = perHandGripBaselines[`${grip}|L`];
      const rBase = perHandGripBaselines[`${grip}|R`];
      const pooledRef = gripBaselines[grip];
      if (lBase && rBase) {
        // Train-to-failure model: every rep with valid actual_time_s is
        // a (T, F) data point. Drop the legacy r.failed filter.
        const buildHandPts = (hand) => history
          .filter(r => r.grip === grip && r.hand === hand)
          .filter(r => r.avg_force_kg > 0 && r.avg_force_kg < 500 && r.actual_time_s > 0)
          .map(r => ({ T: r.actual_time_s, F: r.avg_force_kg }));
        const lAmps = fitAmpsForPts(buildHandPts("L"), grip);
        const rAmps = fitAmpsForPts(buildHandPts("R"), grip);
        const lImp = lAmps ? improvementForAmps(lAmps, lBase.amps) : null;
        const rImp = rAmps ? improvementForAmps(rAmps, rBase.amps) : null;
        if (lImp && rImp) {
          const since = lBase.date < rBase.date ? lBase.date : rBase.date;
          // Average per-hand Δ% per zone — works for any number of zones
          // since improvementForAmps now returns one key per ZONE_KEY.
          const avg = { baselineDate: since };
          for (const k of [...ZONE_KEYS, "total"]) {
            avg[k] = Math.round((lImp[k] + rImp[k]) / 2);
          }
          out[grip] = avg;
          continue;
        }
      }
      // Fallback: pooled-fit comparison when per-hand baselines aren't
      // ready yet on at least one side of this grip.
      if (pooledRef) {
        const imp = improvementForAmps(grip3xEstimates[grip], pooledRef.amps);
        if (imp) out[grip] = { ...imp, baselineDate: pooledRef.date };
      }
    }
    return out;
  }, [gripBaselines, perHandGripBaselines, grip3xEstimates, history]); // eslint-disable-line react-hooks/exhaustive-deps

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
        aRow[`${g}_abs`]   = v ? v.abs   : null;
        pRow[`${g}_pct`]   = v ? v.pct   : null;
        pBwRow[`${g}_pct`] = v ? v.pctBW : null;
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
                {!splitMode && threeExpCurveDataRel.length > 0 && <span title="Three-exp model: governing F-D curve. Phenomenological sum of three exponentials with depletion-tau basis; the fast / middle / slow components approximately align with PCr / glycolytic / oxidative timescales but are not direct tissue measurements."><span style={{ color: curveColor }}>―</span> F-D curve (3-exp)</span>}
                {!splitMode && threeExpRef180 != null && <span title="Three-exp prediction at T=180s — the slow component dominates here, broadly aligned with sustainable / oxidative-driven work in the climbing literature. The closest model analog to a 'sustainable force' reference."><span style={{ color: curveColor }}>╌</span> 3-min sustainable</span>}
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
                  curve-fit component dominates; this is the closest
                  model analog to "what you can sustain", broadly
                  aligned with sustainable / oxidative-driven force in
                  the climbing-physiology literature. */}
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
                <Scatter data={leftDotsRel} dataKey="y" fill={HAND_COLORS.L} opacity={0.9} name="Left" />
              )}
              {!fdSplitData && (
                <Scatter data={rightDotsRel} dataKey="y" fill={HAND_COLORS.R} opacity={0.9} name="Right" />
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
                  });
                  const lDots = gripReps.filter(r => r.hand !== "R").map(toDot);
                  const rDots = gripReps.filter(r => r.hand === "R").map(toDot);
                  elements.push(
                    <Scatter key={`${grip}-L`} data={lDots} dataKey="y"
                      fill={HAND_COLORS.L} stroke={color} strokeWidth={1.5} opacity={0.9} />
                  );
                  elements.push(
                    <Scatter key={`${grip}-R`} data={rDots} dataKey="y"
                      fill={HAND_COLORS.R} stroke={color} strokeWidth={1.5} opacity={0.9} />
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
              middle components). */}
          {handAsymmetry.length > 0 && (
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

        {/* Prescribed Load — tabular sibling of the F-D chart. Six zones,
            both hands, anchored to most recent rep 1. Highlights the zone
            the continuous engine would currently pick. Renders when a
            grip is selected — without one, the prescription is meaningless
            (cross-grip pooled fits aren't a thing). */}
        {selGrip && (
          <PrescribedLoadCard
            history={history}
            grip={selGrip}
            freshMap={freshMap}
            threeExpPriors={threeExpPriors}
            activities={activities}
            personalGains={personalGains}
            unit={unit}
            GOAL_CONFIG={GOAL_CONFIG}
          />
        )}

        {/* Curve Coverage — per-zone data freshness + annual pace.
            Moved here from Setup so both per-zone reference cards
            (prescribed load + freshness) live together. */}
        <CurveCoverageCard history={history} />
      </>)}

      {/* ── 1RM PR tracker ── */}
      <OneRMPRCard activities={activities} rmGrips={RM_GRIPS} unit={unit} />

      {/* ── Total Capacity (Area Under the Curve) over time — % vs baseline ──
          Headline trajectory card: single-number capacity tracker per grip
          showing ∫ F(t) dt over [5,180]s under the three-exp curve refit
          each training date, expressed as % above each grip's baseline.
          Lives at the top because the trajectory is the whole-page story
          ("am I growing?") in one rising-line visual. Per-grip lines,
          never pooled. Same integration window the Journey badges use,
          so chart progress and badge progress read the same metric. The
          absolute (kg·s) view of the same metric lives in the Advanced
          metrics section at the bottom. */}
      {aucHistoryByGrip && aucHistoryByGrip.hasPct && (
        <Card style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>
            Total Capacity (Area Under the Curve) — % vs baseline
            {normalizeOn && <span style={{ color: C.purple, fontSize: 12, marginLeft: 6 }}>· × BW</span>}
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>
            {normalizeOn
              ? "Same metric, normalized to bodyweight at each session date. Rising lines mean your CLIMBING-relevant capacity is growing — strength gains that come with matching weight gains flatten here."
              : "Same metric as a percentage above each grip's baseline. Rising lines mean your overall curve is growing — the cleanest single-number progress signal you have."}
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={normalizeOn ? aucHistoryByGrip.pctRowsBW : aucHistoryByGrip.pctRows} margin={{ top: 6, right: 14, bottom: 28, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
              <XAxis dataKey="date" tick={{ fill: C.muted, fontSize: 9 }} angle={-30} textAnchor="end" interval="preserveStartEnd"
                label={{ value: "Date", position: "insideBottom", offset: -18, fill: C.muted, fontSize: 11 }} />
              <ReferenceLine y={0} stroke={C.muted} strokeWidth={2}
                label={{ value: "baseline", position: "insideRight", fill: C.muted, fontSize: 10 }} />
              <YAxis tick={{ fill: C.muted, fontSize: 11 }} width={48} unit="%"
                label={{ value: "vs baseline", angle: -90, position: "insideLeft", fill: C.muted, fontSize: 11 }} />
              <Tooltip
                contentStyle={{ background: C.card, border: `1px solid ${C.border}`, fontSize: 12 }}
                formatter={(val, name) => [val == null ? "—" : `${val >= 0 ? "+" : ""}${val}%`, name]}
              />
              {aucHistoryByGrip.grips.map(g => (
                <Line key={g} dataKey={`${g}_pct`} stroke={GRIP_COLORS[g] || C.blue}
                  strokeWidth={2} dot={{ r: 3 }} connectNulls name={g} />
              ))}
            </LineChart>
          </ResponsiveContainer>
          <div style={{ display: "flex", justifyContent: "space-around", marginTop: 4, fontSize: 10, color: C.muted }}>
            {aucHistoryByGrip.grips.map(g => (
              <span key={g} style={{ color: GRIP_COLORS[g] || C.blue }}>━ {g}</span>
            ))}
          </div>
        </Card>
      )}

      {/* ── Curve Improvement summary ──
          (Was "Endurance Improvement" — renamed because the headline
          isn't endurance, it's the average of three F-D curve point
          improvements at ZONE_REF_T's power/strength/endurance times
          — currently 7s / 45s / 120s. The blue Endurance cell is the
          one true endurance signal; Power and Strength are the other
          two reference points on the same curve.)
          Now sits BELOW the Area Under the Curve trajectory because
          this card is the per-zone breakdown that answers "where are
          the gains coming from?" once the trajectory has hooked you.
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
            // Train-to-failure model: every rep with valid actual_time_s
            // is a (T, F) data point. Drop the legacy r.failed filter.
            const buildHandPts = (hand) => history
              .filter(r => r.grip === selGrip && r.hand === hand)
              .filter(r => r.avg_force_kg > 0 && r.avg_force_kg < 500 && r.actual_time_s > 0)
              .map(r => ({ T: r.actual_time_s, F: r.avg_force_kg }));
            const lAmps = fitAmpsForPts(buildHandPts("L"), selGrip);
            const rAmps = fitAmpsForPts(buildHandPts("R"), selGrip);
            const lImp = lAmps ? improvementForAmps(lAmps, lBase.amps) : null;
            const rImp = rAmps ? improvementForAmps(rAmps, rBase.amps) : null;
            if (lImp && rImp) {
              // Average per-hand Δ% per zone — works for any number of
              // zones since improvementForAmps returns one key per
              // ZONE_KEY.
              scopedImp = {};
              for (const k of [...ZONE_KEYS, "total"]) {
                scopedImp[k] = Math.round((lImp[k] + rImp[k]) / 2);
              }
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

      {reps.length === 0 ? (
        <Card>
          <div style={{ textAlign: "center", padding: "32px 0", color: C.muted }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📊</div>
            <div>No session data yet for this selection.</div>
            <div style={{ fontSize: 12, marginTop: 8 }}>Run a few sessions on this grip / hand to start building a force-duration curve.</div>
          </div>
        </Card>
      ) : (<>

        {/* (Critical Force Estimate, Climbing Endurance chart, and
            Train block — Next Session Focus per-grip cards — all
            removed under the three-exp / curve-trust direction. The
            Setup tab's ContinuousPickCard is the prescription surface;
            Analysis stays focused on diagnostics: F-D chart, AUC over
            time, Curve Improvement, Hand Asymmetry. The "sustainable
            force ceiling" the old CF card showed isn't lost — the
            F-D chart's dashed "3-min" reference lines show F(180s)
            per grip from the three-exp curve.) */}

        {/* ── Total Capacity (AUC) — absolute (kg·s) ──
            Same metric as the % vs baseline chart at the top of the
            page, but in raw physical units. Useful when you want to
            sanity-check the headline % against the underlying area.
            The "Advanced Metrics" section divider that used to wrap
            this card was removed once the per-compartment dose + energy
            system breakdown cards were dropped — with only one card
            left below it, the divider was overhead for nothing. */}
        {aucHistoryByGrip && (
          <Card style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Total Capacity (Area Under the Curve) — absolute</div>
            <div style={{ fontSize: 12, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>
              Total area under your three-exp F-D curve from 5s to 3 min, per grip. Higher = bigger total work envelope. Each point refits the curve with data up to that date — early points stabilize as the data stack grows.
            </div>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={aucHistoryByGrip.absRows} margin={{ top: 6, right: 14, bottom: 28, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis dataKey="date" tick={{ fill: C.muted, fontSize: 9 }} angle={-30} textAnchor="end" interval="preserveStartEnd"
                  label={{ value: "Date", position: "insideBottom", offset: -18, fill: C.muted, fontSize: 11 }} />
                <YAxis tick={{ fill: C.muted, fontSize: 11 }} width={48}
                  label={{ value: "kg·s", angle: -90, position: "insideLeft", fill: C.muted, fontSize: 11 }} />
                <Tooltip
                  contentStyle={{ background: C.card, border: `1px solid ${C.border}`, fontSize: 12 }}
                  formatter={(val, name) => [val == null ? "—" : `${val.toLocaleString()} kg·s`, name]}
                />
                {aucHistoryByGrip.grips.map(g => (
                  <Line key={g} dataKey={`${g}_abs`} stroke={GRIP_COLORS[g] || C.blue}
                    strokeWidth={2} dot={{ r: 3 }} connectNulls name={g} />
                ))}
              </LineChart>
            </ResponsiveContainer>
            <div style={{ display: "flex", justifyContent: "space-around", marginTop: 4, fontSize: 10, color: C.muted }}>
              {aucHistoryByGrip.grips.map(g => (
                <span key={g} style={{ color: GRIP_COLORS[g] || C.blue }}>━ {g}</span>
              ))}
            </div>
          </Card>
        )}

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
