import { makeMixedDomainPlan, mixedDomainSteps, MIXED_DOMAIN_ZONES, recommendedMixedDomainZone, validMixedDomainPlan } from '../mixedDomain.js';
const rows = MIXED_DOMAIN_ZONES.map((key, i) => ({ key, L: 30 - i * 4, R: 35 - i * 4 }));
test('every opener cycles through all five domains in the same order for both hands', () => {
  // Deliberately reverse one hand's loads: order must not depend on load.
  const asymmetric = rows.map((r, i) => ({ ...r, R: 10 + i * 4 }));
  for (const zone of MIXED_DOMAIN_ZONES) {
    const plan = makeMixedDomainPlan(asymmetric, zone, ['L', 'R']);
    const start = MIXED_DOMAIN_ZONES.indexOf(zone);
    const expected = [...MIXED_DOMAIN_ZONES.slice(start), ...MIXED_DOMAIN_ZONES.slice(0, start)];
    expect(plan.version).toBe(2);
    expect(validMixedDomainPlan(plan, ['L', 'R'])).toBe(true);
    for (const hand of ['L', 'R']) expect(mixedDomainSteps(plan, hand).map(s => s.zone)).toEqual(expected);
  }
});
test('legacy plans retain descending-load order and unknown versions are rejected', () => {
  const plan = { ...makeMixedDomainPlan(rows, 'strength_endurance', ['L', 'R']), version: 1 };
  expect(validMixedDomainPlan(plan, ['L', 'R'])).toBe(true);
  expect(mixedDomainSteps(plan, 'L').map(s => s.zone)).toEqual(['strength_endurance', 'power', 'power_strength', 'strength', 'endurance']);
  expect(validMixedDomainPlan({ ...plan, version: 99 }, ['L', 'R'])).toBe(false);
});
test('beta requires all loads for the chosen hands, but not for an unselected hand', () => {
  const incomplete = rows.map(r => ({ ...r, R: null }));
  expect(makeMixedDomainPlan(incomplete, 'power', ['L', 'R'])).toBeNull();
  expect(makeMixedDomainPlan(incomplete, 'power', ['L'])).not.toBeNull();
  expect(makeMixedDomainPlan(rows.slice(1), 'power', ['L'])).toBeNull();
});
test('a training recommendation is the default; peak or missing recommendations fall back to Power', () => {
  expect(recommendedMixedDomainZone('strength_endurance')).toBe('strength_endurance');
  expect(recommendedMixedDomainZone('max_strength')).toBe('power');
  expect(recommendedMixedDomainZone(null)).toBe('power');
});
