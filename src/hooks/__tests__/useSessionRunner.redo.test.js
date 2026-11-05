import { act, renderHook } from '@testing-library/react';
import { useSessionRunner } from '../useSessionRunner.js';
jest.mock('../../lib/sync.js',()=>({pushDailyState:jest.fn()}));
function setup(grip='Prime',hand='L',connected=true) {
  const history=[];
  const addReps=jest.fn(rows=>history.push(...rows));
  const updateRep=jest.fn((rep,updates)=>{
    const index=history.findIndex(row=>row.id===rep.id);
    history[index]={...history[index],...updates};
    return Promise.resolve();
  });
  const view=renderHook(()=>useSessionRunner({history,addReps,updateRep,tindeqConnected:connected}));
  act(()=>view.result.current.startSession({grip,hand,targetTime:160,repsPerSet:4,restTime:20,plannedLoadByHand:{L:2.8,R:2.7}}));
  return {...view,history,addReps,updateRep};
}
const pull = (time=45,extra={})=>({actualTime:time,avgForce:2.8,peakForce:3.2,failureValid:true,
  forceRecording:{capacity_eligible:true,recording_stop_reason:'release',activity:{duration_s:time,impulse_kg_s:time*2.8,started_at_ms:1000,ended_at_ms:1000+time*1000}},...extra});

test.each(['Prime','Crusher','Micro'])('%s saves and advances normally; explicit redo replaces the same slot and retains disputed work',grip=>{
  const {result,history,addReps,updateRep}=setup(grip);
  for(let i=0;i<2;i++){
    act(()=>result.current.handleRepDone(pull()));
    expect(result.current.phase).toBe('resting');
    act(()=>result.current.handleRestDone());
  }
  act(()=>result.current.handleRepDone(pull(1.3,{manualLoadKg:3,forceRecording:{capacity_eligible:true,recording_stop_reason:'release_not_observed',activity:{duration_s:20.9,impulse_kg_s:55.9,started_at_ms:1000,ended_at_ms:null}}})));
  const original=history.at(-1);
  expect(result.current.phase).toBe('resting');
  expect(result.current.currentRep).toBe(3);
  expect(result.current.canRedoLastRep).toBe(true);
  act(()=>{expect(result.current.handleRedoLastRep()).toBe(true);expect(result.current.handleRedoLastRep()).toBe(false);});
  expect(result.current.phase).toBe('rep_ready');
  expect(result.current.currentRep).toBe(2);
  expect(result.current.retryTargetKg).toBe(3);
  expect(result.current.canRedoLastRep).toBe(false);
  expect(history.at(-1)).toMatchObject({id:original.id,failure_valid:false,force_recording:{redo_pending:true,capacity_eligible:false}});
  act(()=>result.current.handleRepDone(pull()));
  expect(history).toHaveLength(3);
  expect(addReps).toHaveBeenCalledTimes(3);
  expect(updateRep).toHaveBeenCalledTimes(2);
  expect(history.at(-1)).toMatchObject({id:original.id,hand:'L',rep_num:3,actual_time_s:45,force_recording:{recovery_eligible:false,redo_attempts:[expect.objectContaining({actualTime:1.3})],activity:{duration_s:65.9}}});
  act(()=>result.current.handleRestDone());
  act(()=>result.current.handleRepDone(pull()));
  expect(result.current.phase).toBe('done');
  expect(history).toHaveLength(4);
});

test('redo is available at hand switch and final completion, without a duplicate final rep',()=>{
  const {result,history}=setup('Prime','Both');
  for(let i=0;i<4;i++){
    act(()=>result.current.handleRepDone(pull()));
    if(i<3)act(()=>result.current.handleRestDone());
  }
  expect(result.current.phase).toBe('switch_hands');
  act(()=>result.current.handleRedoLastRep());
  expect(result.current.activeHand).toBe('L');
  expect(result.current.currentRep).toBe(3);
  act(()=>result.current.handleRepDone(pull()));
  expect(result.current.phase).toBe('switch_hands');
  act(()=>result.current.handleSwitchHandsReady());
  for(let i=0;i<4;i++){
    act(()=>result.current.handleRepDone(pull()));
    if(i<3)act(()=>result.current.handleRestDone());
  }
  expect(result.current.phase).toBe('done');
  act(()=>result.current.handleRedoLastRep());
  expect(result.current.activeHand).toBe('R');
  act(()=>result.current.handleRepDone(pull()));
  expect(result.current.phase).toBe('done');
  expect(history).toHaveLength(8);
  expect(new Set(history.map(rep=>rep.id)).size).toBe(8);
});

test('redoing an opener and abandoning it cannot leave a false capacity point',()=>{
  const {result,history}=setup();
  act(()=>result.current.handleRepDone(pull()));
  act(()=>result.current.handleRedoLastRep());
  expect(history[0].failure_valid).toBe(false);
  act(()=>result.current.handleRepDone(pull()));
  expect(history[0].force_recording.capacity_eligible).toBe(false);
  expect(history[0].force_recording.redo_attempts).toHaveLength(1);
});

test('a redo left pending when the session ends never claims the next set\'s first rep', () => {
  const {result,history,addReps,updateRep}=setup();
  act(()=>result.current.handleRepDone(pull()));
  act(()=>result.current.handleRestDone());
  act(()=>result.current.handleRepDone(pull()));
  const disputed=history.at(-1);
  act(()=>{result.current.handleRedoLastRep();});
  act(()=>result.current.handleAbort());
  expect(result.current.phase).toBe('done');
  expect(result.current.retryTargetKg).toBeNull();
  act(()=>result.current.handleNextSet());
  act(()=>result.current.handleRepDone(pull(50)));
  const added=addReps.mock.calls.at(-1)[0][0];
  expect(added).toMatchObject({set_num:2,rep_num:1,actual_time_s:50});
  expect(added.id).not.toBe(disputed.id);
  expect(updateRep).toHaveBeenCalledTimes(1);   // only the disputed mark
  expect(history.find(r=>r.id===disputed.id)).toMatchObject({set_num:1,rep_num:2,failure_valid:false});
});

test('a retry is timed from its own attempt, not the disputed one', () => {
  const {result,history}=setup('Prime','L',false);
  act(()=>result.current.handleRepDone(pull(45,{startedAtMs:1000,endedAtMs:46000})));
  act(()=>result.current.handleRestDone());
  act(()=>result.current.handleRepDone(pull(1.3,{startedAtMs:66000,endedAtMs:67300,
    forceRecording:{capacity_eligible:true,recording_stop_reason:'release_not_observed',activity:{duration_s:20.9,impulse_kg_s:55.9,started_at_ms:66000,ended_at_ms:null}}})));
  act(()=>{result.current.handleRedoLastRep();});
  // Manual retry: no force recording of its own.
  act(()=>result.current.handleRepDone(pull(40,{startedAtMs:130000,endedAtMs:170000,forceRecording:null})));
  const retry=history.at(-1);
  expect(retry.rep_timing).toMatchObject({started_at_ms:130000,source:'manual_tap',rest_before_s:84});
  expect(retry.force_recording.redo_attempts).toHaveLength(1);
});
