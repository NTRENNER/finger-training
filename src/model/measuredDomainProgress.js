import { buildPeakForceTrend } from "./peakForce.js";
import { buildZoneSessionHistory } from "./zoneSessionHistory.js";
import { TRAINING_ZONE_KEYS, ZONE6 } from "./zones.js";

function firstPeakDate(trend, grip) {
  return trend?.rows?.find(row => Number.isFinite(row?.[grip]))?.date ?? null;
}

// First-to-latest measured observations for the five trained duration domains,
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
  const latestPeak = peakTrend?.latest?.[grip];
  const peak = firstPeak > 0 && latestPeak?.kg > 0 ? {
    key: "peak_force",
    label: "Peak Force",
    first: { date: firstPeakDate(peakTrend, grip), forceKg: firstPeak },
    latest: { date: latestPeak.date, forceKg: latestPeak.kg },
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
      first: first ? { date: first.date, forceKg: first.openingLoadKg, durationS: first.openingActualS } : null,
      latest: latest ? { date: latest.date, forceKg: latest.openingLoadKg, durationS: latest.openingActualS } : null,
    };
  });

  return { grip, peak, domains };
}
