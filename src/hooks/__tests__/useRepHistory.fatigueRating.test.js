import {renderHook, act} from '@testing-library/react';
import {useRepHistory} from '../useRepHistory.js';
import {saveLS, loadLS, LS_HISTORY_KEY} from '../../lib/storage.js';
import {LS_UPDATE_QUEUE_KEY, applyPendingUpdates} from '../../lib/sync.js';
import {recordedAdjustment, sessionAdjustment} from '../../model/cookedScaling.js';
import {computeDensityLadder} from '../../model/densityLadder.js';

beforeEach(() => localStorage.clear());
test.each([
  ['legacy unrated', null, null, 1],
  ['legacy adjusted', 8, null, 0.8],
  ['keep load', 8, sessionAdjustment(8, false), 1],
  ['adjust load', 8, sessionAdjustment(8, true), 0.8],
])('%s: editing, clearing and replaying a rating preserve capacity and the next ladder load', async (_, cooked, adjustment, multiplier) => {
  const rows=[70,35,25,22,20].map((t,i)=>({
    id:`r${i}`,session_id:'s1',date:'2026-09-20',grip:'Micro',hand:'L',set_num:1,rep_num:i+1,
    actual_time_s:t,target_duration:70,avg_force_kg:11,session_cooked:cooked,session_adjustment:adjustment,
  }));
  saveLS(LS_HISTORY_KEY,rows);
  const {result}=renderHook(()=>useRepHistory({user:null}));
  const before=computeDensityLadder(result.current.history,'Micro','power_strength');
  expect(before.loadByHand.L).toBe(Math.round(11 / multiplier * 10) / 10);
  const freshBefore=[...result.current.freshMap.values()].map(r=>r.fresh);
  for(const rating of [10,3,null]) {
    await act(async()=>result.current.updateSessionCooked('s1',rating));
    expect(result.current.history.every(r=>r.session_cooked===rating)).toBe(true);
    expect([...result.current.freshMap.values()].map(r=>r.fresh)).toEqual(freshBefore);
    expect(computeDensityLadder(result.current.history,'Micro','power_strength')).toEqual(before);
    for(const r of result.current.history) expect(recordedAdjustment(r).multiplier).toBe(multiplier);
    const queue=loadLS(LS_UPDATE_QUEUE_KEY);
    expect(queue).toHaveLength(5);
    expect(queue.every(e=>e.updates.session_adjustment && e.updates.session_cooked===rating)).toBe(true);
    expect(applyPendingUpdates(rows)).toEqual(result.current.history);
  }
});
