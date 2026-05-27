// ─────────────────────────────────────────────────────────────
// GRADE PYRAMID — 5-tier outline model with auto-graduation
// ─────────────────────────────────────────────────────────────
// Visual-first pyramid: 5 tiers from project (apex) down, with a
// fixed outline of 3-5-7-9-11 blocks per tier (+2 per row, wider
// apex). Logged sends shade blocks in from the left at each tier.
// Extras above a tier's target don't extend the row — the pyramid
// keeps its shape, and the "no need to record in the pyramid"
// stance means over-volume at a band is invisible noise rather
// than a coaching signal.
//
// Tier target widths [3, 5, 7, 9, 11]:
//   - Strict +2 arithmetic progression with multiple squares at
//     the project grade. The apex of 3 means "project consolidated"
//     — one lucky send isn't enough; you need to send the route
//     three times to "fill" the project block. That maps the
//     pyramid to a real coaching milestone instead of treating a
//     single redpoint as completion.
//   - Total target volume is 35 sends across the five tiers,
//     identical to the older [1,4,7,10,13] shape — same effort,
//     redistributed toward a wider apex and a slightly narrower
//     base. The visual reads as a more balanced step pyramid.
//
// Auto-graduation:
//   - When the apex is filled (project sent 3×), the climber has
//     consolidated this project grade. The pyramid auto-shifts up
//     one grade so the new apex is one grade above the pinned
//     project. The pinned project itself stays where the user set
//     it; the visual just adapts. Chains: if the post-graduation
//     apex also fills, graduate again, up to MAX_GRADUATION.
//   - Climbs that drop off the bottom of the pyramid (below the
//     graduated base) aren't deleted — they're just no longer
//     shown in the silhouette. The intent is "you've outgrown the
//     bottom grade, it's now warmup territory."
//   - See computeGraduation() for the per-discipline logic.
//
// "Overgrew the project" signal: when sends exist ABOVE the
// effective (graduated) apex rank, that's coaching the shape
// alone can't show. We expose `overgrew`, `overgrewSends`, and
// `overgrewMaxGrade` so the card can surface a "time to re-pin"
// hint.
//
// Pure functions over the existing `pyramid.rows` shape produced
// by ClimbingAnalysisView ({ grade, count, rank } per row, sorted
// easy → hard). No React, no Supabase. Tested in isolation.

// Fixed tier targets, project (apex) → base. Tier offsets are in
// rank units, scaled by `stepSize` so YDS pyramids step by letter
// subgrades (0.25 rank/tier) and boulder pyramids step by V-grades
// (1 rank/tier).
const TIER_TARGETS = [
  { tier:  0, target:  3 },   // apex (project — 3× to consolidate)
  { tier: -1, target:  5 },
  { tier: -2, target:  7 },
  { tier: -3, target:  9 },
  { tier: -4, target: 11 },   // base
];

// Cap on how many tiers the visual pyramid can graduate above the
// user's pinned project. Five is more than any climber should ever
// reach without explicitly re-pinning; the cap exists to bound the
// graduation-chain loop, not as a coaching constraint.
const MAX_GRADUATION = 5;

// Compute how many grades the visual pyramid should sit above the
// user's pinned project, based on how many top-of-pyramid tiers
// have already been filled to target.
//
// Loop:
//   1. Start with graduation = 0 (apex = pin).
//   2. Look up the apex tier's count at apexRank.
//   3. If count >= apex target (3), bump graduation by one and
//      step apexRank up by stepSize, then repeat.
//   4. Stop when the apex tier isn't full, or when graduation
//      hits MAX_GRADUATION (defensive cap).
//
// Pure function — takes the raw rows (same shape as buildPyramidPlan)
// and returns just the integer offset. ClimbingAnalysisView uses
// this to compute the visualApex passed to PyramidChart.
export function computeGraduation(rows, pinnedRank, stepSize = 1) {
  if (!Number.isFinite(pinnedRank) || !Array.isArray(rows)) return 0;
  const apexTarget = TIER_TARGETS[0].target;   // 3 in the current shape
  const rankKey = (r) => Math.round(r * 100) / 100;
  const countByRank = new Map();
  for (const r of rows) {
    if (Number.isFinite(r.rank)) countByRank.set(rankKey(r.rank), r.count);
  }
  let graduation = 0;
  while (graduation < MAX_GRADUATION) {
    const apexRank = pinnedRank + graduation * stepSize;
    const count = countByRank.get(rankKey(apexRank)) ?? 0;
    if (count >= apexTarget) {
      graduation += 1;
    } else {
      break;
    }
  }
  return graduation;
}

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
  // Optional resolver `(rank) => gradeLabel | null` so empty tiers
  // (no rows at that rank) can still display the grade they
  // represent. The model stays scheme-agnostic — the caller, which
  // knows the V / YDS scale for the active discipline, owns the
  // mapping. Without this, empty tiers fall back to grade=null and
  // render as "—" in the chart.
  rankToGrade = null,
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
    // Empty-tier fallback: ask the caller-provided resolver to name
    // the grade at this rank. Without sends at the rank there's no
    // row to read the label from, but the climber still expects to
    // see "V7" or "5.11d" instead of "—" on tiers between the apex
    // and a partly-filled lower tier.
    if (!grade && tierRank != null && typeof rankToGrade === "function") {
      grade = rankToGrade(tierRank);
    }
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
