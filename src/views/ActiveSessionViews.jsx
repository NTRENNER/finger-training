import { displayedRepTime } from "../model/pullMeasurement.js";
import { mixedAdjustmentText } from '../model/mixedLoadPrescription.js';
import { HandCue } from './cards/HandCue.jsx';
import { TindeqBattery, InterruptedBatteryNote } from "./cards/TindeqBattery.jsx";
import { finalizeDeviceActivity } from "../model/forceRecording.js";
import { RepResultDetails } from "./cards/RepResultDetails.jsx";
import { MIXED_DOMAIN_LABELS, isMixedDomainRep, mixedDomainMetadata } from '../model/mixedDomain.js';
// ──────────────────────────────────────────────────────────────
// ACTIVE-SESSION VIEWS
// ──────────────────────────────────────────────────────────────
// Everything the user sees once they hit "Start Session" — the
// big-timer / force-gauge active rep, the rest screen between
// reps, the switch-hands prompt in Both-mode, and the post-session
// summary. Plus the auto-detect Tindeq-driven flow
// (AutoRepSessionView) that replaces ActiveSessionView when BLE
// is connected. One set is recommended; optional extra sets start
// automatically after a five-minute break when selected at setup. Unplanned
// additions remain available from the completed-set summary.
//
// Coupling to App.js is only via props:
//   session    — { config, currentRep,
//                  sessionId, refWeights, activeHand }
//   tindeq     — the BLE hook return (connected, force, peak,
//                avg, tare, startMeasuring, stopMeasuring)
//   onRepDone, onAbort, onRestDone, etc. — App-side callbacks
//
// Plus the small primitives (BigTimer, ForceGauge, RepDots,
// playBeep) used inside the flow. They're file-private since
// nothing outside this module renders them.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { C } from "../ui/theme.js";
import { Card, Btn, Label, PageFrame } from "../ui/components.jsx";
import { fmtW, fmtTime, fromDisp } from "../ui/format.js";
import { BigTimer, ForceGauge } from "./cards/LiveForceCard.jsx";

import { suggestWeight, prescribedLoad } from "../model/prescription.js";
import { levelTitle } from "../model/levels.js";
import { downloadCSV } from "../lib/csv.js";
import { buildRepCurveBundle, buildPhysModel } from "../model/repCurveData.js";
import { RepCurveChart } from "./cards/RepCurveChart.jsx";
import { buildRecoveryBundle } from "../model/recoveryDynamics.js";
import { sessionOverpull } from "../model/overpull.js";
import { RecoveryChart } from "./cards/RecoveryChart.jsx";
import { MAX_OPTIONAL_SETS, recommendAnotherSet, isSetComplete } from "../model/setRecommendation.js";
import { isVolumeSetComplete } from "../model/volumeSession.js";

// Small wrapper used by both ActiveSessionView and AutoRepSessionView
// (and SessionSummaryView) to render the live forecasted-vs-actual
// rep curve. Seeds the forecast from rep 1's actual hold if available,
// otherwise from the configured target_duration so the user sees the
// engine's prediction before they've moved.
function LiveRepCurveCard({
  history, config, currentSet = 1, activeHand, sessionReps, refWeights,
  unit = "lbs", embedded = false,
}) {
  const handForLookup = config.hand === "Both" ? (activeHand || "L") : config.hand;
  const bundle = useMemo(() => {
    if (config.mixedDomainPlan) return null;
    const sameHandReps = (sessionReps || []).filter(r =>
      r.hand === handForLookup && (r.set_num ?? 1) === currentSet
    );
    const rep1 = sameHandReps[0];
    const firstRepTime = rep1?.actual_time_s > 0 ? rep1.actual_time_s : config.targetTime;
    return buildRepCurveBundle({
      history,
      grip: config.grip, hand: handForLookup,
      numReps: config.repsPerSet,
      firstRepTime,
      restSeconds: config.restTime ?? 20,
      actualReps: sameHandReps,
      targetDuration: config.targetTime,
      beforeDate: undefined, // live session — match any prior date
      setNum: currentSet,
      excludeSessionId: sessionReps?.[0]?.session_id ?? null,
    });
  }, [history, config, currentSet, handForLookup, sessionReps]);
  const targetWeightKg = suggestWeight(refWeights?.[handForLookup] ?? null, 0) || null;
  if (!bundle) return null;
  const inner = (
    <RepCurveChart
      forecasted={bundle.forecasted}
      actual={bundle.actual}
      prevSession={bundle.prevSession}
      asymptoticHold={bundle.asymptoticHold}
      targetS={bundle.targetS}
      targetWeightKg={targetWeightKg}
      unit={unit}
      height={160}
      showLegend={false}
    />
  );
  return embedded ? inner : <Card style={{ marginBottom: 12 }}>{inner}</Card>;
}

// Live recovery-dynamics card — between-rep duration retention
// for the current set. Renders alongside LiveRepCurveCard once
// rep 2 has landed (with only rep 1 there's nothing to plot —
// observed series is just [1.0]). The two charts answer different
// questions on the same data: LiveRepCurveCard shows hold-time
// trajectory; LiveRecoveryCard shows what fraction of rep-1 time
// remains at the same load.
function LiveRecoveryCard({ history, config, currentSet = 1, activeHand, sessionReps, embedded = false }) {
  const bundle = useMemo(() => {
    if (config.mixedDomainPlan) return null;
    const handForLookup = config.hand === "Both" ? (activeHand || "L") : config.hand;
    const sameHandReps = (sessionReps || [])
      .filter(r => r.hand === handForLookup && (r.set_num ?? 1) === currentSet);
    // Rep 2 is the first inter-rep recovery measurement. Until
    // that's in the books there's no recovery to show.
    if (sameHandReps.length < 2) return null;
    const physModel = buildPhysModel(history, handForLookup, config.grip);
    return buildRecoveryBundle({
      reps: sameHandReps,
      restSeconds: config.restTime ?? 20,
      physModel,
    });
  }, [history, config, currentSet, activeHand, sessionReps]);
  if (!bundle) return null;
  if (bundle.eligibility === "descriptive_only") return <p>Activity recorded. Recovery comparison needs measured rest and comparable force.</p>;
  if (bundle.observed.length === 0) return null;
  const inner = (
    <>
    {bundle.confidence === "historical_estimate" && <p>Historical estimate using planned rest.</p>}
    <RecoveryChart
      observed={bundle.observed}
      predicted={bundle.predicted}
      headline={{
        observed: bundle.observedAtTarget,
      }}
      height={140}
      showLegend={false}
    />
    </>
  );
  return embedded ? inner : <Card style={{ marginBottom: 12 }}>{inner}</Card>;
}

// Level display — numeric only, no old badge names. Used by
// SessionSummaryView's level-up animation.
const LEVEL_EMOJIS = ["🌱","🏛️","📈","⚡","⚙️","🔥","🏔️","⭐","💎","🏆","🌟"];


// ──────────────────────────────────────────────────────────────

// SHARED PRIMITIVES

// ──────────────────────────────────────────────────────────────

// BigTimer + ForceGauge moved to ./cards/LiveForceCard.jsx so the
// adaptive warmup hang can use the same primitives. The contracts
// here are unchanged — they're just imported at the top of the file
// now instead of defined inline.

function UnloadedZeroCheck({ tindeq }) {
  if (!tindeq?.zeroForNextRep) return null;
  return <div style={{ marginTop: 16 }}>
    {tindeq.releaseCheckRequired && <p role="status"><strong>Unloaded check required.</strong> Release and zero the handle before continuing.</p>}
    <p>Let the handle hang freely with its attachments in place before zeroing.</p>
    <Btn disabled={!tindeq.connected || tindeq.zeroing} onClick={() => tindeq.zeroForNextRep()}>
      {tindeq.zeroing ? 'Checking unloaded zero…' : 'Handle unloaded — zero Tindeq'}
    </Btn>
    {tindeq.bleError && <p role="alert">{tindeq.bleError}</p>}
  </div>;
}

