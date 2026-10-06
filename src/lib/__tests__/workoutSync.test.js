import { loadLS, saveLS, __setNsUidForTests, setLastUserRaw,
  LS_WORKOUT_LOG_KEY as LOG, LS_WORKOUT_SYNCED_KEY as SYNCED,
  LS_WORKOUT_DELETED_KEY as DELETED } from '../storage.js';
import { markWorkoutPending, syncWorkoutSessions } from '../workoutSync.js';
import { pushWorkoutSession, fetchWorkoutSessions, fetchWorkoutSessionTombstoneIds } from '../sync.js';

jest.mock('../sync.js', () => ({
  ownsLocalSession: owner => {
    const storage = jest.requireActual('../storage.js');
    return owner && storage.getStorageUserId() === owner && storage.readRawLastUser() === owner;
  },
  pushWorkoutSession: jest.fn(), fetchWorkoutSessions: jest.fn(),
  fetchWorkoutSessionTombstoneIds: jest.fn(),
}));
const session = (weight = 0) => ({ id: 'workout-1', date: '2026-10-05', workout: 'A', exercises: { weightedPullup: { sets: [{ weight }] } } });
const pending = () => new Promise(resolve => { resolve(); });
beforeEach(() => {
  localStorage.clear(); __setNsUidForTests('a'); setLastUserRaw('a');
  jest.clearAllMocks();
  fetchWorkoutSessions.mockResolvedValue([]);
  fetchWorkoutSessionTombstoneIds.mockResolvedValue([]);
  pushWorkoutSession.mockResolvedValue(true);
});
afterEach(() => __setNsUidForTests(null));

test('refreshes existing clean sessions with corrections from another device', async () => {
  saveLS(LOG, [session()]); saveLS(SYNCED, ['workout-1']);
  fetchWorkoutSessions.mockResolvedValue([session(50)]);
  await syncWorkoutSessions();
  expect(loadLS(LOG)).toEqual([session(50)]);
  expect(pushWorkoutSession).not.toHaveBeenCalled();
});

test('failed edits of already-synced sessions remain pending and retry', async () => {
  saveLS(LOG, [session(50)]); saveLS(SYNCED, ['workout-1']);
  markWorkoutPending('workout-1');
  fetchWorkoutSessions.mockResolvedValue([session()]);
  pushWorkoutSession.mockResolvedValueOnce(false);
  expect(await syncWorkoutSessions()).toBe(false);
  expect(loadLS(LOG)).toEqual([session(50)]);
  expect(loadLS(SYNCED)).toEqual([]);
  expect(await syncWorkoutSessions()).toBe(true);
  expect(pushWorkoutSession).toHaveBeenLastCalledWith(session(50));
  expect(loadLS(SYNCED)).toEqual(['workout-1']);
});

test('an edit during download wins over the old cloud response', async () => {
  saveLS(LOG, [session()]); saveLS(SYNCED, ['workout-1']);
  let finish;
  fetchWorkoutSessions.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const job = syncWorkoutSessions(); await pending(); await pending();
  saveLS(LOG, [session(55)]); markWorkoutPending('workout-1');
  finish([session(50)]); await job;
  expect(loadLS(LOG)).toEqual([session(55)]);
  expect(pushWorkoutSession).toHaveBeenCalledWith(session(55));
});

test('an older upload cannot acknowledge a newer edit; concurrent pass sends latest', async () => {
  saveLS(LOG, [session(50)]);
  let finish; let started;
  const uploading = new Promise(resolve => { started = resolve; });
  pushWorkoutSession.mockImplementationOnce(() => { started(); return new Promise(resolve => { finish = resolve; }); });
  const first = syncWorkoutSessions(); await uploading;
  saveLS(LOG, [session(55)]); markWorkoutPending('workout-1');
  const second = syncWorkoutSessions();
  finish(true); await first; await second;
  expect(pushWorkoutSession.mock.calls.map(([s]) => s)).toEqual([session(50), session(55)]);
  expect(loadLS(LOG)).toEqual([session(55)]);
  expect(loadLS(SYNCED)).toEqual(['workout-1']);
});

