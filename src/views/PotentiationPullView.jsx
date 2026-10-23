import React, { useEffect, useRef, useState } from "react";
import { startingHandForDay, otherHand } from "../model/handOrder.js";
import { potentiationMeasurementRecord } from "../model/potentiationRfd.js";
import { today, uuid } from "../util.js";
import { Btn, Card } from "../ui/components.jsx";
import { C } from "../ui/theme.js";
import { fmtW } from "../ui/format.js";
import { HandCue } from "./cards/HandCue.jsx";
import { ForceGauge } from "./cards/LiveForceCard.jsx";

// Brief, submaximal single-hand pulls used to prime recruitment before
// climbing. Sensor pulls preserve rapid-force metrics in hidden measurement
// rows; those rows never enter training history or the force-duration model.
export function PotentiationPullView({
  grip,
  targetLoadKg,
  repsPerHand = 2,
  restSec = 20,
  history = [],
  tindeq,
  unit = "lbs",
  visible = true,
  manualMode = false,
  swapRequired = false,
  addReps = null,
  onPullStart = null,
  onClose,
  completionLabel = "Continue warm-up",
}) {
  const [context] = useState(() => {
    const date = today();
    const first = startingHandForDay(history, date);
    return {
      date,
      hands: [first, otherHand(first)],
      sessionId: `pot_${uuid()}`,
      startedAt: new Date().toISOString(),
    };
  });
  const total = context.hands.length * repsPerHand;
  const [state, setState] = useState({ phase: "ready", index: 0, elapsed: 0, peaks: {} });
  const live = useRef(state);
  const deadlineRef = useRef(null);
  const callbacks = useRef({});
  const [retry, setRetry] = useState(0);

  const transition = next => {
    live.current = next;
    setState(next);
  };
  const activeHand = context.hands[state.index % context.hands.length];

  function finishAttempt(stats = {}) {
    const current = live.current;
    if (current.phase !== "active") return;
    if (stats.endReason === "equipment_interruption") {
      transition({ ...current, phase: "error" });
      return;
    }
    const hand = context.hands[current.index % context.hands.length];
    if (!manualMode && addReps) {
      const measurement = potentiationMeasurementRecord({
        stats,
        hand,
        grip,
        sessionId: context.sessionId,
        date: context.date,
        startedAt: context.startedAt,
        targetLoadKg,
        position: current.index + 1,
        restSec,
      });
      if (measurement) addReps([measurement]);
    }
    const peak = Number(stats.peakForce);
    const peaks = Number.isFinite(peak)
      ? { ...current.peaks, [hand]: Math.max(current.peaks[hand] || 0, peak) }
      : current.peaks;
    const next = current.index + 1;
    if (next >= total) {
      transition({ phase: "done", index: next, elapsed: 0, peaks });
      return;
    }
    deadlineRef.current = Date.now() + restSec * 1000;
    transition({ phase: "rest", index: next, elapsed: restSec, peaks });
  }

  callbacks.current = {
    start: () => {
      if (live.current.phase !== "ready") {
        tindeq?.endRepAndRequireRelease?.();
        return;
      }
      onPullStart?.();
      transition({ ...live.current, phase: "active" });
    },
    end: stats => finishAttempt(stats),
  };

  useEffect(() => {
    if (manualMode || !visible || !tindeq?.connected || state.phase === "done") return;
    let disposed = false;
    tindeq.targetKgRef.current = targetLoadKg;
    Promise.resolve(tindeq.startAutoDetect(
      () => callbacks.current.start(),
      stats => callbacks.current.end(stats),
      { endOnTargetDrop: false, captureRapidForce: true },
    )).catch(() => {
      if (!disposed) transition({ ...live.current, phase: "error" });
    });
    return () => {
      disposed = true;
      Promise.resolve(tindeq.stopAutoDetect()).catch(() => {});
      tindeq.targetKgRef.current = null;
    };
    // Callbacks read refs; hand and rest transitions must not restart BLE.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manualMode, visible, tindeq?.connected, state.phase === "done", retry, targetLoadKg]);

  useEffect(() => {
    const timer = setInterval(() => {
      const current = live.current;
      if (current.phase !== "rest") return;
      const remaining = Math.max(0, Math.ceil((deadlineRef.current - Date.now()) / 1000));
      transition({ ...current, elapsed: remaining, phase: remaining ? "rest" : "ready" });
    }, 100);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (manualMode || (visible && tindeq?.connected) || live.current.phase !== "active") return;
    transition({ ...live.current, phase: "error" });
  }, [manualMode, visible, tindeq?.connected]);

  const retryPull = () => {
    tindeq?.endRepAndRequireRelease?.();
    transition({ ...live.current, phase: "ready" });
    setRetry(value => value + 1);
  };
  const skipRest = () => transition({ ...live.current, phase: "ready", elapsed: 0 });
  const leave = () => {
    tindeq?.endRepAndRequireRelease?.();
    onClose?.();
  };

  if (state.phase === "done") {
    return <Card>
      <h2 style={{ marginTop: 0 }}>Potentiation Pulls complete</h2>
      <Btn onClick={leave} color={C.green}>{completionLabel}</Btn>
    </Card>;
  }

  const pullNumber = Math.min(state.index + 1, total);
  return <div>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
      <b>{grip} · Potentiation Pulls</b>
      <Btn small color={C.border} onClick={leave}>Skip pulls</Btn>
    </div>
    <Card style={{ textAlign: "center", padding: "24px 16px" }}>
      <div style={{ color: C.muted, marginBottom: 10 }}>Pull {pullNumber} of {total} · {repsPerHand} per hand</div>
      {state.phase === "rest" ? <>
        <div style={{ fontSize: 16 }}>Release and recover</div>
        <div role="timer" aria-label="Potentiation rest" style={{ fontSize: 80, fontWeight: 900, color: C.blue }}>{state.elapsed}s</div>
        <p>Next: {activeHand === "L" ? "Left" : "Right"} hand</p>
        <Btn small color={C.border} onClick={skipRest}>Skip rest</Btn>
      </> : <>
        {swapRequired && state.index === 0 && state.phase === "ready" && <div role="status" style={{
          background: C.bg, border: `1px solid ${C.purple}`, borderRadius: 10,
          padding: "10px 12px", marginBottom: 14,
        }}>Swap the Tindeq to the <b>{grip}</b> gripper, let it settle unloaded, then pull.</div>}
        <HandCue hand={activeHand} />
        <p style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>Hit the target quickly, then release.</p>
        {manualMode ? <div style={{ margin: "20px 0" }}>
          <div style={{ color: C.muted, fontSize: 13 }}>Target</div>
          <div style={{ color: C.blue, fontSize: 48, fontWeight: 900 }}>{fmtW(targetLoadKg, unit)} <span style={{ fontSize: 18 }}>{unit}</span></div>
          {state.phase === "active"
            ? <Btn color={C.green} onClick={() => finishAttempt()}>Pull complete</Btn>
            : <Btn color={C.green} onClick={() => callbacks.current.start()}>Start pull</Btn>}
        </div> : <ForceGauge
          force={tindeq?.connected && !tindeq.signalRecovering ? tindeq.force || 0 : null}
          avg={state.phase === "active" ? tindeq?.avgForce || 0 : null}
          peak={state.phase === "active" ? tindeq?.peak || 0 : 0}
          targetKg={targetLoadKg}
          maxDisplay={Math.max(20, targetLoadKg * 1.35)}
          numberSize="clamp(48px, 15vw, 82px)"
          unit={unit}
          showUnavailable={!!tindeq?.signalRecovering}
        />}
        {state.phase === "error" && <div role="alert">
          <p style={{ color: C.yellow }}>Pull not counted</p>
          <Btn onClick={retryPull} disabled={!tindeq?.connected}>Retry pull</Btn>
        </div>}
        {!manualMode && !tindeq?.connected && <div>
          <p style={{ color: C.yellow }}>Connect the Tindeq to continue.</p>
          <Btn onClick={() => tindeq?.connect?.()} disabled={tindeq?.reconnecting}>Connect Tindeq</Btn>
        </div>}
      </>}
    </Card>
  </div>;
}

export default PotentiationPullView;
