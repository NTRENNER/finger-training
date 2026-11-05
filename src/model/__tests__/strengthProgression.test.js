import { defaultWorkoutProgram, workoutProgramWorkouts, saveWorkoutTemplate } from '../workoutProgram.js';
import { recommendSetCount, recommendSet } from '../workout-progression.js';
import { QUICK_MODIFIERS, setModifierSelection, modifierSelectionSignature } from '../workoutModifiers.js';

const program = { ...defaultWorkoutProgram(), mode: 'block' };
const bench = workoutProgramWorkouts(program).C.exercises.find(ex => ex.id === 'benchPress');
const set = { weight: '155', reps: '5', done: true };
const log = (sets, extra = {}) => [{ date: '2026-10-30', workout: 'C', exercises: {
  benchPress: { sets, effort: 'about_right', ...extra },
} }];
const plan = history => recommendSetCount(history, bench, bench.sets, { referenceDate: '2026-11-05' });

test('strength block uses A/B/C names, three then four sets, and fixed 5 lb upper-body increases', () => {
  const workouts = workoutProgramWorkouts(program);
  expect(['A','C','S3'].map(id => workouts[id].name)).toEqual(['Workout A', 'Workout B', 'Workout C']);
  expect(bench.sets).toBe(3);
  const history = log(Array.from({ length: 3 }, () => ({ ...set })));
  expect(plan(history)).toMatchObject({ sets: 4, mode: 'accumulate' });
  expect(recommendSet(history, bench, 'C', 0, null, plan(history)).weight).toBe('155');
  const topped = log(Array.from({ length: 4 }, () => ({ ...set })));
  expect(plan(topped)).toMatchObject({ sets: 3, mode: 'step_load' });
  expect(recommendSet(topped, bench, 'C', 0, null, plan(topped)).weight).toBe('160');
});

test('missed reps, unchecked targets, at-limit feedback and a Slingshot final rep cannot earn an increase', () => {
  const sets = Array.from({ length: 4 }, () => ({ ...set }));
  const assisted = setModifierSelection(set, QUICK_MODIFIERS[0], 'on');
  assisted.modifiers.modifier_slingshot.repCount = 1;
  for (const history of [
    log([...sets.slice(0,3), { ...set, reps: '4' }]),
    log([...sets.slice(0,3), { ...set, done: false }], { prescription: { sets } }),
    log(sets, { effort: 'at_limit' }),
    log([...sets.slice(0,3), assisted]),
  ]) expect(plan(history).mode).toBe('repeat');
});

test('assistance never supplies the next unmodified load and rep scope survives serialization', () => {
  const assisted = setModifierSelection({ ...set, weight: '225' }, QUICK_MODIFIERS[0], 'on');
  assisted.modifiers.modifier_slingshot.repCount = 1;
  const history = [...log([{ ...set }]), { date:'2026-11-02', workout:'C', exercises:{ benchPress:{ sets:[assisted] } } }];
  expect(recommendSet(history, bench, 'C', 0, null, plan(history)).weight).toBe('155');
  expect(modifierSelectionSignature(JSON.parse(JSON.stringify(assisted)))).toContain('@1');
});

test('explicit template updates retain membership and modifier targets, excluding weights and done flags', () => {
  const assisted = setModifierSelection(set, QUICK_MODIFIERS[0], 'on');
  const updated = saveWorkoutTemplate(program, 'C', [bench], { benchPress:{ sets:[assisted,assisted,assisted] } });
  expect(program.templateDefaults).toEqual({});
  const next = workoutProgramWorkouts(JSON.parse(JSON.stringify(updated))).C;
  expect(next.exercises).toHaveLength(1);
  expect(next.exercises[0].templateSets[0]).toMatchObject({ reps:'5', modifiers:assisted.modifiers });
  expect(next.exercises[0].templateSets[0].weight).toBeUndefined();
  expect(next.exercises[0].templateSets[0].done).toBeUndefined();
});

test('larger lower-body strength work uses 10 lb and metric increments land on plates', () => {
  const { strengthExercise } = require('../workoutProgram.js');
  const lower = strengthExercise({id:'rdl',name:'RDL',type:'S',sets:2,reps:'5',logWeight:true});
  const history = [{date:'2026-10-30',workout:'A',exercises:{rdl:{sets:Array.from({length:4},()=>({weight:'100',reps:'5',done:true}))}}}];
  const pounds = recommendSetCount(history,lower,lower.sets,{referenceDate:'2026-11-05',unit:'lbs'});
  expect(recommendSet(history,lower,'A',0,null,pounds).weight).toBe('110');
  const metric = recommendSetCount(history,lower,lower.sets,{referenceDate:'2026-11-05',unit:'kg'});
  // 10 lb converts to 5 kg, not 4.54 kg: no plate set makes 104.54 kg.
  expect(recommendSet(history,lower,'A',0,null,metric)).toMatchObject({weight:'105',reasoning:'↑ +5 kg (ladder top-out)'});
});

test('metric upper-body increases are 2.5 kg', () => {
  const topped = log(Array.from({ length: 4 }, () => ({ ...set, weight: '60' })));
  const metric = recommendSetCount(topped, bench, bench.sets, { referenceDate: '2026-11-05', unit: 'kg' });
  expect(recommendSet(topped, bench, 'C', 0, null, metric)).toMatchObject({ weight: '62.5', reasoning: '↑ +2.5 kg (ladder top-out)' });
});

