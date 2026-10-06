import { uuid } from '../util.js';
import {
  loadLS, saveLS, getStorageUserId,
  LS_WORKOUT_LOG_KEY, LS_WORKOUT_SYNCED_KEY, LS_WORKOUT_DELETED_KEY,
} from './storage.js';
import {
  ownsLocalSession, pushWorkoutSession, fetchWorkoutSessions,
  fetchWorkoutSessionTombstoneIds,
} from './sync.js';

// An edit invalidates the old acknowledgement synchronously, even offline.
export function markWorkoutPending(id) {
  if (!id) return;
  saveLS(LS_WORKOUT_SYNCED_KEY, (loadLS(LS_WORKOUT_SYNCED_KEY) || []).filter(x => x !== id));
}

const snapshot = value => JSON.stringify(value);
const jobs = new Map();

// Serialize downloads and uploads for each account. A save during a download
// queues a subsequent pass; neither stale fetches nor stale upload acks win.
export function syncWorkoutSessions(owner = getStorageUserId()) {
  const previous = jobs.get(owner) || Promise.resolve();
  const job = previous.catch(() => {}).then(() => reconcile(owner)).catch(error => {
    console.warn('Workout sync:', error?.message);
    return false;
  });
  jobs.set(owner, job);
  const cleanup = () => { if (jobs.get(owner) === job) jobs.delete(owner); };
  job.then(cleanup, cleanup);
  return job;
}

async function reconcile(owner) {
  if (!ownsLocalSession(owner)) return false;
  const before = new Map((loadLS(LS_WORKOUT_LOG_KEY) || []).map(s => [s.id, snapshot(s)]));
  const [remote, cloudDeleted] = await Promise.all([
    fetchWorkoutSessions(), fetchWorkoutSessionTombstoneIds(),
  ]);
  if (!ownsLocalSession(owner)) return false;
  // Unknown cloud deletion state must never resurrect a deleted workout.
  if (!remote || !cloudDeleted) return false;
  const deleted = new Set([...(loadLS(LS_WORKOUT_DELETED_KEY) || []), ...cloudDeleted]);
  saveLS(LS_WORKOUT_DELETED_KEY, [...deleted]);
  const synced = new Set(loadLS(LS_WORKOUT_SYNCED_KEY) || []);
  const remoteById = new Map(remote.filter(s => !deleted.has(s.id)).map(s => [s.id, s]));
  const local = loadLS(LS_WORKOUT_LOG_KEY) || [];
  const merged = local.filter(s => !deleted.has(s.id)).map(s => {
    const cloud = remoteById.get(s.id);
    remoteById.delete(s.id);
    // Only replace a clean copy that has not changed while fetching.
    if (cloud && synced.has(s.id) && before.get(s.id) === snapshot(s)) return cloud;
    return s.id ? s : { ...s, id: uuid() };
  });
  for (const s of remoteById.values()) { merged.push(s); synced.add(s.id); }
  for (const id of deleted) synced.delete(id);
  if (snapshot(local) !== snapshot(merged) && !saveLS(LS_WORKOUT_LOG_KEY, merged)) return false;
  if (!saveLS(LS_WORKOUT_SYNCED_KEY, [...synced])) return false;

  let ok = true;
  for (const queued of merged) {
    if (!ownsLocalSession(owner)) return false;
    const fresh = (loadLS(LS_WORKOUT_LOG_KEY) || []).find(s => s.id === queued.id);
    const acknowledged = new Set(loadLS(LS_WORKOUT_SYNCED_KEY) || []);
    const tombs = new Set(loadLS(LS_WORKOUT_DELETED_KEY) || []);
    if (!fresh || acknowledged.has(fresh.id) || tombs.has(fresh.id)) continue;
    const sent = snapshot(fresh);
    const pushed = await pushWorkoutSession(fresh);
    if (!ownsLocalSession(owner)) return false;
    if (!pushed) { ok = false; continue; }
    const current = (loadLS(LS_WORKOUT_LOG_KEY) || []).find(s => s.id === fresh.id);
    if (snapshot(current) === sent && !(loadLS(LS_WORKOUT_DELETED_KEY) || []).includes(fresh.id)) {
      const confirmed = new Set(loadLS(LS_WORKOUT_SYNCED_KEY) || []);
      confirmed.add(fresh.id);
      if (!saveLS(LS_WORKOUT_SYNCED_KEY, [...confirmed])) ok = false;
    }
  }
  const confirmed = new Set(loadLS(LS_WORKOUT_SYNCED_KEY) || []);
  const tombs = new Set(loadLS(LS_WORKOUT_DELETED_KEY) || []);
  return ok && (loadLS(LS_WORKOUT_LOG_KEY) || []).every(s => confirmed.has(s.id) || tombs.has(s.id));
}
