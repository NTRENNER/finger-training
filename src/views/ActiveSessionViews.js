// ──────────────────────────────────────────────────────────────
// ACTIVE-SESSION VIEWS
// ──────────────────────────────────────────────────────────────
// Everything the user sees once they hit "Start Session" — the
// big-timer / force-gauge active rep, the rest screen between
// reps, the switch-hands prompt in Both-mode, and the post-session
// summary. Plus the auto-detect Tindeq-driven flow
// (AutoRepSessionView) that replaces ActiveSessionView when BLE
// is connected. Sessions are single-set under the curve-trust
// flow; the between-sets and alt-hand-switch transitions are gone.
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
import { Card, Btn, Label } from "../ui/components.js";
import { fmtW, fmtTime, fromDisp } from "../ui/format.js";
import { BigTimer, ForceGauge } from "./cards/LiveForceCard.jsx";

import { suggestWeight, prescribedLoad } from "../model/prescription.js";
import { levelTitle } from "../model/levels.js";
import { downloadCSV } from "../lib/csv.js";
import { buildRepCurveBundle, buildPhysModel } from "../model/repCurveData.js";
import { RepCurveChart } from "./cards/RepCurveChart.jsx";
import { buildRecoveryBundle, classifyRecovery } from "../model/recoveryDynamics.js";
import { sessionOverpull } from "../model/overpull.js";
import { RecoveryChart } from "./cards/RecoveryChart.jsx";

// Small wrapper used by both ActiveSessionView and AutoRepSessionView
// (and SessionSummaryView) to render the live forecasted-vs-actual
// rep curve. Seeds the forecast from rep 1's actual hold if available,
// otherwise from the configured target_duration so the user sees the
// engine's prediction before they've moved.
function LiveRepCurveCard({ history, config, activeHand, sessionReps, embedded = false }) {
  const bundle = useMemo(() => {
    const handForLookup = config.hand === "Both" ? (activeHand || "L") : config.hand;
    const sameHandReps = (sessionReps || []).filter(r => r.hand === handForLookup);
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
    });
  }, [history, config, activeHand, sessionReps]);
  const inner = (
    <RepCurveChart
      forecasted={bundle.forecasted}
      actual={bundle.actual}
      prevSession={bundle.prevSession}
      asymptoticHold={bundle.asymptoticHold}
      targetS={bundle.targetS}
      height={160}
      showLegend={false}
    />
  );
  return embedded ? inner : <Card style={{ marginBottom: 12 }}>{inner}</Card>;
}

// Live recovery-dynamics card — between-rep capacity restoration
// for the current set. Renders alongside LiveRepCurveCard once
// rep 2 has landed (with only rep 1 there's nothing to plot —
// observed series is just [1.0]). The two charts answer different
// questions on the same data: LiveRepCurveCard shows hold-time
// trajectory; LiveRecoveryCard shows what fraction of capacity
// each rep started with.
function LiveRecoveryCard({ history, config, activeHand, sessionReps, embedded = false }) {
  const bundle = useMemo(() => {
    const handForLookup = config.hand === "Both" ? (activeHand || "L") : config.hand;
    const sameHandReps = (sessionReps || [])
      .filter(r => r.hand === handForLookup)
      .filter(r => Number(r.actual_time_s) > 0);
    // Rep 2 is the first inter-rep recovery measurement. Until
    // that's in the books there's no recovery to show.
    if (sameHandReps.length < 2) return null;
    const physModel = buildPhysModel(history, handForLookup, config.grip);
    return buildRecoveryBundle({
      reps: sameHandReps,
      restSeconds: config.restTime ?? 20,
      physModel,
    });
  }, [history, config, activeHand, sessionReps]);
  if (!bundle || bundle.observed.length === 0) return null;
  const classification = classifyRecovery(bundle.observedAtTarget);
  const inner = (
    <RecoveryChart
      observed={bundle.observed}
      predicted={bundle.predicted}
      headline={{
        observed: bundle.observedAtTarget,
        classification,
      }}
      height={140}
      showLegend={false}
    />
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
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
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
    </div>
  );
}

// ──────────────────────────────────────────────────────────────

