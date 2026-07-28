// ─────────────────────────────────────────────────────────────
// CurveImprovementCard — per-grip Δ% + force-curve overlay + slider
// ─────────────────────────────────────────────────────────────
// One card, one block per grip. Each grip block shows:
//   • header: grip name + "since <baselineDate>"
//   • total Δ% + six clickable zone tiles (Max … End)
//   • the baseline (dashed) vs Now (solid) force curve
//   • a "Now" slider over that grip's post-baseline session dates
//   • a zone-history modal comparing every matching workout
//
// The slider drives BOTH the curve AND the tiles: scrubbing recomputes
// every zone Δ% and the total for the selected date, so there's a single
// set of numbers (no separate per-T delta strip) and you can walk the
// progression forward in time. Both grips are always shown — no pills,
// no pooled/per-hand toggle. The fit is the pooled (L+R) per-grip three-
// exp, the same one the headline % uses, so the curve and tiles agree.
// The page-level grip scope can narrow this to one block.
//
// (Merged May 2026: absorbed the standalone "Force Curves — vs baseline"
// card. Curve sampling, the fixed y-axis, and the slider all live here
// now; useHistoryOverlay still supplies the per-grip baseline + the
// cumulative ampsByDate map this reads.)
//
// Modes preserved:
//   • perGripMode (no filter, ≥2 grips) — a block per grip with overlay.
//   • selGrip — that grip's block (or an early-days placeholder).
//   • pooled fallback — static total + tiles (no overlay/slider).

