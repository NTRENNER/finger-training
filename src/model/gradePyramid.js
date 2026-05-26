// ─────────────────────────────────────────────────────────────
// GRADE PYRAMID — 5-tier outline model
// ─────────────────────────────────────────────────────────────
// Visual-first pyramid: 5 tiers from project (apex) down, with a
// fixed outline of 1-4-7-10-13 blocks per tier. Logged sends shade
// blocks in from the left at each tier. Extras above a tier's
// target don't extend the row — the pyramid keeps its shape, and
// the "no need to record in the pyramid" stance means over-volume
// at a band is invisible noise rather than a coaching signal.
//
// Why fixed shape vs the older count-tier model (Power Company,
// 2020):
//   - The article's bands (1-2 project / 3-5 consolidate /
//     5-10 cleanup / 10+ ATB) were useful but UI-noisy: five
//     status chips and an explainer paragraph competing with the
//     picture for attention.
//   - The new shape reads at a glance: a full base with empty
//     apex is "you're climbing solid, time to push the project";
//     a full apex with thin base is "go log easier mileage."
//     No text needed.
//
// Tier target widths [1, 4, 7, 10, 13]:
//   - Strict +3 arithmetic progression from apex to base. Each
//     grade below the project demands proportionally more volume
//     than the one above it; you can't credibly advance to a grade
//     until you've consolidated a real base at the grades below.
//   - Apex stays at 1 — the project is one specific route, by
//     definition. The pyramid won't come to a perfectly crafted
//     peak (the apex-to-tier-1 jump is 1 → 4), but that's a feature:
//     "log lots of mileage at the supporting grades" is the message.
//   - Minimum 4 sends one grade below project pins the coaching
//     principle that 2-3 isn't enough — you should feel comfortable
//     at a grade before pushing through it.
//
// "Overgrew the project" signal: when sends exist ABOVE the apex
// rank, that's the one piece of coaching the shape alone can't
// show (the pyramid stops at the apex). We expose `overgrew`,
// `overgrewSends`, and `overgrewMaxGrade` so the card can surface
// a "time to re-pin" hint.
//
// Pure functions over the existing `pyramid.rows` shape produced
// by ClimbingAnalysisView ({ grade, count, rank } per row, sorted
// easy → hard). No React, no Supabase. Tested in isolation.

// Fixed tier targets, project (apex) → base. Tier offsets are in
// rank units, scaled by `stepSize` so YDS pyramids step by letter
// subgrades (0.25 rank/tier) and boulder pyramids step by V-grades
// (1 rank/tier).
const TIER_TARGETS = [
  { tier:  0, target:  1 },   // apex (project)
  { tier: -1, target:  4 },
  { tier: -2, target:  7 },
  { tier: -3, target: 10 },
  { tier: -4, target: 13 },   // base
];

// Pick the project grade as the highest-rank grade with at least
// `minSends` clean sends. Default 1 — a single redpoint (or flash) of
// a hard grade IS evidence you've sent that grade and the climber's
// own mental model of "what's my project" treats it as anchor-worthy.
// Lucky one-shot inflation is a real concern in bouldering (a single
// hot V6 day) but the pin override is the right escape hatch for it.
// The "outgrew" signal in buildPyramidPlan does the same job in
// reverse — once climbs above the pinned grade accumulate, the card
// surfaces a re-pin hint without changing the pin automatically.
export function inferProjectGrade(rows, { minSends = 1 } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const qualifying = rows.filter(r =>
    Number.isFinite(r.rank) && r.count >= minSends
  );
  if (qualifying.length === 0) return null;
  return qualifying.sort((a, b) => b.rank - a.rank)[0]?.grade ?? null;
}

