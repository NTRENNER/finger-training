// ─────────────────────────────────────────────────────────────
// CLIMB VIEW — top-level "Climb" tab
// ─────────────────────────────────────────────────────────────
// Re-extracted from the Fingers tab in May 2026. Climbing capture
// originally had its own top-level tab; in an earlier consolidation
// pass it was folded into Fingers (the ClimbingLogCard sat above
// SessionSetup). That made Fingers crowded with two unrelated
// inputs, so this view restores the dedicated home: logger on top,
// recent-climbs digest below.
//
// Scope here is the climb-prep + capture surface: an Adaptive
// Warm-up entry at the top (used before a climbing session; moved
// here from Fingers since that's the activity it precedes), the
// climb logger, and a glanceable recent-climbs digest. Deeper
// climbing surfaces (full filterable
// history, grade pyramid, etc.) still live in the History tab's
// climbing pill and the Analysis tab's Climbs pill respectively;
// this view points at History for the full log when the digest
// runs out of rows.

import React, { useState } from "react";
import { C } from "../ui/theme.js";
import { Card } from "../ui/components.js";
import { ClimbingLogCard } from "./cards/ClimbingLogCard.js";
import { WarmupView } from "./WarmupView.js";
import {
  disciplineMeta, ascentMeta, wallMeta, describeClimb,
} from "../lib/climbing-grades.js";
import { today } from "../util.js";
import { loadLS, LS_WORKOUT_LOG_KEY } from "../lib/storage.js";

// How many recent climbs to surface inline before pointing the
// user at the full History tab. Picked to fit comfortably on a
// phone screen without the digest becoming its own scrollable
// region — the moment you want to filter or sort, you're better
// served by ClimbingHistoryList in the History tab.
const RECENT_LIMIT = 8;

// Human-readable relative date for the digest header. Plain ISO
// dates (2026-05-22) make a recent-activity list feel stale even
// when it isn't, so we soften "today" / "yesterday" / "N days ago"
// for the first few days and fall back to the date string after.
//
// All math is done at the date-string level (no Date objects) so a
// climb logged at 11:55pm and viewed at 12:05am the next morning
// still reads as "yesterday" instead of getting timezone-confused.
function relativeDate(dateStr) {
  if (!dateStr) return "—";
  const t = today();
  if (dateStr === t) return "Today";
  // Compute day delta via Date diff in UTC midnight to avoid DST drift.
  const [ty, tm, td] = t.split("-").map(Number);
  const [dy, dm, dd] = dateStr.split("-").map(Number);
  const todayUtc = Date.UTC(ty, tm - 1, td);
  const thatUtc  = Date.UTC(dy, dm - 1, dd);
  const days = Math.round((todayUtc - thatUtc) / 86400000);
  if (days === 1) return "Yesterday";
  if (days > 1 && days < 7) return `${days} days ago`;
  return dateStr;
}

