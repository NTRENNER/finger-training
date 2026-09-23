import { makeMixedDomainPlan, mixedDomainSteps, MIXED_DOMAIN_ZONES, nextMixedDomainZone } from '../mixedDomain.js';
const rows = MIXED_DOMAIN_ZONES.map((key, i) => ({ key, L: 30 - i * 4, R: 35 - i * 4 }));
test('every opener produces five unique domains, with the remaining loads descending per hand', () => {
  for (const zone of MIXED_DOMAIN_ZONES) {
    const plan = makeMixedDomainPlan(rows, zone, ['L', 'R']);
    expect(plan.steps[0].zone).toBe(zone);
    for (const hand of ['L', 'R']) {
      const steps = mixedDomainSteps(plan, hand);
      expect(new Set(steps.map(s => s.zone)).size).toBe(5);
      const loads = steps.slice(1).map(s => s.loadByHand[hand]);
      expect(loads).toEqual([...loads].sort((a, b) => b - a));
    }
  }
});
test('beta requires all loads for the chosen hands, but not for an unselected hand', () => {
  const incomplete = rows.map(r => ({ ...r, R: null }));
  expect(makeMixedDomainPlan(incomplete, 'power', ['L', 'R'])).toBeNull();
  expect(makeMixedDomainPlan(incomplete, 'power', ['L'])).not.toBeNull();
  expect(makeMixedDomainPlan(rows.slice(1), 'power', ['L'])).toBeNull();
});
test('rotation wraps and stays specific to grip and selected hands', () => {
  const opening = { grip: 'Micro', hand: 'L', rep_num: 1, actual_time_s: 50, date: '2026-09-23',
    force_recording: { session_protocol: { id: 'whole_curve_beta', zone: 'endurance' } } };
  expect(nextMixedDomainZone([opening], 'Micro', ['L'])).toBe('power');
  expect(nextMixedDomainZone([opening], 'Crusher', ['L'], 'strength')).toBe('strength');
  expect(nextMixedDomainZone([opening], 'Micro', ['R'], 'strength')).toBe('strength');
});
