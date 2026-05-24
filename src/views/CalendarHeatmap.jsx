// ─────────────────────────────────────────────────────────────
// CalendarHeatmap — GitHub-style year activity heatmap
// ─────────────────────────────────────────────────────────────
// Compact 7×~53 grid of small squares showing the last 365 days of
// training activity at a glance. Each square is one day; color
// intensity scales with how many distinct activities were logged
// that day (finger sessions + workouts + climbs + stretch markers,
// summed). Tap a square → a detail popup lists what was logged.
//
// Lives at the top of HistoryView so the at-a-glance overview shares
// the same "looking backward" mental model as the per-session list
// underneath. Independent of the domain toggle — always shows
// everything regardless of which domain (fingers / workout / etc.)
// you're inspecting in the list below.
//
// Data plumbing: takes history (finger reps), activities, and wLog
// as props rather than reading LS directly, so HistoryView's parent
// stays the single source of truth and tick-bump remounts propagate
// naturally. The detail popup uses derived per-day rollups from the
// same inputs.

import React, { useMemo, useState } from "react";
import { C } from "../ui/theme.js";
import { Card } from "../ui/components.js";
import { ymdLocal } from "../util.js";
import { ascentMeta } from "../lib/climbing-grades.js";

// Heatmap color ramp. Empty days sit at the page background tone so
// they read as "no activity" without dominating the grid. Each
// non-zero bucket steps the green channel up. Tuned for the existing
// dark theme — bright enough to register but not garish.
const RAMP = [
  C.border,           // 0 — no activity
  "#1a3a1a",          // 1 activity
  "#266326",          // 2
  "#3f9a3f",          // 3
  "#5fd95f",          // 4+
];

const CELL    = 11;   // px per cell — fits ~7×53 = 583px wide; scales down via parent overflow
const GAP     = 2;
const ROW_H   = CELL + GAP;
const COL_W   = CELL + GAP;
const DAYS    = 365;  // window
const WEEKDAY = ["", "Mon", "", "Wed", "", "Fri", ""]; // sparse so the labels don't crowd

// Build the per-day activity map from raw inputs. Single pass over
// each source; result is { 'YYYY-MM-DD': { fingers: Set<sessionId>,
// workouts: [...], climbs: [...], stretches: [...] } }. Finger reps
// are deduped by session_id so a 5-rep session counts as 1 activity,
// not 5. Workouts, climbs, and stretch markers each count as 1.
function buildDayIndex({ history, activities, wLog }) {
  const out = new Map();
  const get = (date) => {
    if (!out.has(date)) {
      out.set(date, { fingers: new Set(), workouts: [], climbs: [], stretches: [] });
    }
    return out.get(date);
  };
  for (const r of history || []) {
    if (!r?.date) continue;
    const sid = r.session_id || `${r.date}|${r.grip || ""}|${r.hand || ""}`;
    get(r.date).fingers.add(sid);
  }
  for (const a of activities || []) {
    if (!a?.date) continue;
    if (a.type === "climbing") get(a.date).climbs.push(a);
  }
  for (const s of wLog || []) {
    if (!s?.date) continue;
    // Match the same robust check stretchState uses — cloud-synced
    // rows may carry only `workout`, not `workoutId`.
    const id = s.workoutId || s.workout;
    if (id === "STRETCH") get(s.date).stretches.push(s);
    else if (id) get(s.date).workouts.push(s);
  }
  return out;
}

// Count distinct activity categories on a day. Caps at the RAMP
// length so the color scale doesn't run off the end.
function intensity(entry) {
  if (!entry) return 0;
  let n = 0;
  if (entry.fingers.size > 0)  n += 1;
  if (entry.workouts.length)   n += 1;
  if (entry.climbs.length)     n += 1;
  if (entry.stretches.length)  n += 1;
  return Math.min(n, RAMP.length - 1);
}

