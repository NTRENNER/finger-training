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
// out unsent climbs from hardest-grade computations. "rest" counts as
// a send (the route was completed) but is distinct from a clean Send
// because the climber took weight on the rope (or stepped off the
// wall on a boulder) at least once between bottom and top.
//
// NAMING NOTE (May 2026): the UI-facing label for the "sent clean after
// working" style is "Send" — universal across boulders / top rope /
// lead, since "redpoint" technically applies only to lead climbs.
// The persisted key stays "redpoint" so historical data and existing
// downstream consumers (gradePyramid, ClimbingAnalysisView) don't
// need a migration; labels are looked up via ascentMeta(key).label.
export const ASCENT_STYLES = [
  { key: "onsight",  label: "Onsight",          desc: "1st try, no beta"          },
  { key: "flash",    label: "Flash",            desc: "1st try, with beta"        },
  { key: "redpoint", label: "Send",             desc: "Sent clean after working"  },
  { key: "rest",     label: "Completed w/ rest",desc: "Sent with mid-route rest"  },
  { key: "attempt",  label: "Attempt",          desc: "Worked but didn't send"    },
];

// Boulder wall types — V-grades on a MoonBoard / Kilter are notably
// stiffer than the same number on a commercial set, so we capture the
// surface alongside the grade. Only meaningful for indoor boulders;
// outdoor boulders + all rope routes don't get a wall annotation.
export const BOULDER_WALLS = [
  { key: "commercial", label: "Commercial set", emoji: "🧱" },
  { key: "moonboard",  label: "MoonBoard",      emoji: "🌙" },
  { key: "kilter",     label: "Kilter Board",   emoji: "🎯" },
];

// Venue — orthogonal axis to discipline. A 5.10c onsight at the local
// crag is meaningfully different data from a 5.10c onsight in the gym
// even at the same grade (route-reading, exposure, gear, rock quality).
// Captured on every climb entry; legacy entries without `venue` default
// to "indoor" since that was the historical assumption.
export const VENUES = [
  { key: "indoor",  label: "Indoor",  emoji: "🏢" },
  { key: "outdoor", label: "Outdoor", emoji: "🪨" },
];

export function venueMeta(key) {
  return VENUES.find(v => v.key === key)
      || (key ? { key, label: key, emoji: "" } : null);
}

export function wallMeta(key) {
  return BOULDER_WALLS.find(w => w.key === key)
      || (key ? { key, label: key, emoji: "🧱" } : null);
}

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
// intensity/duration entries so old data still renders. The wall is
// indoor-boulder-only and may be missing on legacy boulder entries; we
// elide it when absent rather than rendering an "—". Venue is shown
// only when explicitly outdoor — indoor stays implicit since it's the
// historical default and is the dominant case.
export function describeClimb(a) {
  if (a.discipline || a.grade || a.ascent) {
    const d = disciplineMeta(a.discipline).label;
    const g = a.grade || "—";
    const s = a.ascent ? ascentMeta(a.ascent).label : "";
    const w = a.discipline === "boulder" && a.wall ? wallMeta(a.wall)?.label : "";
    const v = a.venue === "outdoor" ? "Outdoor" : "";
    const parts = [d];
    if (v) parts.push(v);
    if (w) parts.push(w);
    parts.push(g);
    if (s) parts.push(s);
    return parts.join(" · ");
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

// ─────────────────────────────────────────────────────────────
// AFA V-SUM (route climbing) — YDS → V-equivalent conversion
// ─────────────────────────────────────────────────────────────
// The bouldering "v-sum" sums V-grade ranks per session. Routes use
// YDS, a different scale, so they can't go in the same sum directly.
// The "afa v-sum" conversion chart maps each YDS grade to a fractional
// V-equivalent, letting route sessions get a v-sum in the SAME units as
// bouldering. Values are taken verbatim from the abs-to-v-rating
// conversion chart's "afa v-sum score" column.
//
// Keyed by the app's lowercase YDS strings (5.6 … 5.14d). 5.6–5.8 all
// map to 0. Returns null for non-route / unrecognized grades so callers
// can skip them.
export const AFA_VSUM_BY_YDS = {
  "5.6": 0, "5.7": 0, "5.8": 0, "5.9": 0.5,
  "5.10a": 0.5, "5.10b": 1, "5.10c": 1.5, "5.10d": 1.5,
  "5.11a": 2, "5.11b": 2.5, "5.11c": 3, "5.11d": 4,
  "5.12a": 4.5, "5.12b": 5, "5.12c": 6, "5.12d": 7,
  "5.13a": 7.5, "5.13b": 8, "5.13c": 8.5, "5.13d": 9,
  "5.14a": 10, "5.14b": 10.5, "5.14c": 11, "5.14d": 12,
};

// AFA v-sum value for a YDS route grade, or null if not a recognized
// route grade. Normalizes case (chart shows some uppercase subgrades;
// the app stores lowercase).
export function afaVSum(grade) {
  if (!grade) return null;
  const key = String(grade).toLowerCase();
  return key in AFA_VSUM_BY_YDS ? AFA_VSUM_BY_YDS[key] : null;
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
