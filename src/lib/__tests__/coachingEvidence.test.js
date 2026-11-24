import { assessCoachingEvidence, observeBehavioralCoaching } from '../coachingEvidence.js';

const candidate = () => ({ key: 'spacing', behavior: 'distribution', action: 'Redistribute the same weekly work.',
  evidence: { outcome: 'modeled_endurance', comparable: true, independentDates: true,
    effect: { estimate: 5, lower: 3, upper: 7, worthwhile: 2, confidence: 0.95 },
    confounds: { total_volume: 'considered', climbing: 'considered', grip: 'considered', protocol: 'considered', session_order: 'considered' },
    replicated: true, validatedOutOfSample: true, design: 'observational', causalClaim: false } });

test('cadence and workload changes are observation-only regardless of history length', () => {
  const result = observeBehavioralCoaching([{ key: 'adherence', text: 'A longer recorded gap.', sessions: 10000 },
    { key: 'ramp-spike', text: 'More work.', elapsedDays: 3650 }]);
  expect(result).toMatchObject({ mode: 'observe_only', recommendations: [] });
  expect(result.candidates).toHaveLength(2);
  expect(result.candidates.every(c => !c.evidenceReady && c.reasons.includes('no_longitudinal_outcome'))).toBe(true);
  expect(observeBehavioralCoaching([]).recommendations).toEqual([]);
});

test('target misses and cookedness cannot become behavioral coaching evidence', () => {
  expect(observeBehavioralCoaching([{ key: 'missed_target' }, { key: 'cooked' }]).candidates).toEqual([]);
  const c = candidate(); c.evidence.outcome = 'target_attainment';
  expect(assessCoachingEvidence(c).evidenceReady).toBe(false);
  c.evidence.outcome = 'cookedness';
  expect(assessCoachingEvidence(c).evidenceReady).toBe(false);
});

test('a meaningful and independently supported association can be ready for review without becoming advice', () => {
  expect(assessCoachingEvidence(candidate())).toMatchObject({ evidenceReady: true, reasons: [] });
  expect(observeBehavioralCoaching([candidate()]).recommendations).toEqual([]);
});

test.each([
  { effect: { estimate: 5, lower: -1, upper: 10, worthwhile: 2, confidence: 0.95 } },
  { effect: { estimate: 0.5, lower: 0.1, upper: 1, worthwhile: 2, confidence: 0.95 } },
  { effect: { estimate: 5, lower: 3, upper: 7, worthwhile: 2, confidence: 0.5 } },
  { confounds: {} }, { independentDates: false }, { validatedOutOfSample: false },
  { causalClaim: true },
])('withholds evidence with unresolved support: %j', patch => {
  const c = candidate(); c.evidence = { ...c.evidence, ...patch };
  expect(assessCoachingEvidence(c).evidenceReady).toBe(false);
});
