import {renderHook,act} from '@testing-library/react';
import {useSessionRunner} from '../useSessionRunner.js';
const cfg={grip:'Micro',hand:'L',targetTime:40,repsPerSet:4,restTime:20};
function setup(connected=true) {
 const addReps=jest.fn();
 const hook=renderHook(()=>useSessionRunner({history:[],addReps,tindeqConnected:connected}));
 act(()=>hook.result.current.startSession(cfg));
 return {hook,addReps};
}
test('actual rest includes delayed starts, with prescribed rest preserved separately',()=>{
 const {hook,addReps}=setup();
 act(()=>hook.result.current.handleRepDone({actualTime:10,avgForce:25,startedAtMs:1000,endedAtMs:11000}));
 act(()=>hook.result.current.handleRestDone());
 act(()=>hook.result.current.handleRepDone({actualTime:8,avgForce:25,startedAtMs:46000,endedAtMs:54000}));
 expect(addReps.mock.calls[0][0][0].rep_timing.rest_before_s).toBeNull();
 expect(addReps.mock.calls[1][0][0]).toMatchObject({rest_s:20,rep_timing:{rest_before_s:35},load_provenance:'measured_force'});
});
test('manual failure offset also corrects the previous end used to measure rest',()=>{
 const {hook,addReps}=setup(false);
 act(()=>hook.result.current.chooseOffset(true));
 act(()=>hook.result.current.handleRepDone({actualTime:12,startedAtMs:1000,endedAtMs:13000,manualLoadKg:20}));
 act(()=>hook.result.current.handleRestDone());
 act(()=>hook.result.current.handleRepDone({actualTime:10,startedAtMs:33000,endedAtMs:43000,manualLoadKg:20}));
 expect(addReps.mock.calls[1][0][0].rep_timing.rest_before_s).toBe(22);
 expect(addReps.mock.calls[1][0][0].load_provenance).toBe('nominal_setting');
});
test('missing timestamps are unknown, never filled with the prescribed rest',()=>{
 const {hook,addReps}=setup();
 act(()=>hook.result.current.handleRepDone({actualTime:10,avgForce:25}));
 expect(addReps.mock.calls[0][0][0].rep_timing).toMatchObject({source:'unknown',rest_before_s:null});
});
test('credited loss onset never turns the weaker activity tail into rest',()=>{
 const {hook,addReps}=setup();
 act(()=>hook.result.current.handleRepDone({actualTime:10,avgForce:25,startedAtMs:1000,endedAtMs:11000,
   forceRecording:{version:4,credited_end_at_ms:11000,activity:{started_at_ms:1000,ended_at_ms:18000,duration_s:17}}}));
 act(()=>hook.result.current.handleRestDone());
 act(()=>hook.result.current.handleRepDone({actualTime:8,avgForce:25,startedAtMs:38000,endedAtMs:46000}));
 expect(addReps.mock.calls[0][0][0].rep_timing.ended_at_ms).toBe(18000);
 expect(addReps.mock.calls[0][0][0].actual_time_s).toBe(10);
 expect(addReps.mock.calls[1][0][0].rep_timing.rest_before_s).toBe(20);
});
test('visible rest uses physical release rather than the earlier credited cutoff',()=>{
 const {hook}=setup();
 act(()=>hook.result.current.handleRepDone({actualTime:10,avgForce:25,startedAtMs:1000,endedAtMs:11000,
   forceRecording:{version:4,recording_stop_reason:'release',credited_end_at_ms:11000,
     activity:{started_at_ms:1000,ended_at_ms:18000,duration_s:17}}}));
 expect(hook.result.current.lastRepResult.restStartedAtMs).toBe(18000);
});
test.each(['manual_stop','equipment_interruption'])('a %s never backdates the visible countdown',reason=>{
 const now=Date.now();const {hook}=setup();
 act(()=>hook.result.current.handleRepDone({actualTime:10,avgForce:25,startedAtMs:1000,endedAtMs:11000,
   failureValid:false,forceRecording:{recording_stop_reason:reason,activity:{ended_at_ms:18000}}}));
 expect(hook.result.current.lastRepResult.restStartedAtMs).toBeGreaterThanOrEqual(now);
});

test('missing physical release preserves the hold but cannot fabricate subsequent rest',()=>{
 const {hook,addReps}=setup();
 act(()=>hook.result.current.handleRepDone({actualTime:10,avgForce:25,startedAtMs:1000,endedAtMs:11000,
   failureValid:true,forceRecording:{version:4,recording_stop_reason:'release_not_observed',
     activity:{ended_at_ms:null,observed_until_at_ms:30000}}}));
 act(()=>hook.result.current.handleRestDone());
 act(()=>hook.result.current.handleRepDone({actualTime:8,avgForce:25,startedAtMs:60000,endedAtMs:68000}));
 expect(addReps.mock.calls[0][0][0]).toMatchObject({actual_time_s:10,failure_valid:true,rep_timing:{ended_at_ms:null}});
 expect(addReps.mock.calls[1][0][0].rep_timing.rest_before_s).toBeNull();
});
