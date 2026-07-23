// ──────────────────────────────────────────────────────────────
// useSessionRunner — in-workout finite state machine
// ──────────────────────────────────────────────────────────────
// Owns everything the user sees once they hit "Start Session" —
// the rep counter, the phase machine that drives which view
// renders, and all the callbacks the active-session views call on
// rep completion / rest finish / abort. Fatigue is post-hoc only
// now (see model/fatigue.js + prescription.js freshMap); the
// runtime accumulator was retired in May 2026.
//
// State machine phases:
//   idle          — pre-session, SetupView is rendered
//   offset_prompt — no-Tindeq only: ask once whether to apply the
//                   manual-timing 2s offset before the first rep
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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { today, uid, uuid, nowISO } from "../util.js";
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
import { capacityMultiplier } from "../model/fatigueBeta.js";
import { pushDailyState } from "../lib/sync.js";

// Manual-timing offset (June 2026): non-Tindeq users tap Done a beat
// after they actually fail. When they opt in at session start, they
// count "1-2" after failure and we subtract this fixed offset so the
// recorded hold matches the real failure time. Tindeq sessions never
// use it (auto-detect captures the release precisely). The floor keeps
// a very short hold from recording as zero/negative.
const MANUAL_OFFSET_S = 2;
const MIN_HOLD_S = 0.5;

