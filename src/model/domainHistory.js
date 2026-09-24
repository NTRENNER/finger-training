import { TRAINING_ZONE_KEYS, zoneOf } from './zones.js';
import { isCapacityEvidenceRep, isValidFailureRep } from './forceRecording.js';
import { mixedDomainMetadata } from './mixedDomain.js';
import { ymdLocal } from '../util.js';

// Training exposure is not a fresh measurement. A later mixed-load hold can
// count toward the planned domain without supplying an unfatigued curve anchor.
export function domainHistory(history, grip, hands = ['L', 'R'], asOf = ymdLocal()) {
  return Object.fromEntries(TRAINING_ZONE_KEYS.map(zone => {
    const scoped = (history || []).filter(r => r?.grip === grip && hands.includes(r.hand)
      && r.date && r.date <= asOf && r.actual_time_s > 0);
    const exposure = scoped.filter(r => isValidFailureRep(r)
      && (mixedDomainMetadata(r)?.zone || zoneOf(r.target_duration || r.actual_time_s)) === zone);
    const openings = scoped.filter(r => (r.rep_num ?? 1) === 1 && Number(r.set_num ?? 1) === 1
      && isCapacityEvidenceRep(r) && zoneOf(r.actual_time_s) === zone);
    return [zone, { sessions: new Set(exposure.map(r => `${r.date}|${r.session_id || r.date}`)).size,
      lastTrained: exposure.map(r => r.date).sort().at(-1) ?? null,
      lastOpeningEvidence: openings.map(r => r.date).sort().at(-1) ?? null }];
  }));
}
