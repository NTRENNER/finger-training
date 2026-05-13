// ─────────────────────────────────────────────────────────────
// useSessionRunner — in-workout finite state machine
// ─────────────────────────────────────────────────────────────
// Owns everything the user sees once they hit "Start Session" —
// the rep counter, the phase machine that drives which view
// renders, and all the callbacks the active-session views call on
// rep completion / rest finish / abort. Fatigue is post-hoc only
// now (see model/fatigue.js + prescription.js freshMap); the
// runtime accumulator was retired in May 2026.
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
//   history         — the rep array (for the level-up check)
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
import { calcLevel } from "../model/levels.js";
import { zoneOf } from "../model/zones.js";
// Runtime fatigue accumulator was retired — no view ever consumed it
// and the historical pipeline (freshMap / three-exp fit / prescription
// anchor) handles every analysis-time fatigue concern. fatigueDose +
// fatigueAfterRest still live in src/model/fatigue.js and are used
// post-hoc by the freshMap builder.
import {
  isShortfall,
  estimateRefWeight,
  prescription,
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
  // (currentSet removed — single-set model. Rep records still write
  // set_num: 1 as a constant for backward compat with the existing
  // Supabase schema; the column is otherwise unused going forward.)
  const [phase,       setPhase]       = useState("idle");
  const [currentRep,  setCurrentRep]  = useState(0);
  const [sessionReps, setSessionReps] = useState([]);
  const [sessionId,        setSessionId]        = useState("");
  const [sessionStartedAt, setSessionStartedAt] = useState("");
  const [refWeights,       setRefWeights]        = useState({});
  const [lastRepResult, setLastRepResult] = useState(null);
  const [leveledUp,   setLeveledUp]   = useState(false);
  const [newLevel,    setNewLevel]    = useState(1);
  const [activeHand,  setActiveHand]  = useState("L"); // tracks current hand in Both mode

  // (sMax memos retired with the runtime fatigue accumulator — they
  // were the only consumer. Per-grip baseline data is still available
  // through model/levels.js for any future runtime feature that needs it.)

  // ── Start session ───────────────────────────────────────────
  // refWeights drives the in-workout "Rep 1 suggested weight" display
  // and the weight that gets recorded against each rep. Same prescription
  // chain as the Setup card's "Train at" cell — single unified call to
  // prescription() which internally walks anchored-curve → unanchored-curve
  // → anchored-linear → historical, returning whichever path has data.
  const startSession = useCallback(() => {
    const sid = uid();
    const rw = {};
    ["L", "R"].forEach(h => {
      const p = prescription(history, h, config.grip, config.targetTime,
        { freshMap, threeExpPriors });
      rw[h] = p ? p.value : estimateRefWeight(history, h, config.grip, config.targetTime);
    });
    const startedAt = nowISO();
    setSessionId(sid);
    setSessionStartedAt(startedAt);
    setRefWeights(rw);
    setSessionReps([]);
    setCurrentRep(0);
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
    // Zone bucket of the prescribed T — the level cell this session
    // contributes to. See model/levels.js for the curve-trust grouping.
    const zone = zoneOf(config.targetTime);
    for (const h of hands) {
      const combined = [...history, ...allReps.filter(r => r.hand === h || r.hand === "B")];
      const oldLevel = calcLevel(history, h, config.grip, zone);
      const newLvl   = calcLevel(combined, h, config.grip, zone);
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
      set_num:         1,
      rep_num:         currentRep + 1,
      rest_s:             config.restTime,
      session_id:         sessionId,
      // LEGACY FIELD — kept for backward compatibility with old
      // rep records and the existing Supabase schema. Under the
      // train-to-failure data model (May 2026) every rep ends in
      // physical failure regardless of how actual_time_s compares
      // to target_duration, so this flag no longer carries
      // information the model uses. The F-D fit, prescription
      // engine, coaching engine, and limiter all treat every rep
      // as a (T, F) data point and ignore `failed`. Still written
      // here so historic reads + the History view's per-rep edit
      // surface stay consistent.
      failed:             derivedFailed,
      session_started_at: sessionStartedAt || null,
    };

    setLastRepResult({ actualTime, avgForce, peakForce, targetTime: config.targetTime });
    setSessionReps(reps => [...reps, repRecord]);
    addReps([repRecord]);

    // (Runtime fatigue accumulator removed — was dead state, no view
    // consumed the value. The historical pipeline handles all fatigue
    // analysis via effectiveLoad → freshMap → three-exp fit.)

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
  }, [config, currentRep, refWeights, sessionId, sessionStartedAt, sessionReps, addReps, activeHand]);

  const handleRestDone = useCallback(() => {
    // When Tindeq is connected, go to rep_ready so AutoRepSessionView can arm
    // auto-detection and wait for the next pull. When not connected, auto-start
    // the countdown so the user doesn't need to tap Start Rep.
    setPhase(tindeqConnected ? "rep_ready" : "rep_active");
  }, [tindeqConnected]);

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
    currentRep,
    sessionId, sessionStartedAt, refWeights,
    sessionReps, lastRepResult,
    leveledUp, newLevel,
    activeHand,
    nextWeight,
    startSession, handleRepDone,
    handleRestDone, handleAbort,
  };
}
