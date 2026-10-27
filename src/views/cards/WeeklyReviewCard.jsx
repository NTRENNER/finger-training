// ─────────────────────────────────────────────────────────────
// CURRENT TRAINING ANALYSIS CARD
// ─────────────────────────────────────────────────────────────
// Current interpretation at the top of the Analysis tab. Compact by
// default, with a tap-to-expand five-section evidence summary. Both views
// come from the same
// buildCheckIn() call; the compact card just renders the digest subset.
//
// LIVE-WEEK MODE: refDate is today. Finger, climbing, strength, bodyweight,
// and program writes all invalidate the card, so analysis refreshes after
// completed work instead of waiting for the next calendar week.
//
// Data: history + activities come from props; the workout log and BW
// log are read straight from localStorage, mirroring
// WorkoutAnalysisView / BwPrompt.

import React, { useMemo, useState } from "react";
import { C } from "../../ui/theme.js";
import { Card } from "../../ui/components.jsx";
import { buildCheckIn } from "../../model/weeklyReview.js";
import { buildDeloadGuidance, deloadStatus, DELOAD_WEEK_DAYS } from "../../model/deload.js";
import { saveLS, LS_WORKOUT_LOG_KEY, LS_BW_LOG_KEY, LS_WORKOUT_PLAN_KEY, LS_DELOAD_WEEK_KEY } from "../../lib/storage.js";
import { useLSValue } from "../../hooks/useLSValue.js";
import { today } from "../../util.js";

function fmt(ymd) {
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
const MARK = { win: "✅", concern: "⚠️", info: "•" };
const COLOR = { win: C.green, concern: C.orange, info: C.muted };

// Section order + display copy for the expanded analysis.
// "focus" header (July 2026, per Nathan): the section EXPLAINS what the
// recommender will do and why (staleness receipts), rather than issuing
// a parallel set of orders — item voice in weeklyReview.js matches.
const SECTIONS = [
  ["did",     "Training completed"],
  ["moving",  "Progress"],
  ["stuck",   "Gaps and recovery"],
  ["focus",   "Recommendation inputs"],
  ["headsUp", "Data notes"],
];

export function WeeklyReviewCard({ history = [], activities = [] }) {
  const [expanded, setExpanded] = useState(false);
  const workoutSessionsRaw = useLSValue(LS_WORKOUT_LOG_KEY);
  const bwLogRaw = useLSValue(LS_BW_LOG_KEY);
  const program = useLSValue(LS_WORKOUT_PLAN_KEY);
  const deloadWeek = useLSValue(LS_DELOAD_WEEK_KEY);
  const workoutSessions = useMemo(() => workoutSessionsRaw || [], [workoutSessionsRaw]);
  const bwLog = useMemo(() => bwLogRaw || [], [bwLogRaw]);
  const todayYMD = today();
  const review = useMemo(() => {
    return buildCheckIn(history, activities, workoutSessions, { refDate: todayYMD, bwLog, program });
  }, [history, activities, workoutSessions, todayYMD, bwLog, program]);

  const recoveryStatus = useMemo(
    () => deloadStatus(history, workoutSessions, { today: todayYMD, activities }),
    [history, workoutSessions, todayYMD, activities],
  );
  const dayDiff = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
  const deloadDay = deloadWeek?.start ? dayDiff(deloadWeek.start, todayYMD) + 1 : 0;
  const deloadActive = !!deloadWeek?.start && deloadDay >= 1 && deloadDay <= DELOAD_WEEK_DAYS;
  const activeGuidance = useMemo(() => deloadActive
    ? buildDeloadGuidance(deloadWeek.severity, history, { today: todayYMD }) : null,
  [deloadActive, deloadWeek, history, todayYMD]);
  const startDeloadWeek = () => saveLS(LS_DELOAD_WEEK_KEY,
    { start: todayYMD, severity: recoveryStatus.deload.severity });
  const endDeloadWeek = () => saveLS(LS_DELOAD_WEEK_KEY, null);

  const range = review.range;
  return (
    <Card style={{ margin: "12px 16px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: C.muted }}>
          Current training analysis{range ? ` · ${fmt(range.weekStart)} – ${fmt(range.weekEnd)}` : ""}
        </div>
        {review.sections && (
          <button
            onClick={() => setExpanded(v => !v)}
            aria-expanded={expanded}
            style={{
              background: "none", border: "none", cursor: "pointer", minHeight: 44, padding: "8px 0",
              fontSize: 14, fontWeight: 700, color: C.blue,
            }}
          >
            {expanded ? "− Summary" : "Details ▾"}
          </button>
        )}
      </div>
      <div style={{ fontSize: 16, fontWeight: 700, color: C.text, margin: "6px 0 2px" }}>
        {review.headline}
      </div>

      {(review.points || []).map((p, i) => (
        <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 8 }}>
          <span style={{ flexShrink: 0 }}>{MARK[p.kind] || "•"}</span>
          <span style={{ color: COLOR[p.kind] || C.text, fontSize: 14, lineHeight: 1.4 }}>{p.text}</span>
        </div>
      ))}

      {deloadActive && activeGuidance && (
        <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 14, paddingTop: 12 }}>
          <div style={{ color: C.orange, fontWeight: 700, fontSize: 12 }}>DELOAD WEEK · DAY {deloadDay} OF 7</div>
          <div style={{ color: C.text, fontSize: 13, lineHeight: 1.45, marginTop: 4 }}>{activeGuidance.action}</div>
          <button onClick={endDeloadWeek} style={{ marginTop: 8, background: "none", border: "none", color: C.muted, cursor: "pointer", padding: 0 }}>End deload week</button>
        </div>
      )}
      {!deloadActive && recoveryStatus.deload?.deload && recoveryStatus.deload.severity === "strong" && (
        <button onClick={startDeloadWeek} style={{ marginTop: 12, border: `1px solid ${C.orange}`, color: C.orange, background: "none", borderRadius: 6, padding: "6px 10px", cursor: "pointer", fontWeight: 700 }}>
          Start deload week
        </button>
      )}

      {expanded && review.sections && (
        <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 14, paddingTop: 2 }}>
          {SECTIONS.map(([key, label]) => {
            const items = review.sections[key] || [];
            if (!items.length) return null;
            const numbered = key === "focus";
            return (
              <div key={key} style={{ marginTop: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: C.muted, marginBottom: 4 }}>
                  {label}
                </div>
                {items.map((t, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 4 }}>
                    <span style={{ flexShrink: 0, color: C.muted, fontSize: 13 }}>
                      {numbered ? `${i + 1}.` : "·"}
                    </span>
                    <span style={{ color: C.text, fontSize: 13, lineHeight: 1.45 }}>{t}</span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
