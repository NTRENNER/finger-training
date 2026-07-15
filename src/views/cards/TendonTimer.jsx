// Guided interval timer for the tendon protocol. Steps through the
// preset's hang sequence (work → rest → next), beeping on transitions,
// and calls onComplete once when the final work interval finishes.
// Purely a timer + guidance — no load is measured or recorded.
//
// The completion screen reflects the ACTUAL save outcome (saveState),
// not just "the timer finished": "Saving…" while the cloud write is in
// flight, "Session logged" only once it succeeds, and a retryable error
// state if it didn't — so we never falsely claim a session was saved.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { C } from "../../ui/theme.js";
import { Btn } from "../../ui/components.js";
import { buildIntervals, totalSets, totalWorkSeconds } from "../../model/tendon.js";

function beep(freq = 880, dur = 0.12, vol = 0.35) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    o.start(); o.stop(ctx.currentTime + dur);
    o.onended = () => ctx.close();
  } catch (e) { /* no audio available */ }
}

// saveState: "saving" | "ok" | "error" (undefined = treat as saving, so
// a parent that doesn't wire it in still doesn't over-claim success).
export function TendonTimer({ preset, onComplete, onCancel, onRetry, saveState }) {
  const intervals = useMemo(() => buildIntervals(preset), [preset]);
  const [idx, setIdx] = useState(0);
  const [phase, setPhase] = useState("ready"); // ready | work | rest | done
  const [remaining, setRemaining] = useState(preset.workSec);
  const deadlineRef = useRef(null);
  const timerRef = useRef(null);
  const lastBeepRef = useRef(null);
  const completedRef = useRef(false);

  const cur = intervals[idx] || intervals[intervals.length - 1];

  useEffect(() => {
    if (phase !== "work" && phase !== "rest") return;
    const dur = phase === "work" ? cur.workSec : cur.restSec;
    deadlineRef.current = Date.now() + dur * 1000;
    lastBeepRef.current = null;
    setRemaining(dur);
    const tick = () => {
      const left = Math.max(0, Math.ceil((deadlineRef.current - Date.now()) / 1000));
      setRemaining(left);
      if (left <= 3 && left >= 1 && lastBeepRef.current !== left) {
        lastBeepRef.current = left;
        beep(left === 1 ? 1050 : 760, 0.07);
      }
      if (left <= 0) {
        clearInterval(timerRef.current);
        if (phase === "work") {
          beep(1100, 0.16);
          if (idx >= intervals.length - 1) {
            setPhase("done");
            if (!completedRef.current) {
              completedRef.current = true;
              onComplete && onComplete({ sets: totalSets(preset), totalWorkS: totalWorkSeconds(preset) });
            }
          } else {
            setPhase("rest");
          }
        } else {
          beep(880, 0.12);
          setIdx(i => i + 1);
          setPhase("work");
        }
      }
    };
    tick();
    timerRef.current = setInterval(tick, 200);
    return () => clearInterval(timerRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, idx]);

  useEffect(() => () => clearInterval(timerRef.current), []);

  const stop = () => { clearInterval(timerRef.current); onCancel && onCancel(); };

  if (phase === "done") {
    const st = saveState || "saving";
    return (
      <div style={{ textAlign: "center", padding: "8px 4px" }}>
        <div style={{ fontSize: 40, lineHeight: 1 }}>
          {st === "ok" ? "✅" : st === "error" ? "⚠️" : "⏳"}
        </div>
        <div style={{
          fontSize: 16, fontWeight: 800, marginTop: 6,
          color: st === "ok" ? C.green : st === "error" ? C.red : C.muted,
        }}>
          {st === "ok" ? "Session logged" : st === "error" ? "Couldn't save session" : "Saving…"}
        </div>
        <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>
          {st === "error"
            ? "Your session isn't saved yet. Check your connection and retry."
            : `${totalSets(preset)} hangs · ~${totalWorkSeconds(preset)}s under tension`}
        </div>
        {st === "error" ? (
          <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 14 }}>
            <Btn onClick={onRetry} color={C.blue} style={{ padding: "10px 24px", borderRadius: 12 }}>
              ↻ Retry
            </Btn>
            <Btn onClick={onCancel} color={C.muted} style={{ padding: "10px 20px", borderRadius: 12 }}>
              Dismiss
            </Btn>
          </div>
        ) : (
          <Btn onClick={onCancel} color={st === "ok" ? C.green : C.muted}
               disabled={st === "saving"}
               style={{ marginTop: 14, padding: "10px 28px", borderRadius: 12, opacity: st === "saving" ? 0.6 : 1 }}>
            Done
          </Btn>
        )}
      </div>
    );
  }

  const isWork = phase === "work";
  const setNum = idx + 1;

  return (
    <div style={{ textAlign: "center", padding: "4px 2px" }}>
      <div style={{ fontSize: 11, color: C.muted, letterSpacing: 1.2, textTransform: "uppercase" }}>
        Hang {setNum} of {intervals.length}
      </div>
      <div style={{ fontSize: 18, fontWeight: 800, color: C.text, marginTop: 4 }}>
        {cur.grip}{cur.ofSets > 1 ? ` · set ${cur.set}/${cur.ofSets}` : ""}
      </div>
      {cur.detail && (
        <div style={{ fontSize: 12, color: C.muted, marginTop: 1 }}>{cur.detail}</div>
      )}
      <div style={{ fontSize: 12, color: C.blue, fontWeight: 700, marginTop: 4 }}>
        ~{cur.effortPct}% effort · no failure
      </div>

      {phase === "ready" ? (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 10 }}>
            Get set up on your first grip, then start.
          </div>
          <Btn onClick={() => setPhase("work")} color={C.green}
               style={{ padding: "14px 0", width: "100%", fontSize: 17, borderRadius: 12 }}>
            ▶ Start
          </Btn>
        </div>
      ) : (
        <>
          <div style={{
            fontSize: 12, fontWeight: 800, letterSpacing: 2,
            textTransform: "uppercase", marginTop: 10,
            color: isWork ? C.green : C.orange,
          }}>
            {isWork ? "Hold" : "Rest"}
          </div>
          <div style={{
            fontSize: 72, fontWeight: 900, lineHeight: 1,
            color: isWork ? C.green : C.orange,
            fontVariantNumeric: "tabular-nums",
          }}>
            {remaining}s
          </div>
          {!isWork && intervals[idx + 1] && (
            <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>
              Next: {intervals[idx + 1].grip}
            </div>
          )}
        </>
      )}

      <Btn onClick={stop} color={C.muted}
           style={{ marginTop: 16, padding: "8px 0", width: "100%", fontSize: 13, borderRadius: 10 }}>
        {phase === "ready" ? "Cancel" : "Stop"}
      </Btn>
    </div>
  );
}
