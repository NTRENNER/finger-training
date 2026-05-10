// ─────────────────────────────────────────────────────────────
// useSessionRunner — in-workout finite state machine
// ─────────────────────────────────────────────────────────────
// Owns everything the user sees once they hit "Start Session" —
// the rep/set counters, the fatigue accumulator, the phase
// machine that drives which view renders, and all the callbacks
// the active-session views call on rep completion / rest finish /
// abort.
//
// State machine phases:
//   idle          — pre-session, SetupView is rendered
//   rep_ready     — show "Start Rep" button (manual mode) or arm
//                   auto-detect (BLE mode)
//   rep_active    — rep in progress
//   resting       — countdown between reps
//   switch_hands  — Both-mode prompt to swap to the other hand
//   done          — SessionSummaryView is rendered
//
// Multi-set machinery removed (May 2026, curve-trust commit C):
// every session is one set of N hangs. The user trains a single set
// to failure, end of session. The legacy `between_sets` phase, the
// numSets / setRestTime config fields, and currentSet bookkeeping
// are gone. set_num is kept on rep records (always 1 going forward)
// for backward compat with the Supabase schema and existing data.
//
// Multi-set machinery removed in commit C; alternating-hand mode
// (interleave L↔R within a set, restTime ≥ targetTime trigger)
// removed in the follow-up — with the flat 20s rest the efficiency
// gain from interleaving is minimal, and "do all your L hangs,
// then all your R hangs" is simpler to reason about. config now
// equals rawConfig (no derived fields).
//
// Inputs:
//   history         — the rep array (for sMax + level-up check)
//   freshMap        — fatigue-adjusted load lookup (for startSession's
//                     prescription chain)
//   threeExpPriors  — three-exp per-grip priors (same)
//   addReps         — callback to push the new rep into history
//   tindeqConnected — whether to land on rep_ready vs rep_active
//                     after rest (BLE mode arms auto-detect; manual
//                     mode auto-starts the countdown)
//   onSessionStart  — fires after startSession() so App can switch
//                     tabs back to Train

import { useCallback, useMemo, useState } from "react";

import { today, uid, nowISO } from "../util.js";
import { getBaseline, getBestLoad, calcLevel } from "../model/levels.js";
import { fatigueDose, fatigueAfterRest } from "../model/fatigue.js";
import {
  isShortfall,
  estimateRefWeight,
  prescribedLoad,
  empiricalPrescription,
  suggestWeight,
} from "../model/prescription.js";

