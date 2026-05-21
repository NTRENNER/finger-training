// ─────────────────────────────────────────────────────────────
// PYRAMID CHART — true centered grade pyramid
// ─────────────────────────────────────────────────────────────
// Replaces the horizontal bar-chart "pyramid" with one that
// actually looks like a pyramid: each row is centered on a
// vertical axis, with N blocks per row matching the send count.
// Reads pyramid plan from model/gradePyramid.js for tier labels,
// targets, and per-tier coaching status.
//
// Renders two passes:
//   1. The pyramid itself — every grade row with sends, centered.
//      Coaching tiers (project, P-1, P-2, P-3) get the article's
//      labels and target-band callouts.
//   2. A compact coaching panel below — top recommendation +
//      per-tier status chips.
//
// No charting library; pure CSS flex. Stays responsive at narrow
// (340px) widths.

import React, { useMemo } from "react";
import { C } from "../../ui/theme.js";
import {
  buildPyramidPlan,
  topPyramidRecommendation,
  inferProjectGrade,
} from "../../model/gradePyramid.js";

// Status → color. Used for the tier badge + the row's coaching tag.
const STATUS_COLOR = {
  on_track: "#22c55e",  // green
  light:    "#f59e0b",  // amber
  heavy:    "#a78bfa",  // violet — "consider shifting up"
  missing:  "#6b7280",  // gray
};
const STATUS_LABEL = {
  on_track: "on track",
  light:    "light",
  heavy:    "heavy",
  missing:  "no sends",
};

// Block sizing tuned so a base tier with 12+ sends still fits in
// ~340px without wrapping. The container is set to flex-wrap so
// extreme counts (50+ ATB sends) wrap cleanly across multiple rows.
const BLOCK = { size: 14, gap: 3 };