// ACTIVE-REP SCREEN (manual flow — no BLE)

// ──────────────────────────────────────────────────────────────

export function ActiveSessionView({ session, onRepDone, onAbort, tindeq, autoStart = false, unit = "lbs", history = [] }) {
  const { config, currentRep, activeHand, sessionReps = [] } = session;

  // repPhase: 'ready' (show Start button, first rep only)
  //           'countdown' (3-2-1)
  //           'active' (rep in progress)
  const [repPhase,     setRepPhase]    = useState(autoStart ? "active" : "ready");
  const [countdown,    setCountdown]   = useState(3);
  const [elapsed,      setElapsed]     = useState(0);
  // Raw display-unit string, NOT kg. The input used to round-trip
  // through fmtW(toFixed(1)) on every keystroke, which made multi-
  // digit weights untypable ("12" → "1.0" after the first key) and
  // drifted values through double kg↔lbs conversion. Keep what the
  // user typed; convert to kg only where consumed (targetKg).
  const [manualWeightStr, setManualWeightStr] = useState("");
  const startTimeRef = useRef(null);
  const timerRef     = useRef(null);
  // Latest manual weight override in kg. endRep (a stable useCallback) reads
  // this at rep-completion time; without the ref it would close over a stale
  // manualKg (or need manualKg in its deps). Kept in sync every render below.
  const manualKgRef  = useRef(null);

  // Suggested weight per hand — held CONSTANT within a set. We don't
  // fatigue-discount the displayed weight; the user holds the same load
  // each rep and we track how actual_time_s decays. See also AutoRepSessionView.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const suggestions = useMemo(() => {
    const handList = config.hand === "Both" ? ["L", "R"] : [config.hand];
    return Object.fromEntries(
      handList.map(h => [h, {
        suggested: suggestWeight(session.refWeights?.[h] ?? null, 0),
      }])
    );
  }, [config.hand, session.refWeights]);

  // Actually start recording the rep
  const startRep = useCallback(async () => {
    setElapsed(0);
    startTimeRef.current = Date.now();
    setRepPhase("active");
    if (tindeq.connected) {
      await tindeq.tare();
      await tindeq.startMeasuring();
    }
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 100);
  }, [tindeq]);

  // Auto-start on mount when autoStart=true
  useEffect(() => {
    if (autoStart) { startRep(); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 3-2-1 countdown
  useEffect(() => {
    if (repPhase !== "countdown") return;
    if (countdown <= 0) { startRep(); return; }
    const t = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [repPhase, countdown, startRep]);

  // Tracks whether this rep was ended by auto-failure (vs manual tap).
  const autoFailedRef = useRef(false);

  // End rep — called by manual tap (failed=false) or auto-failure (failed=true).
  const endRep = useCallback(async () => {
    if (!startTimeRef.current) return;
    const failed = autoFailedRef.current;
    autoFailedRef.current = false;
    clearInterval(timerRef.current);
    const actualTime = (Date.now() - startTimeRef.current) / 1000;
    startTimeRef.current = null;
    setRepPhase("ready");
    // stopMeasuring returns the rep's plateau-trimmed avg and peak
    // directly — no reliance on stale React state. Falls back to
    // tindeq.peak / tindeq.avgForce when BLE was disconnected and
    // there are no samples to trim (manual / no-Tindeq sessions).
    let avgForce = tindeq.avgForce;
    let peakForce = tindeq.peak;
    if (tindeq.connected) {
      const stats = await tindeq.stopMeasuring();
      avgForce = stats.avgForce;
      peakForce = stats.peakForce;
    }
    // manualLoadKg (non-Tindeq / override): the load the user actually
    // lifted this rep. For manual sessions it's the ONLY load signal —
    // without it the rep persists load=0 and every downstream fit reads
    // zero (the elcerritotom bug, July 2026). Tindeq reps still prefer the
    // measured avg_force_kg via effectiveLoad, so this is a no-op there.
    onRepDone({ actualTime, avgForce, peakForce, failed, manualLoadKg: manualKgRef.current });
  }, [tindeq, onRepDone]);

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
    tindeq.targetKgRef.current = repPhase === "active" ? targetKg : null;
  }, [tindeq, repPhase, targetKg]);

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
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
        <Btn small color={C.red} onClick={onAbort}>End Session</Btn>
      </div>

      <RepDots total={config.repsPerSet} done={currentRep} current={currentRep} />

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
          <BigTimer seconds={elapsed} targetSeconds={config.targetTime} running={true} />
          {tindeq.connected ? (
            <ForceGauge force={tindeq.force} avg={tindeq.avgForce} peak={tindeq.peak} targetKg={targetKg} unit={unit} />
          ) : (
            <div style={{ fontSize: 12, color: C.muted, textAlign: "center", marginTop: 8 }}>
              No Tindeq — tap Done when you let go.
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

      {/* Controls */}
      <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
        {repPhase === "ready" && (
          <Btn
            onClick={() => { setCountdown(3); setRepPhase("countdown"); }}
            style={{ flex: 1, padding: "18px 0", fontSize: 18, borderRadius: 12 }}
            color={C.green}
          >
            ▶ Start Rep
          </Btn>
        )}
        {repPhase === "active" && (
          <Btn
            onClick={endRep}
            style={{ flex: 1, padding: "18px 0", fontSize: 18, borderRadius: 12 }}
            color={C.red}
          >
            ✕ Done
          </Btn>
        )}
      </div>

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
          activeHand={activeHand}
          sessionReps={sessionReps}
        />

        <LiveRecoveryCard
          history={history}
          config={config}
          activeHand={activeHand}
          sessionReps={sessionReps}
        />
      </div>
    </div>
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
  } catch (e) { /* audio not available */ }
}

export function RestView({ lastRep, nextWeight, restSeconds, onRestDone, repNum, repsPerSet, unit = "lbs" }) {
  // Wall-clock countdown, NOT tick-counted. The old version decremented
  // once per setInterval fire; background tabs / locked phones throttle
  // intervals to ≥1/min, so a 20s rest silently stretched to minutes —
  // exactly when the user pockets the phone between hangs. Deadline math
  // (same pattern as WarmupView) survives throttling: a late tick just
  // jumps the display to the correct remaining time. Side effects
  // (beeps, onRestDone) live in effects keyed off `remaining`, not
  // inside the setState updater — StrictMode double-invokes updaters,
  // which double-fired the beep and the phase transition in dev.
  const [remaining, setRemaining] = useState(restSeconds);
  const deadlineRef = useRef(null);
  const intervalRef = useRef(null);
  const lastBeepRef = useRef(null);
  const doneRef     = useRef(false);

  useEffect(() => {
    deadlineRef.current = Date.now() + restSeconds * 1000;
    doneRef.current = false;
    setRemaining(restSeconds);
    const tick = () => {
      const left = Math.max(0, Math.ceil((deadlineRef.current - Date.now()) / 1000));
      setRemaining(left);
    };
    // 250ms cadence keeps the displayed second accurate without
    // relying on 1000ms fires landing on second boundaries.
    intervalRef.current = setInterval(tick, 250);
    return () => clearInterval(intervalRef.current);
  }, [restSeconds]);

  useEffect(() => {
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
  }, [remaining]);

  const pct = remaining / restSeconds;
  // Single-set model (curve-trust commit C): no more "set complete"
  // language — the session ends when the rep counter hits the
  // configured count (handled by useSessionRunner). Rest is always
  // between reps within the single set.
  const isLastRepInSet = repNum >= repsPerSet;

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
      <Card>
        <div style={{ textAlign: "center", paddingBottom: 8 }}>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 4 }}>
            {isLastRepInSet
              ? "Session complete!"
              : `Rest — rep ${repNum} of ${repsPerSet}`}
          </div>
          <div style={{ fontSize: 64, fontWeight: 800, color: pct > 0.3 ? C.green : C.orange, lineHeight: 1 }}>
            {remaining}s
          </div>
          <div style={{ marginTop: 10, height: 6, background: C.border, borderRadius: 3, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${pct * 100}%`, background: C.green, borderRadius: 3, transition: "width 1s linear" }} />
          </div>
        </div>
      </Card>

      {lastRep && (
        <Card>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 8 }}>Last rep result</div>
          <div style={{ display: "flex", gap: 32 }}>
            <div>
              <Label>Time</Label>
              <span style={{
                fontSize: 28, fontWeight: 700,
                color: lastRep.actualTime >= lastRep.targetTime ? C.green : C.red,
              }}>
                {Math.round(lastRep.actualTime)}s
              </span>
              <div style={{ fontSize: 11, color: C.muted }}>target {lastRep.targetTime}s</div>
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
        </Card>
      )}

      {nextWeight != null && !isLastRepInSet && (
        <Card style={{ borderColor: C.blue }}>
          <Label>Next rep suggested weight</Label>
          <div style={{ fontSize: 36, fontWeight: 800, color: C.blue }}>
            {fmtW(nextWeight, unit)} {unit}
          </div>
        </Card>
      )}

      <Btn
        onClick={() => {
          if (doneRef.current) return;   // already transitioned
          doneRef.current = true;
          clearInterval(intervalRef.current);
          onRestDone();
        }}
        style={{ width: "100%", padding: "14px 0", fontSize: 16, borderRadius: 12 }}
        color={C.muted}
      >
        Skip rest →
      </Btn>
    </div>
  );
}

export function SwitchHandsView({ onReady }) {
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
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "40px 16px", textAlign: "center" }}>
      <div style={{ fontSize: 56 }}>🤚➡️✋</div>
      <h2 style={{ margin: "16px 0 8px" }}>Switch to Right Hand</h2>
      <p style={{ color: C.muted, marginBottom: 24 }}>Left hand complete. Get ready to train right hand.</p>
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
    </div>
  );
}

// (AltSwitchView removed — alternating-hand mode was retired with
// the flat-20s-rest workout flow; Both-mode now does all L hangs then
// all R hangs, with the existing HandSwitchView prompt covering the
// single switch.)
// (BetweenSetsView removed — single-set under curve-trust commit C.)

export function SessionSummaryView({ reps, config, leveledUp, newLevel, onDone, unit = "lbs" }) {
  const sets = useMemo(() => {
    const groups = {};
    for (const r of reps) {
      const k = r.set_num;
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

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
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

      <h2 style={{ margin: "0 0 16px", fontSize: 22 }}>Session Complete</h2>

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
                <tr key={r.rep_num} style={{ borderTop: `1px solid ${C.border}` }}>
                  <td style={{ padding: "6px 0" }}>{r.rep_num}</td>
                  <td style={{ textAlign: "right" }}>{fmtW(prescribedLoad(r), unit)} {unit}</td>
                  <td style={{ textAlign: "right", color: r.actual_time_s >= config.targetTime ? C.green : C.red }}>
                    {fmtTime(r.actual_time_s)}
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

      <div style={{ display: "flex", gap: 12 }}>
        <Btn onClick={() => downloadCSV(reps)} color={C.muted} style={{ flex: 1 }}>
          ↓ Export CSV
        </Btn>
        <Btn onClick={onDone} style={{ flex: 2 }}>
          Back to Setup
        </Btn>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────

// AUTO-REP SCREEN (Tindeq-driven flow)

// ──────────────────────────────────────────────────────────────

export function AutoRepSessionView({ session, onRepDone, onAbort, tindeq, unit = "lbs", history = [] }) {
  const { config, currentRep, activeHand, refWeights, sessionReps = [] } = session;
  const handLabel = config.hand === "Both"
    ? (activeHand === "L" ? "Left Hand" : "Right Hand")
    : config.hand === "L" ? "Left Hand" : "Right Hand";

  // Program-recommended target weight for the active hand.
  // Held CONSTANT within a set — the user hangs the same load each rep and
  // we record how actual_time_s changes. Those rep-time curves then feed
  // the next session's prescription via the three-exp curve fit. We
  // intentionally do NOT discount the suggested weight by within-set
  // fatigue.
  const suggestedKg = useMemo(
    () => suggestWeight(refWeights?.[activeHand] ?? null, 0),
    [refWeights, activeHand]
  );

  // Keep Tindeq's target ref in sync so the force gauge & auto-fail threshold
  // reflect the program recommendation during the rep.
  useEffect(() => {
    tindeq.targetKgRef.current = suggestedKg;
    return () => { tindeq.targetKgRef.current = null; };
  }, [tindeq, suggestedKg]);

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

  const handleRepEnd = useCallback(({ actualTime, avgForce, peakForce }) => {
    if (repEndedRef.current) return;  // already ended — ignore until next rep arms
    repEndedRef.current = true;
    clearInterval(timerRef.current);
    setRepActive(false);
    setElapsed(0);
    startTimeRef.current = null;
    onRepDone({ actualTime, avgForce, peakForce, failed: false });
  }, [onRepDone]);

  const handleRepStart = useCallback(() => {
    repEndedRef.current = false;  // re-arm the end guard for this rep
    startTimeRef.current = Date.now();
    setRepActive(true);
    setElapsed(0);
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 100);
  }, []);

  useEffect(() => {
    tindeq.startAutoDetect(handleRepStart, handleRepEnd);
    return () => {
      tindeq.stopAutoDetect();
      clearInterval(timerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);  // mount/unmount only — handleRepStart/End are stable refs

  const targetReached = elapsed >= config.targetTime;

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
      {/* Header — single-set under curve-trust commit C; just show
          grip + hand. The "Set X of Y" line is gone. */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{config.grip} · {handLabel}</div>
        </div>
        <Btn small color={C.red} onClick={onAbort}>End Session</Btn>
      </div>

      <RepDots total={config.repsPerSet} done={currentRep} current={currentRep} />

      {/* Status card first — the big hold timer must never scroll
          below the fold mid-rep. Live charts moved below the force
          gauge (June 2026); they're between-rep reading material. */}
      <Card style={{ textAlign: "center", padding: "32px 16px", marginTop: 12 }}>
        {repActive ? (
          <>
            <div style={{ fontSize: 13, color: C.muted, marginBottom: 8 }}>Holding — release when done</div>
            <div style={{
              fontSize: 96, fontWeight: 900, lineHeight: 1,
              color: targetReached ? C.green : C.blue,
              fontVariantNumeric: "tabular-nums",
            }}>
              {elapsed}s
            </div>
            <div style={{ fontSize: 13, color: C.muted, marginTop: 8 }}>
              target {config.targetTime}s
              {targetReached && <span style={{ color: C.green, marginLeft: 8 }}>✓ target reached</span>}
            </div>
          </>
        ) : (
          <>
            <div style={{
              fontSize: 13, color: C.muted, letterSpacing: 1.2,
              textTransform: "uppercase", marginBottom: 4,
            }}>Use your</div>
            <div style={{
              fontSize: 32, fontWeight: 900,
              color: activeHand === "R" ? C.orange : C.blue,
              marginBottom: 14,
            }}>
              {activeHand === "R" ? "✋ Right Hand" : "🤚 Left Hand"}
            </div>

            {/* Program-recommended target weight */}
            <div style={{
              fontSize: 11, color: C.muted, letterSpacing: 1.2,
              textTransform: "uppercase", marginBottom: 2,
            }}>
              Program target
            </div>
            <div style={{
              fontSize: 44, fontWeight: 900, color: C.blue,
              lineHeight: 1, marginBottom: 14,
              fontVariantNumeric: "tabular-nums",
            }}>
              {suggestedKg != null ? `${fmtW(suggestedKg, unit)} ${unit}` : "—"}
            </div>

            <div style={{ fontSize: 40, marginBottom: 8 }}>⬇</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: C.text }}>Pull to begin rep {currentRep + 1}</div>
            <div style={{ fontSize: 13, color: C.muted, marginTop: 8 }}>
              Target: <strong>{config.targetTime}s</strong> · Release when done
            </div>
          </>
        )}
      </Card>

      {/* Live force */}
      {tindeq.connected && (
        <Card style={{ marginTop: 12 }}>
          <ForceGauge
            force={tindeq.force}
            avg={tindeq.avgForce}
            peak={tindeq.peak}
            targetKg={suggestedKg}
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
          activeHand={activeHand}
          sessionReps={sessionReps}
        />

        <LiveRecoveryCard
          history={history}
          config={config}
          activeHand={activeHand}
          sessionReps={sessionReps}
        />
      </div>
    </div>
  );
}