export function useSessionRunner({
  history,
  freshMap,
  threeExpPriors,
  addReps,
  // Per-grip β model loaded from user_settings.settings.fatigue_model.
  // capacityMultiplier(fatigueModel, grip, cooked) returns the load
  // scale-down factor exp(-β·c). Updated server-side by the
  // update_fatigue_beta_from_rep_trg trigger after rep-1 inserts.
  fatigueModel = null,
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
    // Pre-workout cookedness scalar (0–10). Defaults to 0 (fresh, no
    // scale-down); the user only raises it on days they're not fresh.
    // Set by the SessionPlanCard slider. startSession upserts this into
    // daily_state by today's date so the server-side β trigger can read
    // it when reps land.
    cooked: 0,
    // Density-ladder pinned loads ({ L?, R? } fresh-equivalent kg, or
    // null when the ladder isn't active). Set by SessionPlanCard's
    // onApplyPlan; startSession prefers these over re-prescribing so
    // "same weight, more reps" holds between ladder rungs.
    ladderLoadByHand: null,
  }));

  // No derived fields anymore — config is rawConfig.
  const config = rawConfig;

  // ── Phase machine + per-rep counters ──────────────────────
  // (currentSet removed — single-set model. Rep records still write
  // set_num: 1 as a constant for backward compat with the existing
  // Supabase schema; the column is otherwise unused going forward.)
  const [phase,       setPhase]       = useState("idle");
  const [currentRep,  setCurrentRep]  = useState(0);
  const [sessionReps, setSessionReps] = useState([]);
  const [sessionId,        setSessionId]        = useState("");
  // Pre-session history snapshot for level-up detection (fixed
  // 2026-07-01): handleRepDone pushes each rep into `history` via
  // addReps as it lands, so by finishSession the "old" history
  // already contains this session's reps 1..N-1 — at the same
  // (possibly PR) load, since load is constant within a set.
  // calcLevel is max-load based, so oldLevel === newLevel for any
  // session with ≥2 reps and the Level Up celebration could
  // essentially never fire. Snapshot at startSession instead. A ref,
  // not state: it must not retrigger effects and is only read once.
  const preSessionHistoryRef = useRef(null);
  const [sessionStartedAt, setSessionStartedAt] = useState("");
  // Session-anchored local date (YYYY-MM-DD), captured once at
  // startSession. Every rep in the session is stamped with THIS,
  // not today() at each rep-completion. A session that crosses local
  // midnight (e.g. a late-evening hang past 12) otherwise had its
  // later reps stamped with the next day and split across two
  // History entries (Nathan's 2026-07-12 Crusher session, July 2026).
  const [sessionDate, setSessionDate] = useState("");
  const [refWeights,       setRefWeights]        = useState({});
  const [lastRepResult, setLastRepResult] = useState(null);
  const [leveledUp,   setLeveledUp]   = useState(false);
  const [newLevel,    setNewLevel]    = useState(1);
  const [activeHand,  setActiveHand]  = useState("L"); // tracks current hand in Both mode
  // Per-session manual-timing offset opt-in (see MANUAL_OFFSET_S).
  // Chosen at session start via the offset_prompt phase; false until
  // chosen, and irrelevant when a Tindeq is driving the timing.
  const [manualOffset, setManualOffset] = useState(false);

  // (sMax memos retired with the runtime fatigue accumulator — they
  // were the only consumer. Per-grip baseline data is still available
  // through model/levels.js for any future runtime feature that needs it.)

  // ── Start session ──────────────────────────────────────
  // refWeights drives the in-workout "Rep 1 suggested weight" display
  // and the weight that gets recorded against each rep. Same prescription
  // chain as the Setup card's "Train at" cell — single unified call to
  // prescription() which internally walks anchored-curve → unanchored-curve
  // → anchored-linear → historical, returning whichever path has data.
  // Optional `override` config lets a caller launch a session with a
  // config distinct from the live setup state — used by the Peak Test
  // launcher (SetupView), which starts a target-less 3s max preset that
  // must NOT be clobbered by the SessionPlanCard's onApplyPlan. When an
  // override is passed we also setConfig(override) so every downstream
  // reader (handleRepDone stamps target_duration from config) sees it.
  // Anything without a .grip (e.g. a click event from onClick={onStart})
  // is ignored, so the plain Start button keeps working unchanged.
  const startSession = useCallback((override) => {
    const cfg = (override && override.grip) ? override : config;
    if (override && override.grip) setConfig(override);
    const sid = uid();
    const rw = {};
    // Per-grip capacity multiplier: exp(-β·cooked). 1.0 when cooked
    // is null/0. Replaces the old per-zone applyPersonalGain path —
    // same multiplicative role on load, but the learner is per-grip
    // and lives in user_settings.settings.fatigue_model.
    const fatigueMod = capacityMultiplier(fatigueModel, cfg.grip, cfg.cooked);
    ["L", "R"].forEach(h => {
      // Density-ladder pin (see model/densityLadder.js + SessionPlanCard):
      // for repeat (grip, zone) sessions the plan carries the previous
      // session's fresh-equivalent load — "same weight, more reps" only
      // holds if we DON'T re-prescribe from the (still-learning) curve.
      // Today's cooked multiplier still applies, same as the curve path.
      const pinned = cfg.ladderLoadByHand?.[h];
      const base = pinned > 0
        ? pinned
        : (() => {
            const p = prescription(history, h, cfg.grip, cfg.targetTime,
              { freshMap, threeExpPriors });
            return p ? p.value : estimateRefWeight(history, h, cfg.grip, cfg.targetTime);
          })();
      rw[h] = base != null ? base * fatigueMod : base;
    });
    // Anchor the session's local date ONCE, here at start. Reused for
    // daily_state and stamped on every rep so the whole session stays
    // on the day it began even if it runs past local midnight.
    const startedDay = today();
    // Persist today's cookedness so the server-side β trigger can
    // join it onto rep-1 inserts. Fire-and-forget; failure here
    // doesn't block the session, just costs a learning update.
    if (cfg.cooked != null) {
      pushDailyState(startedDay, cfg.cooked);
    }
    const startedAt = nowISO();
    preSessionHistoryRef.current = history;  // freeze pre-session view for level-up detection
    repDoneLockRef.current = false;   // arm rep-done for the first rep
    setSessionId(sid);
    setSessionStartedAt(startedAt);
    setSessionDate(startedDay);
    setRefWeights(rw);
    setSessionReps([]);
    setCurrentRep(0);
    setLeveledUp(false);
    setLastRepResult(null);
    setActiveHand(cfg.hand === "Both" ? "L" : cfg.hand);
    setManualOffset(false);
    // No Tindeq → ask once whether to apply the 2s manual-timing offset
    // before the first rep. Tindeq sessions skip straight into the rep
    // flow (auto-detect handles timing precisely).
    setPhase(tindeqConnected ? "rep_ready" : "offset_prompt");
    onSessionStart?.();
  }, [history, config, freshMap, threeExpPriors, fatigueModel, onSessionStart, tindeqConnected]);

  // Resolve the offset_prompt phase: store the per-session choice and
  // enter the rep flow.
  const chooseOffset = useCallback((enabled) => {
    setManualOffset(!!enabled);
    setPhase("rep_ready");
  }, []);

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
    // Level-up compares against the PRE-session snapshot (see
    // preSessionHistoryRef) — `history` here already contains this
    // session's earlier reps, which used to mask the level change.
    const before = preSessionHistoryRef.current ?? history;
    for (const h of hands) {
      const combined = [...before, ...allReps.filter(r => r.hand === h || r.hand === "B")];
      const oldLevel = calcLevel(before, h, config.grip, zone);
      const newLvl   = calcLevel(combined, h, config.grip, zone);
      if (newLvl > oldLevel) { leveled = true; maxNewLevel = Math.max(maxNewLevel, newLvl); }
    }
    setLeveledUp(leveled);
    setNewLevel(maxNewLevel);
    setPhase("done");
  }, [config, history]);

  // Duplicate-event lock (June 2026 audit): a double-tapped Done
  // button or a doubled Tindeq release event called handleRepDone
  // twice for one physical rep. Each call minted a fresh UUID, so the
  // duplicate looked like a real rep locally — feeding the live
  // charts, the session summary, and double-advancing the rep counter
  // — until the cloud's workout-slot unique constraint collapsed it
  // on the next sync. A ref (not state) because the second call can
  // arrive in the same tick, before any re-render.
  //
  // RE-ARMING (fixed 2026-06-12): v1 cleared the lock only in
  // startSession and handleRestDone, on the WRONG assumption that the
  // switch-hands resume routed through handleRestDone. It doesn't —
  // App.js calls setPhase("rep_ready") directly from SwitchHandsView's
  // onReady — so the lock set by the LEFT hand's final rep was never
  // cleared and every RIGHT-hand rep completion was silently dropped
  // (rep timer ran in the view; no record, no rest phase — the
  // 2026-06-12 Crusher session lost its entire R set this way). The
  // phase effect below now clears the lock on ANY transition into a
  // rep-startable phase, so no arming path — present or future — can
  // be missed. The explicit clears in startSession/handleRestDone are
  // kept as belt-and-braces.
  const repDoneLockRef = useRef(false);
  useEffect(() => {
    if (phase === "rep_ready" || phase === "rep_active") {
      repDoneLockRef.current = false;
    }
  }, [phase]);

  // ── Handle rep completion ─────────────────────────────────
  const handleRepDone = useCallback(({ actualTime, avgForce, peakForce, failed = false, manualLoadKg = null }) => {
    if (repDoneLockRef.current) return;   // duplicate event for this rep — drop
    repDoneLockRef.current = true;
    const effectiveHand = config.hand === "Both" ? activeHand : config.hand;
    // Weight is constant across the set — no within-set fatigue discount.
    // The rep-time curve (actual_time_s) is what reflects fatigue and feeds
    // the next session's prescription via the three-exp curve fit.
    const weight = (() => {
      const ws = [suggestWeight(refWeights[effectiveHand], 0)].filter(Boolean);
      return ws.length > 0 ? ws[0] : 0;
    })();

    // Apply the per-session manual-timing offset (non-Tindeq only): the
    // user counted "1-2" after failure before tapping Done, so the raw
    // elapsed overshoots real failure by ~2s. Floored so a very short
    // hold can't record as zero/negative.
    const adjTime = (manualOffset && !tindeqConnected)
      ? Math.max(MIN_HOLD_S, actualTime - MANUAL_OFFSET_S)
      : actualTime;
    const roundedActual = Math.round(adjTime * 10) / 10;
    const derivedFailed = failed || isShortfall(roundedActual, config.targetTime);
    const roundedPrescribed = Math.round(weight * 10) / 10;
    const repRecord = {
      // Real UUID, not uid(): pushRep re-stamps non-UUID ids into the
      // cloud payload without writing back, so a uid() here meant
      // local id ≠ cloud id until the next reconcile — and id-based
      // updateRep/deleteRep calls silently matched 0 cloud rows.
      id:              uuid(),
      date:            sessionDate || today(),
      grip:            config.grip,
      hand:            effectiveHand,
      target_duration: config.targetTime,
      // Prescribed (what the program suggested). Schema split in late
      // May 2026 — was `weight_kg`, which doubled as "what actually
      // happened" on reads. weight_kg is still set so legacy readers
      // (and any unsynced offline reads) keep working through the
      // transition; it'll be dropped in a follow-up commit once
      // every read site is confirmed using effectiveLoad's fallback chain.
      prescribed_load_kg: roundedPrescribed,
      weight_kg:          roundedPrescribed,
      // manual_load_kg = the live weight-override the user typed this
      // rep (kg). For a non-Tindeq session this is the ONLY record of what
      // they lifted — effectiveLoad reads avg_force_kg first (Tindeq), then
      // this. Was hardcoded null (July 2026 fix): the override box fed the
      // live color/auto-fail threshold but never reached the saved rep, so
      // manual users' reps persisted load=0 and every fit read zero. The
      // History rep editor's "Manual load" field still back-fills it later.
      // Store at ~0.001 kg precision, NOT 0.1 kg. In lbs mode a 0.1 kg
      // grid quantizes to ~0.22 lb steps, so a user with lb plates can't
      // land on a round weight — e.g. 20.0 lb snapped to 20.1 or 20.3
      // (Tom's bug, July 2026). Fine precision lets toDisp reproduce the
      // exact value they typed. Matches the History rep editor, which
      // already stores fromDisp(...) unrounded.
      manual_load_kg:     (Number.isFinite(manualLoadKg) && manualLoadKg > 0)
                            ? Math.round(manualLoadKg * 1000) / 1000
                            : null,
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
      // perceived_rpe was the per-rep learning signal for the old
      // per-zone shrinkage model. The new per-grip β model reads
      // cookedness from daily_state via the server trigger instead.
      // Always null on new writes — column preserved for back-compat
      // with historical rows and the History view's rep editor.
      perceived_rpe:      null,
      // Per-session cookedness — stamped on every rep in the session
      // (same value across rep 1..N) so the curve fit can apply
      // per-rep compensation without a separate join. Reads from the
      // pre-session slider via config.cooked. Null when the user left
      // the slider at "no opinion" — the fit then falls back to
      // daily_state.cooked for the rep's date.
      session_cooked:     (config.cooked != null && Number.isFinite(Number(config.cooked)))
                            ? Number(config.cooked)
                            : null,
    };

    // prescribedWeight rides along for the RestView's over-pull check
    // (July 2026, per Nathan): with a spring/anchor setup the user
    // controls the pull, and pulling well over prescription is what
    // collapsed the June sessions (e.g. 2026-06-19: 70.5 lb prescribed,
    // 83 lb pulled, reps 2+ died at 15-30s).
    setLastRepResult({
      actualTime: adjTime, avgForce, peakForce,
      targetTime: config.targetTime,
      prescribedWeight: roundedPrescribed,
    });
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
  }, [config, currentRep, refWeights, sessionId, sessionStartedAt, sessionDate, sessionReps, addReps, activeHand, manualOffset, tindeqConnected]);

  const handleRestDone = useCallback(() => {
    repDoneLockRef.current = false;   // next rep armed — accept its completion
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
    startSession, chooseOffset, handleRepDone,
    handleRestDone, handleAbort,
  };
}
