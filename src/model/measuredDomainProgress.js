import { buildPeakForceTrend } from "./peakForce.js";
import { buildZoneSessionHistory } from "./zoneSessionHistory.js";
import { TRAINING_ZONE_KEYS, ZONE6 } from "./zones.js";

const FORCE_MATCH_FRACTION = 0.05;
const FORCE_MATCH_FLOOR_KG = 0.25;
const DURATION_MATCH_FRACTION = 0.10;
const DURATION_MATCH_FLOOR_S = 2;

function firstPeakDate(trend, grip) {
  return trend?.rows?.find(row => Number.isFinite(row?.[grip]))?.date ?? null;
}

function measuredResult(session) {
  return session ? {
    date: session.date,
    forceKg: session.openingLoadKg,
    durationS: session.openingActualS,
  } : null;
}

// Find the newest observation that has a defensible older match, then use the
// earliest such match to maximize the comparison span. One dimension must be
// essentially unchanged: force within 5% (0.25 kg minimum) or duration within
// 10% (2 s minimum). If neither condition is met, the observations describe
// different tests and should not be presented as a progress comparison.
export function buildLikeForLikeComparison(sessions) {
  if (!Array.isArray(sessions) || sessions.length < 2) return null;
  for (let latestIndex = 0; latestIndex < sessions.length - 1; latestIndex += 1) {
    const latest = sessions[latestIndex];
    const olderSessions = sessions.slice(latestIndex + 1).reverse();
    for (const earlier of olderSessions) {
      const forceTolerance = Math.max(
        FORCE_MATCH_FLOOR_KG,
        earlier.openingLoadKg * FORCE_MATCH_FRACTION
      );
      const durationTolerance = Math.max(
        DURATION_MATCH_FLOOR_S,
        earlier.openingActualS * DURATION_MATCH_FRACTION
      );
      const forceGap = Math.abs(latest.openingLoadKg - earlier.openingLoadKg);
      const durationGap = Math.abs(latest.openingActualS - earlier.openingActualS);
      const forceMatch = forceGap <= forceTolerance;
      const durationMatch = durationGap <= durationTolerance;
      if (!forceMatch && !durationMatch) continue;

      const type = forceMatch && durationMatch
        ? forceGap / forceTolerance <= durationGap / durationTolerance
          ? "fixed_force"
          : "fixed_duration"
        : forceMatch ? "fixed_force" : "fixed_duration";
      return {
        type,
        earlier: measuredResult(earlier),
        latest: measuredResult(latest),
        anchorForceKg: type === "fixed_force"
          ? (earlier.openingLoadKg + latest.openingLoadKg) / 2
          : null,
        anchorDurationS: type === "fixed_duration"
          ? (earlier.openingActualS + latest.openingActualS) / 2
          : null,
      };
    }
  }
  return null;
}

// Like-for-like measured observations for the five trained duration domains,
// plus instantaneous peak force. Nothing here is fitted or inferred.
export function buildMeasuredDomainProgress(history, {
  grip,
  handView = "pooled",
  throughDate = null,
} = {}) {
  if (!grip) return null;
  const scoped = (history || []).filter(rep => rep?.grip === grip
    && (!throughDate || rep.date <= throughDate)
    && (handView === "pooled" || rep.hand === handView));
  const peakTrend = buildPeakForceTrend(scoped, { roundDigits: 5 });
  const firstPeak = peakTrend?.firstBest?.[grip];
  const bestPeak = peakTrend?.best?.[grip];
  const latestPeak = peakTrend?.latestMaxIntent?.[grip];
  // best = highest measured peak (PR); latest = the most recent max-intent
  // reading (peak test or short protocol), so the tile can show how close
  // current form is to the PR without an endurance hold posing as a max.
  const peak = firstPeak > 0 && bestPeak?.kg > 0 ? {
    key: "peak_force",
    label: "Peak Force",
    first: { date: firstPeakDate(peakTrend, grip), forceKg: firstPeak },
    best: { date: bestPeak.date, forceKg: bestPeak.kg },
    latest: latestPeak?.kg > 0 ? { date: latestPeak.date, forceKg: latestPeak.kg } : null,
    sessions: peakTrend.rows.filter(row => Number.isFinite(row?.[grip])).length,
  } : null;

  const domains = TRAINING_ZONE_KEYS.map(zoneKey => {
    const sessions = buildZoneSessionHistory(scoped, {
      grip,
      zoneKey,
      handView,
      throughDate,
      measuredOnly: true,
    });
    const zone = ZONE6.find(item => item.key === zoneKey);
    const first = sessions.at(-1) ?? null;
    const latest = sessions[0] ?? null;
    return {
      key: zoneKey,
      label: zone?.label || zoneKey,
      color: zone?.color,
      sessions: sessions.length,
      first: measuredResult(first),
      latest: measuredResult(latest),
      comparison: buildLikeForLikeComparison(sessions),
    };
  });

  return { grip, peak, domains };
}