// Build the 7×N grid of dates ending today. Aligns weeks so Sunday
// is row 0; some leading cells before the first day are blank to
// pad the column. Returns columns[col][row] = date string or null.
function buildGrid(endDate) {
  const end = new Date(endDate + "T00:00:00");
  const startMs = end.getTime() - (DAYS - 1) * 86400000;
  const dates = [];
  for (let i = 0; i < DAYS; i++) {
    dates.push(new Date(startMs + i * 86400000));
  }
  // Pad the front so column 0 starts on Sunday.
  const firstDow = dates[0].getDay();
  const padded = [...Array(firstDow).fill(null), ...dates];
  // Slice into 7-row columns. Trailing nulls if the last column is
  // partial so the grid stays rectangular.
  const cols = [];
  for (let i = 0; i < padded.length; i += 7) {
    const col = padded.slice(i, i + 7);
    while (col.length < 7) col.push(null);
    cols.push(col);
  }
  return cols;
}

// Group adjacent columns by the month their FIRST in-range day falls
// in, so we can render a small month label above each new month's
// first column.
function buildMonthBands(cols) {
  const bands = [];
  let lastLabel = null;
  cols.forEach((col, ci) => {
    const firstDate = col.find(d => d != null);
    if (!firstDate) return;
    const label = firstDate.toLocaleString(undefined, { month: "short" });
    if (label !== lastLabel) {
      bands.push({ col: ci, label });
      lastLabel = label;
    }
  });
  return bands;
}

