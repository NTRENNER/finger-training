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


test('returning preserves the bad-miss back-off while reducing sets', () => {
  const def = { ...ex, reps: '10', sets: 4 };
  const h = [session('2026-07-01', [set('200', true, '2')])];
  const normal = plan(h, '2026-07-03', def), returning = plan(h, '2026-09-30', def);
  expect(returning).toMatchObject({ mode: 'return', sets: 2 });
  expect(recommendSet(h, def, 'A', 0, null, returning).weight)
    .toBe(recommendSet(h, def, 'A', 0, null, normal).weight);
  expect(recommendSet(h, def, 'A', 0, null, returning)).toMatchObject({ weight: '195', reps: '10' });
});

test('returning maintenance retains at-limit easing and respects available implements', () => {
  const h = [session('2026-07-01', [set('50')], { effort: 'at_limit' })];
  for (const availableLoads of [undefined, [35, 50], [50, 70]]) {
    const def = { ...ex, progressionPolicy: 'maintain', availableLoads };
    const returning = plan(h, '2026-09-30', def), normal = plan(h, '2026-07-03', def);
    expect(returning).toMatchObject({ mode: 'return', sets: 2, loadMode: 'ease' });
    expect(recommendSet(h, def, 'C', 0, null, returning).weight)
      .toBe(recommendSet(h, def, 'C', 0, null, normal).weight);
  }
});

test.each(['', '0'])('bodyweight with added weight %s retries the target instead of the previous miss', weight => {
  const def = { ...ex, id: 'weightedPullup', reps: '3-5', sets: 2 };
  const old = { date: '2026-09-28', workout: 'A', exercises: { weightedPullup: { sets: [set(weight, true, '1'), set(weight, true, '1')] } } };
  const h = [old];
  const p = plan(h, '2026-09-29', def);
  const target = recommendSet(h, def, 'A', 0, null, p);
  expect(target.reps).toBe('3');
  h.push({ date: '2026-09-29', workout: 'A', exercises: { weightedPullup: {
    prescription: { sets: [target, target] }, sets: [set(weight, true, '1'), set(weight, true, '1')],
  } } });
  expect(plan(h, '2026-09-30', def).mode).toBe('repeat');
  h[1].exercises.weightedPullup.sets = [set(weight, true, '3'), set(weight, true, '3')];
  expect(plan(h, '2026-09-30', def)).toMatchObject({ mode: 'accumulate', sets: 3 });
});

test('deliberately chosen rep targets remain the completion gate and receive an accurate receipt', () => {
  const h = [session('2026-09-29', [set('', true, '1'), set('', true, '1')],
    { prescription: { sets: [{ reps: '1' }, { reps: '1' }] } })];
  const p = plan(h);
  expect(p.mode).toBe('accumulate');
  expect(p.reasoning).toContain('Completed all 2 planned sets and their rep targets');
  expect(p.reasoning).not.toContain('2×5');
});


test.each([[[35, 50]], [[50, 70]]])('return after a severe kettlebell miss keeps an editable reference and names the miss (%j)', availableLoads => {
  const def = { ...ex, reps: '10', sets: 4, availableLoads };
  const h = [session('2026-07-01', [set('50', true, '2')])];
  const returning = plan(h, '2026-09-30', def);
  expect(returning).toMatchObject({ mode: 'return', sets: 2 });
  const target = recommendSet(h, def, 'A', 0, null, returning);
  expect(target).toMatchObject({ weight: '50', reps: '10' });
  expect(target.reasoning).toContain('You did not reach the previous rep target');
  expect(target.reasoning).toContain('Choose a manageable available weight');
  expect(target.reasoning).toContain('use a lighter implement if needed');
});

test('a successful kettlebell return is not described as a missed target', () => {
  const def = { ...ex, reps: '10', availableLoads: [35, 50] };
  const h = [session('2026-07-01', [set('50', true, '10')])];
  const target = recommendSet(h, def, 'A', 0, null, plan(h, '2026-09-30', def));
  expect(target).toMatchObject({ weight: '50', reps: '10' });
  expect(target.reasoning).not.toContain('did not reach');
});