test('cloud deletions scrub local copies and never upload them again', async () => {
  saveLS(LOG, [session()]);
  fetchWorkoutSessionTombstoneIds.mockResolvedValue(['workout-1']);
  await syncWorkoutSessions();
  expect(loadLS(LOG)).toEqual([]); expect(loadLS(DELETED)).toEqual(['workout-1']);
  expect(pushWorkoutSession).not.toHaveBeenCalled();
});

test('unknown deletion state defers uploads without losing local edits', async () => {
  saveLS(LOG, [session(50)]);
  fetchWorkoutSessionTombstoneIds.mockResolvedValue(null);
  expect(await syncWorkoutSessions()).toBe(false);
  expect(loadLS(LOG)).toEqual([session(50)]);
  expect(pushWorkoutSession).not.toHaveBeenCalled();
});

test('a newly downloaded session is marked synced', async () => {
  fetchWorkoutSessions.mockResolvedValue([session(50)]);
  await syncWorkoutSessions();
  expect(loadLS(LOG)).toEqual([session(50)]);
  expect(loadLS(SYNCED)).toEqual(['workout-1']);
  expect(pushWorkoutSession).not.toHaveBeenCalled();
});

test('account switch during fetch cannot save the response into another account', async () => {
  let finish;
  fetchWorkoutSessions.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const job = syncWorkoutSessions(); await pending(); await pending();
  __setNsUidForTests('b'); setLastUserRaw('b'); saveLS(LOG, [{ id: 'b-workout' }]);
  finish([session(50)]);
  expect(await job).toBe(false);
  expect(loadLS(LOG)).toEqual([{ id: 'b-workout' }]);
});

test('account switch during upload cannot acknowledge it for the next user', async () => {
  saveLS(LOG, [session(50)]);
  let finish; let started;
  const uploading = new Promise(resolve => { started = resolve; });
  pushWorkoutSession.mockImplementationOnce(() => { started(); return new Promise(resolve => { finish = resolve; }); });
  const job = syncWorkoutSessions(); await uploading;
  __setNsUidForTests('b'); setLastUserRaw('b'); saveLS(SYNCED, ['b-workout']);
  finish(true); expect(await job).toBe(false);
  expect(loadLS(SYNCED)).toEqual(['b-workout']);
});

test('preserves an edit when its upload finishes during the download', async () => {
  saveLS(LOG, [session()]); saveLS(SYNCED, ['workout-1']);
  let finish;
  fetchWorkoutSessions.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const job = syncWorkoutSessions(); await pending(); await pending();
  saveLS(LOG, [session(55)]); saveLS(SYNCED, ['workout-1']);
  finish([session(50)]); await job;
  expect(loadLS(LOG)).toEqual([session(55)]);
});

test('legacy workouts get durable IDs before being uploaded', async () => {
  saveLS(LOG, [{ ...session(50), id: undefined }]);
  await syncWorkoutSessions();
  const [saved] = loadLS(LOG);
  expect(saved.id).toBeTruthy();
  expect(pushWorkoutSession).toHaveBeenCalledWith(saved);
  expect(loadLS(SYNCED)).toContain(saved.id);
});

test('a failed download leaves both history and acknowledgement state untouched', async () => {
  saveLS(LOG, [session(50)]); saveLS(SYNCED, ['workout-1']);
  fetchWorkoutSessions.mockResolvedValue(null);
  expect(await syncWorkoutSessions()).toBe(false);
  expect(loadLS(LOG)).toEqual([session(50)]);
  expect(loadLS(SYNCED)).toEqual(['workout-1']);
});

test('an unexpected network rejection leaves pending data intact and permits another attempt', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  saveLS(LOG, [session(50)]);
  fetchWorkoutSessions.mockRejectedValueOnce(new Error('connection dropped'));
  expect(await syncWorkoutSessions()).toBe(false);
  expect(loadLS(LOG)).toEqual([session(50)]);
  expect(await syncWorkoutSessions()).toBe(true);
  expect(loadLS(SYNCED)).toContain('workout-1');
  warn.mockRestore();
});
