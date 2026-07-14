// ──────────────────────────────────────────────────────────────
// BADGES — derived, no storage
// ──────────────────────────────────────────────────────────────
// A user's "badge collection" is derived on the fly from rep history:
// for each (grip, zone) they've trained, their current level (see
// levels.js calcLevel, which is best-ever-load based so a badge never
// regresses). No new table, no backfill — the collection is a pure
// function of history, so it stays correct through any future scoring
// change. Displayed by src/views/cards/BadgeCollection.jsx in History.

import { ZONE6 } from "./zones.js";
import { calcLevel, getBaseline } from "./levels.js";

// Emoji tier per level (index = level - 1, clamped). Mirrors the
// LEVEL_EMOJIS ladder used by the in-session Level-Up celebration.
export const BADGE_TIERS = [
  "🌱", "🏛️", "📈", "⚡", "⚙️", "🔥", "🏔️", "⭐", "💎", "🏆", "🌟",
];
export const badgeEmoji = (level) =>
  BADGE_TIERS[Math.min(Math.max(level, 1) - 1, BADGE_TIERS.length - 1)];

// Build the badge collection from history. One badge per (grip, zone)
// the user has actually trained (baseline exists for at least one
// hand); level is the better of the two hands. Sorted highest-level
// first, then grip, then physiological zone order.
export function deriveBadges(history) {
  if (!history || history.length === 0) return [];
  const grips = [...new Set(history.filter(r => r && r.grip).map(r => r.grip))];
  const out = [];
  for (const grip of grips) {
    for (const z of ZONE6) {
      let level = 0;
      let hasData = false;
      for (const hand of ["L", "R"]) {
        if (getBaseline(history, hand, grip, z.key) == null) continue;
        hasData = true;
        const lvl = calcLevel(history, hand, grip, z.key);
        if (lvl > level) level = lvl;
      }
      if (!hasData) continue;
      out.push({
        grip, zone: z.key, zoneLabel: z.label, zoneShort: z.short,
        color: z.color, level, emoji: badgeEmoji(level),
      });
    }
  }
  const zoneOrder = Object.fromEntries(ZONE6.map((z, i) => [z.key, i]));
  out.sort((a, b) =>
    b.level - a.level ||
    a.grip.localeCompare(b.grip) ||
    zoneOrder[a.zone] - zoneOrder[b.zone]);
  return out;
}