import React, { useMemo, useState } from "react";
import {
  ResponsiveContainer, LineChart, Line,
  XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
import { C } from "../../ui/theme.js";
import { Card } from "../../ui/components.js";
import { GRIP_COLORS } from "../../ui/grip-colors.js";
import { bwOnDate, fmt1, toDisp } from "../../ui/format.js";
import { ZONE6, ZONE_REF_T } from "../../model/zones.js";
import {
  buildGripImprovement,
  improvementForAmps,
  SUPPORT_MIN_HOLD_FRAC,
  perZoneBaselineAmps,
  gripBaselineProgress,
  GRIP_BASELINE_REP_THRESHOLD,
  GRIP_BASELINE_DURATION_THRESHOLD,
} from "../../model/baselines.js";
import { predForceThreeExp } from "../../model/threeExp.js";
import { effectiveLoad } from "../../model/load.js";
import { ZoneSessionHistoryModal } from "./ZoneSessionHistoryModal.jsx";

const scaleAmps = (amps, bw) =>
  Array.isArray(amps) && bw > 0 ? amps.map(value => value / bw) : amps;

function latestDateForKey(history, key) {
  const [grip, hand] = key.split("|");
  let latest = null;
  for (const rep of history || []) {
    if (rep?.grip !== grip || (hand && rep?.hand !== hand) || !rep?.date) continue;
    if (!(effectiveLoad(rep) > 0) || !(rep.actual_time_s > 0)) continue;
    if (latest == null || rep.date > latest) latest = rep.date;
  }
  return latest;
}

function normalizeBaselineMap(baselines, bwForDate) {
  return Object.fromEntries(Object.entries(baselines || {}).map(([key, baseline]) => [
    key,
    {
      ...baseline,
      amps: scaleAmps(baseline?.amps, bwForDate(baseline?.date)),
    },
  ]));
}

function normalizeEstimateMap(estimates, history, bwForDate) {
  return Object.fromEntries(Object.entries(estimates || {}).map(([key, amps]) => [
    key,
    scaleAmps(amps, bwForDate(latestDateForKey(history, key))),
  ]));
}

function normalizeHistoryOverlay(historyOverlay, bwForDate) {
  const out = {};
  for (const [grip, overlay] of Object.entries(historyOverlay || {})) {
    const normalizeBranch = branch => {
      if (!branch) return branch;
      return {
        ...branch,
        baselineAmps: scaleAmps(branch.baselineAmps, bwForDate(branch.baselineDate)),
        ampsByDate: new Map(
          [...(branch.ampsByDate || new Map()).entries()].map(([date, amps]) => [
            date,
            scaleAmps(amps, bwForDate(date)),
          ])
        ),
      };
    };
    out[grip] = {
      ...normalizeBranch(overlay),
      perHand: Object.fromEntries(
        Object.entries(overlay.perHand || {}).map(([hand, branch]) => [
          hand,
          normalizeBranch(branch),
        ])
      ),
    };
  }
  return out;
}

function BaselineProgressRow({ grip, history, hand = null, divider = false }) {
  const progress = gripBaselineProgress(history, grip, hand);
  return (
    <div style={{
      paddingTop: divider ? 12 : 0,
      marginTop: divider ? 12 : 0,
      borderTop: divider ? `1px solid ${C.border}` : "none",
      fontSize: 11,
      color: C.muted,
      lineHeight: 1.5,
    }}>
      <b style={{ color: GRIP_COLORS[grip] || C.text }}>{grip}</b>
      <span>{" — building baseline · "}</span>
      <span style={{
        color: progress.qualifyingReps >= GRIP_BASELINE_REP_THRESHOLD ? C.green : C.text,
      }}>
        {Math.min(progress.qualifyingReps, GRIP_BASELINE_REP_THRESHOLD)}
        {" of "}
        {GRIP_BASELINE_REP_THRESHOLD}
        {" fresh reps"}
      </span>
      <span>{" · "}</span>
      <span style={{
        color: progress.distinctDurations >= GRIP_BASELINE_DURATION_THRESHOLD ? C.green : C.text,
      }}>
        {Math.min(progress.distinctDurations, GRIP_BASELINE_DURATION_THRESHOLD)}
        {" of "}
        {GRIP_BASELINE_DURATION_THRESHOLD}
        {" target durations"}
      </span>
    </div>
  );
}

// One-line explainer under the header.
function BasisNote() {
  return (
    <div style={{ fontSize: 11, color: C.muted, marginBottom: 12, lineHeight: 1.4 }}>
      What your reps actually showed — sessions trained deep in fatigue count at the loads you actually held, so hard training weeks can dip.
    </div>
  );
}

// Static per-grip block: header (grip + since date) + tiles. The
// fallback shape for grips without an interactive overlay.
function StaticGripTiles({
  grip,
  imp,
  divider,
  onZoneSelect = null,
  selectedZoneKey = null,
}) {
  return (
    <div style={{
      paddingBottom: divider ? 14 : 0,
      borderBottom: divider ? `1px solid ${C.border}` : "none",
      marginBottom: divider ? 14 : 0,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: GRIP_COLORS[grip] || C.blue }}>{grip}</div>
        <div style={{ fontSize: 11, color: C.muted }}>since {imp.baselineDate}</div>
      </div>
      <ImprovementRow
        label={null}
        imp={imp}
        onZoneSelect={onZoneSelect ? zoneKey => onZoneSelect(grip, zoneKey, null) : null}
        selectedZoneKey={selectedZoneKey}
      />
    </div>
  );
}

// Total Δ% + the six zone tiles. Shared by every render path.
function ImprovementRow({
  label,
  imp,
  onZoneSelect = null,
  selectedZoneKey = null,
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
        {label && (
          <div style={{ fontSize: 12, fontWeight: 700, color: C.text }}>{label}</div>
        )}
        <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginLeft: "auto" }}>
          <div style={{ fontSize: 26, fontWeight: 900, color: (imp.total ?? 0) >= 0 ? C.green : C.red, lineHeight: 1 }}>
            {imp.total == null ? "—" : `${imp.total >= 0 ? "+" : ""}${imp.total}%`}
          </div>
          <div style={{ fontSize: 11, color: C.muted }}>total</div>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
        {ZONE6.map(z => {
          const val = imp[z.key];
          // val === null → this zone's reference duration is past what the
          // baseline actually measured (extrapolated), so there's no honest
          // starting point to compare against. Show it as "new", muted, and
          // it's already excluded from the total.
          const unbaselined = val == null;
          const selected = selectedZoneKey === z.key;
          const content = (
            <>
              <div style={{ fontSize: 9, color: C.muted, marginBottom: 3 }}>{z.short}</div>
              {unbaselined ? (
                <div style={{ fontSize: 12, fontWeight: 700, color: C.muted }}>new</div>
              ) : (
                <div style={{ fontSize: 16, fontWeight: 800, color: val >= 0 ? z.color : C.red }}>
                  {val >= 0 ? "+" : ""}{val}%
                </div>
              )}
            </>
          );
          const style = {
            width: "100%",
            minHeight: 51,
            background: selected ? `${z.color}18` : C.bg,
            borderRadius: 8,
            padding: "8px 6px",
            textAlign: "center",
            border: `1px solid ${selected ? z.color : `${z.color}30`}`,
            opacity: unbaselined ? 0.5 : 1,
            boxSizing: "border-box",
          };
          const title = unbaselined
            ? "No baseline data — this zone wasn't trained when your baseline was set"
            : `${z.label} session history`;

          return onZoneSelect ? (
            <button
              key={z.key}
              type="button"
              onClick={() => onZoneSelect(z.key)}
              aria-label={`${z.label} session history`}
              aria-pressed={selected}
              title={title}
              style={{
                ...style,
                color: C.text,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {content}
            </button>
          ) : (
            <div key={z.key} title={title} style={style}>{content}</div>
          );
        })}
      </div>
    </div>
  );
}

// Gate the pooled global-fallback improvement to the baseline's real reach.
// The per-grip paths pass baselineMaxHoldS into improvementForAmps, but the
// pooled `improvement` prop (AnalysisView) is computed WITHOUT it, so its
// long zones would show extrapolated deltas instead of "new". Post-gate here
// with the pooled baseline's maxHoldS: null out any zone whose refT is past
// the baseline's real reach, then recompute the total over the supported
// zones only. A zone's % IS the cur/ref force ratio at its refT, and
// geomean(aᵢ/bᵢ) = geomean(aᵢ)/geomean(bᵢ), so the balanced total is the
// geomean of (1 + zonePct) over the supported zones — identical to what
// improvementForAmps would return with the maxHoldS gate applied.
function gateGlobalImprovement(imp, maxHoldS) {
  if (!imp || maxHoldS == null) return imp;
  const out = { ...imp };
  const supportedPcts = [];
  for (const z of ZONE6) {
    const refT = ZONE_REF_T[z.key];
    if (maxHoldS < refT * SUPPORT_MIN_HOLD_FRAC) {
      out[z.key] = null;
    } else if (typeof imp[z.key] === "number") {
      supportedPcts.push(imp[z.key]);
    }
  }
  if (supportedPcts.length === 0) { out.total = null; return out; }
  const gm = Math.exp(
    supportedPcts.reduce((sum, p) => sum + Math.log(1 + p / 100), 0) / supportedPcts.length
  );
  out.total = Math.round((gm - 1) * 100);
  return out;
}

// Baseline vs Now force-curve chart with a FIXED y-axis (sized once from
// the tallest curve any slider position can draw, so scrubbing doesn't
// rescale the axis). tMin..tMax sampled at 80 points.
function OverlayChart({
  baselineAmps,
  nowAmps,
  candidateAmps,
  unit,
  normalizeOn,
  maxDur,
  color,
  baselineDate,
  nowDate,
}) {
  const tMin = 5;
  const tMax = Math.max(180, maxDur || 0);
  const displayForce = force => normalizeOn ? force : toDisp(force, unit);
  const displayUnit = normalizeOn ? "× BW" : unit;
  const axisStep = normalizeOn ? 0.1 : 10;
  const samples = [];
  for (let i = 0; i < 80; i++) {
    const t = tMin + ((tMax - tMin) / 79) * i;
    samples.push({
      x: t,
      past: baselineAmps ? displayForce(Math.max(predForceThreeExp(baselineAmps, t), 0)) : null,
      now:  nowAmps      ? displayForce(Math.max(predForceThreeExp(nowAmps, t), 0))      : null,
    });
  }
  const yPeak = candidateAmps.reduce(
    (m, a) => Math.max(m, displayForce(Math.max(predForceThreeExp(a, tMin), 0))),
    normalizeOn ? 0.1 : 1
  );
  const yDomain = [0, Math.ceil(yPeak * 1.1 / axisStep) * axisStep];

  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={samples} margin={{ top: 6, right: 14, bottom: 26, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
        <XAxis type="number" dataKey="x" domain={[tMin, tMax]}
          tick={{ fill: C.muted, fontSize: 11 }}
          label={{ value: "Duration (s)", position: "insideBottom", offset: -14, fill: C.muted, fontSize: 11 }}
        />
        <YAxis
          domain={yDomain}
          tick={{ fill: C.muted, fontSize: 11 }}
          width={44}
          unit={normalizeOn ? "" : ` ${unit}`}
        />
        <Tooltip
          contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }}
          formatter={(val, name) => [
            val == null
              ? "—"
              : `${normalizeOn ? Number(val).toFixed(2) : fmt1(val)} ${displayUnit}`,
            name,
          ]}
          labelFormatter={(t) => `${fmt1(t)}s`}
        />
        <Line dataKey="past" stroke={C.muted} strokeWidth={2} strokeDasharray="6 4"
          dot={false} connectNulls name={`Baseline (${baselineDate})`} isAnimationActive={false} />
        <Line dataKey="now" stroke={color} strokeWidth={3}
          dot={false} connectNulls name={`Now (${nowDate})`} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

// One grip's full block: header, tiles (at slider date), curve, slider.
function GripBlock({
  grip,
  overlay,
  unit,
  normalizeOn,
  maxDur,
  nowIdx,
  onScrub,
  divider,
  onZoneSelect = null,
  selectedZoneKey = null,
}) {
  const dates = overlay.dates;
  const last = Math.max(0, dates.length - 1);
  const idx = nowIdx == null ? last : Math.max(0, Math.min(last, nowIdx));
  const nowDate = dates[idx];
  const nowAmps = overlay.ampsByDate.get(nowDate);
  const color = GRIP_COLORS[grip] || C.blue;

  // Per-zone baselines fill the long-hold "new" tiles once trained:
  // each such zone is measured from the first date its data reached that
  // duration, not the pooled baseline (which never got there).
  const zoneRef = perZoneBaselineAmps(
    overlay.dates, overlay.ampsByDate, overlay.maxHoldByDate, overlay.baselineMaxHoldS ?? null,
  );
  const imp = nowAmps
    ? improvementForAmps(nowAmps, overlay.baselineAmps, overlay.baselineMaxHoldS ?? null, zoneRef)
    : null;

  // Every drawable curve for this grip — for the fixed y-axis.
  const candidateAmps = [overlay.baselineAmps, ...overlay.ampsByDate.values()].filter(Boolean);

  return (
    <div style={{
      paddingBottom: divider ? 14 : 0,
      borderBottom: divider ? `1px solid ${C.border}` : "none",
      marginBottom: divider ? 14 : 0,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color }}>{grip}</div>
        <div style={{ fontSize: 11, color: C.muted }}>since {overlay.baselineDate}</div>
      </div>

      {imp && (
        <ImprovementRow
          label={null}
          imp={imp}
          onZoneSelect={onZoneSelect
            ? zoneKey => onZoneSelect(grip, zoneKey, nowDate)
            : null}
          selectedZoneKey={selectedZoneKey}
        />
      )}

      <OverlayChart
        baselineAmps={overlay.baselineAmps}
        nowAmps={nowAmps}
        candidateAmps={candidateAmps}
        unit={unit}
        normalizeOn={normalizeOn}
        maxDur={maxDur}
        color={color}
        baselineDate={overlay.baselineDate}
        nowDate={nowDate}
      />

      {/* Now slider — scrub the comparison date; tiles + curve follow.
          BELOW the chart (June 2026): the scrubbing thumb sits under
          the user's finger, and with the slider above, that hand
          covered exactly the curve they were trying to watch move. */}
      <div style={{ margin: "8px 0 0" }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color, marginBottom: 4 }}>
          <span>Now: <b>{nowDate}</b></span>
          <span style={{ color: C.muted }}>{idx + 1} of {dates.length} session{dates.length === 1 ? "" : "s"} since baseline</span>
        </div>
        <input type="range" min={0} max={last} step={1} value={idx}
          onChange={(e) => onScrub(grip, parseInt(e.target.value, 10))}
          style={{ width: "100%", accentColor: color, cursor: "pointer" }}
        />
      </div>
    </div>
  );
}

export function CurveImprovementCard({
  improvement,
  gripImprovement,
  grip3xEstimates,
  gripBaselines,
  global3xBaseline,
  selGrip,
  grips = [],
  history,
  // Merged-in overlay data (per grip: baselineAmps, baselineDate, dates,
  // ampsByDate). Supplies the curve + slider.
  historyOverlay = {},
  maxDur = 180,
  unit = "lbs",
  normalizeOn = false,
  bodyWeight = null,
  bwLog = [],
  // Hand selector (June 2026): "pooled" | "L" | "R". In L/R mode the
  // card renders STATIC per-grip tiles from perHandGripImprovement
  // (keys `${grip}|${hand}`, vs the FROZEN per-hand baselines) — the
  // interactive overlay + slider stay pooled-only, where the fits
  // have the data density to be worth scrubbing.
  handView = "pooled",
  perHandGripImprovement = {},
  perHandGripBaselines = {},
  // Current per-hand fits (keys `grip|hand`) — the "now" amps the L/R
  // tiles' supported zones are built from; used so the per-zone fill
  // shares the same basis (July 2026).
  perHandGripEstimates = {},
}) {
  // Per-grip "Now" slider index. null → latest date for that grip.
  const [nowIdxByGrip, setNowIdxByGrip] = useState({});
  const [zoneDetail, setZoneDetail] = useState(null);
  const scrub = (grip, idx) => setNowIdxByGrip(prev => ({ ...prev, [grip]: idx }));
  const openZoneDetail = (grip, zoneKey, throughDate = null) => {
    setZoneDetail({ grip, zoneKey, throughDate });
  };

  const scaledData = useMemo(() => {
    if (!normalizeOn) {
      return {
        gripImprovement,
        perHandGripImprovement,
        perHandGripEstimates,
        historyOverlay,
        improvement,
      };
    }
    const bwForDate = date => bwOnDate(bwLog, date)?.kg ?? bodyWeight;
    const scaledGripBaselines = normalizeBaselineMap(gripBaselines, bwForDate);
    const scaledGripEstimates = normalizeEstimateMap(grip3xEstimates, history, bwForDate);
    const scaledPerHandBaselines = normalizeBaselineMap(perHandGripBaselines, bwForDate);
    const scaledPerHandEstimates = normalizeEstimateMap(
      perHandGripEstimates,
      history,
      bwForDate
    );
    const fallbackGrip = selGrip || Object.keys(scaledGripEstimates)[0];
    const fallbackCurrent = fallbackGrip ? scaledGripEstimates[fallbackGrip] : null;
    const fallbackBaseline = global3xBaseline?.amps
      ? scaleAmps(global3xBaseline.amps, bwForDate(global3xBaseline.date))
      : null;
    return {
      gripImprovement: buildGripImprovement(scaledGripBaselines, scaledGripEstimates),
      perHandGripImprovement: buildGripImprovement(
        scaledPerHandBaselines,
        scaledPerHandEstimates
      ),
      perHandGripEstimates: scaledPerHandEstimates,
      historyOverlay: normalizeHistoryOverlay(historyOverlay, bwForDate),
      improvement: fallbackCurrent && fallbackBaseline
        ? improvementForAmps(
            fallbackCurrent,
            fallbackBaseline,
            global3xBaseline?.maxHoldS ?? null
          )
        : improvement,
    };
  }, [
    normalizeOn,
    gripImprovement,
    perHandGripImprovement,
    perHandGripEstimates,
    historyOverlay,
    improvement,
    bwLog,
    bodyWeight,
    gripBaselines,
    perHandGripBaselines,
    grip3xEstimates,
    history,
    selGrip,
    global3xBaseline,
  ]);

  const impMap = scaledData.gripImprovement;
  const scopedGripNames = [...new Set([
    ...(selGrip ? [selGrip] : grips),
    ...Object.keys(grip3xEstimates || {}),
    ...Object.keys(impMap),
  ])];
  if (
    !scaledData.improvement
    && Object.keys(impMap).length === 0
    && scopedGripNames.length === 0
  ) return null;

  const perGripMode = !selGrip && scopedGripNames.length >= 2;
  const gripImpEntries = scopedGripNames
    .filter(grip => impMap[grip])
    .map(grip => [grip, impMap[grip]]);
  const pendingGrips = scopedGripNames.filter(grip => !impMap[grip]);

  // Grips that have an interactive overlay (baseline + ≥1 post-baseline
  // fit). These render as full blocks; grips with an improvement but no
  // overlay fall back to a static tiles row.
  const overlayGrips = new Set(
    Object.keys(scaledData.historyOverlay)
      .filter(g => scaledData.historyOverlay[g]?.dates?.length > 0)
  );
  const fallbackGrip = selGrip
    || Object.keys(grip3xEstimates)[0]
    || (history || []).find(rep => rep?.grip)?.grip
    || null;
  const zoneHistoryModal = zoneDetail ? (
    <ZoneSessionHistoryModal
      history={history}
      grip={zoneDetail.grip}
      zoneKey={zoneDetail.zoneKey}
      handView={handView}
      throughDate={zoneDetail.throughDate}
      unit={unit}
      onClose={() => setZoneDetail(null)}
    />
  ) : null;

  // ── Per-hand mode: static tiles vs frozen per-hand baselines ──
  if (handView === "L" || handView === "R") {
    const handImpMap = scaledData.perHandGripImprovement;
    const entries = Object.entries(handImpMap)
      .filter(([key]) =>
        key.endsWith(`|${handView}`)
        && (!selGrip || key.startsWith(`${selGrip}|`))
      )
      .map(([key, imp]) => {
        // Fill this hand's long-hold "new" tiles the same way the pooled
        // block does: anchor each zone the hand baseline never reached to
        // the earliest per-hand cumulative fit that reached it. Merge ONLY
        // the previously-null zones so the existing supported-zone numbers
        // and the `total` are untouched.
        const grip = key.split("|")[0];
        const ph = scaledData.historyOverlay[grip]?.perHand?.[handView];
        let merged = imp;
        if (ph?.ampsByDate && ph.dates?.length) {
          // "Now" basis for the filled zones = the CURRENT per-hand
          // estimate — the SAME amps the supported-zone tiles were
          // computed from (perHandGripImprovement is built on
          // perHandGripEstimates), so filled and supported tiles can't
          // disagree about what "now" means. The overlay's last-date
          // cumulative fit is only the fallback (partial estimates map).
          const nowAmps = scaledData.perHandGripEstimates[key]
            ?? ph.ampsByDate.get(ph.dates[ph.dates.length - 1]);
          const zoneRef = perZoneBaselineAmps(
            ph.dates, ph.ampsByDate, ph.maxHoldByDate, ph.baselineMaxHoldS ?? null,
          );
          if (nowAmps && Object.keys(zoneRef).length) {
            const filled = improvementForAmps(nowAmps, ph.baselineAmps, ph.baselineMaxHoldS ?? null, zoneRef);
            if (filled) {
              merged = { ...imp };
              for (const zk of Object.keys(zoneRef)) {
                if (imp[zk] == null && typeof filled[zk] === "number") merged[zk] = filled[zk];
              }
            }
          }
        }
        return [grip, merged];
      })
      .sort((a, b) => a[0].localeCompare(b[0]));
    return (
      <Card style={{ marginBottom: 16, border: `1px solid ${C.purple}40` }}>
        {zoneHistoryModal}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4, flexWrap: "wrap", gap: 8 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>
            Curve Improvement
            <span style={{ color: handView === "R" ? C.orange : C.blue, marginLeft: 8, fontSize: 12 }}>
              {handView === "R" ? "Right hand" : "Left hand"}
            </span>
            {normalizeOn && (
              <span style={{ color: C.purple, marginLeft: 8, fontSize: 12 }}>· × BW</span>
            )}
          </div>
        </div>
        <div style={{ fontSize: 11, color: C.muted, marginBottom: 4, lineHeight: 1.4 }}>
          Per-hand fits vs that hand's frozen baseline — half the data
          of the pooled view, so expect noisier numbers.
        </div>
        <BasisNote />
        {entries.length > 0 ? entries.map(([grip, imp], i, arr) => (
          <StaticGripTiles key={grip} grip={grip} imp={imp}
            divider={i < arr.length - 1}
            onZoneSelect={openZoneDetail}
            selectedZoneKey={zoneDetail?.grip === grip ? zoneDetail.zoneKey : null}
          />
        )) : (
          <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
            No {handView === "R" ? "right" : "left"}-hand baseline seeded
            yet — a hand needs ≥{GRIP_BASELINE_REP_THRESHOLD} fresh reps across
            ≥{GRIP_BASELINE_DURATION_THRESHOLD} durations of its own before its frame freezes.
          </div>
        )}
      </Card>
    );
  }

  return (
    <Card style={{ marginBottom: 16, border: `1px solid ${C.purple}40` }}>
      {zoneHistoryModal}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4, flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>
          Curve Improvement
          {normalizeOn && (
            <span style={{ color: C.purple, marginLeft: 8, fontSize: 12 }}>· × BW</span>
          )}
        </div>
      </div>
      <BasisNote />

      {perGripMode ? (
        gripImpEntries.length > 0 || pendingGrips.length > 0 ? (
          <>
            {gripImpEntries.map(([grip, imp], i, arr) => {
              const divider = i < arr.length - 1 || pendingGrips.length > 0;
              if (overlayGrips.has(grip)) {
                return (
                  <GripBlock key={grip} grip={grip} overlay={scaledData.historyOverlay[grip]}
                    unit={unit} normalizeOn={normalizeOn} maxDur={maxDur}
                    nowIdx={nowIdxByGrip[grip]} onScrub={scrub} divider={divider}
                    onZoneSelect={openZoneDetail}
                    selectedZoneKey={zoneDetail?.grip === grip ? zoneDetail.zoneKey : null}
                  />
                );
              }
              // No overlay — static tiles at latest.
              return (
                <StaticGripTiles
                  key={grip}
                  grip={grip}
                  imp={imp}
                  divider={divider}
                  onZoneSelect={openZoneDetail}
                  selectedZoneKey={zoneDetail?.grip === grip ? zoneDetail.zoneKey : null}
                />
              );
            })}
            {pendingGrips.map((grip, index) => (
              <BaselineProgressRow
                key={grip}
                grip={grip}
                history={history}
                divider={gripImpEntries.length > 0 || index > 0}
              />
            ))}
          </>
        ) : (
          <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
            Need ≥5 failures across ≥3 target durations <i>per grip</i> to seed a stable per-grip baseline. Until then the three-exp fit can't separate the fast / medium / slow components cleanly enough for the per-zone Δ% to be meaningful.
          </div>
        )
      ) : selGrip ? (
        overlayGrips.has(selGrip) ? (
          <GripBlock grip={selGrip} overlay={scaledData.historyOverlay[selGrip]}
            unit={unit} normalizeOn={normalizeOn} maxDur={maxDur}
            nowIdx={nowIdxByGrip[selGrip]} onScrub={scrub} divider={false}
            onZoneSelect={openZoneDetail}
            selectedZoneKey={zoneDetail?.grip === selGrip ? zoneDetail.zoneKey : null}
          />
        ) : (
          <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
            Need ≥{GRIP_BASELINE_REP_THRESHOLD} fresh reps across
            ≥{GRIP_BASELINE_DURATION_THRESHOLD} target durations on <b>{selGrip}</b> for a fair apples-to-apples comparison. Pooled global baseline isn't shown here — it mixes muscle groups (FDP pinch vs FDS crush) and would produce misleading Δ%.
            <BaselineProgressRow grip={selGrip} history={history} divider />
          </div>
        )
      ) : scaledData.improvement ? (
        // Global fallback (single-grip histories) — the pooled global fit.
        <>
          {global3xBaseline && (
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 8, textAlign: "right" }}>
              since {global3xBaseline.date}
            </div>
          )}
          <ImprovementRow
            label={null}
            imp={gateGlobalImprovement(scaledData.improvement, global3xBaseline?.maxHoldS ?? null)}
            onZoneSelect={fallbackGrip
              ? zoneKey => openZoneDetail(fallbackGrip, zoneKey, null)
              : null}
            selectedZoneKey={zoneDetail?.grip === fallbackGrip ? zoneDetail.zoneKey : null}
          />
        </>
      ) : null}
    </Card>
  );
}
