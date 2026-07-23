// ─────────────────────────────────────────────────────────────
// WEEKLY REVIEW CARD
// ─────────────────────────────────────────────────────────────
// Coach's note at the top of the Analysis tab. COMPACT by default —
// the digest headline + 2-4 points from src/model/weeklyReview.js —
// with a tap-to-expand FULL CHECK-IN (July 2026): the five-section
// coach report (What you did / What's moving / What's stuck or
// missing / What the engine will recommend / Heads up) modeled on the
// scheduled-task coach prompt. Both views come from the same
// buildCheckIn() call; the compact card just renders the digest subset.
//
// COMPLETED-WEEK MODE: refDate is the Sunday that ended the last full
// Mon–Sun week (weekStart-of-today minus one day), so the card always
// shows a stable, finished week rather than a sparse mid-week sliver.
//
// Data: history + activities come from props; the workout log and BW
// log are read straight from localStorage, mirroring
// WorkoutAnalysisView / BwPrompt.

import React, { useMemo, useState } from "react";
import { C } from "../../ui/theme.js";
import { Card } from "../../ui/components.js";
import { buildCheckIn } from "../../model/weeklyReview.js";
import { weekKey } from "../../lib/climbing-grades.js";
import { loadLS, LS_WORKOUT_LOG_KEY, LS_BW_LOG_KEY } from "../../lib/storage.js";

function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function fmt(ymd) {
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
const MARK = { win: "✅", concern: "⚠️", info: "•" };
const COLOR = { win: C.green, concern: C.orange, info: C.muted };

// Section order + display copy for the expanded check-in.
// "focus" header (July 2026, per Nathan): the section EXPLAINS what the
// recommender will do and why (staleness receipts), rather than issuing
// a parallel set of orders — item voice in weeklyReview.js matches.
const SECTIONS = [
  ["did",     "What you did"],
  ["moving",  "What's moving"],
  ["stuck",   "What's stuck or missing"],
  ["focus",   "What the engine will recommend — and why"],
  ["headsUp", "Heads up"],
];

export function WeeklyReviewCard({ history = [], activities = [] }) {
  const [expanded, setExpanded] = useState(false);
  const review = useMemo(() => {
    // Last complete Mon–Sun week: the Sunday before this week's Monday.
    const todayYMD = new Date().toLocaleDateString("en-CA"); // local YYYY-MM-DD
    const refDate = addDays(weekKey(todayYMD), -1);
    let workoutSessions = [];
    let bwLog = [];
    try { workoutSessions = loadLS(LS_WORKOUT_LOG_KEY) || []; } catch (e) { workoutSessions = []; }
    try { bwLog = loadLS(LS_BW_LOG_KEY) || []; } catch (e) { bwLog = []; }
    return buildCheckIn(history, activities, workoutSessions, { refDate, bwLog });
  }, [history, activities]);

  const range = review.range;
  return (
    <Card style={{ margin: "12px 16px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: C.muted }}>
          Weekly check-in{range ? ` · ${fmt(range.weekStart)} – ${fmt(range.weekEnd)}` : ""}
        </div>
        {review.sections && (
          <button
            onClick={() => setExpanded(v => !v)}
            style={{
              background: "none", border: "none", cursor: "pointer", padding: 0,
              fontSize: 11, fontWeight: 700, color: C.blue,
            }}
          >
            {expanded ? "− compact" : "Full check-in ▾"}
          </button>
        )}
      </div>
      <div style={{ fontSize: 16, fontWeight: 700, color: C.text, margin: "6px 0 2px" }}>
        {review.headline}
      </div>

      {!expanded && (review.points || []).map((p, i) => (
        <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 8 }}>
          <span style={{ flexShrink: 0 }}>{MARK[p.kind] || "•"}</span>
          <span style={{ color: COLOR[p.kind] || C.text, fontSize: 14, lineHeight: 1.4 }}>{p.text}</span>
        </div>
      ))}

      {expanded && review.sections && SECTIONS.map(([key, label]) => {
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
      {expanded && (
        <div style={{ marginTop: 12, fontSize: 11, color: C.muted, fontStyle: "italic" }}>— Coach</div>
      )}
    </Card>
  );
}