// One row inside the Recent Climbs card. Mirrors the visual
// language of ClimbingHistoryList's ClimbRow but stripped to a
// read-only summary — no inline edit or delete here; the full
// editor lives in the History tab.
function RecentClimbRow({ climb: c, showTopBorder }) {
  const isSend = c.ascent && c.ascent !== "attempt";
  const disc   = disciplineMeta(c.discipline);
  const wall   = c.discipline === "boulder" && c.wall ? wallMeta(c.wall) : null;
  const venueLabel = c.venue === "outdoor" ? "Outdoor" : null;
  const locationParts = [c.route_name, c.crag, c.area].filter(Boolean);

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
      padding: "8px 0",
      borderTop: showTopBorder ? `1px solid ${C.border}` : "none",
    }}>
      <div style={{ fontSize: 18 }}>{disc.emoji}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>
          {c.grade || "—"}{" "}
          <span style={{ color: C.muted, fontWeight: 400 }}>
            {disc.label}
            {venueLabel ? ` · ${venueLabel}` : ""}
            {wall ? ` · ${wall.label}` : ""}
          </span>
        </div>
        <div style={{ fontSize: 11, color: isSend ? C.green : C.muted }}>
          {relativeDate(c.date)}
          {" · "}
          {c.ascent ? ascentMeta(c.ascent).label : describeClimb(c)}
          {Number.isFinite(c.rpe) ? ` · RPE ${c.rpe}` : ""}
        </div>
        {locationParts.length > 0 && (
          <div style={{
            fontSize: 11, color: C.text, marginTop: 2,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {c.route_name && <b>{c.route_name}</b>}
            {c.route_name && (c.crag || c.area) ? " · " : ""}
            <span style={{ color: C.muted }}>
              {[c.crag, c.area].filter(Boolean).join(", ")}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

export function ClimbView({
  activities = [],
  onLogActivity = () => {},
  // Optional — when provided, the "View full history" button in the
  // Recent Climbs card calls this to switch the user to the History
  // tab. App.js wires it to setTab(historyTabIndex) so the user
  // doesn't have to find History manually after the digest fills.
  onNavigateToHistory = null,
  // Adaptive Warm-up inputs — the warm-up generates force-curve-derived
  // hangs from finger history and cross-loaded pullups, used before a
  // climbing session. Self-contained (its own Connect Tindeq button).
  history = [],
  bodyWeight = null,
  tindeq = null,
  unit = "lbs",
}) {
  const [warmupActive, setWarmupActive] = useState(false);

  // Adaptive Warm-up takeover — replaces ClimbView until closed.
  if (warmupActive) {
    const wLog = loadLS(LS_WORKOUT_LOG_KEY) || [];
    return (
      <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
        <WarmupView
          history={history}
          wLog={wLog}
          bodyWeightKg={bodyWeight}
          tindeq={tindeq}
          unit={unit}
          onClose={() => setWarmupActive(false)}
        />
      </div>
    );
  }

  // Sort climbs date-descending and cap at RECENT_LIMIT. ISO date
  // strings sort lexicographically so localeCompare on .date does
  // the right thing without parsing.
  const climbs = activities
    .filter(a => a?.type === "climbing")
    .slice()
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const recent = climbs.slice(0, RECENT_LIMIT);

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
      <h2 style={{ margin: "0 0 20px", fontSize: 22, fontWeight: 700 }}>Climb</h2>

      {/* Adaptive Warm-up entry point — warm up your fingers before
          climbing. Force-curve-derived hangs + cross-loaded pullups. */}
      <Card style={{ marginBottom: 16, border: `1px solid ${C.purple}40` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 2 }}>Adaptive Warm-up</div>
            <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.4 }}>
              Force-curve-derived hangs + cross-loaded pullups. Same feel every session, never near failure.
            </div>
          </div>
          <button
            onClick={() => setWarmupActive(true)}
            style={{
              background: C.purple, color: "#fff", border: "none", borderRadius: 8,
              padding: "10px 18px", fontSize: 13, fontWeight: 700, cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            Generate
          </button>
        </div>
      </Card>

      {/* Logger — same single-card component used elsewhere. Tapping
          expands the form inline; saves go through onLogActivity which
          mirrors to LS + cloud. */}
      <ClimbingLogCard activities={activities} onLog={onLogActivity} />

      {/* Recent climbs digest. Empty state prompts the user to log;
          populated state shows the last N entries with a deep link
          out to the full History tab. */}
      <Card>
        <div style={{
          display: "flex", justifyContent: "space-between",
          alignItems: "baseline", marginBottom: 10,
        }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>Recent Climbs</div>
          <div style={{ fontSize: 11, color: C.muted }}>
            {climbs.length} total
          </div>
        </div>

        {recent.length === 0 ? (
          <div style={{ fontSize: 12, color: C.muted, padding: "4px 0" }}>
            No climbs logged yet. Tap <b style={{ color: C.text }}>Log a climb</b> above to start.
          </div>
        ) : (
          <>
            {recent.map((c, i) => (
              <RecentClimbRow
                key={c.id || `${c.date}-${c.grade}-${c.ascent}-${i}`}
                climb={c}
                showTopBorder={i > 0}
              />
            ))}
            {climbs.length > recent.length && onNavigateToHistory && (
              <button
                onClick={onNavigateToHistory}
                style={{
                  marginTop: 10, width: "100%", padding: "8px 12px",
                  borderRadius: 8, background: "none",
                  border: `1px solid ${C.border}`,
                  color: C.muted, fontSize: 12, fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                View all {climbs.length} climbs in History →
              </button>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
