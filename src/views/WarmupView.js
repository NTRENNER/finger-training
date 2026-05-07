// ─────────────────────────────────────────────────────────────
// ADAPTIVE WARM-UP VIEW
// ─────────────────────────────────────────────────────────────
// Step-by-step UI for the adaptive warm-up protocol. Pure prescription
// — no Tindeq, no rep recording, no schema changes. The protocol
// generator (src/model/warmup.js) builds the 5-step plan from the
// user's force curves + bodyweight + recent pullup max; this view
// walks the user through it with a timer for hangs and a tap counter
// for the pullup finisher.
//
// State machine:
//   'preview' — show the full protocol so the user can see what's coming
//   'hang'    — running a hang step: count-up timer to target, Done advances
//   'rest'    — between steps: count-down rest timer, auto-advances at 0
//   'pullup'  — pullup finisher: tap counter for reps × N sets
//   'done'    — protocol complete, summary + close
//
// Reps DO NOT get logged. This is a one-off generated each time.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Card, Btn } from "../ui/components.js";
import { C } from "../ui/theme.js";
import { generateWarmupProtocol } from "../model/warmup.js";

const GRIP_COLORS = { Micro: "#e05560", Crusher: C.orange, Prime: "#7c5cbf" };

// Format seconds as M:SS or just S depending on size.
function fmtSec(s) {
  if (s == null || !isFinite(s)) return "0";
  const sec = Math.max(0, Math.round(s));
  if (sec < 60) return `${sec}`;
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

// Render a Left/Right grip pair as colored chips. Used in step headers
// so the user sees at a glance which gripper goes on which hand.
function GripPair({ leftGrip, rightGrip }) {
  const cell = (label, grip) => (
    <div style={{
      flex: 1, padding: "8px 10px",
      background: C.bg, borderRadius: 8,
      border: `1px solid ${(GRIP_COLORS[grip] || C.blue) + "40"}`,
    }}>
      <div style={{ fontSize: 10, color: C.muted, letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 2 }}>
        {label}
      </div>
      <div style={{ fontSize: 14, fontWeight: 700, color: GRIP_COLORS[grip] || C.text }}>
        {grip}
      </div>
    </div>
  );
  return (
    <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
      {cell("Left Hand", leftGrip)}
      {cell("Right Hand", rightGrip)}
    </div>
  );
}

export function WarmupView({ history, wLog, bodyWeightKg, onClose }) {
  // Build protocol once on mount. Re-builds only if the inputs change.
  const protocol = useMemo(
    () => generateWarmupProtocol({ history, wLog, bodyWeightKg }),
    [history, wLog, bodyWeightKg]
  );

  // Top-level flow state. 'preview' before user hits Start.
  const [phase, setPhase] = useState("preview"); // preview|hang|rest|pullup|done
  const [stepIdx, setStepIdx] = useState(0);
  const [setIdx, setSetIdx] = useState(0);     // for pullup multi-set
  const [pullupReps, setPullupReps] = useState(0);
  const [elapsed, setElapsed] = useState(0);   // sec since step started
  const [restRemaining, setRestRemaining] = useState(0); // sec left in rest
  const tickRef = useRef(null);

  // Timer drivers — one for the active hang/rest state, recreated when
  // phase or stepIdx changes. Cleared on unmount and on phase exit.
  useEffect(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    if (phase === "hang") {
      const startedAt = Date.now();
      setElapsed(0);
      tickRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startedAt) / 1000));
      }, 250);
    } else if (phase === "rest") {
      const startedAt = Date.now();
      const restSec = currentStep?.restAfterSec || 60;
      setRestRemaining(restSec);
      tickRef.current = setInterval(() => {
        const remaining = restSec - Math.floor((Date.now() - startedAt) / 1000);
        setRestRemaining(Math.max(0, remaining));
        if (remaining <= 0) {
          clearInterval(tickRef.current);
          advanceFromRest();
        }
      }, 250);
    }
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, stepIdx, setIdx]);

  if (!protocol.ok) {
    return (
      <div>
        <Card>
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Adaptive Warm-up</div>
          <div style={{ fontSize: 13, color: C.yellow, marginBottom: 12, lineHeight: 1.5 }}>
            ⚠ Can't generate yet
          </div>
          <div style={{ fontSize: 13, color: C.text, lineHeight: 1.6, marginBottom: 16 }}>
            {protocol.reason}
          </div>
          <Btn onClick={onClose} small>Back</Btn>
        </Card>
      </div>
    );
  }

  const steps = protocol.steps;
  const currentStep = steps[stepIdx];

  function startProtocol() {
    setStepIdx(0);
    setSetIdx(0);
    setPullupReps(0);
    enterStep(0);
  }

  function enterStep(idx) {
    const step = steps[idx];
    if (!step) {
      setPhase("done");
      return;
    }
    if (step.type === "hang") setPhase("hang");
    else if (step.type === "pullup") {
      setPullupReps(0);
      setPhase("pullup");
    }
  }

  function completeHang() {
    if (currentStep.restAfterSec > 0 && stepIdx < steps.length - 1) {
      setPhase("rest");
    } else {
      advanceToNextStep();
    }
  }

  function completePullupSet() {
    const nSets = currentStep.sets || 1;
    if (setIdx + 1 < nSets) {
      // Rest between pullup sets, then advance setIdx.
      setPhase("rest");
    } else {
      // Final set done — go straight to next step (no rest after final).
      advanceToNextStep();
    }
  }

  function advanceFromRest() {
    if (currentStep?.type === "pullup" && (currentStep.sets || 1) > setIdx + 1) {
      setSetIdx(s => s + 1);
      setPullupReps(0);
      setPhase("pullup");
    } else {
      advanceToNextStep();
    }
  }

  function advanceToNextStep() {
    const next = stepIdx + 1;
    setSetIdx(0);
    setPullupReps(0);
    if (next >= steps.length) {
      setPhase("done");
      setStepIdx(next);
    } else {
      setStepIdx(next);
      enterStep(next);
    }
  }

  function skipStep() {
    if (currentStep?.type === "pullup" && (currentStep.sets || 1) > setIdx + 1) {
      setSetIdx(s => s + 1);
      setPullupReps(0);
      setPhase("pullup");
    } else {
      advanceToNextStep();
    }
  }

  // ── Render: PREVIEW ──
  if (phase === "preview") {
    return (
      <div>
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
            <div style={{ fontSize: 18, fontWeight: 800 }}>Adaptive Warm-up</div>
            <div style={{ fontSize: 11, color: C.muted }}>
              BW {protocol.bodyWeightLbs} lbs
            </div>
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 16, lineHeight: 1.5 }}>
            Personalized from your force curves and bodyweight. Loads stay well below failure — every step is force-curve-normalized so the warm-up feels the same session after session.
          </div>
          <div style={{ marginBottom: 16 }}>
            {steps.map((s, i) => (
              <div key={s.id} style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "10px 0",
                borderBottom: i < steps.length - 1 ? `1px solid ${C.border}` : "none",
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, color: C.muted, marginBottom: 2 }}>Step {i + 1}</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{s.title}</div>
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
                    {s.intensityLabel}
                    {i < steps.length - 1 && ` · rest ${fmtSec(s.restAfterSec)}s`}
                  </div>
                </div>
                <div style={{ textAlign: "right", marginLeft: 12 }}>
                  <div style={{ fontSize: 22, fontWeight: 800, color: C.purple, lineHeight: 1 }}>
                    {s.type === "hang" ? `${s.targetSec}s` : `${s.targetReps}×${s.sets || 1}`}
                  </div>
                  <div style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>
                    {s.type === "hang" ? "hold" : "reps × sets"}
                  </div>
                </div>
              </div>
            ))}
          </div>
          {protocol.anyFallback && (
            <div style={{
              fontSize: 11, color: C.yellow, marginBottom: 8, lineHeight: 1.5,
              padding: "6px 10px", background: `${C.yellow}10`,
              border: `1px solid ${C.yellow}30`, borderRadius: 6,
            }}>
              ⚠ Some hang targets are using a default 120s reference because your force curve doesn't reach bodyweight load yet. Run a few near-MVC Crusher hangs to seed the curve and these will calibrate to your data.
            </div>
          )}
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 12, lineHeight: 1.5, fontStyle: "italic" }}>
            Pullup count: {protocol.pullupSource.sourceText}
            {protocol.pullupSource.count != null && ` (${protocol.pullupSource.count})`}.
            Nothing here gets logged as training data.
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <Btn onClick={startProtocol} color={C.green}>Start</Btn>
            <Btn onClick={onClose} color={C.border} small>Back</Btn>
          </div>
        </Card>
      </div>
    );
  }

  // ── Render: HANG ──
  if (phase === "hang") {
    const target = currentStep.targetSec;
    const reached = elapsed >= target;
    return (
      <div>
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: C.muted, letterSpacing: 0.5, textTransform: "uppercase" }}>
              Step {stepIdx + 1} of {steps.length} · {currentStep.intensityLabel}
            </div>
            <div style={{ fontSize: 11, color: C.muted }}>BW {protocol.bodyWeightLbs} lbs</div>
          </div>
          <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 10 }}>{currentStep.title}</div>
          <GripPair leftGrip={currentStep.leftGrip} rightGrip={currentStep.rightGrip} />
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 16, lineHeight: 1.5 }}>
            {currentStep.description}
          </div>
          <div style={{
            background: C.bg, border: `1px solid ${C.border}`,
            borderRadius: 12, padding: "20px 16px", marginBottom: 16,
            textAlign: "center",
          }}>
            <div style={{ fontSize: 11, color: C.muted, letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 6 }}>
              Hold time
            </div>
            <div style={{ fontSize: 56, fontWeight: 900, color: reached ? C.green : C.purple, lineHeight: 1, letterSpacing: -1 }}>
              {fmtSec(elapsed)}
            </div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 6 }}>
              target {fmtSec(target)}s
            </div>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <Btn onClick={completeHang} color={reached ? C.green : C.blue}>
              {reached ? "Done" : "Done early"}
            </Btn>
            <Btn onClick={skipStep} color={C.border} small>Skip</Btn>
            <div style={{ flex: 1 }} />
            <Btn onClick={onClose} color={C.border} small>End</Btn>
          </div>
        </Card>
      </div>
    );
  }

  // ── Render: REST ──
  if (phase === "rest") {
    const nextStep = steps[stepIdx + 1];
    const isMidPullupSet = currentStep?.type === "pullup" && (currentStep.sets || 1) > setIdx + 1;
    return (
      <div>
        <Card>
          <div style={{ fontSize: 11, color: C.muted, letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 8 }}>
            Rest
          </div>
          <div style={{
            background: C.bg, border: `1px solid ${C.border}`,
            borderRadius: 12, padding: "20px 16px", marginBottom: 16,
            textAlign: "center",
          }}>
            <div style={{ fontSize: 56, fontWeight: 900, color: C.blue, lineHeight: 1, letterSpacing: -1 }}>
              {fmtSec(restRemaining)}
            </div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 6 }}>seconds remaining</div>
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 16, lineHeight: 1.5 }}>
            {isMidPullupSet ? (
              <>Next: <b style={{ color: C.text }}>set {setIdx + 2} of {currentStep.sets}</b> — grips swap to <b style={{ color: GRIP_COLORS[currentStep.rightGrip] }}>{currentStep.rightGrip}</b> Left / <b style={{ color: GRIP_COLORS[currentStep.leftGrip] }}>{currentStep.leftGrip}</b> Right.</>
            ) : nextStep ? (
              <>Up next: <b style={{ color: C.text }}>{nextStep.title}</b> · {nextStep.intensityLabel}.</>
            ) : (
              <>Final step coming up.</>
            )}
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <Btn onClick={advanceFromRest} color={C.blue}>Skip rest</Btn>
            <div style={{ flex: 1 }} />
            <Btn onClick={onClose} color={C.border} small>End</Btn>
          </div>
        </Card>
      </div>
    );
  }

  // ── Render: PULLUP ──
  if (phase === "pullup") {
    const setsTotal = currentStep.sets || 1;
    // For swapAfterSet steps, the displayed grips swap each set: set 0
    // shows the configured pair, set 1 shows them swapped.
    const swap = currentStep.swapAfterSet && setIdx % 2 === 1;
    const leftGripDisplay  = swap ? currentStep.rightGrip : currentStep.leftGrip;
    const rightGripDisplay = swap ? currentStep.leftGrip  : currentStep.rightGrip;
    return (
      <div>
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: C.muted, letterSpacing: 0.5, textTransform: "uppercase" }}>
              Step {stepIdx + 1} of {steps.length} · Set {setIdx + 1} of {setsTotal}
            </div>
            <div style={{ fontSize: 11, color: C.muted }}>BW {protocol.bodyWeightLbs} lbs</div>
          </div>
          <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 10 }}>{currentStep.title}</div>
          <GripPair leftGrip={leftGripDisplay} rightGrip={rightGripDisplay} />
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 16, lineHeight: 1.5 }}>
            {currentStep.description}
          </div>
          <div style={{
            background: C.bg, border: `1px solid ${C.border}`,
            borderRadius: 12, padding: "20px 16px", marginBottom: 16,
            textAlign: "center",
          }}>
            <div style={{ fontSize: 11, color: C.muted, letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 6 }}>
              Reps
            </div>
            <div style={{ fontSize: 56, fontWeight: 900, color: pullupReps >= currentStep.targetReps ? C.green : C.purple, lineHeight: 1, letterSpacing: -1 }}>
              {pullupReps}
            </div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 6 }}>
              target {currentStep.targetReps}
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 14, justifyContent: "center" }}>
              <Btn onClick={() => setPullupReps(r => Math.max(0, r - 1))} color={C.border} small>−</Btn>
              <Btn onClick={() => setPullupReps(r => r + 1)} color={C.green}>+1 rep</Btn>
            </div>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <Btn onClick={completePullupSet} color={C.blue}>
              {setIdx + 1 < setsTotal ? "Set done" : "Done"}
            </Btn>
            <Btn onClick={skipStep} color={C.border} small>Skip set</Btn>
            <div style={{ flex: 1 }} />
            <Btn onClick={onClose} color={C.border} small>End</Btn>
          </div>
        </Card>
      </div>
    );
  }

  // ── Render: DONE ──
  if (phase === "done") {
    return (
      <div>
        <Card>
          <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 8, color: C.green }}>
            ✓ Warm-up complete
          </div>
          <div style={{ fontSize: 13, color: C.text, lineHeight: 1.6, marginBottom: 16 }}>
            Forearms primed, fingers awake, neither flash-pumped nor under-cooked. The video calls for ~10 minutes of full rest now to fully clear fatigue, then you're ready for early goes.
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 16, lineHeight: 1.5, fontStyle: "italic" }}>
            Nothing here was logged — warm-up reps don't update the force curve.
          </div>
          <Btn onClick={onClose} color={C.green}>Close</Btn>
        </Card>
      </div>
    );
  }

  return null;
}

export default WarmupView;
