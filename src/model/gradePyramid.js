// ─────────────────────────────────────────────────────────────
// GRADE PYRAMID — Power Company Climbing coaching logic
// ─────────────────────────────────────────────────────────────
// Based on Nate Drolet's "Not All Pyramids Are Built the Same"
// (powercompanyclimbing.com, May 2020). The premise: a healthy
// pyramid widens substantially as you descend grades — the tier
// at project − 3 should contain "All The Boulders" (ATB), not
// just a few token easier sends.
//
// The climber picks the project grade explicitly (via the pin in
// ClimbingAnalysisView). The model just walks tiers down from there.
// Two label/band sets are available:
//
//   anchorMode = 'flash' (default for live UI, forward-looking)
//     Bands tolerate aspirational projects:
//       Project       — what you're trying       0–2 sends
//       Push          — the bridge               1–3 sends
//       Consolidate   — solid territory          3–5 sends
//       Volume (ATB)  — your reliable grade      10+ sends
//
//   anchorMode = 'send' (legacy / backward-looking)
//     Bands assume project = grade you've already sent:
//       Project   1-2 / Consolidate 3-5 / Cleanup 5-10 / Base 10+
//
// Both sets share the same {0, -1, -2, -3} tier offsets in rank
// units, scaled by `stepSize` so YDS pyramids step by letter
// subgrades (0.25 rank/tier) and boulder pyramids step by V-grades
// (1 rank/tier).
//
// Cold-start auto-anchor: inferProjectGrade picks the highest grade
// with ≥2 clean sends (one-shot fallback) — used only when the user
// hasn't pinned a project yet.
//
// Pure functions over the existing `pyramid.rows` shape produced by
// ClimbingAnalysisView ({ grade, count, rank } per row, sorted easy
// → hard). No React, no Supabase. Tested in isolation.

const SEND_TIER_TARGETS = [
  { tier: 0,  label: "Project",     min: 1,  max: 2,
    advice: "1–2 sends. Pick low-hanging fruit — climbs that feel realistic at your peak." },
  { tier: -1, label: "Consolidate", min: 3,  max: 5,
    advice: "3–5 sends. Climb the classics; start branching out into styles you've avoided." },
  { tier: -2, label: "Cleanup",     min: 5,  max: 10,
    advice: "5–10 sends. The ones you skipped — harder styles, less classic, weird problems." },
  { tier: -3, label: "Base (ATB)",  min: 10, max: Infinity,
    advice: "All The Boulders. Take down a new one every session as part of warmup. When you run out of easy ones, the leftovers are the ones with the most to teach you." },
];

// Flash-anchored tiers — same 4-row shape but reframed for the
// forward-looking interpretation. Project may have 0 sends because
// by definition it's what you're working on, not what you've done.
// The Volume tier sits at the flash grade itself: this is where
// the article's "all the boulders" advice actually belongs.
const FLASH_TIER_TARGETS = [
  { tier: 0,  label: "Project",     min: 0,  max: 2,
    advice: "What you're trying. 0–2 sends here is healthy — by definition this is the work, not the result." },
  { tier: -1, label: "Push",        min: 1,  max: 3,
    advice: "1–3 sends. The bridge between flash and project — hard climbs you can send with focused effort." },
  { tier: -2, label: "Consolidate", min: 3,  max: 5,
    advice: "3–5 sends. Solid territory — climbs you redpoint cleanly, occasional flash, hard styles still feel hard." },
  { tier: -3, label: "Volume (ATB)", min: 10, max: Infinity,
    advice: "All The Boulders at your flash grade. Branch out into styles you've avoided; the leftovers teach the most." },
];

// Pick the active tier-target set for an anchorMode. Kept as a
// helper so future modes (e.g. send + gap=3) only need to plug in
// a new constant.
function tiersFor(anchorMode) {
  return anchorMode === "flash" ? FLASH_TIER_TARGETS : SEND_TIER_TARGETS;
}

// (Legacy alias TIER_TARGETS removed May 2026 — both internal call
// sites switched to tiersFor(anchorMode) so the underlying constants
// only need one canonical name each.)

