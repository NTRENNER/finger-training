// ─────────────────────────────────────────────────────────────
// PYRAMID CHART — fixed-outline 5-tier silhouette
// ─────────────────────────────────────────────────────────────
// Renders the 5-tier pyramid from model/gradePyramid.js as an
// outlined silhouette (1-2-3-4-7 blocks per tier) that shades in
// from the left as sends accrue. The shape itself communicates
// progress — no coaching status text, no per-tier chips, no
// headline recommendation banner.
//
// The one piece of context the shape can't show is climbs above
// the apex grade (the pyramid stops there). When `plan.overgrew`
// is true, a small re-pin hint sits above the silhouette.
//
// Tap any shaded block to open a modal listing every clean send
// at that grade — route name, date, ascent style, venue/wall,
// RPE, stars, notes. The popover lists ALL climbs at the grade
// (including capped extras above the tier's target width), since
// the block-shading view drops those visually but the climbs
// themselves are still real and the user wants to see them.
//
// No charting library; pure CSS flex. Stays readable at narrow
// (340px) widths — the base tier at 7 blocks × 14px + 6 × 3px gap
// = ~116px, well under the available content width even with the
// grade-label gutter mirrored on both sides for centering.

import React, { useMemo, useState } from "react";
import { C } from "../../ui/theme.js";
import {
  buildPyramidPlan,
  inferProjectGrade,
} from "../../model/gradePyramid.js";
import {
  ascentMeta, venueMeta, wallMeta,
} from "../../lib/climbing-grades.js";

// Block sizing — tuned so the 7-wide base fits cleanly at mobile
// widths with room for the symmetric grade-label gutters.
const BLOCK = { size: 14, gap: 3 };
// Gutter width on each side of the centered block row. Mirrored
// left/right so the pyramid axis lands on the card's true center,
// not the post-label center, which would shift everything right
// by ~26px and look subtly off-balance.
const GUTTER = 44;

// Short month labels for the popover date display. Inline rather
// than pulling Intl.DateTimeFormat — three-letter month is the only
// formatting choice needed here and a 12-entry array is lighter
// than locale machinery the rest of the codebase doesn't use.
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// Format an ISO date string (YYYY-MM-DD) as "May 18" for the current
// year or "May 18, 2025" for older. Falls back to the raw string for
// anything unparseable so legacy malformed entries still render.
function fmtDate(date) {
  if (!date || typeof date !== "string") return "—";
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return date;
  const [, y, mo, d] = m;
  const month = MONTHS[Number(mo) - 1] ?? mo;
  const day = Number(d);
  const year = Number(y);
  const nowYear = new Date().getFullYear();
  return year === nowYear ? `${month} ${day}` : `${month} ${day}, ${year}`;
}

