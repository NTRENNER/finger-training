// ─────────────────────────────────────────────────────────────
// GRADE PYRAMID — Power Company Climbing coaching logic
// ─────────────────────────────────────────────────────────────
// Based on Nate Drolet's "Not All Pyramids Are Built the Same"
// (powercompanyclimbing.com, May 2020). The premise: a healthy
// pyramid widens substantially as you descend grades — the tier
// at project − 3 should contain "All The Boulders" (ATB), not
// just a few token easier sends.
//
// Target counts per tier (relative to project grade):
//   tier 0  (project)     1–2   "low-hanging fruit"
//   tier −1 (consolidate) 3–5   "send more, branch out styles"
//   tier −2 (cleanup)     5–10  "the ones you skipped before"
//   tier −3 (base / ATB)  10+   "do every climb at this grade"
//
// The numbers are heuristic, not gospel. The article's deeper point:
// variation matters more than count at every tier, and progression
// comes from breadth+depth rather than chasing a higher number.
//
// Pure functions over the existing `pyramid.rows` shape produced by
// ClimbingAnalysisView ({ grade, count, rank } per row, sorted easy
// → hard). No React, no Supabase. Tested in isolation.

const TIER_TARGETS = [
  { tier: 0,  label: "Project",     min: 1,  max: 2,
    advice: "1–2 sends. Pick low-hanging fruit — climbs that feel realistic at your peak." },
  { tier: -1, label: "Consolidate", min: 3,  max: 5,
    advice: "3–5 sends. Climb the classics; start branching out into styles you've avoided." },
  { tier: -2, label: "Cleanup",     min: 5,  max: 10,
    advice: "5–10 sends. The ones you skipped — harder styles, less classic, weird problems." },
  { tier: -3, label: "Base (ATB)",  min: 10, max: Infinity,
    advice: "All The Boulders. Take down a new one every session as part of warmup. When you run out of easy ones, the leftovers are the ones with the most to teach you." },
];

// Pick the project grade as the highest-rank grade with at least one
// clean send. Returns null if the input is empty or has no ranks.
//
// The Power Company article explicitly notes the rubric should shift
// up a grade once the user starts sending the level below quickly —
// so a future iteration could let the user pin the project grade by
// hand. v1 just derives it from the data.
export function inferProjectGrade(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const sorted = [...rows]
    .filter(r => Number.isFinite(r.rank) && r.count > 0)
    .sort((a, b) => b.rank - a.rank);
  return sorted[0]?.grade ?? null;
}

// Build the 4-tier plan with status + advice per tier. Accepts the
// project grade as an override; falls back to inferProjectGrade.
//
// Returns: [{ tier, label, grade, rank, actualCount, targetMin,
//             targetMax, status, advice }] — exactly 4 entries,
// ordered top (project) → bottom (base). Tiers without a matching
// grade in the rows array still appear with actualCount = 0 and
// grade = null (so the UI can render the empty row as "missing").
export function buildPyramidPlan(rows, projectGrade = null) {
  const allGrades = (rows || [])
    .filter(r => Number.isFinite(r.rank))
    .sort((a, b) => a.rank - b.rank);
  const projectRank = (() => {
    const pg = projectGrade || inferProjectGrade(rows);
    if (!pg) return null;
    const match = (rows || []).find(r => r.grade === pg);
    if (match && Number.isFinite(match.rank)) return match.rank;
    return null;
  })();

  // countByRank lets us look up actual counts even for tier ranks
  // that don't show up in the rows array (no sends at that rank).
  const countByRank = new Map();
  const gradeByRank = new Map();
  for (const r of allGrades) {
    countByRank.set(r.rank, r.count);
    gradeByRank.set(r.rank, r.grade);
  }

  return TIER_TARGETS.map(t => {
    const tierRank = projectRank != null ? projectRank + t.tier : null;
    const actualCount = tierRank != null ? (countByRank.get(tierRank) ?? 0) : 0;
    const grade = tierRank != null ? (gradeByRank.get(tierRank) ?? null) : null;
    const status = classifyStatus(actualCount, t.min, t.max);
    return {
      tier: t.tier,
      label: t.label,
      grade,
      rank: tierRank,
      actualCount,
      targetMin: t.min,
      targetMax: t.max,
      status,
      advice: t.advice,
    };
  });
}

// Status buckets:
//   missing   — 0 sends here
//   light     — below the target band
//   on_track  — within the band
//   heavy     — above the band (per the article: consider shifting
//               the rubric up a grade)
function classifyStatus(actual, min, max) {
  if (actual === 0) return "missing";
  if (actual < min) return "light";
  if (actual > max) return "heavy";
  return "on_track";
}

// Surface a single "what to do next" headline from the plan. Used
// above the pyramid in the UI. Returns null if there's no project
// grade yet (cold start).
//
// Priority: light or missing at any tier wins, starting from the
// base upward (the article's whole point — fix the base first).
// If everything is on_track, suggest progressing.
export function topPyramidRecommendation(plan) {
  if (!Array.isArray(plan) || plan.length === 0) return null;
  // Base first
  for (let i = plan.length - 1; i >= 0; i--) {
    const p = plan[i];
    if (p.status === "missing" || p.status === "light") {
      const need = Math.max(0, p.targetMin - p.actualCount);
      const gradeLabel = p.grade ?? `${p.label.toLowerCase()} tier`;
      return {
        tier: p.tier,
        message: p.status === "missing"
          ? `Build the ${p.label.toLowerCase()} tier — start sending at ${gradeLabel}.`
          : `You're light at ${gradeLabel} (${p.actualCount}/${p.targetMin}+). Get ${need} more before pushing the project tier.`,
      };
    }
  }
  // Everything on track — base is heavy or all bands are filled
  const project = plan[0];
  if (project.status === "heavy" || project.actualCount >= project.targetMax) {
    return {
      tier: 0,
      message: `${project.grade} is going down — consider shifting the pyramid up a grade.`,
    };
  }
  return {
    tier: 0,
    message: `Pyramid is balanced. Time to push the project tier (${project.grade ?? "next up"}).`,
  };
}

// Exported so the chart can render an empty-state hint with the
// same target language as the model.
export const TIER_DEFINITIONS = TIER_TARGETS.map(t => ({
  tier: t.tier,
  label: t.label,
  min: t.min,
  max: t.max,
  advice: t.advice,
}));