// Pick the project grade as the highest-rank grade with at least
// `minSends` clean sends. Returns null if the input is empty or has
// no ranks. A second cold-start tier kicks in when no grade clears
// the threshold yet — we fall back to the highest grade with ≥1 send
// rather than returning null, so early data still surfaces a pyramid.
//
// Why a minimum: a lucky one-shot send shouldn't anchor the project
// tier. Before the threshold, a single V6 in an otherwise V4-heavy
// log would shift every tier up one grade and label V3 as "base."
// Requiring 2+ sends matches the article's spirit — project = the
// grade you're sending, not the one you've happened to send.
//
// The Power Company article explicitly notes the rubric should shift
// up a grade once the user starts sending the level below quickly,
// so users should also be able to pin the project grade by hand
// (see buildPyramidPlan's projectGrade override + the pin UI on
// ClimbingAnalysisView).
export function inferProjectGrade(rows, { minSends = 2 } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const withSends = rows.filter(r => Number.isFinite(r.rank) && r.count > 0);
  if (withSends.length === 0) return null;
  const qualifying = withSends.filter(r => r.count >= minSends);
  const pool = qualifying.length > 0 ? qualifying : withSends; // cold-start fallback
  return pool.sort((a, b) => b.rank - a.rank)[0]?.grade ?? null;
}

// Build the 4-tier plan with status + advice per tier. Accepts the
// project grade as an override; falls back to inferProjectGrade for
// send-anchored mode (flash-anchored always passes an explicit project
// derived from flash + gap upstream).
//
// Returns: [{ tier, label, grade, rank, actualCount, targetMin,
//             targetMax, status, advice }] — exactly 4 entries,
// ordered top (project) → bottom (base). Tiers without a matching
// grade in the rows array still appear with actualCount = 0 and
// grade = null (so the UI can render the empty row as "missing").
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
  const allGrades = (rows || [])
    .filter(r => Number.isFinite(r.rank))
    .sort((a, b) => a.rank - b.rank);
  const projectRank = (() => {
    if (Number.isFinite(explicitRank)) return explicitRank;
    const pg = projectGrade || inferProjectGrade(rows);
    if (!pg) return null;
    const match = (rows || []).find(r => r.grade === pg);
    if (match && Number.isFinite(match.rank)) return match.rank;
    return null;
  })();

  // countByRank lets us look up actual counts even for tier ranks
  // that don't show up in the rows array (no sends at that rank).
  // Keys are normalized to 2 decimals so float-precision wobble on
  // 0.25 increments (0.5, 0.75, etc.) doesn't fragment the lookup.
  const rankKey = (r) => Math.round(r * 100) / 100;
  const countByRank = new Map();
  const gradeByRank = new Map();
  for (const r of allGrades) {
    countByRank.set(rankKey(r.rank), r.count);
    gradeByRank.set(rankKey(r.rank), r.grade);
  }

  // Even with no row at the project rank, we still want a grade label
  // for the tier (e.g. flash + 3 = V7 with zero sends). The caller
  // passes the pinned/derived project, so reuse it.
  const projectGradeFallback = projectGrade;

  return tiersFor(anchorMode).map(t => {
    const tierRank = projectRank != null ? projectRank + t.tier * stepSize : null;
    const lookupKey = tierRank != null ? rankKey(tierRank) : null;
    const actualCount = lookupKey != null ? (countByRank.get(lookupKey) ?? 0) : 0;
    let grade = lookupKey != null ? (gradeByRank.get(lookupKey) ?? null) : null;
    // If the project tier itself has no rows (truly aspirational),
    // surface the explicit project grade label so the UI shows the
    // tier name instead of "—".
    if (t.tier === 0 && !grade && projectGradeFallback) grade = projectGradeFallback;
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
//   missing   — 0 sends here AND the tier's band has a positive min
//               (i.e. you should have something here but don't)
//   light     — below the target band
//   on_track  — within the band (including 0 sends when the band's
//               min is 0, e.g. the flash-anchored project tier where
//               "no sends yet" is the expected starting state)
//   heavy     — above the band (per the article: consider shifting
//               the rubric up a grade, or in flash-anchored mode,
//               your flash grade is moving up)
function classifyStatus(actual, min, max) {
  if (actual === 0 && min > 0) return "missing";
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

// Exported so callers can render empty-state hints or pickers with
// the same target language the model uses. Defaults to the legacy
// send-anchored set for backward compat.
export const TIER_DEFINITIONS = SEND_TIER_TARGETS.map(t => ({
  tier: t.tier, label: t.label, min: t.min, max: t.max, advice: t.advice,
}));

export const FLASH_TIER_DEFINITIONS = FLASH_TIER_TARGETS.map(t => ({
  tier: t.tier, label: t.label, min: t.min, max: t.max, advice: t.advice,
}));
