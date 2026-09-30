import { recommendSetCount, recommendSet, returnToTrainingPlan } from '../workout-progression.js';
const ex = { id: 'bench', reps: '5', sets: 3 };
const set = (weight = '135', done = true, reps = '5') => ({ weight, done, reps });
const session = (date, sets, extra = {}) => ({ date, workout: 'A', exercises: { bench: { sets, ...extra } } });
const plan = (h, date = '2026-09-30', def = ex) => recommendSetCount(h, def, def.sets, { referenceDate: date });

test('partial completion neither advances nor imports an unchecked heavier load', () => {
  const h = [session('2026-09-29', [set(), set('185', false), set('185', false)])];
  const p = plan(h);
  expect(p).toMatchObject({ mode: 'repeat', sets: 3 });
  expect(recommendSet(h, ex, 'A', 2, null, p).weight).toBe('135');
});
test('deleted planned sets and higher saved rep targets cannot earn progression', () => {
  const prescription = { sets: [set(), set(), set()] };
  expect(plan([session('2026-09-29', [set(), set()], { prescription })]).mode).toBe('repeat');
  expect(plan([session('2026-09-29', [set(), set(), set()], {
    prescription: { sets: [set('135', false, '8'), set(), set()] } })]).mode).toBe('repeat');
});
test('full completed plan progresses; at-limit feedback holds, absent feedback stays absent', () => {
  const h = [session('2026-09-29', [set(), set(), set()])];
  expect(plan(h).mode).toBe('accumulate');
  h[0].exercises.bench.effort = 'at_limit';
  expect(plan(h).mode).toBe('repeat');
  const light = { ...ex, progressionPolicy: 'maintain' };
  const p = plan(h, '2026-09-30', light);
  expect(p.mode).toBe('ease');
  expect(+recommendSet(h, light, 'C', 0, null, p).weight).toBeLessThan(135);
});
test('maintenance with fixed implements cannot invent a lighter implement', () => {
  const def = { ...ex, progressionPolicy: 'maintain', availableLoads: [35, 50] };
  const h = [session('2026-09-29', [set('35')], { effort: 'at_limit' })];
  expect(recommendSet(h, def, 'C', 0, null, plan(h, '2026-09-30', def)).weight).toBe('35');
});
test('a long gap reduces sets without escalating or inventing strength loss', () => {
  const h = [session('2026-07-29', [set(), set(), set(), set(), set()])];
  const p = plan(h);
  expect(p).toMatchObject({ mode: 'return', sets: 2, completedReturnDays: 0 });
  expect(recommendSet(h, ex, 'A', 0, null, p).weight).toBe('135');
});
test('return requires two fully completed independent prior dates, not two same-day workouts', () => {
  const h = [session('2026-07-29', [set(), set(), set()])];
  const prescription = { sets: [set(), set()], returnStartedOn: '2026-09-28' };
  h.push(session('2026-09-28', [set(), set()], { prescription }));
  h.push(session('2026-09-28', [set(), set()], { prescription }));
  expect(plan(h).mode).toBe('return');
  h.push(session('2026-09-29', [set()], { prescription }));
  expect(plan(h).mode).toBe('return');
  h[h.length-1].exercises.bench.sets.push(set());
  expect(plan(h).mode).not.toBe('return');
});
test('return is per exercise across workout letters and ignores future sessions', () => {
  const h = [session('2026-07-29', [set()]), { ...session('2026-09-29', [set(), set(), set()]), workout: 'C' }];
  expect(plan(h).mode).toBe('return'); // first return exposure, despite a different letter
  h.push({ ...session('2026-09-30', [set(), set(), set()]), workout: 'C' });
  expect(plan(h, '2026-10-01').mode).not.toBe('return');
  const earlier = plan(h, '2026-08-01');
  expect(recommendSet(h, ex, 'A', 0, null, earlier).weight).toBe('135');
  expect(returnToTrainingPlan([], ex, 3, '2026-09-30')).toBeNull();
});
test('unilateral completion requires each side to reach its own prescribed target', () => {
  const def = { ...ex, unilateral: true };
  const target = { leftReps: '6', rightReps: '8' };
  const actual = { ...target, rightReps: '7', leftWeight: '20', rightWeight: '20', done: true };
  const h = [session('2026-09-29', [actual], { prescription: { sets: [target] } })];
  expect(plan(h, '2026-09-30', def).mode).toBe('repeat');
});
test('partial power work cannot earn extra repetitions', () => {
  const def = { ...ex, progressionPolicy: 'double' };
  const h = [session('2026-09-29', [set(), set('135', false), set('135', false)])];
  const p = plan(h, '2026-09-30', def);
  expect(p.mode).toBe('repeat');
  expect(recommendSet(h, def, 'B', 0, null, p).reps).toBe('5');
});
