import { TRAINING_ZONE_KEYS, zoneOf } from './zones.js';
import { isValidFailureRep } from './forceRecording.js';
import { isMixedDomainRep, mixedDomainMetadata } from './mixedDomain.js';
import { isPeakTestRep } from './peakForce.js';
import { effectiveLoad } from './load.js';
import { getLastZoneTrainedDates } from './lockout.js';

// This describes logged exposure, never fresh capacity or a physiological
// adaptation. A completed Chaos hold near its intended duration supplies
// exposure without entering the fresh-curve fit. Short attempts remain visible.
export const EXPOSURE_TARGET_FRACTION = 0.8;
export function trainingExposure(history = [], asOf = '9999-12-31') {
  const rows = history.filter(r => r?.date && r.date <= asOf);
  const measured = getLastZoneTrainedDates(rows);
  const out = Object.fromEntries(TRAINING_ZONE_KEYS.map(zone => [zone,
    { trainedDate: null, attemptedDate: null, measuredDate: measured[zone] || null }]));
  for (const r of rows) {
    if (isPeakTestRep(r) || !(r.actual_time_s > 0) || !(effectiveLoad(r) > 0)) continue;
    const mixed = isMixedDomainRep(r);
    if (!mixed && (Number(r.rep_num ?? 1) !== 1 || Number(r.set_num ?? 1) !== 1)) continue;
    const zone = mixed ? mixedDomainMetadata(r).zone : zoneOf(r.actual_time_s);
    const item = out[zone];
    if (!item) continue;
    item.attemptedDate = !item.attemptedDate || r.date > item.attemptedDate ? r.date : item.attemptedDate;
    if (!isValidFailureRep(r) || (mixed && !(r.target_duration > 0
      && r.actual_time_s >= r.target_duration * EXPOSURE_TARGET_FRACTION))) continue;
    item.trainedDate = !item.trainedDate || r.date > item.trainedDate ? r.date : item.trainedDate;
  }
  return out;
}
