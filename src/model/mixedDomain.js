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

// Follow the ordinary recommender; peak tests or unavailable recommendations
// cannot become a Chaos domain. Manual choices are handled by the setup card.
export function recommendedMixedDomainZone(zone) {
  return MIXED_DOMAIN_ZONES.includes(zone) ? zone : 'power';
}

// Loads are fresh-load references, not predictions of fatigued hold times.
// Freeze the reference loads and order at session start. Adaptive loads
// use a separate frozen model and never rewrite these references. Explicit
// false remains supported for legacy fixed-reference plans.
export function makeMixedDomainPlan(rows, openingZone, hands, adjustLoads = true) {
  if (!MIXED_DOMAIN_ZONES.includes(openingZone)) return null;
  const start = MIXED_DOMAIN_ZONES.indexOf(openingZone);
  const order = [...MIXED_DOMAIN_ZONES.slice(start), ...MIXED_DOMAIN_ZONES.slice(0, start)];
  const steps = order.map(zone => {
    const row = rows?.find(r => r.key === zone);
    if (!row || row.deferredReason || hands.some(h => !(row[h] > 0 && row[h] < 200))) return null;
    return { zone, targetTime: ZONE_REF_T[zone], loadByHand: Object.fromEntries(hands.map(h => [h, row[h]])) };
  });
  return steps.every(Boolean) ? { id: MIXED_DOMAIN_ID, version: 2, steps, adjustLoads: adjustLoads === true } : null;
}

export function validMixedDomainPlan(plan, hands) {
  return plan?.id === MIXED_DOMAIN_ID && [1, 2].includes(plan.version)
    && (plan.adjustLoads == null || typeof plan.adjustLoads === 'boolean') && plan.steps?.length === 5
    && new Set(plan.steps.map(s => s.zone)).size === 5
    && plan.steps.every(s => MIXED_DOMAIN_ZONES.includes(s.zone)
      && s.targetTime === ZONE_REF_T[s.zone]
      && hands.every(h => Number.isFinite(s.loadByHand?.[h]) && s.loadByHand[h] > 0 && s.loadByHand[h] < 200));
}

// New plans preserve the domain cycle for both hands. Older saved plans keep
// their original per-hand descending-load order. Never re-sort adaptive targets.
export function mixedDomainSteps(plan, hand) {
  if (!plan?.steps?.length) return [];
  if (plan.version === 2) return plan.steps;
  return [plan.steps[0], ...plan.steps.slice(1).sort((a, b) => b.loadByHand[hand] - a.loadByHand[hand])];
}