export function PyramidChart({
  rows = [],
  fill = "#f59e0b",   // tier-agnostic fallback color (matches the old bar chart's orange)
  projectGrade = null, // optional override; otherwise inferred from rows
}) {
  const plan = useMemo(
    () => buildPyramidPlan(rows, projectGrade),
    [rows, projectGrade]
  );
  const headline = useMemo(() => topPyramidRecommendation(plan), [plan]);
  const inferredProject = useMemo(() => inferProjectGrade(rows), [rows]);
  const activeProject = projectGrade || inferredProject;

  // Build the per-grade render list. Show:
  //   - every grade present in `rows`, top → bottom (descending rank)
  //   - any "missing" tier grades that have rank set (so the pyramid
  //     shows gaps visually instead of silently skipping them)
  const renderRows = useMemo(() => {
    const byRank = new Map();
    for (const r of rows || []) {
      if (Number.isFinite(r.rank)) {
        byRank.set(r.rank, { grade: r.grade, rank: r.rank, count: r.count });
      }
    }
    // Inject zero-count rows for any tier in the plan that has a
    // null grade so the pyramid shows the gap.
    for (const t of plan) {
      if (t.rank != null && !byRank.has(t.rank)) {
        // synthesize a grade label from the closest known scale —
        // we don't have a grade name for empty tiers (the rows array
        // didn't have it), so leave it blank.
        byRank.set(t.rank, { grade: `(${t.label})`, rank: t.rank, count: 0, ghost: true });
      }
    }
    return [...byRank.values()].sort((a, b) => b.rank - a.rank);
  }, [rows, plan]);

  if (rows.length === 0 || !activeProject) {
    return (
      <div style={{ color: C.muted, fontSize: 12, padding: "16px 0", textAlign: "center" }}>
        No clean sends yet. Log a few climbs to start your pyramid.
      </div>
    );
  }

  // Lookup tier metadata by rank so we can decorate the matching rows
  // in the pyramid with project/consolidate/cleanup/base badges.
  const tierByRank = new Map();
  for (const t of plan) {
    if (t.rank != null) tierByRank.set(t.rank, t);
  }

  return (
    <div>
      {/* Headline recommendation */}
      {headline && (
        <div style={{
          padding: "8px 10px", marginBottom: 12,
          background: STATUS_COLOR[plan.find(p => p.tier === headline.tier)?.status ?? "on_track"] + "22",
          border: `1px solid ${STATUS_COLOR[plan.find(p => p.tier === headline.tier)?.status ?? "on_track"]}66`,
          borderRadius: 8,
          fontSize: 12, lineHeight: 1.4,
        }}>
          <span style={{ fontWeight: 700, marginRight: 6 }}>Next:</span>
          {headline.message}
        </div>
      )}

      {/* The pyramid itself — each row centered on the vertical axis */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 14 }}>
        {renderRows.map(r => {
          const tier = tierByRank.get(r.rank);
          const isProject = tier?.tier === 0;
          const isBase    = tier?.tier === -3;
          const statusColor = tier ? STATUS_COLOR[tier.status] : C.muted;
          return (
            <div key={r.rank} style={{
              display: "flex", alignItems: "center", gap: 8,
            }}>
              {/* Grade label — fixed-width gutter on the left */}
              <div style={{
                width: 44, flex: "0 0 44px", textAlign: "right",
                fontSize: 12, color: tier ? "#fff" : C.muted,
                fontWeight: tier ? 700 : 400,
                opacity: r.ghost ? 0.5 : 1,
              }}>
                {r.ghost ? "—" : r.grade}
              </div>

              {/* Centered block row */}
              <div style={{
                flex: 1, display: "flex", justifyContent: "center",
              }}>
                <div style={{
                  display: "flex", flexWrap: "wrap", justifyContent: "center",
                  gap: BLOCK.gap, maxWidth: "100%",
                  // Subtle bg for the base tier to visually echo "this
                  // is the foundation" without being heavy-handed.
                  padding: isBase ? "3px 6px" : 0,
                  borderRadius: isBase ? 4 : 0,
                  background: isBase ? statusColor + "10" : "transparent",
                }}>
                  {r.count === 0 ? (
                    <span style={{ fontSize: 11, color: C.muted, fontStyle: "italic" }}>
                      no sends
                    </span>
                  ) : (
                    Array.from({ length: r.count }).map((_, i) => (
                      <span key={i} style={{
                        display: "inline-block",
                        width: BLOCK.size, height: BLOCK.size,
                        background: tier ? statusColor : fill,
                        border: isProject ? `1.5px solid #fde68a` : "none",
                        borderRadius: 2,
                        opacity: tier ? 1 : 0.7,
                      }} />
                    ))
                  )}
                </div>
              </div>

              {/* Right-side tier badge — only on the four coaching tiers */}
              <div style={{
                width: 72, flex: "0 0 72px", textAlign: "left",
                fontSize: 9, color: tier ? statusColor : "transparent",
                fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4,
                lineHeight: 1.2,
              }}>
                {tier && (
                  <>
                    <div>{tier.label}</div>
                    <div style={{ color: C.muted, fontWeight: 500, textTransform: "none", fontSize: 9 }}>
                      {tier.actualCount}
                      {tier.targetMax === Infinity
                        ? ` / ${tier.targetMin}+`
                        : ` / ${tier.targetMin}–${tier.targetMax}`}
                    </div>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Per-tier coaching panel */}
      <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>
          Pyramid · project = {activeProject}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {plan.map(t => (
            <div key={t.tier} style={{
              display: "flex", gap: 8, alignItems: "flex-start",
              fontSize: 11, lineHeight: 1.4,
            }}>
              <span style={{
                flex: "0 0 auto", padding: "1px 6px", borderRadius: 4,
                background: STATUS_COLOR[t.status] + "22",
                color: STATUS_COLOR[t.status], fontWeight: 700,
                fontSize: 9, textTransform: "uppercase", letterSpacing: 0.4,
                whiteSpace: "nowrap",
              }}>
                {t.label} {t.grade ? `· ${t.grade}` : ""}
              </span>
              <span style={{ flex: 1, color: C.muted }}>
                <b style={{ color: "#fff" }}>{STATUS_LABEL[t.status]}</b>
                {" — "}
                {t.advice}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