export function useSessionRunner({
  history,
  freshMap,
  threeExpPriors,
  addReps,
  tindeqConnected,
  onSessionStart,
}) {
  // ── Session config (see comment at top) ─────────────────────
  // Multi-set fields (numSets, setRestTime) removed — every session
  // is single-set under the curve-trust model.
  const [rawConfig, setConfig] = useState(() => ({
    hand:       "Both",
    grip:       "",
    goal:       "",  // zone key (e.g., "power") set when ContinuousPickCard applies its plan
    repsPerSet: 5,
    targetTime: 45,
    restTime:   20,
  }));

  // No derived fields anymore — config is rawConfig.
  const config = rawConfig;

  // ── Phase machine + per-rep counters ────────────────────────
  // currentSet is always 0 under the single-set model — persisted
  // into rep records as set_num = currentSet + 1 = 1 for backward
  // compat with the existing Supabase schema. No state, no setter.
  const currentSet = 0;
  const [phase,       setPhase]       = useState("idle");
  const [currentRep,  setCurrentRep]  = useState(0);
  const [fatigue,     setFatigue]     = useState(0);
  const [sessionReps, setSessionReps] = useState([]);
  const [sessionId,        setSessionId]        = useState("");
  const [sessionStartedAt, setSessionStartedAt] = useState("");
  const [refWeights,       setRefWeights]        = useState({});
  const [lastRepResult, setLastRepResult] = useState(null);
  const [leveledUp,   setLeveledUp]   = useState(false);
  const [newLevel,    setNewLevel]    = useState(1);
  const [activeHand,  setActiveHand]  = useState("L"); // tracks current hand in Both mode

  // ── sMax (for fatigue dose calculation) ─────────────────────
  // Use post-session-1 best; fall back to baseline (first session); then 20 kg if no data.
  const sMaxL = useMemo(() => {
    const best = getBestLoad(history, "L", config.grip, config.targetTime)
               || getBaseline(history, "L", config.grip, config.targetTime);
    return best ? best * 1.2 : 20;
  }, [history, config.grip, config.targetTime]);
  const sMaxR = useMemo(() => {
    const best = getBestLoad(history, "R", config.grip, config.targetTime)
               || getBaseline(history, "R", config.grip, config.targetTime);
    return best ? best * 1.2 : 20;
  }, [history, config.grip, config.targetTime]);

  // ── Start session ───────────────────────────────────────────
  // refWeights drives the in-workout "Rep 1 suggested weight" display
  // and the weight that gets recorded against each rep. Same prescription
  // chain as the Setup card's "Train at" cell so the two views match
  // to the kg: empirical-first (anchored to user's most recent rep 1),
  // then per-grip three-exp curve, then cross-grip three-exp, then
  // historical weighted average as the last-resort fallback.
  const startSession = useCallback(() => {
    const sid = uid();
    const rw = {};
    ["L", "R"].forEach(h => {
      rw[h] = empiricalPrescription(history, h, config.grip, config.targetTime, { threeExpPriors })
           ?? prescribedLoad(history, h, config.grip, config.targetTime, freshMap, { threeExpPriors })
           ?? prescribedLoad(history, h, null,        config.targetTime, freshMap, { threeExpPriors })
           ?? estimateRefWeight(history, h, config.grip, config.targetTime);
    });
    const startedAt = nowISO();
    setSessionId(sid);
    setSessionStartedAt(startedAt);
    setRefWeights(rw);
    setSessionReps([]);
    setCurrentRep(0);
    setFatigue(0);
    setLeveledUp(false);
    setLastRepResult(null);
    setActiveHand(config.hand === "Both" ? "L" : config.hand);
    setPhase("rep_ready");
    onSessionStart?.();
  }, [history, config, freshMap, threeExpPriors, onSessionStart]);

  // Forward-declared so handleRepDone can call it before its
  // own useCallback identity is materialised.
  const finishSession = useCallback((allReps) => {
    // Check for level up
    const hands = config.hand === "Both" ? ["L","R"] : [config.hand];
    let leveled = false;
    let maxNewLevel = 1;
    for (const h of hands) {
      const combined = [...history, ...allReps.filter(r => r.hand === h || r.hand === "B")];
      const oldLevel = calcLevel(history, h, config.grip, config.targetTime);
      const newLvl   = calcLevel(combined, h, config.grip, config.targetTime);
      if (newLvl > oldLevel) { leveled = true; maxNewLevel = Math.max(maxNewLevel, newLvl); }
    }
    setLeveledUp(leveled);
    setNewLevel(maxNewLevel);
    setPhase("done");
  }, [config, history]);

  // ── Handle rep completion ───────────────────────────────────
  const handleRepDone = useCallback(({ actualTime, avgForce, peakForce, failed = false }) => {
    const effectiveHand = config.hand === "Both" ? activeHand : config.hand;
    // Weight is constant across the set — no within-set fatigue discount.
    // The rep-time curve (actual_time_s) is what reflects fatigue and feeds
    // the next session's prescription via the three-exp curve fit.
    const weight = (() => {
      const ws = [suggestWeight(refWeights[effectiveHand], 0)].filter(Boolean);
      return ws.length > 0 ? ws[0] : 0;
    })();

    const roundedActual = Math.round(actualTime * 10) / 10;
    const derivedFailed = failed || isShortfall(roundedActual, config.targetTime);
    const repRecord = {
      id:              uid(),
      date:            today(),
      grip:            config.grip,
      hand:            effectiveHand,
      target_duration: config.targetTime,
      weight_kg:       Math.round(weight * 10) / 10,
      actual_time_s:   roundedActual,
      avg_force_kg:    (isFinite(avgForce) && avgForce > 0 && avgForce < 500)
                         ? Math.round(avgForce * 10) / 10
                         : null,
      // Peak force from the Tindeq stream — the highest single
      // sample seen during the rep. Stored alongside avg_force_kg
      // so the user can see "I hit 38kg even though my average
      // was 24kg" — useful for power reps where peak is the metric
      // of interest. Same sanity range as avg.
      peak_force_kg:   (isFinite(peakForce) && peakForce > 0 && peakForce < 500)
                         ? Math.round(peakForce * 10) / 10
                         : null,
      set_num:         currentSet + 1,
      rep_num:         currentRep + 1,
      rest_s:             config.restTime,
      session_id:         sessionId,
      failed:             derivedFailed,
      session_started_at: sessionStartedAt || null,
    };

    setLastRepResult({ actualTime, avgForce, peakForce, targetTime: config.targetTime });
    setSessionReps(reps => [...reps, repRecord]);
    addReps([repRecord]);

    // Update fatigue
    const sMax = config.hand === "R" ? sMaxR : sMaxL;
    const dose = fatigueDose(weight, actualTime, sMax);
    setFatigue(f => Math.min(f + dose, 0.95));

    // Single-set model (curve-trust commit C). All set-completion /
    // between-sets logic has been removed — every session is one set
    // of N hangs; when reps fill the set, the session ends (or
    // switches to the other hand in Both-mode).
    //
    // Alternating-hand interleaving (the legacy altMode) was removed
    // in the follow-up — with the flat 20s rest the efficiency gain
    // from interleaving is minimal. Both-mode now always does all
    // hangs on the primary hand, then switches to the other.
    const nextRep = currentRep + 1;
    if (nextRep >= config.repsPerSet) {
      // Set complete. In Both-mode, switch to the other hand for
      // its set; otherwise finish.
      if (config.hand === "Both" && activeHand === "L") {
        setCurrentRep(0);
        setFatigue(0);
        setActiveHand("R");
        setPhase("switch_hands");
      } else {
        finishSession([...sessionReps, repRecord]);
      }
    } else {
      setCurrentRep(nextRep);
      setPhase("resting");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, currentRep, currentSet, fatigue, refWeights, sessionId, sessionStartedAt, sessionReps, addReps, sMaxL, sMaxR, activeHand]);

  const handleRestDone = useCallback(() => {
    setFatigue(f => fatigueAfterRest(f, config.restTime));
    // When Tindeq is connected, go to rep_ready so AutoRepSessionView can arm
    // auto-detection and wait for the next pull. When not connected, auto-start
    // the countdown so the user doesn't need to tap Start Rep.
    setPhase(tindeqConnected ? "rep_ready" : "rep_active");
  }, [config.restTime, tindeqConnected]);

  // handleNextSet removed (curve-trust commit C — single-set only).

  const handleAbort = useCallback(() => {
    if (sessionReps.length > 0) finishSession(sessionReps);
    else setPhase("idle");
  }, [sessionReps, finishSession]);

  // Compute next rep suggestion for rest screen — same constant set weight.
  const nextWeight = useMemo(() => {
    if (phase !== "resting") return null;
    const hand = config.hand === "Both" ? activeHand : config.hand;
    return suggestWeight(refWeights[hand], 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, config.hand, refWeights, activeHand]);

  return {
    config, setConfig,
    phase, setPhase,
    currentSet, currentRep, fatigue,
    sessionId, sessionStartedAt, refWeights,
    sessionReps, lastRepResult,
    leveledUp, newLevel,
    activeHand,
    nextWeight,
    startSession, handleRepDone,
    handleRestDone, handleAbort,
  };
}