export function PyramidChart({
  rows = [],
  fill = "#f59e0b",   // discipline color; falls through from ClimbingAnalysisView
  projectGrade = null, // visual apex (graduation-shifted in ClimbingAnalysisView)
  projectRank = null,  // visual apex rank
  // The user's actually-pinned project, before graduation shifts it.
  // Used only by the footer caption so the user always sees what they
  // explicitly chose, even when the pyramid is graduated above it.
  // Falls back to projectGrade when omitted (back-compat).
  pinnedProjectGrade = null,
  // How many grades the visual apex sits above the pinned project,
  // computed via model/gradePyramid.js computeGraduation. Drives the
  // graduation caption when > 0.
  graduation = 0,
  anchorMode = "send", // 'send' | 'flash' — passed through to the model
  stepSize = 1,        // tier offset in rank units (V = 1, YDS letter = 0.25)
  rankToGrade = null,  // (rank) => gradeLabel — labels empty tiers with the
                       // grade they represent instead of "—". Caller in
                       // ClimbingAnalysisView builds it from V_GRADES /
                       // YDS_GRADES so the chart stays scheme-agnostic.
}) {
  const plan = useMemo(
    () => buildPyramidPlan(rows, projectGrade, { anchorMode, projectRank, stepSize, rankToGrade }),
    [rows, projectGrade, anchorMode, projectRank, stepSize, rankToGrade]
  );
  const inferredProject = useMemo(() => inferProjectGrade(rows), [rows]);
  const activeProject = projectGrade || inferredProject;

  // Tier currently surfaced in the detail popover (null = closed).
  // Stored as the whole tier object so the modal has direct access
  // to grade label + climbs without a second lookup.
  const [openTier, setOpenTier] = useState(null);

  if (rows.length === 0 || !activeProject) {
    return (
      <div style={{ color: C.muted, fontSize: 12, padding: "16px 0", textAlign: "center" }}>
        No clean sends yet. Log a few climbs to start your pyramid.
      </div>
    );
  }

  return (
    <div>
      {/* Re-pin hint — only when there are sends above the apex.
          Uses a neutral violet so it reads as "informational nudge"
          rather than "status warning" (no red/amber). */}
      {plan.overgrew && (
        <div style={{
          padding: "8px 10px", marginBottom: 12,
          background: C.purple + "22",
          border: `1px solid ${C.purple}66`,
          borderRadius: 8,
          fontSize: 12, lineHeight: 1.4,
        }}>
          <span style={{ fontWeight: 700, marginRight: 6 }}>Outgrew the pin:</span>
          {plan.overgrewSends} send{plan.overgrewSends === 1 ? "" : "s"} above {plan.projectGrade}
          {plan.overgrewMaxGrade && plan.overgrewMaxGrade !== plan.projectGrade
            ? ` (up to ${plan.overgrewMaxGrade})`
            : ""}
          {" — time to re-pin?"}
        </div>
      )}

      {/* The silhouette — five centered rows of outlined blocks,
          shaded left-to-right as sends accrue. Shaded blocks are
          tappable (when climbs metadata is available) and open the
          per-grade detail popover. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 10 }}>
        {plan.tiers.map(t => {
          const isApex = t.tier === 0;
          // Tappable when there's at least one shaded block AND we
          // actually have per-climb metadata to show. Older callers
          // that don't thread `climbs` through will see the static
          // silhouette without an interaction affordance.
          const tappable = t.shaded > 0 && Array.isArray(t.climbs) && t.climbs.length > 0;
          return (
            <div key={t.tier} style={{
              display: "flex", alignItems: "center",
            }}>
              {/* Left gutter — grade label for this tier. */}
              <div style={{
                width: GUTTER, flex: `0 0 ${GUTTER}px`, textAlign: "right",
                paddingRight: 8, boxSizing: "border-box",
                fontSize: 12,
                color: t.grade ? (isApex ? "#fde68a" : "#fff") : C.muted,
                fontWeight: t.grade ? 700 : 400,
              }}>
                {t.grade ?? "—"}
              </div>

              {/* Centered block row — outline + left-to-right shading. */}
              <div style={{
                flex: 1, display: "flex", justifyContent: "center",
              }}>
                <div style={{ display: "flex", gap: BLOCK.gap }}>
                  {Array.from({ length: t.target }).map((_, i) => {
                    const isShaded = i < t.shaded;
                    const interactive = tappable && isShaded;
                    return (
                      <span
                        key={i}
                        onClick={interactive ? () => setOpenTier(t) : undefined}
                        title={interactive
                          ? `${t.actualCount} send${t.actualCount === 1 ? "" : "s"} at ${t.grade} — tap for details`
                          : undefined}
                        style={{
                          display: "inline-block",
                          width: BLOCK.size, height: BLOCK.size,
                          background: isShaded ? fill : "transparent",
                          // Apex outline gets a warm-yellow tint so the
                          // "project" position is identifiable even in
                          // the empty state (no shading yet). Below the
                          // apex, unshaded outlines use the muted border
                          // color so empty rows recede visually.
                          border: `1.5px solid ${
                            isShaded ? fill : (isApex ? "#fde68a" : C.border)
                          }`,
                          borderRadius: 2,
                          cursor: interactive ? "pointer" : "default",
                        }}
                      />
                    );
                  })}
                </div>
              </div>

              {/* Right gutter — empty, mirrors the left so the
                  pyramid axis stays centered on the card. */}
              <div style={{
                width: GUTTER, flex: `0 0 ${GUTTER}px`,
              }} />
            </div>
          );
        })}
      </div>

      {/* Minimal footer — project pin label, plus a graduation tag
          when the visual apex has shifted above the pin (climber
          consolidated and the silhouette auto-graduated up). The
          pinned label stays so the climber always sees what they
          explicitly chose; the "graduated to" tag tells them where
          the visual apex sits. */}
      <div style={{
        borderTop: `1px solid ${C.border}`, paddingTop: 8,
        fontSize: 11, color: C.muted, textAlign: "center",
      }}>
        Project pin · {pinnedProjectGrade ?? plan.projectGrade}
        {graduation > 0 && plan.projectGrade && (
          <>
            {" · "}
            <span style={{ color: C.purple, fontWeight: 700 }}>
              Graduated to {plan.projectGrade}
            </span>
          </>
        )}
      </div>

      {/* Per-tier climb-detail popover. Backdrop catches outside-taps
          to close; modal body stops propagation so internal taps
          don't dismiss. Rendered last so it overlays the silhouette
          via the fixed-position parent. */}
      {openTier && (
        <ClimbDetailModal
          tier={openTier}
          accent={fill}
          onClose={() => setOpenTier(null)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Per-grade climb-detail popover
// ─────────────────────────────────────────────────────────────
// Fixed-position modal listing every clean send at the tapped
// tier's grade. Includes capped extras (climbs that didn't get a
// visible block) because the user logged them and should be able
// to see them. Sorted newest-first by the caller.
function ClimbDetailModal({ tier, accent, onClose }) {
  // Defensive sort here too — if a future caller passes climbs in a
  // different order, the popover stays "newest first" regardless.
  const climbs = useMemo(
    () => [...(tier.climbs || [])].sort(
      (a, b) => (a.date || "") < (b.date || "") ? 1 : -1
    ),
    [tier.climbs]
  );

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 100,
        background: "rgba(0,0,0,0.65)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.card,
          border: `1px solid ${C.border}`,
          borderRadius: 10,
          width: "100%", maxWidth: 380, maxHeight: "80vh",
          display: "flex", flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Header — grade + count + close. Accent strip down the left
            mirrors the tier's block color so the popover visually
            "belongs" to the row that opened it. */}
        <div style={{
          padding: "12px 14px",
          borderBottom: `1px solid ${C.border}`,
          display: "flex", alignItems: "center", justifyContent: "space-between",
          gap: 8,
          borderLeft: `4px solid ${accent}`,
        }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#fff" }}>
              {tier.grade ?? "—"} sends
            </div>
            <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
              {tier.actualCount} clean send{tier.actualCount === 1 ? "" : "s"}
              {tier.capped ? ` · ${tier.actualCount - tier.target} above pyramid target` : ""}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "transparent", border: "none", color: C.muted,
              fontSize: 22, cursor: "pointer", padding: "0 4px",
              lineHeight: 1,
            }}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Scrollable list of climbs. Each row is a compact card with
            ascent badge, route name (or grade fallback), date, venue/
            wall, RPE, stars, and notes. */}
        <div style={{ overflowY: "auto", padding: "4px 0" }}>
          {climbs.length === 0 ? (
            <div style={{ padding: 16, color: C.muted, fontSize: 12, textAlign: "center" }}>
              No detail captured for this grade.
            </div>
          ) : (
            climbs.map((c, i) => <ClimbRow key={i} climb={c} />)
          )}
        </div>
      </div>
    </div>
  );
}

