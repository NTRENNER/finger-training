import { effectiveLoad, isOpenerRep } from "./load.js";
import { zoneOf } from "./zones.js";

function mean(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function numeric(values) {
  return values.map(Number).filter(value => Number.isFinite(value) && value > 0);
}

// Build newest-first, workout-by-workout comparisons for one grip and
// prescribed zone. Zone membership uses the session's median target
// duration; the opening hold's actual zone is reported separately so an
// under-hit Endurance workout remains visible as an Endurance prescription.
export function buildZoneSessionHistory(history, {
  grip,
  zoneKey,
  handView = "pooled",
  throughDate = null,
} = {}) {
  if (!grip || !zoneKey) return [];

  const selectedHand = handView === "L" || handView === "R" ? handView : null;
  const grouped = new Map();

  for (const rep of history || []) {
    if (!rep || rep.grip !== grip || !rep.date) continue;
    if (throughDate && rep.date > throughDate) continue;
    if (selectedHand && rep.hand !== selectedHand) continue;
    if (!(Number(rep.actual_time_s) > 0) || !(effectiveLoad(rep) > 0)) continue;

    // Include date in the identity because sessions can legitimately span
    // midnight while retaining one session_id.
    const key = `${rep.session_id || rep.date}|${rep.date}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(rep);
  }

  const sessions = [];
  for (const [key, reps] of grouped) {
    const targetDurations = numeric(
      reps.map(rep => rep.target_duration || rep.actual_time_s)
    );
    const targetS = median(targetDurations);
    if (!(targetS > 0) || zoneOf(targetS) !== zoneKey) continue;

    const openers = reps.filter(isOpenerRep);
    const comparisonReps = openers.length > 0 ? openers : reps.slice(0, 1);
    const openingActualS = mean(numeric(comparisonReps.map(rep => rep.actual_time_s)));
    const openingLoadKg = mean(numeric(comparisonReps.map(effectiveLoad)));
    if (!(openingActualS > 0) || !(openingLoadKg > 0)) continue;

    const hands = [...new Set(reps.map(rep => rep.hand).filter(hand => hand === "L" || hand === "R"))];
    const tutS = reps.reduce((sum, rep) => sum + (Number(rep.actual_time_s) || 0), 0);
    const ratio = openingActualS / targetS;

    sessions.push({
      key,
      sessionId: reps[0]?.session_id || null,
      date: reps.reduce((latest, rep) => rep.date > latest ? rep.date : latest, ""),
      sessionStartedAt: reps.reduce(
        (latest, rep) => rep.session_started_at && rep.session_started_at > latest
          ? rep.session_started_at
          : latest,
        ""
      ) || null,
      grip,
      zoneKey,
      outcomeZoneKey: zoneOf(openingActualS),
      targetS,
      openingActualS,
      openingLoadKg,
      ratio,
      repCount: reps.length,
      tutS,
      hands,
      reps,
    });
  }

  sessions.sort((a, b) =>
    a.date.localeCompare(b.date)
    || (a.sessionStartedAt || "").localeCompare(b.sessionStartedAt || "")
    || a.key.localeCompare(b.key)
  );
  for (let index = 0; index < sessions.length; index += 1) {
    const previous = sessions[index - 1] || null;
    sessions[index].loadDeltaKg = previous
      ? sessions[index].openingLoadKg - previous.openingLoadKg
      : null;
    sessions[index].ratioDelta = previous
      ? sessions[index].ratio - previous.ratio
      : null;
  }

  return sessions.reverse();
}
