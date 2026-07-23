import { gradeRank, isClimbingPrSend } from "../lib/climbing-grades.js";

// Climbing grades are comparable only within the same setting. Indoor
// boulders split by wall system; routes split by venue while combining
// lead and top rope into one progression.
export const CLIMBING_PR_CONTEXTS = [
  {
    key: "boulder_indoor_commercial",
    discipline: "boulder",
    venue: "indoor",
    wall: "commercial",
    label: "Indoor Commercial",
    shortLabel: "Commercial",
    narrativeLabel: "commercial-set boulder",
    emoji: "🧱",
  },
  {
    key: "boulder_indoor_moonboard",
    discipline: "boulder",
    venue: "indoor",
    wall: "moonboard",
    label: "Indoor MoonBoard",
    shortLabel: "MoonBoard",
    narrativeLabel: "MoonBoard",
    emoji: "🌙",
  },
  {
    key: "boulder_indoor_kilter",
    discipline: "boulder",
    venue: "indoor",
    wall: "kilter",
    label: "Indoor Kilter",
    shortLabel: "Kilter",
    narrativeLabel: "Kilter Board",
    emoji: "🎯",
  },
  {
    key: "boulder_outdoor",
    discipline: "boulder",
    venue: "outdoor",
    wall: null,
    label: "Outdoor Boulder",
    shortLabel: "Outdoor Boulder",
    narrativeLabel: "outdoor boulder",
    emoji: "🪨",
  },
  {
    key: "route_indoor",
    discipline: "route",
    venue: "indoor",
    wall: null,
    label: "Indoor Route",
    shortLabel: "Indoor Route",
    narrativeLabel: "indoor route",
    emoji: "🏢",
  },
  {
    key: "route_outdoor",
    discipline: "route",
    venue: "outdoor",
    wall: null,
    label: "Outdoor Route",
    shortLabel: "Outdoor Route",
    narrativeLabel: "outdoor route",
    emoji: "🧗",
  },
];

const CONTEXT_BY_KEY = new Map(CLIMBING_PR_CONTEXTS.map(context => [context.key, context]));

export function climbingPrContext(activity) {
  if (!activity || (activity.type && activity.type !== "climbing")) return null;

  const venue = activity.venue === "outdoor" ? "outdoor" : "indoor";
  if (activity.discipline === "boulder") {
    if (venue === "outdoor") return CONTEXT_BY_KEY.get("boulder_outdoor");

    // Indoor boulders logged before wall tracking existed were commercial
    // gym sets, which is also the logger's current default.
    const wall = activity.wall || "commercial";
    return CONTEXT_BY_KEY.get(`boulder_indoor_${wall}`) || null;
  }

  if (activity.discipline === "lead" || activity.discipline === "top_rope") {
    return CONTEXT_BY_KEY.get(`route_${venue}`);
  }

  return null;
}

function bestClimbsByContext(activities) {
  const best = new Map();

  for (const climb of activities || []) {
    if (climb.type !== "climbing" || !isClimbingPrSend(climb)) continue;

    const context = climbingPrContext(climb);
    const rank = gradeRank(climb.grade);
    if (!context || rank < 0) continue;

    const current = best.get(context.key);
    const earlierAtSameGrade = current
      && rank === current.rank
      && String(climb.date || "") < String(current.climb.date || "");
    if (!current || rank > current.rank || earlierAtSameGrade) {
      best.set(context.key, { climb, context, rank });
    }
  }

  return best;
}

export function deriveClimbingPrBadges(activities) {
  const best = bestClimbsByContext(activities);

  return CLIMBING_PR_CONTEXTS.flatMap(context => {
    const result = best.get(context.key);
    if (!result) return [];

    const { climb, rank } = result;
    return [{
      ...context,
      grade: climb.grade,
      rank,
      date: climb.date,
      ascent: climb.ascent,
      sourceDiscipline: climb.discipline,
      routeName: climb.route_name || "",
      climb,
    }];
  });
}

export function newClimbingPrForEntry(activities, entry) {
  if (!isClimbingPrSend(entry)) return null;

  const context = climbingPrContext(entry);
  const rank = gradeRank(entry?.grade);
  if (!context || rank < 0) return null;

  const previous = bestClimbsByContext(activities).get(context.key);
  if (previous && rank <= previous.rank) return null;

  return {
    ...context,
    grade: entry.grade,
    rank,
    date: entry.date,
    ascent: entry.ascent,
    sourceDiscipline: entry.discipline,
    routeName: entry.route_name || "",
    previousGrade: previous?.climb.grade || null,
    climb: entry,
  };
}
