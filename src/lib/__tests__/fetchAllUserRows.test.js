import { fetchAllUserRows } from '../fetchAllUserRows.js';
import { fetchReps, fetchWorkoutSessions } from '../sync.js';
import { __setNsUidForTests, setLastUserRaw } from '../storage.js';
const mockPages = jest.fn();
const mockQueries = [];
let mockRows = [];
jest.mock('../supabase.js', () => ({ supabase: { from: table => {
  const state = { table, after: '', size: 500 };
  const query = {
    select: jest.fn(() => query),
    eq: jest.fn((column, owner) => { state.column = column; state.owner = owner; return query; }),
    order: jest.fn((column, options) => { state.order = [column, options]; return query; }),
    limit: jest.fn(size => { state.size = size; return query; }),
    gt: jest.fn((column, after) => { state.after = after; return query; }),
    then: (resolve, reject) => { mockQueries.push({ ...state }); return mockPages(state).then(resolve, reject); },
  };
  return query;
} } }));

beforeEach(() => {
  localStorage.clear(); __setNsUidForTests('owner'); setLastUserRaw('owner');
  mockQueries.length = 0;
  mockRows = Array.from({ length: 1007 }, (_, i) => ({ id: String(i).padStart(5, '0'), date: '2026-04-20' }));
  mockPages.mockReset().mockImplementation(({ after, size }) => Promise.resolve({
    data: mockRows.filter(row => row.id > after).slice(0, size), error: null,
  }));
});
afterEach(() => __setNsUidForTests(null));

test.each(['reps', 'workout_sessions'])('downloads all 1,007 %s, with deterministic owner-scoped pages', async table => {
  expect(await fetchAllUserRows(table)).toEqual(mockRows);
  expect(mockQueries.map(q => q.after)).toEqual(['', '00499', '00999', '01006']);
  expect(mockQueries.every(q => q.owner === 'owner' && q.column === 'user_id')).toBe(true);
  expect(mockQueries.every(q => q.order[0] === 'id' && q.order[1].ascending)).toBe(true);
});

test('the real rep fetch and workout fetch retain the seven oldest rows', async () => {
  expect(await fetchReps()).toHaveLength(1007);
  expect(await fetchWorkoutSessions()).toHaveLength(1007);
});

test('continues when a server page is smaller than requested', async () => {
  mockPages.mockImplementation(({ after }) => Promise.resolve({ data: mockRows.filter(row => row.id > after).slice(0, 100) }));
  expect(await fetchAllUserRows('reps')).toHaveLength(1007);
});

test('page failure returns no partial history', async () => {
  mockPages.mockResolvedValueOnce({ data: mockRows.slice(0, 500) }).mockResolvedValueOnce({ error: { message: 'offline' } });
  expect(await fetchReps()).toBeNull();
});

test('account switch discards the partial download', async () => {
  mockPages.mockImplementationOnce(() => {
    setLastUserRaw('other');
    return Promise.resolve({ data: mockRows.slice(0, 500) });
  });
  expect(await fetchAllUserRows('reps')).toBeNull();
  expect(mockPages).toHaveBeenCalledTimes(1);
});

test('a non-advancing page fails safely rather than looping', async () => {
  mockPages.mockResolvedValue({ data: mockRows.slice(0, 500) });
  expect(await fetchAllUserRows('reps')).toBeNull();
  expect(mockPages).toHaveBeenCalledTimes(2);
});
