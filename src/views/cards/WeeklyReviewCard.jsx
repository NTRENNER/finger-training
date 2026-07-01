// ─────────────────────────────────────────────────────────────
// WEEKLY REVIEW CARD
// ─────────────────────────────────────────────────────────────
// Read-only coach's note at the top of the Analysis tab. Renders the
// completed-week digest from src/model/weeklyReview.js (a narration
// layer over the app's existing signals — deload status, curve
// improvement, ladder bumps, climbing grade PRs, staleness).
//
// COMPLETED-WEEK MODE: refDate is the Sunday that ended the last full
// Mon–Sun week (weekStart-of-today minus one day), so the card always
// shows a stable, finished week rather than a sparse mid-week sliver.
// The same buildWeeklyReview() call, given refDate = yesterday on a
// Monday, is what a future scheduled Monday digest would use.
//
// Data: history + activities come from props (already threaded into
// AnalysisContainer); the workout log is read straight from
// localStorage, mirroring WorkoutAnalysisView.

import React, { useMemo } from "react";
import { C } from "../../ui/theme.js";
import { Card } from "../../ui/components.js";
import { buildWeeklyReview } from "../../model/weeklyReview.js";
import { weekKey } from "../../lib/climbing-grades.js";
import { loadLS, LS_WORKOUT_LOG_KEY } from "../../lib/storage.js";

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

export function WeeklyReviewCard({ history = [], activities = [] }) {
  const review = useMemo(() => {
    // Last complete Mon–Sun week: the Sunday before this week's Monday.
    const todayYMD = new Date().toLocaleDateString("en-CA"); // local YYYY-MM-DD
    const refDate = addDays(weekKey(todayYMD), -1);
    let workoutSessions = [];
    try { workoutSessions = loadLS(LS_WORKOUT_LOG_KEY) || []; } catch (e) { workoutSessions = []; }
    return buildWeeklyReview(history, activities, workoutSessions, { refDate });
  }, [history, activities]);

  const range = review.range;
  return (
    <Card style={{ margin: "12px 16px 0" }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: C.muted }}>
        Weekly review{range ? ` · ${fmt(range.weekStart)} – ${fmt(range.weekEnd)}` : ""}
      </div>
      <div style={{ fontSize: 16, fontWeight: 700, color: C.text, margin: "6px 0 2px" }}>
        {review.headline}
      </div>
      {review.points.map((p, i) => (
        <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 8 }}>
          <span style={{ flexShrink: 0 }}>{MARK[p.kind] || "•"}</span>
          <span style={{ color: COLOR[p.kind] || C.text, fontSize: 14, lineHeight: 1.4 }}>{p.text}</span>
        </div>
      ))}
    </Card>
  );
}
