import { ZONE_REF_T } from './zones.js';

export const MIXED_DOMAIN_ID = 'whole_curve_beta';
export const MIXED_DOMAIN_ZONES = ['power', 'power_strength', 'strength', 'strength_endurance', 'endurance'];
export const MIXED_DOMAIN_REST_S = 30;
export const MIXED_DOMAIN_LABELS = {
  power: 'Power', power_strength: 'Power/Strength', strength: 'Strength',
  strength_endurance: 'Strength/Endurance', endurance: 'Endurance',
};

export const mixedDomainMetadata = rep => rep?.force_recording?.session_protocol;
export const isMixedDomainRep = rep => mixedDomainMetadata(rep)?.id === MIXED_DOMAIN_ID;

// Only completed, valid opening holds move the beta rotation forward.
// Training another grip or aborting before an opener cannot skip a domain.
export function nextMixedDomainZone(history, grip, hands, preferred = 'power') {
  const openings = (history || []).filter(r => r.grip === grip && hands.includes(r.hand)
    && isMixedDomainRep(r) && Number(r.rep_num) === 1 && r.failure_valid !== false
    && r.actual_time_s > 0 && MIXED_DOMAIN_ZONES.includes(mixedDomainMetadata(r).zone));
  openings.sort((a, b) => String(b.session_started_at || b.date).localeCompare(String(a.session_started_at || a.date)));
  if (!openings.length) return MIXED_DOMAIN_ZONES.includes(preferred) ? preferred : 'power';
  const previous = mixedDomainMetadata(openings[0]).zone;
  return MIXED_DOMAIN_ZONES[(MIXED_DOMAIN_ZONES.indexOf(previous) + 1) % MIXED_DOMAIN_ZONES.length];
}

// Loads are fresh-load references, not predictions of fatigued hold times.
// Freeze all five at session start so learning from rep 1 cannot change rep 2.
export function makeMixedDomainPlan(rows, openingZone, hands) {
  if (!MIXED_DOMAIN_ZONES.includes(openingZone)) return null;
  const order = [openingZone, ...MIXED_DOMAIN_ZONES.filter(z => z !== openingZone)];
  const steps = order.map(zone => {
    const row = rows?.find(r => r.key === zone);
    if (!row || row.deferredReason || hands.some(h => !(row[h] > 0 && row[h] < 200))) return null;
    return { zone, targetTime: ZONE_REF_T[zone], loadByHand: Object.fromEntries(hands.map(h => [h, row[h]])) };
  });
  return steps.every(Boolean) ? { id: MIXED_DOMAIN_ID, version: 1, steps } : null;
}

export function validMixedDomainPlan(plan, hands) {
  return plan?.id === MIXED_DOMAIN_ID && plan.version === 1 && plan.steps?.length === 5
    && new Set(plan.steps.map(s => s.zone)).size === 5
    && plan.steps.every(s => MIXED_DOMAIN_ZONES.includes(s.zone)
      && s.targetTime === ZONE_REF_T[s.zone]
      && hands.every(h => Number.isFinite(s.loadByHand?.[h]) && s.loadByHand[h] > 0 && s.loadByHand[h] < 200));
}

// After the opener, use actual planned loads to order the remaining holds.
// Separate hand orderings handle asymmetric or bounded prescriptions honestly.
export function mixedDomainSteps(plan, hand) {
  if (!plan?.steps?.length) return [];
  return [plan.steps[0], ...plan.steps.slice(1).sort((a, b) => b.loadByHand[hand] - a.loadByHand[hand])];
}
