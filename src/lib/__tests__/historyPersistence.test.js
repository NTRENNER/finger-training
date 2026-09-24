import { persistHistory, boundResearchCache } from '../historyPersistence.js';
import { saveLS } from '../storage.js';
jest.mock('../storage.js', () => ({LS_HISTORY_KEY:'history',saveLS:jest.fn()}));
const row = (id, date, session=id) => ({id, date, session_id:session, actual_time_s:30,
  force_recording:{basis:'target_acquired',capacity_eligible:true,prediction_check:{models:'x'.repeat(500)}}});
beforeEach(()=>saveLS.mockReset());
test('bounds research by complete sessions while preserving every workout and its evidence',()=>{
  const rows=[row('old','2026-09-01'),row('new1','2026-09-24','new'),row('new2','2026-09-24','new')];
  const result=boundResearchCache(rows,2500);
  expect(result.map(r=>r.id)).toEqual(rows.map(r=>r.id));
  expect(result[0].force_recording.prediction_check).toBeUndefined();
  expect(result.slice(1).every(r=>r.force_recording.prediction_check)).toBe(true);
  expect(rows[0].force_recording.prediction_check).toBeDefined();
  result.forEach(r=>expect(r.force_recording.capacity_eligible).toBe(true));
});
test('quota retry discards only optional research, never workout data',()=>{
  saveLS.mockReturnValueOnce(false).mockReturnValueOnce(true);
  const rows=[row('new','2026-09-24')];
  expect(persistHistory(rows).status).toBe('research_trimmed');
  expect(saveLS.mock.calls[1][1]).toEqual([{...rows[0],force_recording:{basis:'target_acquired',capacity_eligible:true}}]);
});
test('failure of essential persistence is exposed and can be retried',()=>{
  saveLS.mockReturnValue(false);
  const rows=[row('new','2026-09-24')];
  expect(persistHistory(rows).status).toBe('failed');
  saveLS.mockReturnValue(true);
  expect(persistHistory(rows).status).toBe('saved');
});
