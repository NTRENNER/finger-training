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
