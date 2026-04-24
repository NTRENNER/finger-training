// ─────────────────────────────────────────────────────────────
// CLIMBING GRADE HELPERS
// ─────────────────────────────────────────────────────────────
// Pure data + ranking helpers for boulder (V-scale) and rope (YDS)
// grades. Used by both the Climbing tab (for entry pickers) and the
// Trends view (for hardest-send chart lines).

// V0..V13 covers the vast majority of recreational to advanced
// boulder grades.
export const V_GRADES = Array.from({ length: 14 }, (_, i) => `V${i}`);

// YDS 5.6..5.14d with a-d subgrades above 5.10.
export const YDS_GRADES = (() => {
  const base = ["5.6", "5.7", "5.8", "5.9"];
  const suffix = ["a", "b", "c", "d"];
  const sub = [];
  for (const n of [10, 11, 12, 13, 14]) {
    for (const s of suffix) sub.push(`5.${n}${s}`);
  }
  return [...base, ...sub];
})();

// Numeric ordering for mixed V / YDS grades. Returns a rank that is
// comparable within a discipline family; -1 for anything we don't
// recognize so legacy entries don't skew max/min computations.
//
// Ranks:
//   V0 → 0, V1 → 1, ... V13 → 13
//   5.10a → 10.00, 5.10b → 10.25, 5.10c → 10.50, 5.10d → 10.75
//   5.11a → 11.00, ... 5.14d → 14.75
//
// Within-discipline comparable; cross-discipline ranks are not
// meaningful (V5 and 5.10c have similar numeric ranks but no
// physical correspondence).
export function gradeRank(grade) {
  if (!grade) return -1;
  const vMatch = /^V(\d+)$/.exec(grade);
  if (vMatch) return parseInt(vMatch[1], 10);
  const ydsMatch = /^5\.(\d+)([abcd])?$/.exec(grade);
  if (ydsMatch) {
    const n = parseInt(ydsMatch[1], 10);
    const s = ydsMatch[2] ? "abcd".indexOf(ydsMatch[2]) / 4 : 0;
    return n + s;
  }
  return -1;
}

// Returns the ISO date of the Monday of the week this date falls in.
// Used as the x-axis key for weekly aggregates (climbing volume, etc).
export function weekKey(isoDate) {
  const d = new Date(isoDate + "T00:00:00Z");
  if (isNaN(d.getTime())) return isoDate;
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const mondayOffset = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + mondayOffset);
  return d.toISOString().slice(0, 10);
}
