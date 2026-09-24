import { act, renderHook } from '@testing-library/react';
import { useRepHistory } from '../useRepHistory.js';
import { saveLS, loadLS, LS_HISTORY_KEY } from '../../lib/storage.js';

beforeEach(()=>localStorage.clear());
afterEach(()=>jest.restoreAllMocks());
test('failed history write is visible, data stays in memory, and retry persists it',async()=>{
  const row={id:'r',session_id:'s',date:'2026-09-24',grip:'Micro',hand:'L',set_num:1,rep_num:1,actual_time_s:30,avg_force_kg:10};
  saveLS(LS_HISTORY_KEY,[row]);
  const {result}=renderHook(()=>useRepHistory({user:null}));
  jest.spyOn(console,'error').mockImplementation(()=>{});
  const writes=jest.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new DOMException('full','QuotaExceededError');});
  await act(async()=>result.current.replaceHistory([{...row,actual_time_s:40}]));
  expect(result.current.persistenceStatus).toBe('failed');
  expect(result.current.history[0].actual_time_s).toBe(40);
  writes.mockRestore();
  act(()=>result.current.retryPersistence());
  expect(result.current.persistenceStatus).toBe('saved');
  expect(loadLS(LS_HISTORY_KEY)[0].actual_time_s).toBe(40);
});