// Build the 5-tier outline plan. Returns:
//
//   {
//     projectGrade,           // resolved apex grade label (or null)
//     projectRank,             // resolved apex rank (or null)
//     anchorMode,              // echoed back for callers
//     tiers: [                 // project → base, length 5
//       {
//         tier,                // 0, -1, -2, -3, -4
//         target,              // 1, 4, 7, 10, 13
//         grade,               // grade label at this rank (or null)
//         rank,                // rank for this tier (or null)
//         actualCount,         // total sends at this rank
//         shaded,              // min(actualCount, target) — block count to fill
//         capped,              // actualCount > target (visually clamped)
//         status,              // 'empty' | 'partial' | 'complete'
//         climbs,              // per-send detail (when callers pass row.climbs).
//                              // Threaded straight through — order preserved
//                              // so the consumer can pick chronological,
//                              // newest-first, or any other sort.
//       },
//     ],
//     overgrew,                // any sends above the apex rank?
//     overgrewSends,           // total send count above apex
//     overgrewMaxGrade,        // highest grade among the over-sends (or null)
//   }
//
// When no project grade can be inferred (no rows, no pin), the
// tiers array still returns the 5 outline rows with grade/rank null
// and counts zero so the consumer can render the empty silhouette.
export function buildPyramidPlan(rows, projectGrade = null, {
  anchorMode = "send",
  // Explicit projectRank when the caller already knows it — required
  // for flash-anchored mode because the project tier may have zero
  // sends (and therefore no row in `rows` to derive rank from). The
  // caller in ClimbingAnalysisView computes this via gradeRank() from
  // climbing-grades.js, which knows the V / YDS scales.
  projectRank: explicitRank = null,
  // Tier offset in rank units. Boulder = 1 (each tier = 1 V-grade).
  // YDS at 5.10+ = 0.25 (each tier = 1 letter subgrade). Caller picks
  // based on discipline; this function stays scheme-agnostic.
  stepSize = 1,
} = {}) {
  const projectRank = (() => {
    if (Number.isFinite(explicitRank)) return explicitRank;
    const pg = projectGrade || inferProjectGrade(rows);
    if (!pg) return null;
    const match = (rows || []).find(r => r.grade === pg);
    if (match && Number.isFinite(match.rank)) return match.rank;
    return null;
  })();

  // Normalize rank keys to 2 decimals so float-precision wobble on
  // 0.25-step YDS pyramids (0.5, 0.75, etc.) doesn't fragment the
  // lookup map.
  const rankKey = (r) => Math.round(r * 100) / 100;
  const countByRank = new Map();
  const gradeByRank = new Map();
  const climbsByRank = new Map();    // optional: per-send detail per rank
  for (const r of (rows || [])) {
    if (!Number.isFinite(r.rank)) continue;
    countByRank.set(rankKey(r.rank), r.count);
    gradeByRank.set(rankKey(r.rank), r.grade);
    if (Array.isArray(r.climbs)) {
      climbsByRank.set(rankKey(r.rank), r.climbs);
    }
  }

  const tiers = TIER_TARGETS.map(t => {
    const tierRank = projectRank != null ? projectRank + t.tier * stepSize : null;
    const lookupKey = tierRank != null ? rankKey(tierRank) : null;
    const actualCount = lookupKey != null ? (countByRank.get(lookupKey) ?? 0) : 0;
    let grade = lookupKey != null ? (gradeByRank.get(lookupKey) ?? null) : null;
    // Apex fallback: if there are no rows at the project rank yet
    // (e.g. flash-anchored "you haven't sent V7 yet"), still label
    // the row with the pinned project grade so the chart reads
    // correctly instead of showing "—".
    if (t.tier === 0 && !grade && projectGrade) grade = projectGrade;
    const shaded = Math.min(actualCount, t.target);
    const status = actualCount === 0
      ? "empty"
      : actualCount >= t.target ? "complete" : "partial";
    const climbs = lookupKey != null ? (climbsByRank.get(lookupKey) ?? []) : [];
    return {
      tier: t.tier,
      target: t.target,
      grade,
      rank: tierRank,
      actualCount,
      shaded,
      capped: actualCount > t.target,
      status,
      climbs,
    };
  });

  // Overgrew detection — climbs ABOVE the apex rank are evidence
  // the pinned project has been outgrown. Sum the extras and pick
  // the highest such grade so the card can name it in the hint.
  // Small +0.01 slack so float wobble on YDS letter steps (0.25
  // increments) doesn't accidentally flag the apex rank itself as
  // "above" itself.
  let overgrewSends = 0;
  let overgrewMaxGrade = null;
  let overgrewMaxRank = -Infinity;
  if (projectRank != null) {
    for (const r of (rows || [])) {
      if (!Number.isFinite(r.rank)) continue;
      if (r.rank > projectRank + 0.01 && r.count > 0) {
        overgrewSends += r.count;
        if (r.rank > overgrewMaxRank) {
          overgrewMaxRank = r.rank;
          overgrewMaxGrade = r.grade;
        }
      }
    }
  }

  // Resolved apex label: prefer the pinned/passed grade, fall back
  // to whatever row sits at the resolved projectRank.
  const resolvedProjectGrade = projectGrade
    || (projectRank != null ? (gradeByRank.get(rankKey(projectRank)) ?? null) : null);

  return {
    projectGrade: resolvedProjectGrade,
    projectRank,
    anchorMode,
    tiers,
    overgrew: overgrewSends > 0,
    overgrewSends,
    overgrewMaxGrade,
  };
}

// Exported tier targets so callers (tests, picker UIs) can read the
// canonical outline shape without re-declaring it.
export const TIER_DEFINITIONS = TIER_TARGETS.map(t => ({
  tier: t.tier, target: t.target,
}));
