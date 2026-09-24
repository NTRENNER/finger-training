import { act, renderHook } from '@testing-library/react';
import { usePreparedPredictions } from '../usePreparedPredictions.js';
import { createPredictionWorker } from '../../model/predictionWorkerClient.js';
jest.mock('../../model/predictionWorkerClient.js',()=>({createPredictionWorker:jest.fn()}));
const cfg={grip:'Micro',targetTime:70};
let workers;
beforeEach(()=>{
  jest.useFakeTimers().setSystemTime(new Date(2026,8,24,12)); global.Worker=jest.fn(); workers=[];
  createPredictionWorker.mockImplementation(()=>{const w={terminate:jest.fn(),postMessage:jest.fn()};workers.push(w);return w;});
});
afterEach(()=>{jest.useRealTimers();delete global.Worker;});
test('starts without research when pending; ignores stale completion and freezes worker input',async()=>{
  const history=[{id:'one',date:'2026-09-01'}];
  const {result,rerender,unmount}=renderHook(({h,config=cfg,enabled=true})=>usePreparedPredictions(h,config,enabled),{initialProps:{h:history}});
  await act(async()=>{});
  expect(result.current(cfg,'2026-09-24')).toEqual({});
  history[0].date='2026-09-02';
  expect(workers[0].postMessage.mock.calls[0][0].history[0].date).toBe('2026-09-01');
  const h2=[...history,{id:'two',date:'2026-09-03'}];
  await act(async()=>rerender({h:h2}));
  act(()=>workers[0].onmessage({data:{models:{L:'stale'}}}));
  expect(result.current(cfg,'2026-09-24')).toEqual({});
  act(()=>workers[1].onmessage({data:{models:{L:'fresh'}}}));
  expect(result.current(cfg,'2026-09-24')).toEqual({L:'fresh'});
  expect(result.current({...cfg,targetTime:30},'2026-09-24')).toEqual({});
  expect(result.current(cfg,'2026-09-25')).toEqual({});
  unmount();expect(workers[1].terminate).toHaveBeenCalled();
});
test('worker errors cannot block training or trigger a synchronous fallback',async()=>{
  const {result}=renderHook(()=>usePreparedPredictions([],cfg,true));
  await act(async()=>{});
  act(()=>workers[0].onerror());
  expect(result.current(cfg,'2026-09-24')).toEqual({});
  expect(workers[0].terminate).toHaveBeenCalled();
});