// A setup selected today (here a band the template does not have) is
// recommended from that setup's own history.
test('a selected setup modifier gets its own load and ladder from matching sessions', () => {
  const band = { id: 'modifier_band_red', name: 'Band', kind: 'assistance', control: 'standard', options: [{ id: 'red', label: 'Red' }] };
  const banded = setModifierSelection({ ...set, weight: '20' }, band, 'red');
  const history = log(Array.from({ length: 3 }, () => ({ ...banded })), { prescription: { sets: [{ reps: '5' }, { reps: '5' }, { reps: '5' }] } });
  const today = setModifierSelection({ reps: '5', weight: '' }, band, 'red');
  const ladder = recommendSetCount(history, bench, bench.sets, { referenceDate: '2026-11-05', setup: today });
  expect(ladder.mode).not.toBe('seed');
  expect(recommendSet(history, bench, 'C', 0, null, ladder, today).weight).toBe('20');
  // The unassisted setup never borrows the banded load.
  expect(recommendSet(history, bench, 'C', 0, null, plan(history)).weight).toBe('');
});

test('changing a modifier\'s value keeps its rep and side scope', () => {
  const bands = QUICK_MODIFIERS.find(m => m.control === 'bands');
  const red = setModifierSelection(set, bands, ['red']);
  red.modifiers[bands.id].repCount = 2;
  red.modifiers[bands.id].side = 'L';
  const both = setModifierSelection(red, bands, ['red', 'blue']);
  expect(both.modifiers[bands.id]).toMatchObject({ value: 'red+blue', repCount: 2, side: 'L' });
});

test('modified sets remain volume but cannot inflate the unmodified estimated maximum', () => {
  const { sessionExerciseEst1RM, sessionExerciseVolume } = require('../workout-volume.js');
  const assisted = setModifierSelection({...set,weight:'225'},QUICK_MODIFIERS[0],'on');
  expect(sessionExerciseEst1RM([assisted],0,bench)).toBe(0);
  expect(sessionExerciseVolume([assisted],0,bench)).toBeGreaterThan(0);
});

test('saving a four-set template cannot turn strength progression into a four-to-five-set ladder', () => {
  const savedBench = {...bench,sets:4,templateSets:Array.from({length:4},()=>({reps:'5'}))};
  const history = log(Array.from({length:4},()=>({...set})));
  const next = recommendSetCount(history,savedBench,savedBench.sets,{referenceDate:'2026-11-05'});
  expect(next).toMatchObject({sets:3,mode:'step_load'});
  expect(recommendSet(history,savedBench,'C',0,null,next).weight).toBe('160');
});

test('a completed assisted template cannot advance the unmodified ladder; its own ladder still progresses', () => {
  const rawSets = Array.from({length:3},()=>({...set}));
  const assisted = setModifierSelection({...set,weight:'225'},QUICK_MODIFIERS[0],'on');
  const assistedSets = Array.from({length:4},()=>({...assisted}));
  const history = [
    ...log(rawSets,{prescription:{sets:rawSets}}),
    {date:'2026-11-02',workout:'C',exercises:{benchPress:{sets:assistedSets,prescription:{sets:assistedSets}}}},
  ];
  const rawPlan = plan(history);
  expect(rawPlan).toMatchObject({mode:'accumulate',sets:4});
  expect(recommendSet(history,bench,'C',0,null,rawPlan).weight).toBe('155');
  const assistedBench = {...bench,templateSets:assistedSets};
  const assistedPlan = recommendSetCount(history,assistedBench,3,{referenceDate:'2026-11-05'});
  expect(assistedPlan).toMatchObject({mode:'step_load',sets:3});
  expect(recommendSet(history,assistedBench,'C',0,null,assistedPlan).weight).toBe('230');
});

test('a ladder-added assisted set inherits the final template setup and its load history', () => {
  const rawSets = Array.from({length:3},()=>({...set}));
  const assisted = setModifierSelection({...set,weight:'225'},QUICK_MODIFIERS[0],'on');
  const assistedSets = Array.from({length:3},()=>({...assisted}));
  const history = [...log(rawSets,{prescription:{sets:rawSets}}),
    {date:'2026-11-02',workout:'C',exercises:{benchPress:{sets:assistedSets,prescription:{sets:assistedSets}}}}];
  const assistedBench = {...bench,templateSets:assistedSets};
  const next = recommendSetCount(history,assistedBench,3,{referenceDate:'2026-11-05'});
  expect(next).toMatchObject({mode:'accumulate',sets:4});
  expect(Array.from({length:4},(_,index)=>recommendSet(history,assistedBench,'C',index,null,next).weight))
    .toEqual(['225','225','225','225']);
});

// An extra set added and left undone is not another setup; it must not
// block an otherwise complete session from progressing.
test('an undone extra set does not mark a modifier-filtered session incomplete', () => {
  const { filterHistoryForModifierSetup } = require('../workoutModifiers.js');
  const band = { id: 'modifier_band_red', name: 'Band', kind: 'assistance', control: 'standard', options: [{ id: 'red', label: 'Red' }] };
  const banded = setModifierSelection({ ...set, weight: '20' }, band, 'red');
  const history = log([banded, banded, banded, { ...banded, done: false, reps: '', weight: '' }]);
  const filtered = filterHistoryForModifierSetup(history, 'benchPress', banded);
  expect(filtered[0].exercises.benchPress.modifierHistoryIncomplete).toBe(false);
  const mixed = filterHistoryForModifierSetup(log([banded, banded, { ...set }]), 'benchPress', banded);
  expect(mixed[0].exercises.benchPress.modifierHistoryIncomplete).toBe(true);
  expect(recommendSetCount(filtered, bench, bench.sets, { referenceDate: '2026-11-05', setup: banded }).mode)
    .toBe(recommendSetCount(log([banded, banded, banded]), bench, bench.sets, { referenceDate: '2026-11-05', setup: banded }).mode);
});