function ForceLossNotice({ state }) {
  if (!state || (state.status === 'holding' && state.pendingEndTs == null)) return null;
  return <p role="status" style={{ color: C.yellow, fontSize: 22, fontWeight: 700 }}>
    {state.status === 'complete' ? 'Rep complete — release the handle' : 'Checking force dip — return to a steady hold. Time resumes if it recovers.'}
  </p>;
}

function creditedSeconds(state, elapsed) {
  if (!state) return elapsed;
  const start = Object.hasOwn(state, 'pullStartTs') ? state.pullStartTs : state.startTs;
  if (start == null) return '0.0';
  const end = state.status === 'complete' ? state.endTs : state.pendingEndTs ?? state.observedTs;
  return Number.isFinite(end) ? Math.max(0, (end - start) / 1000).toFixed(1) : '0.0';
}

function RepDots({ total, done, current }) {
  return (
    <div style={{ display: "flex", gap: 8, justifyContent: "center", margin: "16px 0" }}>
      {Array.from({ length: total }, (_, i) => {
        const isDone = i < done;
        const isCur  = i === done;
        return (
          <div key={i} style={{
            width: 16, height: 16, borderRadius: "50%",
            background: isDone ? C.green : isCur ? C.blue : C.border,
            border: isCur ? `2px solid ${C.blue}` : "2px solid transparent",
            boxShadow: isCur ? `0 0 8px ${C.blue}` : "none",
            transition: "all 0.2s",
          }} />
        );
      })}
    </div>
  );
}

// Manual-timing offset prompt — shown once at the start of a no-Tindeq
// session (the offset_prompt phase in useSessionRunner). Opting in means
// the user counts "1-2" after failure before tapping Done, and the runner
// subtracts a fixed 2s from every recorded hold this session so the data
// matches real failure time. Tindeq sessions never reach this phase.
export function ManualOffsetPrompt({ onChoose }) {
  return (
    <PageFrame style={{ padding: "20px 16px" }}>
      <Card style={{ textAlign: "center" }}>
        <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 8 }}>Manual timing</div>
        <div style={{ fontSize: 14, color: C.muted, lineHeight: 1.6, marginBottom: 20 }}>
          No Tindeq connected, so you'll tap <b>Done</b> by hand — which always lags
          a beat behind the moment you actually fail.
          <br /><br />
          Use the <b>2-second offset</b>? When you fail, count <b>"one, two"</b> and
          then tap Done. The app subtracts 2s so the recorded hold matches your real
          failure time.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Btn
            onClick={() => onChoose(true)}
            color={C.green}
            style={{ padding: "14px 0", fontSize: 16, borderRadius: 12 }}
          >
            Yes — count 1-2, then tap Done
          </Btn>
          <Btn
            onClick={() => onChoose(false)}
            color={C.muted}
            style={{ padding: "14px 0", fontSize: 16, borderRadius: 12 }}
          >
            No — I'll tap right at failure
          </Btn>
        </div>
      </Card>
    </PageFrame>
  );
}

// ──────────────────────────────────────────────────────────────

// ACTIVE-REP SCREEN (manual flow — no BLE)

// ──────────────────────────────────────────────────────────────

// Manual weight-override persistence across ActiveSessionView remounts.
// This view unmounts on every rest phase (App renders RestView between
// reps), so the override string — if held in local state — reset to ""
// each rep and the next rep silently fell back to the prescribed weight
// (Tom's bug, July 2026). Module-scoped and keyed by sessionId, then by
// hand: L and R are tracked and prescribed independently, so their
// overrides are independent too. The value survives remounts within a
// session but clears when a new session starts (fresh sessionId).
let _overrideBySession = { sessionId: null, byHand: {} };

