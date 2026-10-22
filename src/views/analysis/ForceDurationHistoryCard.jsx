import React, { useMemo, useState } from "react";
import { C } from "../../ui/theme.js";
import { toDisp } from "../../ui/format.js";
import { STRENGTH_MAX } from "../../model/zones.js";
import { buildThreeExpPriors, predForceThreeExp } from "../../model/threeExp.js";
import { fitAmpsForPts } from "../../model/baselines.js";
import { isCapacityEvidenceRep, comparableCapacityHistory } from "../../model/forceRecording.js";
import { buildForceDurationGripScope } from "../../model/analysisScope.js";
import { effectiveLoad, freshFitReps } from "../../model/load.js";
import {
  buildFreshLoadMap,
  freshLoadFor,
  prescription,
  prescribedLoad,
  repKey,
} from "../../model/prescription.js";
import { buildRepCurveBundle } from "../../model/repCurveData.js";
import { GRIP_COLORS } from "../../ui/grip-colors.js";
import { RepCurveChart } from "../cards/RepCurveChart.jsx";
import { ForceDurationCard } from "./ForceDurationCard.jsx";

const CURVE_MIN_DURATION_S = 5;

export function ForceDurationHistoryCard({
  history = [],
  grip = "",
  hand = "",
  unit = "lbs",
  freshMap = null,
  threeExpPriors = null,
}) {
  const [basis, setBasis] = useState("fresh");
  const [selectedPoint, setSelectedPoint] = useState(null);
  const handView = hand || "pooled";
  const priors = useMemo(
    () => threeExpPriors || buildThreeExpPriors(history),
    [threeExpPriors, history]
  );
  const fitMap = useMemo(
    () => freshMap || buildFreshLoadMap(history),
    [freshMap, history]
  );
  const scopedHistory = useMemo(() => history.filter(rep =>
    (!grip || rep?.grip === grip)
    && (handView === "pooled" || rep?.hand === handView)
  ), [history, grip, handView]);
  const reps = useMemo(() => scopedHistory.filter(rep =>
    effectiveLoad(rep) > 0 && Number(rep.actual_time_s) > 0
  ), [scopedHistory]);
  const failures = useMemo(() => comparableCapacityHistory(reps).filter(rep =>
    isCapacityEvidenceRep(rep) && fitMap.get(repKey(rep))?.capacityEligible !== false
  ), [reps, fitMap]);
  const maxDur = Math.max(...reps.map(rep => Number(rep.actual_time_s)), STRENGTH_MAX + 60);
  const basisMap = basis === "fresh" ? fitMap : null;
  const amps = useMemo(() => {
    if (failures.length < 2) return null;
    return fitAmpsForPts(failures.map(rep => ({
      T: Number(rep.actual_time_s),
      F: basisMap ? freshLoadFor(rep, basisMap) : effectiveLoad(rep),
    })), grip, priors);
  }, [failures, basisMap, grip, priors]);
  const curve = useMemo(() => {
    if (!amps) return [];
    const end = Math.max(maxDur, CURVE_MIN_DURATION_S + 10);
    return Array.from({ length: 80 }, (_, index) => {
      const x = CURVE_MIN_DURATION_S + ((end - CURVE_MIN_DURATION_S) / 79) * index;
      return { x, y: toDisp(Math.max(predForceThreeExp(amps, x), 0), unit) };
    });
  }, [amps, maxDur, unit]);
  const ref180 = useMemo(
    () => amps ? predForceThreeExp(amps, 180) : null,
    [amps]
  );
  const dots = useMemo(() => freshFitReps(reps, { preserveAllBases: true }).map(rep => ({
    x: Number(rep.actual_time_s),
    y: toDisp(effectiveLoad(rep), unit),
    date: rep.date,
    grip: rep.grip,
    hand: rep.hand,
    session_id: rep.session_id,
    target_duration: rep.target_duration,
    rest_s: rep.rest_s,
  })), [reps, unit]);
  const splitData = useMemo(() => buildForceDurationGripScope(scopedHistory, {
    grip,
    hand: handView,
  }), [scopedHistory, grip, handView]);
  const maxForce = Math.max(...reps.map(rep => toDisp(effectiveLoad(rep), unit)), 40);
  const selectedSession = useMemo(() => {
    if (!selectedPoint?.session_id) return null;
    const sessionReps = history.filter(rep =>
      rep.session_id === selectedPoint.session_id
      && (!selectedPoint.date || rep.date === selectedPoint.date)
    );
    if (sessionReps.length === 0) return null;
    const sorted = [...sessionReps].sort((a, b) =>
      Number(a.set_num ?? 1) - Number(b.set_num ?? 1)
      || Number(a.rep_num ?? 0) - Number(b.rep_num ?? 0)
    );
    const date = sorted[0].date;
    const sessionGrip = sorted[0].grip;
    const targetDuration = sorted[0].target_duration;
    const restS = sorted[0].rest_s ?? 20;
    const priorHistory = history.filter(rep => rep.date < date);
    const hands = [...new Set(sorted.map(rep => rep.hand).filter(value => value === "L" || value === "R"))];
    return {
      meta: {
        date,
        grip: sessionGrip,
        targetDuration,
        restS,
        multipleSets: sorted.some(rep => Number(rep.set_num ?? 1) > 1),
      },
      perHand: (hands.length ? hands : [sorted[0].hand || "L"]).map(handKey => {
        const handReps = sorted.filter(rep =>
          rep.hand === handKey && Number(rep.set_num ?? 1) === 1
        );
        const firstRep = handReps[0];
        if (!firstRep) return null;
        const storedTarget = prescribedLoad(firstRep);
        const target = storedTarget > 0
          ? storedTarget
          : prescription(priorHistory, handKey, sessionGrip, targetDuration, {
              freshMap,
              threeExpPriors: priors,
              referenceDate: date,
            })?.value ?? null;
        return {
          handKey,
          firstRep,
          target,
          bundle: buildRepCurveBundle({
            history,
            grip: sessionGrip,
            hand: handKey,
            numReps: handReps.length,
            firstRepTime: firstRep.actual_time_s,
            restSeconds: firstRep.rest_s ?? restS,
            actualReps: handReps,
            targetDuration,
            beforeDate: date,
          }),
        };
      }).filter(Boolean),
    };
  }, [selectedPoint, history, freshMap, priors]);

  if (reps.length === 0) return null;

  return <>
    {selectedSession?.perHand.length > 0 && (
      <div
        onClick={() => setSelectedPoint(null)}
        style={{
          position: "fixed", inset: 0, zIndex: 100,
          background: "rgba(0,0,0,0.7)", display: "flex",
          alignItems: "center", justifyContent: "center", padding: 16,
        }}
      >
        <div
          onClick={event => event.stopPropagation()}
          style={{
            background: C.card ?? "#1a1a1a", borderRadius: 8, padding: 16,
            maxWidth: 520, width: "100%", maxHeight: "90vh", overflowY: "auto",
            border: `1px solid ${C.border}`,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>
              {selectedSession.meta.grip}
              <span style={{ marginLeft: 8, fontSize: 12, color: C.muted, fontWeight: 400 }}>
                {selectedSession.meta.date} · target {selectedSession.meta.targetDuration}s
              </span>
            </div>
            <button type="button" onClick={() => setSelectedPoint(null)} aria-label="Close"
              style={{ background: "none", border: "none", color: C.muted, fontSize: 20, cursor: "pointer" }}>×</button>
          </div>
          {selectedSession.meta.multipleSets && <p style={{ color: C.muted, fontSize: 12 }}>Set 1 comparison. All sets remain in History.</p>}
          {selectedSession.perHand.map(item => <div key={item.handKey} style={{ marginBottom: 12 }}>
            {selectedSession.perHand.length > 1 && <div style={{ fontSize: 10, fontWeight: 700, color: item.handKey === "L" ? C.blue : C.orange }}>
              {item.handKey === "L" ? "LEFT" : "RIGHT"}
            </div>}
            <RepCurveChart
              forecasted={item.bundle.forecasted}
              actual={item.bundle.actual}
              prevSession={item.bundle.prevSession}
              asymptoticHold={item.bundle.asymptoticHold}
              targetS={item.bundle.targetS}
              targetWeightKg={item.target}
              usedWeightKg={effectiveLoad(item.firstRep) || null}
              unit={unit}
              height={220}
            />
          </div>)}
        </div>
      </div>
    )}
    <ForceDurationCard
      title="Force-Duration Map"
      unit={unit}
      useRel={false}
      normalizeOn={false}
      handView={handView}
      fdBasis={basis}
      onFdBasisChange={setBasis}
      fdSplitData={splitData}
      threeExpCurveDataRel={curve}
      threeExpRef180={ref180}
      curveColor={grip ? (GRIP_COLORS[grip] || C.purple) : C.purple}
      dotsRel={dots}
      maxDur={maxDur}
      maxForceRel={maxForce}
      handAsymmetry={[]}
      history={scopedHistory}
      threeExpPriors={priors}
      freshMap={basisMap}
      handleDotClick={point => setSelectedPoint({ session_id: point?.session_id, date: point?.date })}
    />
  </>;
}
