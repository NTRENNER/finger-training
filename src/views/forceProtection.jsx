// ─────────────────────────────────────────────────────────────
// FORCE PROTECTION — shared rep-end tolerance helpers
// ─────────────────────────────────────────────────────────────
// Pulled out of ActiveSessionViews so WarmupView and PeakTestView
// can inherit the same "brief force dips don't end the rep" and
// "BLE signal recovering" affordances. Prevents an unintentional
// rep end from a transient slip, cable blip, or momentary slack.
//
// Both pieces are stateless UI/formatting around the tindeq hook's
// forceLoss observation (status: 'holding' | 'pending' | 'complete').
// They don't own tindeq.forceLoss themselves — the hook does — and
// they don't dispatch anything, so they're safe to drop into any
// hang view.

import React from "react";
import { C } from "../ui/theme.js";

// Yellow banner shown when a dip is being evaluated (pending) or
// the rep has just completed (release the handle). Returns null
// during a clean steady hold.
export function ForceLossNotice({ state }) {
  if (!state || (state.status === "holding" && state.pendingEndTs == null)) return null;
  return (
    <p role="status" style={{ color: C.yellow, fontSize: 22, fontWeight: 700 }}>
      {state.status === "complete"
        ? "Rep complete — release the handle"
        : "Checking force dip — return to a steady hold. Time resumes if it recovers."}
    </p>
  );
}

// Elapsed seconds credited toward the hold, accounting for a
// pending dip (freezes the clock) or completion (locks the
// recorded time). Returns a 1-decimal string. Falls through to
// the raw elapsed value when no forceLoss state exists yet.
export function creditedSeconds(state, elapsed) {
  if (!state) return elapsed;
  const start = Object.hasOwn(state, "pullStartTs") ? state.pullStartTs : state.startTs;
  if (start == null) return "0.0";
  const end = state.status === "complete" ? state.endTs : state.pendingEndTs ?? state.observedTs;
  return Number.isFinite(end) ? Math.max(0, (end - start) / 1000).toFixed(1) : "0.0";
}

// Orange status row for a transient BLE blip. Non-destructive —
// the recorded effort continues; the message just tells the user
// the stream is reconnecting so they don't bail on a working hold.
export function SignalRecoveringNotice({ recovering }) {
  if (!recovering) return null;
  return (
    <div role="status" style={{ color: C.orange }}>
      Waiting for the Tindeq signal. Your recorded effort is being kept.
    </div>
  );
}
