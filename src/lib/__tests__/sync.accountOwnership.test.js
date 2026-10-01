import { supabase } from '../supabase.js';
import { pushRep, pushWorkoutSession, pushActivity, pushDailyState, pushUserSettings,
  pushUserSettingsPatch, enqueueReps, flushQueue, LS_QUEUE_KEY, enqueueRepUpdate,
  flushUpdateQueue, LS_UPDATE_QUEUE_KEY } from '../sync.js';
import { __setNsUidForTests, setLastUserRaw, saveLS, loadLS } from '../storage.js';

jest.mock('../supabase.js', () => ({ supabase: {
  auth: { getUser: jest.fn() }, from: jest.fn(), rpc: jest.fn(),
} }));
const rep = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', session_id: 'session-a',
  grip: 'Micro', hand: 'L', set_num: 1, rep_num: 1 };
let authenticatedId, queries, execute;
beforeEach(() => {
  jest.clearAllMocks(); localStorage.clear();
  __setNsUidForTests('a'); setLastUserRaw('a'); authenticatedId = 'a'; queries = [];
  execute = () => ({ data: [], error: null });
  supabase.auth.getUser.mockImplementation(async () => ({ data: { user: authenticatedId ? { id: authenticatedId } : null } }));
  supabase.rpc.mockResolvedValue({ error: null });
  supabase.from.mockImplementation(table => {
    const q = { table, filters: [] };
    q.upsert = rows => { q.rows = rows; return q; };
    q.select = () => q;
    q.update = patch => { q.patch = patch; return q; };
    q.eq = (key, value) => { q.filters.push([key, value]); return q; };
    q.then = (resolve, reject) => Promise.resolve(execute(q)).then(resolve, reject);
    queries.push(q); return q;
  });
});
afterEach(() => __setNsUidForTests(null));
const operations = [
  ['rep', () => pushRep(rep), 'error'],
  ['workout', () => pushWorkoutSession({ id: 'work-a' }), false],
  ['climb', () => pushActivity({ id: 'climb-a' }), false],
  ['rating', () => pushDailyState('2026-10-01', 3), false],
  ['settings', () => pushUserSettings({ theme: 'dark' }), false],
  ['settings patch', () => pushUserSettingsPatch({ theme: 'dark' }), false],
];
test.each(operations)('%s never relabels old-account work', async (_name, run, failure) => {
  authenticatedId = 'b';
  expect(await run()).toBe(failure);
  expect(supabase.from).not.toHaveBeenCalled(); expect(supabase.rpc).not.toHaveBeenCalled();
});
test.each(operations)('%s stops an account switch during auth lookup', async (_name, run, failure) => {
  supabase.auth.getUser.mockImplementationOnce(async () => {
    setLastUserRaw('b'); return { data: { user: { id: 'a' } } };
  });
  expect(await run()).toBe(failure);
  expect(supabase.from).not.toHaveBeenCalled(); expect(supabase.rpc).not.toHaveBeenCalled();
});
test('matching account uploads the original rep owner', async () => {
  expect(await pushRep(rep)).toBe('ok');
  expect(queries[0].rows[0]).toMatchObject({ id: rep.id, user_id: 'a' });
});
test('queue survives a switch while tombstones are being fetched', async () => {
  enqueueReps([rep]);
  execute = q => { if (q.table === 'rep_tombstones') setLastUserRaw('b'); return { data: [], error: null }; };
  expect(await flushQueue()).toBe(0);
  expect(loadLS(LS_QUEUE_KEY)).toEqual([rep]);
  expect(queries.some(q => q.table === 'reps')).toBe(false);
});
test('queued edit is bound to owner and newer same-row edits survive completion', async () => {
  enqueueRepUpdate({ kind: 'rep', id: rep.id, updates: { actual_time_s: 30 } });
  execute = () => {
    enqueueRepUpdate({ kind: 'rep', id: rep.id, updates: { actual_time_s: 31 } });
    return { error: null };
  };
  expect(await flushUpdateQueue()).toBe(1);
  expect(queries[0].filters).toContainEqual(['user_id', 'a']);
  expect(loadLS(LS_UPDATE_QUEUE_KEY)[0].updates.actual_time_s).toBe(31);
});
test('queued edits stay local on authentication mismatch', async () => {
  saveLS(LS_UPDATE_QUEUE_KEY, [{ kind: 'rep', id: rep.id, updates: { actual_time_s: 30 } }]);
  authenticatedId = 'b';
  expect(await flushUpdateQueue()).toBe(0);
  expect(loadLS(LS_UPDATE_QUEUE_KEY)).toHaveLength(1);
  expect(queries).toEqual([]);
});
