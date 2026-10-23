import { buildPeakForceTrend } from "./peakForce.js";
import { getZoneStaleness } from "./lockout.js";
import { TRAINING_ZONE_KEYS, ZONE6 } from "./zones.js";

const DEFAULT_GRIP_ORDER = ["Crusher", "Micro", "Prime"];
const LABELS = Object.fromEntries(ZONE6.map(zone => [zone.key, zone.label]));

export function curveCoverageByGrip(
  history = [],
  { handView = "pooled", grips = [] } = {},
) {
  const scopedHistory = handView === "pooled"
    ? history
    : history.filter(rep => rep?.hand === handView);
  const recordedGrips = new Set(scopedHistory.map(rep => rep?.grip).filter(Boolean));
  const requestedGrips = [...new Set(grips.filter(Boolean))];
  const orderedGrips = requestedGrips.length > 0
    ? requestedGrips
    : DEFAULT_GRIP_ORDER.filter(grip => recordedGrips.has(grip));

  if (requestedGrips.length === 0) {
    for (const grip of recordedGrips) {
      if (!orderedGrips.includes(grip)) orderedGrips.push(grip);
    }
  }

  return Object.fromEntries(orderedGrips.map(grip => {
    const gripHistory = scopedHistory.filter(rep => rep?.grip === grip);
    const staleness = getZoneStaleness(gripHistory);
    const maxMeasured = buildPeakForceTrend(gripHistory)?.grips?.includes(grip) === true;
    const missing = [];
    const aging = [];
    const stale = [];

    if (!maxMeasured) missing.push(LABELS.max_strength);
    for (const zone of TRAINING_ZONE_KEYS) {
      const status = staleness[zone]?.status;
      if (status === "never") missing.push(LABELS[zone]);
      else if (status === "warning") aging.push(LABELS[zone]);
      else if (status === "stale") stale.push(LABELS[zone]);
    }

    const current = (maxMeasured ? 1 : 0)
      + TRAINING_ZONE_KEYS.filter(zone => staleness[zone]?.status === "ok").length;

    return [grip, { current, total: 6, missing, aging, stale }];
  }));
}