export function ActiveSessionView({ session, onRepDone, onAbort, tindeq, autoStart = false, visible = true, unit = "lbs", history = [] }) {
  const { config, currentSet = 1, currentRep, activeHand, sessionReps = [] } = session;

  // repPhase: 'ready' (show Start button, first rep only)
  //           'countdown' (3-2-1)
  //           'active' (rep in progress)
  const [repPhase,     setRepPhase]    = useState(autoStart && visible ? "active" : "ready");
  const [countdown,    setCountdown]   = useState(3);
  const [elapsed,      setElapsed]     = useState(0);
  // Raw display-unit string, NOT kg. The input used to round-trip
  // through fmtW(toFixed(1)) on every keystroke, which made multi-
  // digit weights untypable ("12" → "1.0" after the first key) and
  // drifted values through double kg↔lbs conversion. Keep what the
  // user typed; convert to kg only where consumed (targetKg).
  // Hydrate the override from the module-scoped store so it persists
  // across this view's per-rep remount; write-through on every change.
  // Keyed by hand so L and R hold independent override weights (both-mode
  // does all L reps then all R; single-hand sessions use just that hand).
  const sessionKey = session.sessionId;
  const overrideHand = config.hand === "Both" ? activeHand : config.hand;
  // Mixed-load holds need their own override; ordinary sets retain one per hand.
  const overrideKey = config.mixedDomainPlan ? `${overrideHand}:${currentRep}` : overrideHand;
  const [manualWeightStr, setManualWeightStrState] = useState(
    () => (_overrideBySession.sessionId === sessionKey
      ? (_overrideBySession.byHand[overrideKey] ?? "")
      : "")
  );
  const setManualWeightStr = useCallback((v) => {
    const byHand = _overrideBySession.sessionId === sessionKey
      ? _overrideBySession.byHand
      : {};
    _overrideBySession = {
      sessionId: sessionKey,
      byHand: { ...byHand, [overrideKey]: v },
    };
    setManualWeightStrState(v);
  }, [sessionKey, overrideKey]);
  const startTimeRef = useRef(null);
  const timerRef     = useRef(null);
  // Latest manual weight override in kg. endRep (a stable useCallback) reads
  // this at rep-completion time; without the ref it would close over a stale
  // manualKg (or need manualKg in its deps). Kept in sync every render below.
  const manualKgRef  = useRef(null);

  // Suggested weight per hand — held constant in ordinary sets. The beta
  // runner provides a new reference for each domain. We don't
  // fatigue-discount the displayed weight; the user holds the same load
  // each rep and we track how actual_time_s decays. See also AutoRepSessionView.

  const suggestions = useMemo(() => {
    const handList = config.hand === "Both" ? ["L", "R"] : [config.hand];
    return Object.fromEntries(
      handList.map(h => [h, {
        suggested: suggestWeight(session.refWeights?.[h] ?? null, 0),
      }])
    );
  }, [config.hand, session.refWeights]);

  const [startError, setStartError] = useState(null);
  const usedDeviceRef = useRef(false);
  const startAttemptRef = useRef(0);
  const endingRef = useRef(false);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  // Actually start recording the rep
  const startRep = useCallback(async () => {
    if (!visibleRef.current || endingRef.current || startTimeRef.current != null) return;
    const attempt = ++startAttemptRef.current;
    usedDeviceRef.current = tindeq.connected;
    setElapsed(0);
    startTimeRef.current = Date.now();
    setRepPhase("active");
    setStartError(null);
    if (tindeq.connected) {
      try {
        if (await tindeq.tare() === false) throw new Error("Tare failed");
        if (attempt !== startAttemptRef.current || !visibleRef.current) return;
        await tindeq.startMeasuring();
      } catch {
        if (attempt !== startAttemptRef.current) return;
        startTimeRef.current = null;
        setRepPhase("ready");
        setStartError("Tindeq could not start. Reconnect and try this rep again.");
        return;
      }
    }
  }, [tindeq]);

  // A hidden session may finish its rest, but cannot start a manual pull.
  useEffect(() => {
    if (autoStart && visible) startRep();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, visible]);

  useEffect(() => {
    if (repPhase !== 'active') return;
    timerRef.current = setInterval(() => {
      if (startTimeRef.current != null) setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 100);
    return () => clearInterval(timerRef.current);
  }, [repPhase]);

  // 3-2-1 countdown
  useEffect(() => {
    if (repPhase !== "countdown" || !visible) return;
    if (countdown <= 0) { startRep(); return; }
    const t = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [repPhase, countdown, startRep, visible]);

  // Tracks whether this rep was ended by auto-failure (vs manual tap).
  const autoFailedRef = useRef(false);

  // End rep — called by manual tap (failed=false) or auto-failure (failed=true).
  const endRep = useCallback(async (interrupted = false, endSession = false) => {
    if (startTimeRef.current == null) return;
    startAttemptRef.current++;
    endingRef.current = true;
    const failed = autoFailedRef.current;
    autoFailedRef.current = false;
    clearInterval(timerRef.current);
    const startedAtMs = startTimeRef.current;
    const endedAtMs = Date.now();
    const actualTime = (endedAtMs - startedAtMs) / 1000;
    startTimeRef.current = null;
    setRepPhase("finishing");
    // Use the completed measurement; manual reps must not reuse stale BLE stats.
    let avgForce = null;
    let peakForce = null;
    let measurement = {};
    if (usedDeviceRef.current) {
      const stats = await tindeq.stopMeasuring();
      measurement = finalizeDeviceActivity(stats, startedAtMs, endedAtMs, interrupted === true || !tindeq.connected);
      avgForce = stats.avgForce;
      peakForce = stats.peakForce;
    }
    // manualLoadKg (non-Tindeq / override): the load the user actually
    // lifted this rep. For manual sessions it's the ONLY load signal —
    // without it the rep persists load=0 and every downstream fit reads
    // zero (the elcerritotom bug, July 2026). Tindeq reps still prefer the
    // measured avg_force_kg via effectiveLoad, so this is a no-op there.
    onRepDone({ actualTime, avgForce, peakForce, failed, startedAtMs, endedAtMs, ...measurement,
      failureValid: interrupted === true ? false : (measurement.failureValid ?? true),
      endReason: interrupted === true ? "interrupted" : (measurement.endReason ?? "muscular_failure"),
      manualLoadKg: manualKgRef.current, endSession });
  }, [tindeq, onRepDone]);

  useEffect(() => {
    if (visible) return;
    if (startTimeRef.current != null) endRep(true);
    else if (repPhase === 'countdown') { setRepPhase('ready'); setCountdown(3); }
  }, [visible, endRep, repPhase]);

  // Wire auto-failure → endRep for the duration of an active rep only.
  // Cleanup nulls the callback whenever phase changes or the component unmounts,
  // eliminating the stale-ref gap that caused auto-fail to silently stop working
  // after the first rep.
  useEffect(() => {
    if (repPhase !== "active") {
      tindeq.setAutoFailCallback(null);
      return;
    }
    tindeq.setAutoFailCallback(() => {
      autoFailedRef.current = true;
      endRep();
    });
    return () => tindeq.setAutoFailCallback(null);
  }, [tindeq, repPhase, endRep]);

  useEffect(() => () => clearInterval(timerRef.current), []);

  // Active suggestion follows the active hand (or the only configured hand)
  const activeSugHand = config.hand === "Both" ? activeHand : config.hand;
  const sug = suggestions[activeSugHand] ?? null;

  // Effective target weight in kg for color-coding and auto-failure threshold
  const manualKg = (() => {
    const n = parseFloat(manualWeightStr);
    return Number.isFinite(n) && n > 0 ? fromDisp(n, unit) : null;
  })();
  manualKgRef.current = manualKg;
  const targetKg = manualKg ?? sug?.suggested ?? null;

  // Keep the Tindeq hook's target ref in sync so auto-failure uses the right threshold
  useEffect(() => {
    if (visible) tindeq.targetKgRef.current = repPhase === "active" ? targetKg : null;
  }, [tindeq.targetKgRef, repPhase, targetKg, visible]);

  return (
    <PageFrame style={{ padding: "20px 16px" }}>
      {/* Header — single-set under curve-trust commit C; just show
          grip + hand. The "Set X of Y" line is gone. */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>
            {config.grip} · {config.hand === "Both"
              ? (activeHand === "L" ? "Left Hand" : "Right Hand")
              : config.hand === "L" ? "Left" : "Right"}
          </div>
        </div>
        <Btn small color={C.red} onClick={() => {
          if (endingRef.current) return;
          if (startTimeRef.current != null) endRep(true, true);
          else onAbort();
        }} disabled={repPhase === "finishing"}>End Session</Btn>
      </div>

      {startError && <p role="alert" style={{ color: C.red }}>{startError}</p>}
      <TindeqBattery battery={tindeq.battery} connected={tindeq.connected} warningOnly />
      {tindeq.signalRecovering && <div role="status" style={{ color: C.orange }}>
        Waiting for the Tindeq signal. Your recorded effort is being kept.
      </div>}
      <RepDots total={config.repsPerSet} done={currentRep} current={currentRep} />
      <MixedHoldInfo config={config} currentRep={currentRep} />
      <p>Target time guides the prescribed load. Maintain the prescribed force until muscular failure.</p>


      {/* Phase cards (countdown / timer / ready) render FIRST so the
          timer never scrolls below the fold mid-rep — the live charts
          moved below the controls (June 2026). During a hang you need
          the clock, not the forecast. */}

      {/* Countdown overlay */}
      {repPhase === "countdown" && (
        <Card style={{ textAlign: "center", padding: "40px 0" }}>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 8 }}>Get ready…</div>
          <div style={{ fontSize: 96, fontWeight: 900, color: C.yellow, lineHeight: 1 }}>
            {countdown === 0 ? "GO" : countdown}
          </div>
          <div style={{ fontSize: 14, color: C.muted, marginTop: 8 }}>
            {fmtW(sug?.suggested ?? 0, unit)} {unit}
          </div>
        </Card>
      )}

      {/* Timer (shown during active rep) */}
      {repPhase === "active" && (
        <Card>
          <ForceLossNotice state={tindeq.forceLoss} />
          <BigTimer seconds={Number(creditedSeconds(tindeq.forceLoss, elapsed))} targetSeconds={config.targetTime} running={tindeq.forceLoss?.status !== 'complete' && tindeq.forceLoss?.pendingEndTs == null} referenceOnly={!!config.mixedDomainPlan} />
          {tindeq.connected ? (
            <ForceGauge force={tindeq.force} avg={tindeq.avgForce} peak={tindeq.peak} targetKg={targetKg} unit={unit} />
          ) : (
            <div style={{ fontSize: 12, color: C.muted, textAlign: "center", marginTop: 8 }}>
              No Tindeq — tap Done at muscular failure.
            </div>
          )}
        </Card>
      )}

      {/* Weight suggestion (shown when ready) */}
      {repPhase === "ready" && (
        <Card>
          {/* Big active-hand indicator so it's obvious which hand to use */}
          {config.hand === "Both" && (
            <div style={{ textAlign: "center", marginBottom: 12 }}>
              <div style={{
                fontSize: 13, color: C.muted, letterSpacing: 1.2,
                textTransform: "uppercase", marginBottom: 2,
              }}>Use your</div>
              <div style={{
                fontSize: 26, fontWeight: 900,
                color: activeHand === "R" ? C.orange : C.blue,
              }}>
                {activeHand === "R" ? "✋ Right Hand" : "🤚 Left Hand"}
              </div>
            </div>
          )}
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 8 }}>
            Rep {currentRep + 1} suggested weight
          </div>
          <div style={{ fontSize: 36, fontWeight: 800, color: C.blue }}>
            {sug?.suggested != null ? `${fmtW(sug.suggested, unit)} ${unit}` : "—"}
          </div>
          <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="number" min={0} step={0.5}
              value={manualWeightStr}
              onChange={e => setManualWeightStr(e.target.value)}
              placeholder={`Override ${unit}…`}
              style={{ width: 120, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px", color: C.text, fontSize: 15 }}
            />
            <span style={{ fontSize: 12, color: C.muted }}>{unit} (override)</span>
          </div>
        </Card>
      )}

      {repPhase === 'ready' && tindeq.connected && <UnloadedZeroCheck tindeq={tindeq} />}
      {/* Controls */}
      <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
        {repPhase === "ready" && (
          <Btn
            disabled={tindeq.releaseCheckRequired || tindeq.zeroing}
            onClick={() => { setCountdown(3); setRepPhase("countdown"); }}
            style={{ flex: 1, padding: "18px 0", fontSize: 18, borderRadius: 12 }}
            color={C.green}
          >
            ▶ Start Rep
          </Btn>
        )}
        {repPhase === "active" && (
          <Btn
            onClick={() => endRep()}
            disabled={tindeq.connected && tindeq.forceLoss?.status === 'complete'}
            style={{ flex: 1, padding: "18px 0", fontSize: 18, borderRadius: 12 }}
            color={C.red}
          >
            Done — muscular failure
          </Btn>
        )}
      </div>

      {repPhase === "active" && <Btn onClick={() => endRep(true)}>Rep interrupted</Btn>}

      {/* Live rep-curve preview — forecasted vs. actual so far, with
          last-session overlay and asymptotic floor. Re-seeds from rep
          1's actual time once it lands so the forecast tracks the
          user's actual capacity for this session. Rendered below the
          timer + controls so the clock stays on-screen during a hang;
          these are between-rep reading material. */}
      <div style={{ marginTop: 12 }}>
        <LiveRepCurveCard
          history={history}
          config={config}
          currentSet={currentSet}
          activeHand={activeHand}
          sessionReps={sessionReps}
          refWeights={session.refWeights}
          unit={unit}
        />

        <LiveRecoveryCard
          history={history}
          config={config}
          currentSet={currentSet}
          activeHand={activeHand}
          sessionReps={sessionReps}
        />
      </div>
    </PageFrame>
  );
}

// ──────────────────────────────────────────────────────────────

// REST / SWITCH-HANDS / BETWEEN-SETS / SUMMARY

// ──────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────
function playBeep(freq = 880, duration = 0.12, volume = 0.4) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
    osc.onended = () => ctx.close();
  } catch { /* audio not available */ }
}