// One row inside the detail modal. Compact enough that several fit on
// a phone screen but spacious enough that each climb's metadata reads
// without a second tap.
function ClimbRow({ climb }) {
  const ascent = ascentMeta(climb.ascent);
  const venue  = climb.venue ? venueMeta(climb.venue) : null;
  const wall   = climb.wall  ? wallMeta(climb.wall)   : null;
  const stars  = Number.isFinite(climb.stars) ? climb.stars : 0;
  const rpe    = Number(climb.rpe);
  // Title line: route name if present, otherwise the grade. Falling
  // back to grade keeps the row from feeling empty for gym climbs
  // the user didn't name.
  const title  = climb.route_name || climb.grade || "Climb";

  return (
    <div style={{
      padding: "10px 14px",
      borderBottom: `1px solid ${C.border}33`,
      fontSize: 12, lineHeight: 1.4,
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2 }}>
        <span style={{ fontWeight: 700, color: "#fff", fontSize: 13, flex: 1 }}>
          {title}
        </span>
        <span style={{ color: C.muted, fontSize: 11, whiteSpace: "nowrap" }}>
          {fmtDate(climb.date)}
        </span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, color: C.muted, fontSize: 11 }}>
        {/* Ascent style — colored to echo the success-vs-grind palette
            used elsewhere (green for onsight/flash, orange for
            redpoint/rest). */}
        <span style={{
          color: climb.ascent === "onsight" || climb.ascent === "flash"
            ? C.green
            : climb.ascent === "redpoint" ? C.orange : C.muted,
          fontWeight: 600,
        }}>
          {ascent.label}
        </span>
        {venue && <span>· {venue.emoji} {venue.label}</span>}
        {wall && <span>· {wall.emoji} {wall.label}</span>}
        {climb.crag && <span>· {climb.crag}</span>}
        {climb.area && <span>· {climb.area}</span>}
        {rpe > 0 && <span>· RPE {rpe}</span>}
        {stars > 0 && (
          <span style={{ color: C.orange }}>
            {"★".repeat(stars)}{"☆".repeat(5 - stars)}
          </span>
        )}
      </div>
      {climb.notes && (
        <div style={{
          marginTop: 4, fontSize: 11, color: C.muted, fontStyle: "italic",
        }}>
          “{climb.notes}”
        </div>
      )}
    </div>
  );
}