export function CalendarHeatmap({ history = [], activities = [], wLog = [] }) {
  const [selectedDate, setSelectedDate] = useState(null);

  const dayIndex = useMemo(
    () => buildDayIndex({ history, activities, wLog }),
    [history, activities, wLog],
  );

  const today = ymdLocal();
  const cols = useMemo(() => buildGrid(today), [today]);
  const monthBands = useMemo(() => buildMonthBands(cols), [cols]);

  // Totals shown in the card header — quick at-a-glance counts for
  // the visible window.
  const totals = useMemo(() => {
    let f = 0, w = 0, c = 0, s = 0, activeDays = 0;
    for (const entry of dayIndex.values()) {
      if (intensity(entry) === 0) continue;
      activeDays += 1;
      f += entry.fingers.size;
      w += entry.workouts.length;
      c += entry.climbs.length;
      s += entry.stretches.length;
    }
    return { fingers: f, workouts: w, climbs: c, stretches: s, activeDays };
  }, [dayIndex]);

  const selectedEntry = selectedDate ? dayIndex.get(selectedDate) : null;

  return (
    <Card style={{ marginBottom: 16, padding: "12px 14px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6, flexWrap: "wrap", gap: 6 }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>Last 365 days</div>
        <div style={{ fontSize: 11, color: C.muted }}>
          {totals.activeDays} active {totals.activeDays === 1 ? "day" : "days"}
          {" · "}
          {totals.fingers} finger · {totals.workouts} workout · {totals.climbs} climb · {totals.stretches} stretch
        </div>
      </div>

      {/* Grid wrapper handles horizontal overflow on narrow screens.
          Padding-bottom leaves room for the day-of-week labels on
          the left when the grid scrolls — they're absolutely
          positioned to stay aligned with their rows. */}
      <div style={{ overflowX: "auto", paddingTop: 14, position: "relative" }}>
        <div style={{
          display: "inline-grid",
          gridTemplateColumns: `auto repeat(${cols.length}, ${COL_W}px)`,
          gridTemplateRows: `auto repeat(7, ${ROW_H}px)`,
          gap: 0,
        }}>
          {/* Top-left blank corner */}
          <div />

          {/* Month band row */}
          {cols.map((_, ci) => {
            const band = monthBands.find(b => b.col === ci);
            return (
              <div key={`m${ci}`} style={{
                gridColumn: ci + 2, gridRow: 1,
                fontSize: 9, color: C.muted, height: 14, lineHeight: "14px",
                paddingLeft: 1, whiteSpace: "nowrap",
              }}>
                {band ? band.label : ""}
              </div>
            );
          })}

          {/* Weekday labels (sparse) */}
          {WEEKDAY.map((label, r) => (
            <div key={`w${r}`} style={{
              gridColumn: 1, gridRow: r + 2,
              fontSize: 9, color: C.muted, paddingRight: 4,
              lineHeight: `${ROW_H}px`,
              textAlign: "right",
            }}>{label}</div>
          ))}

          {/* Cells */}
          {cols.flatMap((col, ci) => col.map((date, r) => {
            if (!date) {
              return (
                <div key={`${ci}-${r}-empty`} style={{
                  gridColumn: ci + 2, gridRow: r + 2,
                  width: CELL, height: CELL, opacity: 0,
                }} />
              );
            }
            const ymd = ymdLocal(date);
            const entry = dayIndex.get(ymd);
            const lvl = intensity(entry);
            const isToday = ymd === today;
            const isSel   = ymd === selectedDate;
            return (
              <button
                key={`${ci}-${r}`}
                onClick={() => setSelectedDate(sel => sel === ymd ? null : ymd)}
                title={`${ymd}${lvl > 0 ? ` · ${lvl} ${lvl === 1 ? "activity" : "activities"}` : ""}`}
                style={{
                  gridColumn: ci + 2, gridRow: r + 2,
                  width: CELL, height: CELL,
                  background: RAMP[lvl],
                  border: isSel ? `1px solid ${C.blue}`
                        : isToday ? `1px solid ${C.muted}`
                        : "none",
                  borderRadius: 2, padding: 0, cursor: "pointer",
                }}
              />
            );
          }))}
        </div>
      </div>

      {/* Legend — small ramp + "less / more" tags so first-time
          viewers can decode the color scale without instructions. */}
      <div style={{
        display: "flex", justifyContent: "flex-end",
        alignItems: "center", gap: 4, marginTop: 8,
        fontSize: 10, color: C.muted,
      }}>
        <span>Less</span>
        {RAMP.map((c, i) => (
          <span key={i} style={{
            display: "inline-block", width: CELL, height: CELL,
            background: c, borderRadius: 2,
          }} />
        ))}
        <span>More</span>
      </div>

      {/* Detail strip — appears below the grid when a day is tapped.
          Keeps the calendar's vertical footprint stable in the
          common (un-tapped) case while still surfacing the
          per-category breakdown when the user wants it. */}
      {selectedDate && (
        <div style={{
          marginTop: 12, padding: "10px 12px",
          background: C.bg, borderRadius: 8,
          border: `1px solid ${C.border}`,
          fontSize: 12, lineHeight: 1.5,
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
            <div style={{ fontWeight: 700 }}>
              {new Date(selectedDate + "T00:00:00").toLocaleDateString(undefined, {
                weekday: "short", month: "short", day: "numeric", year: "numeric",
              })}
            </div>
            <button
              onClick={() => setSelectedDate(null)}
              style={{
                background: "none", border: "none", color: C.muted,
                cursor: "pointer", fontSize: 16, padding: "0 2px", lineHeight: 1,
              }}
              aria-label="Close detail"
            >×</button>
          </div>
          {!selectedEntry || intensity(selectedEntry) === 0 ? (
            <div style={{ color: C.muted }}>No activity logged.</div>
          ) : (
            <>
              {selectedEntry.fingers.size > 0 && (
                <div>
                  <b style={{ color: C.orange }}>🖐 Fingers:</b>{" "}
                  {selectedEntry.fingers.size}{" "}
                  {selectedEntry.fingers.size === 1 ? "session" : "sessions"}
                </div>
              )}
              {selectedEntry.workouts.length > 0 && (
                <div>
                  <b style={{ color: C.blue }}>🏋️ Workout:</b>{" "}
                  {selectedEntry.workouts.map(w => w.workoutId || w.workout).join(", ")}
                </div>
              )}
              {selectedEntry.climbs.length > 0 && (
                <div>
                  <b style={{ color: C.green }}>🧗 Climbs:</b>{" "}
                  {selectedEntry.climbs.length} —{" "}
                  {/* Compact one-line preview: "V5 flash, V4 send, …" */}
                  {selectedEntry.climbs.slice(0, 4).map((c, i) => (
                    <span key={c.id || i}>
                      {i > 0 ? ", " : ""}
                      {c.grade || "—"}{c.ascent ? ` ${ascentMeta(c.ascent).label.toLowerCase()}` : ""}
                    </span>
                  ))}
                  {selectedEntry.climbs.length > 4 && ` (+${selectedEntry.climbs.length - 4} more)`}
                </div>
              )}
              {selectedEntry.stretches.length > 0 && (
                <div>
                  <b style={{ color: C.purple }}>🧘 Stretch:</b> logged
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Card>
  );
}