export function RestView({ lastRep, nextWeight, nextDomain = null, nextAdjustment = null, restSeconds, onRestDone, repNum, repsPerSet, unit = "lbs", tindeq = null }) {
  // Wall-clock countdown, NOT tick-counted. The old version decremented
  // once per setInterval fire; background tabs / locked phones throttle
  // intervals to ≥1/min, so a 20s rest silently stretched to minutes —
  // exactly when the user pockets the phone between hangs. Deadline math
  // (same pattern as WarmupView) survives throttling: a late tick just
  // jumps the display to the correct remaining time. Side effects
  // (beeps, onRestDone) live in effects keyed off `remaining`, not
  // inside the setState updater — StrictMode double-invokes updaters,
  // which double-fired the beep and the phase transition in dev.
  const releaseBlocked = !!(tindeq?.releaseCheckRequired || tindeq?.zeroing);
  const wasBlockedRef = useRef(releaseBlocked);
  const mountedAtRef = useRef(Date.now());
  const restStartedAtMs = Number.isFinite(lastRep?.restStartedAtMs)
    ? Math.min(mountedAtRef.current, lastRep.restStartedAtMs) : mountedAtRef.current;
  const [remaining, setRemaining] = useState(() => Math.max(0,
    Math.ceil((restStartedAtMs + restSeconds * 1000 - Date.now()) / 1000)));
  const deadlineRef = useRef(null);
  const intervalRef = useRef(null);
  const lastBeepRef = useRef(null);
  const doneRef     = useRef(false);

  useEffect(() => {
    if (releaseBlocked) {
      wasBlockedRef.current = true;
      setRemaining(restSeconds);
      return;
    }
    // Release confirmation and rendering can take time. Credit that time;
    // the weaker pulling tail before physical release is never rest.
    deadlineRef.current = (wasBlockedRef.current ? Date.now() : restStartedAtMs) + restSeconds * 1000;
    wasBlockedRef.current = false;
    const tick = () => {
      const left = Math.max(0, Math.ceil((deadlineRef.current - Date.now()) / 1000));
      setRemaining(left);
    };
    tick();
    if (!doneRef.current) intervalRef.current = setInterval(tick, 250);
    return () => clearInterval(intervalRef.current);
  }, [restSeconds, restStartedAtMs, releaseBlocked]);

  useEffect(() => {
    if (releaseBlocked) return;
    if (remaining <= 3 && remaining >= 1 && lastBeepRef.current !== remaining) {
      lastBeepRef.current = remaining;
      playBeep(remaining === 1 ? 1100 : 880);
    }
    if (remaining === 0 && !doneRef.current) {
      doneRef.current = true;
      clearInterval(intervalRef.current);
      onRestDone();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remaining, releaseBlocked]);

  const pct = remaining / restSeconds;
  // This timer is only between pulls within the current set. Optional
  // extra sets start from the summary without a prescribed rest timer.
  const isLastRepInSet = repNum >= repsPerSet;

  return (
    <PageFrame style={{ padding: "20px 16px" }}>
      <Card>
        <div style={{ textAlign: "center", paddingBottom: 8 }}>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 4 }}>
            {isLastRepInSet
              ? "Session complete!"
              : `Rest — rep ${repNum} of ${repsPerSet}`}
          </div>
          <div style={{ fontSize: releaseBlocked ? 28 : 64, fontWeight: 800, color: pct > 0.3 ? C.green : C.orange, lineHeight: 1 }}>
            {releaseBlocked ? 'Release check' : `${remaining}s`}
          </div>
          <div style={{ marginTop: 10, height: 6, background: C.border, borderRadius: 3, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${pct * 100}%`, background: C.green, borderRadius: 3, transition: "width 1s linear" }} />
          </div>
        </div>
      </Card>

      {releaseBlocked && <Card><p>Your hold is saved. Rest starts after this check.</p><UnloadedZeroCheck tindeq={tindeq} /></Card>}

      {/* OVER-PULL WARNING (July 2026, per Nathan). Spring/anchor
          setups let the user pull whatever they like — and pulling
          well over the prescribed load is what quietly collapsed the
          June 2026 sessions (opener at +18% looks strong, then reps
          2+ die at 15-30s and the session's stimulus lands in the
          wrong zone). Flag it during rest, when there's still time to
          ease off for the remaining reps. Threshold 110%: the same
          ~10% grid the ladder's steps use; ordinary Tindeq noise sits
          well inside it. */}
      {!nextDomain && lastRep && lastRep.prescribedWeight > 0 && lastRep.avgForce > lastRep.prescribedWeight * 1.1 && !isLastRepInSet && (
        <Card style={{ borderColor: C.orange }}>
          <div style={{ fontSize: 13, color: C.orange, fontWeight: 700, marginBottom: 4 }}>
            Pulling {Math.round((lastRep.avgForce / lastRep.prescribedWeight - 1) * 100)}% over prescription
          </div>
          <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
            Avg {fmtW(lastRep.avgForce, unit)} {unit} vs {fmtW(lastRep.prescribedWeight, unit)} {unit} prescribed.
            Heavier feels strong on rep 1, but the next reps won't recover in {restSeconds}s — ease off toward the prescription to keep the set in its zone.
          </div>
        </Card>
      )}

      {lastRep && (
        <Card>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 8 }}>Last rep result</div>
          <div style={{ display: "flex", gap: 32 }}>
            <div>
              <Label>Time</Label>
              <span style={{
                fontSize: 28, fontWeight: 700,
                color: nextDomain ? C.text : displayedRepTime(lastRep.actualTime, lastRep.forceRecording) >= lastRep.targetTime ? C.green : C.red,
              }}>
                {Math.round(displayedRepTime(lastRep.actualTime, lastRep.forceRecording))}s
              </span>
              <div style={{ fontSize: 11, color: C.muted }}>{nextDomain && !lastRep.forceRecording?.session_protocol?.target_outcome ? 'fresh reference' : 'target'} {lastRep.targetTime}s</div>
            </div>
            {lastRep.avgForce > 0 && (
              <div>
                <Label>Avg Force</Label>
                <span style={{ fontSize: 28, fontWeight: 700, color: C.blue }}>
                  {fmtW(lastRep.avgForce, unit)} {unit}
                </span>
              </div>
            )}
            {lastRep.peakForce > 0 && (
              <div>
                <Label>Peak Force</Label>
                <span style={{ fontSize: 28, fontWeight: 700, color: C.orange }}>
                  {fmtW(lastRep.peakForce, unit)} {unit}
                </span>
              </div>
            )}
          </div>
          {['met', 'missed'].includes(lastRep.forceRecording?.session_protocol?.target_outcome) && <p style={{ color: lastRep.forceRecording.session_protocol.target_outcome === 'met' ? C.green : C.orange }}>
            {lastRep.forceRecording.session_protocol.target_outcome === 'met' ? 'Target met' : 'Target missed'}
          </p>}
          <RepResultDetails rep={{ failure_valid: lastRep.failureValid, end_reason: lastRep.endReason,
            force_recording: lastRep.forceRecording, load_provenance: lastRep.loadProvenance }}>
            {lastRep.endReason === "equipment_interruption" && <InterruptedBatteryNote battery={lastRep.forceRecording?.battery} />}
            {lastRep.restBefore != null && <p>Actual rest before this rep: {lastRep.restBefore.toFixed(1)}s.</p>}
            {lastRep.forceRecording?.plateau?.duration_s > 0 && <p>
              Strong phase: {fmtW(lastRep.forceRecording.plateau.avg_force_kg, unit)} {unit} for {lastRep.forceRecording.plateau.duration_s.toFixed(1)}s.
            </p>}
            <p>{lastRep.forceRecording?.duration_basis === "elapsed_activity_estimate" ? "Elapsed activity time estimated; no measured hold duration available." : lastRep.avgForce > 0 ? `${fmtW(lastRep.avgForce, unit)} ${unit} time-weighted average over ${lastRep.actualTime.toFixed(1)}s.` : "Manually timed effort."}</p>
          </RepResultDetails>
        </Card>
      )}

      {nextWeight != null && !isLastRepInSet && (
        <Card style={{ borderColor: C.blue }}>
          <Label>{nextAdjustment?.status === 'adjusted' ? 'New target weight' : 'Next target weight'}</Label>
          {nextDomain && <p><strong>{MIXED_DOMAIN_LABELS[nextDomain]}</strong> · Pull to this target on your next hold.</p>}
          {mixedAdjustmentText(nextAdjustment) && <p>{mixedAdjustmentText(nextAdjustment)}</p>}
          <div style={{ fontSize: 36, fontWeight: 800, color: C.blue }}>
            {fmtW(nextWeight, unit)} {unit}
          </div>
        </Card>
      )}

      <Btn disabled={releaseBlocked}
        onClick={() => {
          if (doneRef.current || releaseBlocked) return;   // already transitioned or release unknown
          doneRef.current = true;
          clearInterval(intervalRef.current);
          onRestDone();
        }}
        style={{ width: "100%", padding: "14px 0", fontSize: 16, borderRadius: 12 }}
        color={C.muted}
      >
        Skip rest →
      </Btn>
    </PageFrame>
  );
}

export function SwitchHandsView({ onReady, activeHand = "R" }) {
  // Wall-clock countdown — see RestView for the rationale.
  const SWITCH_SECONDS = 10;
  const [remaining, setRemaining] = useState(SWITCH_SECONDS);
  const deadlineRef = useRef(null);
  const intervalRef = useRef(null);
  const doneRef     = useRef(false);

  useEffect(() => {
    deadlineRef.current = Date.now() + SWITCH_SECONDS * 1000;
    doneRef.current = false;
    const tick = () => {
      setRemaining(Math.max(0, Math.ceil((deadlineRef.current - Date.now()) / 1000)));
    };
    intervalRef.current = setInterval(tick, 250);
    return () => clearInterval(intervalRef.current);
  }, []);

  useEffect(() => {
    if (remaining === 0 && !doneRef.current) {
      doneRef.current = true;
      clearInterval(intervalRef.current);
      onReady();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remaining]);

  return (
    <PageFrame style={{ padding: "40px 16px", textAlign: "center" }}>
      <div style={{ fontSize: 56 }}>🤚➡️✋</div>
      <h2 style={{ margin: "16px 0 8px" }}>Switch to {activeHand === "R" ? "Right" : "Left"} Hand</h2>
      <p style={{ color: C.muted, marginBottom: 24 }}>{activeHand === "R" ? "Left" : "Right"} hand complete. Get ready to train {activeHand === "R" ? "right" : "left"} hand.</p>
      <div style={{ fontSize: 80, fontWeight: 900, color: remaining > 3 ? C.green : C.orange, lineHeight: 1, marginBottom: 24 }}>
        {remaining}
      </div>
      <Btn onClick={() => {
        if (doneRef.current) return;
        doneRef.current = true;
        clearInterval(intervalRef.current);
        onReady();
      }}
        style={{ padding: "14px 40px", fontSize: 16, borderRadius: 12 }}>
        Ready →
      </Btn>
    </PageFrame>
  );
}

// Selected sets rest after the final hand; legacy optional Chaos additions
// use a same-hand clock. Both start from physical release, never mounting,
// and reaching zero never starts a rep.
export function BetweenSetRestView({ startedAtMs, restSeconds = 300, hand = 'L',
  source = 'estimated_transition', setNumber = 2, fullSetBreak = false, onReady, onFinish, tindeq }) {
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [extraSeconds, setExtraSeconds] = useState(0);
  const doneRef = useRef(false);
  const origin = Number.isFinite(startedAtMs) ? Math.min(mountedAt, startedAtMs) : mountedAt;
  const remaining = Math.max(0, Math.ceil((origin + (restSeconds + extraSeconds) * 1000 - now) / 1000));
  const releaseBlocked = !!(tindeq?.releaseCheckRequired || tindeq?.zeroing);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  const finish = handler => {
    if (doneRef.current) return;
    doneRef.current = true;
    handler?.();
  };
  return <PageFrame style={{ padding: '32px 16px', textAlign: 'center' }}>
    <h2 style={{ margin: '0 0 18px' }}>Rest before set {setNumber}</h2>
    <HandCue hand={hand} />
    <Card>
      <div style={{ fontSize: 64, fontWeight: 900, color: remaining ? C.blue : C.green }} aria-live="off">
        {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}
      </div>
      <p style={{ color: C.muted }}>{fullSetBreak ? 'Five-minute break between sets. Start when you are ready.'
        : 'Five minutes for this hand. Time spent training your other hand counts.'}</p>
      {source === 'estimated_transition' && <p style={{ color: C.muted }}>
        Rest is estimated from when the last hold was recorded because its release time was not captured.
      </p>}
      {remaining === 0 && <p>Ready for set {setNumber} when you are.</p>}
      {releaseBlocked && <UnloadedZeroCheck tindeq={tindeq} />}
    </Card>
    <Btn onClick={() => finish(onReady)} disabled={releaseBlocked}
      style={{ width: '100%', marginBottom: 12, padding: '14px 0' }}>
      {remaining > 0 ? 'Start when ready' : `Start set ${setNumber}`}
    </Btn>
    <div style={{ display: 'flex', gap: 12 }}>
      <Btn color={C.muted} onClick={() => setExtraSeconds(s =>
        Math.max(s + 60, (Date.now() - origin) / 1000 - restSeconds + 60))} style={{ flex: 1 }}>Rest another minute</Btn>
      <Btn color={C.muted} onClick={() => finish(onFinish)} style={{ flex: 1 }}>Finish today</Btn>
    </div>
  </PageFrame>;
}

// (AltSwitchView removed — alternating-hand mode was retired with
// the flat-20s-rest workout flow; Both-mode now does all L hangs then
// all R hangs, with the existing HandSwitchView prompt covering the
// single switch.)

export function SessionSummaryView({
  reps, config, leveledUp, newLevel, currentSet = 1, onAddSet, onDone,
  history = [], unit = "lbs",
}) {
  const sets = useMemo(() => {
    const groups = {};
    for (const r of reps) {
      const k = r.set_num ?? 1;
      if (!groups[k]) groups[k] = [];
      groups[k].push(r);
    }
    return Object.entries(groups).map(([s, rs]) => ({ setNum: Number(s), reps: rs }));
  }, [reps]);

  const totalReps  = reps.length;
  const avgTime    = totalReps > 0 ? reps.reduce((a, r) => a + r.actual_time_s, 0) / totalReps : 0;
  // "Top weight" here means the heaviest prescribed load across the
  // set — what the program told the athlete to lift. Tindeq avg force
  // varies rep-to-rep with effort, so reading prescribed_load_kg (with
  // legacy fallback) keeps this row reading "today's session was @ 33kg"
  // rather than swinging with effort fluctuations.
  const maxWeight  = Math.max(...reps.map(r => prescribedLoad(r)), 0);
  const hasForce   = reps.some(r => r.avg_force_kg > 0 && r.avg_force_kg < 500);
  // Peak across the whole session — only meaningful when we have
  // any peak readings at all. The Tindeq stream populates it for
  // both manual and auto-rep sessions; older reps logged before
  // peak capture was wired will be null and excluded from the max.
  const sessionPeak = reps.reduce((m, r) =>
    (r.peak_force_kg > 0 && r.peak_force_kg < 500 && r.peak_force_kg > m) ? r.peak_force_kg : m,
    0);
  const hasPeak    = sessionPeak > 0;
  const volume = config.volumePlan?.id === 'volume_beta' && !config.mixedDomainPlan && !config.peakTest;
  const setComplete = volume ? isVolumeSetComplete(reps, config, currentSet)
    : isSetComplete({ sessionReps: reps, config, setNum: currentSet });
  const setSuggestion = useMemo(() => volume ? null : recommendAnotherSet({
    history, sessionReps: reps, config, setNum: currentSet,
  }), [history, reps, config, currentSet, volume]);

  return (
    <PageFrame style={{ padding: "20px 16px" }}>
      {leveledUp && (
        <Card style={{ background: "#1c1f0a", borderColor: C.green, marginBottom: 20 }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 48 }}>{LEVEL_EMOJIS[Math.min(newLevel - 1, LEVEL_EMOJIS.length - 1)]}</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: C.green }}>Level Up!</div>
            <div style={{ fontSize: 16, color: C.text, marginTop: 4 }}>
              {levelTitle(newLevel)}
            </div>
            <div style={{ fontSize: 13, color: C.muted, marginTop: 6 }}>
              5% load improvement — keep going
            </div>
          </div>
        </Card>
      )}

      <h2 style={{ margin: "0 0 16px", fontSize: 22 }}>
        {setComplete ? (volume && currentSet === 2 ? 'Volume Beta Complete' : config.mixedDomainPlan ? `Chaos Machine · Set ${currentSet} Complete` : currentSet === 1 ? "Recommended Set Complete" : `Set ${currentSet} Complete`) : "Session Ended Early"}
      </h2>
      {!volume && config.plannedSets > 1 && <p style={{ color: C.muted }}>{config.plannedSets} sets per hand selected. Continue when ready, or finish today.</p>}
      {config.mixedDomainPlan && <p>Chaos Machine (Beta). Only eligible opening holds from set one can update the curve; later holds and sets are recorded as fatigued work. Your regular rep progression is unchanged.</p>}

      {(() => {
        const op = sessionOverpull(reps);
        return op.isOver ? (
          <Card style={{ borderColor: C.orange, marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.orange, marginBottom: 4 }}>
              You trained ~{op.pct}% over the target weight
            </div>
            <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.5 }}>
              Next time, hold the prescribed load to failure. The model learns from where
              you actually fail, so staying on target gives cleaner data and better progress.
            </div>
          </Card>
        ) : null;
      })()}

      <Card>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, textAlign: "center" }}>
          <div>
            <Label>Total Reps</Label>
            <div style={{ fontSize: 28, fontWeight: 700 }}>{totalReps}</div>
          </div>
          <div>
            <Label>Avg Time</Label>
            <div style={{ fontSize: 28, fontWeight: 700 }}>{fmtTime(avgTime)}</div>
          </div>
          <div>
            <Label>Top Weight</Label>
            <div style={{ fontSize: 28, fontWeight: 700 }}>{fmtW(maxWeight, unit)} {unit}</div>
          </div>
          {hasForce && (
            <div>
              <Label>Avg Force (Tindeq)</Label>
              <div style={{ fontSize: 22, fontWeight: 700, color: C.green }}>
                {fmtW(reps.reduce((a, r) => a + (r.avg_force_kg || 0), 0) / reps.filter(r => r.avg_force_kg > 0).length, unit)} {unit}
              </div>
            </div>
          )}
          {hasPeak && (
            <div>
              <Label>Peak Force</Label>
              <div style={{ fontSize: 22, fontWeight: 700, color: C.orange }}>
                {fmtW(sessionPeak, unit)} {unit}
              </div>
            </div>
          )}
        </div>
      </Card>

      {sets.map(({ setNum, reps: sReps }) => (
        <Card key={setNum}>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 10 }}>Set {setNum}</div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ color: C.muted }}>
                <th style={{ textAlign: "left", paddingBottom: 6 }}>Rep</th>
                <th style={{ textAlign: "right", paddingBottom: 6 }}>Weight</th>
                <th style={{ textAlign: "right", paddingBottom: 6 }}>Time</th>
                {hasForce && <th style={{ textAlign: "right", paddingBottom: 6 }}>Avg F</th>}
                {hasPeak  && <th style={{ textAlign: "right", paddingBottom: 6 }}>Peak F</th>}
              </tr>
            </thead>
            <tbody>
              {sReps.map(r => (
                <tr key={r.id || `${r.hand}-${r.rep_num}`} style={{ borderTop: `1px solid ${C.border}` }}>
                  <td style={{ padding: "6px 0" }}>{r.hand} {r.rep_num}
                    {isMixedDomainRep(r) && <div>{MIXED_DOMAIN_LABELS[mixedDomainMetadata(r).zone]}</div>}
                    <RepResultDetails rep={r}>
                      {r.end_reason === "equipment_interruption" && <InterruptedBatteryNote battery={r.force_recording?.battery} />}
                    </RepResultDetails>
                  </td>
                  <td style={{ textAlign: "right" }}>{fmtW(prescribedLoad(r), unit)} {unit}</td>
                  <td style={{ textAlign: "right", color: isMixedDomainRep(r) ? C.text : displayedRepTime(r.actual_time_s, r.force_recording) >= r.target_duration ? C.green : C.red }}>
                    {fmtTime(displayedRepTime(r.actual_time_s, r.force_recording))}
                  </td>
                  {hasForce && (
                    <td style={{ textAlign: "right", color: C.green }}>
                      {r.avg_force_kg > 0 ? `${fmtW(r.avg_force_kg, unit)} ${unit}` : "—"}
                    </td>
                  )}
                  {hasPeak && (
                    <td style={{ textAlign: "right", color: C.orange }}>
                      {r.peak_force_kg > 0 ? `${fmtW(r.peak_force_kg, unit)} ${unit}` : "—"}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ))}

      {volume && currentSet === 1 && setComplete && onAddSet && <Card>
        <strong>Volume Beta: second set planned</strong>
        <p style={{ color: C.muted }}>Same target weights and holds. Each hand gets five minutes of rest, including time spent training the other hand.</p>
        <Btn onClick={onAddSet} style={{ width: '100%', padding: '14px 0' }}>Continue to set 2</Btn>
      </Card>}

      {!volume && !config.peakTest && (!config.mixedDomainPlan || setComplete) && currentSet < MAX_OPTIONAL_SETS && onAddSet && (
        <>
          {setSuggestion?.recommend && (
            <div style={{
              marginBottom: 10, padding: "10px 12px", borderRadius: 10,
              background: C.green + "18", border: `1px solid ${C.green}55`,
              color: C.text, fontSize: 13, lineHeight: 1.45,
            }}>
              <strong style={{ color: C.green }}>Good set.</strong>{" "}
              {setSuggestion.text}
            </div>
          )}
          <Btn onClick={onAddSet} style={{ width: "100%", marginBottom: 12, padding: "14px 0" }}>
            {currentSet < (config.plannedSets || 1) ? `Continue to set ${currentSet + 1} of ${config.plannedSets}` : `+ Add another set (${currentSet + 1} of ${MAX_OPTIONAL_SETS})`}
          </Btn>
        </>
      )}

      <div style={{ display: "flex", gap: 12 }}>
        <Btn onClick={() => downloadCSV(reps)} color={C.muted} style={{ flex: 1 }}>
          ↓ Export CSV
        </Btn>
        <Btn onClick={onDone} style={{ flex: 2 }}>
          {volume || config.plannedSets > 1 ? 'Finish today' : 'Back to Setup'}
        </Btn>
      </div>
    </PageFrame>
  );
}

// ──────────────────────────────────────────────────────────────

// AUTO-REP SCREEN (Tindeq-driven flow)

// ──────────────────────────────────────────────────────────────

export function AutoRepSessionView({ session, onRepDone, onAbort, tindeq, visible = true, unit = "lbs", history = [] }) {
  const { config, currentSet = 1, currentRep, activeHand, refWeights, sessionReps = [] } = session;
  const handLabel = config.hand === "Both"
    ? (activeHand === "L" ? "Left Hand" : "Right Hand")
    : config.hand === "L" ? "Left Hand" : "Right Hand";

  // Program-recommended target weight for the active hand.
  // Held constant in ordinary sets; the beta runner changes it per domain.
  // In ordinary sets the user hangs the same load each rep and
  // we record how actual_time_s changes. Those rep-time curves then feed
  // the next session's prescription via the three-exp curve fit. We
  // intentionally do NOT discount the suggested weight by within-set
  // fatigue.
  const suggestedKg = useMemo(
    () => suggestWeight(refWeights?.[activeHand] ?? null, 0),
    [refWeights, activeHand]
  );

  // Explicit pre-pull selection; never infer a new target from sagging force.
  // The program prescription stays intact, while the chosen target controls
  // acquisition, averaging and force-loss detection for this attempt.
  const [targetInput, setTargetInput] = useState('');
  const inputKg = fromDisp(Number(targetInput), unit);
  const manualKg = targetInput.trim() && Number.isFinite(inputKg) && inputKg > 0 && inputKg < 200 ? inputKg : null;
  const targetKg = manualKg ?? suggestedKg;
  const chosenTargetRef = useRef(null);
  chosenTargetRef.current = manualKg;
  const repManualKgRef = useRef(null);

  // Keep Tindeq's target ref in sync so the force gauge & auto-fail threshold
  // reflect the explicitly chosen target during the rep.
  useEffect(() => {
    if (visible) tindeq.targetKgRef.current = targetKg;
  }, [tindeq.targetKgRef, targetKg, visible]);

  const [startError, setStartError] = useState(null);
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [repActive, setRepActive] = useState(false);
  const [elapsed,   setElapsed]   = useState(0);
  const startTimeRef = useRef(null);
  const timerRef     = useRef(null);
  // Re-entrancy guard for handleRepEnd. BLE force-stream noise can make
  // auto-detect fire onRepEnd twice for one physical rep; without a
  // guard the second call logged a duplicate rep. The manual flow gets
  // this for free (its end handler bails when startTimeRef is null);
  // this is the auto-flow equivalent. Starts true — no rep is armed
  // until handleRepStart runs.
  const repEndedRef = useRef(true);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const handleRepEnd = useCallback((stats) => {
    if (repEndedRef.current) return;  // already ended — ignore until next rep arms
    repEndedRef.current = true;
    clearInterval(timerRef.current);
    setRepActive(false);
    setElapsed(0);
    const completed = finalizeDeviceActivity(stats, startTimeRef.current ?? Date.now(), Date.now());
    startTimeRef.current = null;
    onRepDone({ ...completed, manualLoadKg: repManualKgRef.current, failed: false, endSession: stats.endSession === true });
  }, [onRepDone]);

  const finishAttempt = useCallback(({ endSession = false, targetNotReached = false } = {}) => {
    if (repEndedRef.current) { if (endSession) onAbort(); return; }
    handleRepEnd({ ...tindeq.endRepAndRequireRelease({ requireZero: targetNotReached }),
      failureValid: false, endReason: targetNotReached ? 'target_not_reached' : 'interrupted', endSession });
  }, [handleRepEnd, onAbort, tindeq]);
  const finishAttemptRef = useRef(finishAttempt);
  finishAttemptRef.current = finishAttempt;

  const handleRepStart = useCallback(() => {
    repManualKgRef.current = chosenTargetRef.current;
    repEndedRef.current = false;  // re-arm the end guard for this rep
    startTimeRef.current = Date.now();
    setRepActive(true);
    setElapsed(0);
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 100);
  }, []);

  // Keep the same detector/callbacks while the hook tries a brief reconnect.
  const streamAvailable = tindeq.connected || tindeq.reconnecting;
  useEffect(() => {
    if (!streamAvailable || !visible) return;
    tindeq.targetKgRef.current = targetKg;
    let disposed = false;
    setStartError(null);
    Promise.resolve(tindeq.startAutoDetect(handleRepStart, handleRepEnd)).catch(() => {
      if (!disposed) setStartError("Tindeq could not start. Release the handle and try again.");
    });
    return () => {
      disposed = true;
      // Navigation is an explicit interruption. StrictMode's visible replay
      // must not save a fake attempt or duplicate a completed one.
      if (!visibleRef.current && !repEndedRef.current) finishAttemptRef.current();
      tindeq.targetKgRef.current = null;
      Promise.resolve(tindeq.stopAutoDetect({ observeRelease: repEndedRef.current })).catch(() => {});
      clearInterval(timerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamAvailable, streamAttempt, visible]); // re-arm only on the visible training tab

  const holdSeconds = Number(creditedSeconds(tindeq.forceLoss, elapsed));
  const targetReached = holdSeconds >= config.targetTime;
  const timeLabel = config.mixedDomainPlan && !['adjusted', 'capped_at_original', 'adjusted_reference'].includes(config.mixedLoadAdjustment?.status)
    ? 'Fresh reference' : 'Target';

  return (
    <PageFrame style={{ padding: "20px 16px" }}>
      {/* Header — single-set under curve-trust commit C; just show
          grip + hand. The "Set X of Y" line is gone. */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{config.grip} · {handLabel}</div>
        </div>
        <Btn small color={C.red} onClick={() => finishAttempt({ endSession: true })}>End Session</Btn>
      </div>

      <TindeqBattery battery={tindeq.battery} connected={tindeq.connected} warningOnly />
      {tindeq.signalRecovering && <div role="status" style={{ color: C.orange }}>
        Waiting for the Tindeq signal. Your recorded effort is being kept.
      </div>}
      <RepDots total={config.repsPerSet} done={currentRep} current={currentRep} />
      <MixedHoldInfo config={config} currentRep={currentRep} />
      <p>Target time guides the prescribed load. Maintain the prescribed force until muscular failure.</p>
      {targetKg > 0 && <p>Brief force adjustments are allowed. A sustained loss of force ends the hold; release the handle to begin rest.</p>}
      {startError && <div role="alert" style={{ color: C.red }}>
        <p>{startError}</p>
        <Btn onClick={() => setStreamAttempt(attempt => attempt + 1)}>Retry Tindeq</Btn>
      </div>}
      {repActive && <Btn onClick={() => finishAttempt()}>Rep interrupted</Btn>}
      {repActive && targetKg > 0 && tindeq.forceLoss?.startTs == null && <div>
        <p>The target has not been reached. You can finish this attempt and choose a manageable target.</p>
        <Btn onClick={() => finishAttempt({ targetNotReached: true })}>Finish attempt — target not reached</Btn>
      </div>}

      {/* Status card first — the big hold timer must never scroll
          below the fold mid-rep. Live charts moved below the force
          gauge (June 2026); they're between-rep reading material. */}
      <Card style={{ textAlign: "center", padding: "32px 16px", marginTop: 12 }}>
        {repActive ? (
          <>
            <ForceLossNotice state={tindeq.forceLoss} />
            <div style={{ fontSize: 13, color: C.muted, marginBottom: 8 }}>{tindeq.forceLoss?.status === 'complete' ? 'Hold time recorded. Rest starts after release.' : 'Maintain a steady hold'}</div>
            <div style={{
              fontSize: 96, fontWeight: 900, lineHeight: 1,
              color: targetReached ? C.green : C.blue,
              fontVariantNumeric: "tabular-nums",
            }}>
              {holdSeconds.toFixed(1)}s
            </div>
            <div style={{ fontSize: 13, color: C.muted, marginTop: 8 }}>
              {timeLabel} {config.targetTime}s
              {targetReached && !config.mixedDomainPlan && tindeq.forceLoss?.status !== 'complete' && <span style={{ color: C.green, marginLeft: 8 }}>Target reached — keep pulling to failure</span>}
            </div>
          </>
        ) : (
          <>
            <HandCue hand={activeHand} />

            {/* Program-recommended target weight */}
            <div style={{
              fontSize: 11, color: C.muted, letterSpacing: 1.2,
              textTransform: "uppercase", marginBottom: 2,
            }}>
              {manualKg != null ? "Your target" : "Program target"}
            </div>
            <div style={{
              fontSize: 44, fontWeight: 900, color: C.blue,
              lineHeight: 1, marginBottom: 14,
              fontVariantNumeric: "tabular-nums",
            }}>
              {targetKg != null ? `${fmtW(targetKg, unit)} ${unit}` : "—"}
            </div>

            <div style={{ fontSize: 40, marginBottom: 8 }}>⬇</div>
            <div role="status" style={{ fontSize: 22, fontWeight: 700, color: C.text }}>
              {tindeq.releaseCheckRequired || tindeq.zeroing ? "Release and zero the handle before your next pull" : tindeq.awaitingRelease ? "Release the handle fully before your next pull" : `Pull to begin rep ${currentRep + 1}`}
            </div>
            <div style={{ fontSize: 13, color: C.muted, marginTop: 8 }}>
              {timeLabel}: <strong>{config.targetTime}s</strong> · Release when done
            </div>
          </>
        )}
      </Card>

      {!repActive && <details style={{ marginTop: 12 }}>
        <summary style={{ cursor: 'pointer', color: C.blue }}>Adjust target weight</summary>
        <label style={{ display: 'block', marginTop: 12 }}>
          Target weight ({unit})
          <input type="number" min="0" step="any" inputMode="decimal"
            value={targetInput} placeholder={suggestedKg != null ? fmtW(suggestedKg, unit) : ''}
            onChange={e => { if (repEndedRef.current) setTargetInput(e.target.value); }}
            style={{ display: 'block', width: '100%', boxSizing: 'border-box', marginTop: 6,
              padding: 12, borderRadius: 8, background: C.bg, color: C.text, border: `1px solid ${C.border}`, fontSize: 18 }} />
        </label>
        <p style={{ color: C.muted }}>Choose before pulling. This target applies to this hold; the original recommendation is kept in your history.</p>
        {manualKg != null && <Btn small onClick={() => setTargetInput('')}>Use program target</Btn>}
      </details>}
      {!repActive && <UnloadedZeroCheck tindeq={tindeq} />}

      {/* Live force */}
      {tindeq.connected && (
        <Card style={{ marginTop: 12 }}>
          <ForceGauge
            force={tindeq.force}
            avg={tindeq.avgForce}
            peak={tindeq.peak}
            targetKg={targetKg}
            unit={unit}
          />
        </Card>
      )}


      {/* Live rep-curve preview (same component as the manual flow) —
          below the timer + gauge so the clock stays on-screen. */}
      <div style={{ marginTop: 12 }}>
        <LiveRepCurveCard
          history={history}
          config={config}
          currentSet={currentSet}
          activeHand={activeHand}
          sessionReps={sessionReps}
          refWeights={refWeights}
          unit={unit}
        />

        <LiveRecoveryCard
          history={history}
          config={config}
          currentSet={currentSet}
          activeHand={activeHand}
          sessionReps={sessionReps}
        />
      </div>
    </PageFrame>
  );
}

function MixedHoldInfo({ config, currentRep }) {
  if (!config.mixedDomainPlan) return null;
  return <div style={{ marginTop: 12, fontSize: 18, lineHeight: 1.5 }}>
    <strong>Chaos Machine (Beta) · {MIXED_DOMAIN_LABELS[config.goal]}</strong>
    <div style={{ fontSize: 14, color: C.muted }}>{currentRep === 0
      ? 'Opening hold. Maintain the target force until failure.'
      : mixedAdjustmentText(config.mixedLoadAdjustment) || 'Fatigued hold. A shorter time is expected; there is no time to beat.'}</div>
  </div>;
}
