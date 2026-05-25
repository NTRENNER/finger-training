// ─────────────────────────────────────────────────────────────
// CookednessSlider — day-default + per-session override editor
// ─────────────────────────────────────────────────────────────
// Cookedness is the user's pre-session systemic fatigue load
// (0 = fresh, 10 = wrecked). Used by buildFreshLoadMap to scale a
// cooked session's reps up to their fresh-equivalent before the
// curve fit consumes them — without compensation, a cooked session
// silently teaches the engine "your true capacity is lower" and
// drifts future fresh prescriptions down.
//
// Two scopes:
//   • Day default (daily_state.cooked, keyed by date)
//   • Session override (reps.session_cooked, stamped on every rep
//     in a single session)
//
// Resolution order in the curve fit is session override → day
// default → null. So the day default works as a blanket setting for
// the whole day, with each session free to peel off if its conditions
// were different (e.g. cooked from a midday MoonBoard session that
// only the evening Tindeq workout actually inherited).
//
// UX rules:
//   • Always show the EFFECTIVE value the curve fit will actually use.
//   • Default mode = "day": slider edits go to the day-level value
//     (matches the simple case of "I was cooked this day", affecting
//     every session on that date).
//   • One-tap "Override for this session" promotes to session mode:
//     slider edits go to that session only, leaving the day default
//     alone. A "Use day default" link reverts.
//   • Both modes have a "clear" affordance — distinct meanings:
//     in day mode, clear removes daily_state.cooked entirely
//     (= no opinion logged for the day); in session mode, clear
//     removes just the override and inherits the day default again.

import React, { useState, useEffect } from "react";
import { C } from "../../ui/theme.js";

export function CookednessSlider({
  date,
  dayValue,            // daily_state.cooked for this date (number | null)
  sessionValue,        // session-specific override (number | null)
  onSaveDay,           // (cooked|null) => void
  onSaveSessionOverride, // (cooked|null) => void  — null clears the override
}) {
  // The slider always edits the EFFECTIVE value (whichever scope is
  // currently active). Mode flips between "day" (default) and
  // "session" (override). Initial mode is "session" iff a session
  // override is already set — opening an overridden session lands
  // in session mode so the displayed value matches what's being
  // edited if the user moves the slider.
  const hasOverride = sessionValue != null;
  const [mode, setMode] = useState(hasOverride ? "session" : "day");

  // If session override clears externally (e.g. the user clicked
  // "Use day default" and the upstream state now has no override),
  // collapse back to day mode so subsequent edits don't silently
  // re-create a session override.
  useEffect(() => {
    if (sessionValue == null && mode === "session") setMode("day");
  }, [sessionValue, mode]);

  const effective = sessionValue ?? dayValue ?? null;
  const draftFloor = effective ?? 0;

  // Draft state mirrors the slider during drag. Commit on release so
  // the curve fit rebuilds once per gesture, not per pixel.
  const [draft, setDraft] = useState(draftFloor);
  useEffect(() => { setDraft(draftFloor); }, [draftFloor]);

  const commit = () => {
    const v = draft ?? 0;
    if (mode === "session") onSaveSessionOverride(v);
    else onSaveDay(v);
  };

  // Status line — describes what scope the slider is currently
  // editing AND what scope the displayed value is sourced from.
  // Worth being explicit here because the difference matters for
  // multi-session days.
  const statusLine = (() => {
    if (mode === "session") {
      return hasOverride
        ? "Editing this session's override"
        : "Editing this session's override (not saved yet)";
    }
    // Day mode
    if (hasOverride) {
      return `Day default = ${dayValue ?? 0}/10 · this session is overridden`;
    }
    if (dayValue != null) return "Editing day default — applies to all sessions today";
    return "Editing day default — no value set yet";
  })();

  // The "scope toggle" link — flips between day and session.
  // Wording reflects the destination, not the current state.
  const scopeToggle = mode === "day" ? (
    <button
      onClick={() => setMode("session")}
      style={linkStyle}
    >Override for this session only</button>
  ) : (
    <button
      onClick={() => {
        // Clear the override AND return to day mode.
        if (hasOverride) onSaveSessionOverride(null);
        setMode("day");
      }}
      style={linkStyle}
    >Use day default</button>
  );

  // Clear action — meaning depends on mode.
  const clearLink = (() => {
    if (mode === "session" && hasOverride) {
      return (
        <button
          onClick={() => onSaveSessionOverride(null)}
          style={linkStyle}
        >clear override</button>
      );
    }
    if (mode === "day" && dayValue != null) {
      return (
        <button
          onClick={() => onSaveDay(null)}
          style={linkStyle}
        >clear day</button>
      );
    }
    return null;
  })();

  return (
    <div style={{
      marginTop: 14, paddingTop: 12,
      borderTop: `1px solid ${C.border}`,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
        <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5 }}>
          Cookedness on {date}
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: effective != null ? C.purple : C.muted }}>
            {effective != null ? `${draft}/10` : "unset"}
          </div>
        </div>
      </div>
      <input
        type="range"
        min="0" max="10" step="1"
        value={draft}
        onChange={(e) => setDraft(Number(e.target.value))}
        onMouseUp={commit}
        onTouchEnd={commit}
        style={{ width: "100%", accentColor: C.purple }}
      />
      <div style={{
        fontSize: 11, color: C.muted, marginTop: 4, lineHeight: 1.4,
        display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap",
      }}>
        <span style={{ flex: 1, minWidth: 0 }}>{statusLine}</span>
        <span style={{ display: "flex", gap: 10, flexShrink: 0 }}>
          {clearLink}
          {scopeToggle}
        </span>
      </div>
      <div style={{ fontSize: 10, color: C.muted, marginTop: 6, lineHeight: 1.4, fontStyle: "italic" }}>
        Higher = more cooked. The curve fit treats this session's reps as
        their fresh-equivalent so future fresh prescriptions don't drift down.
      </div>
    </div>
  );
}

const linkStyle = {
  background: "none", border: "none", color: C.muted,
  fontSize: 11, cursor: "pointer", padding: 0,
  textDecoration: "underline",
};
