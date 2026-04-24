// ─────────────────────────────────────────────────────────────
// CLIMBING DATA + GRADE HELPERS
// ─────────────────────────────────────────────────────────────
// Pure data + helpers for the climbing log domain. Used by the
// Climbing tab (entry pickers, log widget), the Trends view
// (hardest-send chart lines, weekly aggregates), and any other
// view that needs to display a climb entry.

// Discipline catalogue — keys persisted to log entries; emoji + label
// drive the UI rendering.
export const CLIMB_DISCIPLINES = [
  { key: "boulder",  label: "Boulder",  emoji: "⚡", desc: "Power / max moves"     },
  { key: "top_rope", label: "Top rope", emoji: "🧗", desc: "Roped, top-anchor"     },
  { key: "lead",     label: "Lead",     emoji: "🪢", desc: "Roped, clip as you go" },
];

// Ascent styles ordered from cleanest (onsight) to messiest (attempt).
// "attempt" is the only non-send entry — used by analytics to filter
// out unsent climbs from hardest-grade computations.
export const ASCENT_STYLES = [
  { key: "onsight",  label: "Onsight",  desc: "1st try, no beta"      },
  { key: "flash",    label: "Flash",    desc: "1st try, with beta"    },
  { key: "redpoint", label: "Redpoint", desc: "Sent after working"    },
  { key: "attempt",  label: "Attempt",  desc: "Worked but didn't send"},
];

// Discipline + ascent metadata lookup; falls back to a stub object
// for unknown keys so legacy entries still render with the raw key.
export function disciplineMeta(key) {
  return CLIMB_DISCIPLINES.find(d => d.key === key)
      || { key, label: key, emoji: "🧗", desc: "" };
}

export function ascentMeta(key) {
  return ASCENT_STYLES.find(a => a.key === key)
      || { key, label: key, desc: "" };
}

// Pretty one-liner for a single climb entry. Handles legacy
// intensity/duration entries so old data still renders.
export function describeClimb(a) {
  if (a.discipline || a.grade || a.ascent) {
    const d = disciplineMeta(a.discipline).label;
    const g = a.grade || "—";
    const s = a.ascent ? ascentMeta(a.ascent).label : "";
    return s ? `${d} · ${g} · ${s}` : `${d} · ${g}`;
  }
  // Legacy (pre-grade) entries
  const parts = [];
  if (a.intensity)    parts.push(a.intensity);
  if (a.duration_min) parts.push(`${a.duration_min}m`);
  return parts.join(" · ") || "Climbing session";
}

// Discipline → applicable grades. Boulder uses V-grades; everything
// else uses YDS.
export function gradesFor(discipline) {
  return discipline === "boulder" ? V_GRADES : YDS_GRADES;
}

// Discipline → default grade selection in the entry picker.
export function defaultGradeFor(discipline) {
  return discipline === "boulder" ? "V3" : "5.10a";
}

// ─────────────────────────────────────────────────────────────
// GRADES + RANKING
// ─────────────────────────────────────────────────────────────

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
