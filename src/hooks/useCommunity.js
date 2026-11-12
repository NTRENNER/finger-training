import { useCallback, useEffect, useRef, useState } from 'react';
import { loadLS, saveLS } from '../lib/storage.js';
import { ownsLocalSession } from '../lib/sync.js';
import { ensureCommunityProfile, saveCommunityProfile, syncCommunity } from '../lib/communityApi.js';
import { subscribeCommunity } from '../lib/communityLive.js';

const PENDING = 'ft_community_preferences_pending';
const CACHED = 'ft_community_profile';

export function useCommunity({ user, isOnline, syncSignal, live = false }) {
  const owner = user?.id && !user.is_anonymous && ownsLocalSession(user.id) ? user.id : null;
  const [profile, setProfile] = useState(() => loadLS(CACHED));
  const [pending, setPending] = useState(() => loadLS(PENDING) || {});
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [liveStatus, setLiveStatus] = useState('refreshing');
  const chain = useRef(Promise.resolve());
  const signature = useRef(null);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const queue = useCallback(task => {
    const run = chain.current.then(async () => {
      if (!active.current || !ownsLocalSession(owner)) return;
      return task();
    });
    chain.current = run.catch(e => {
      if (active.current && ownsLocalSession(owner)) setError(e.code === '42P01' || e.code === 'PGRST202' || e.code === 'PGRST205'
        ? 'Community is not available yet.' : 'Community could not sync. We’ll retry when you reconnect.');
    });
    return chain.current;
  }, [owner]);

  const refresh = useCallback((resetPublication = true) => {
    if (!owner || !isOnline) return;
    return queue(async () => {
      let next = await ensureCommunityProfile(owner);
      // Read the durable queue when this job executes, not a stale render.
      const patch = loadLS(PENDING) || {};
      if (Object.keys(patch).length) {
        if (Object.keys(patch).some(key => next[key] !== patch[key])) next = await saveCommunityProfile(owner, patch);
        const remaining = { ...(loadLS(PENDING) || {}) };
        for (const key of Object.keys(patch)) if (remaining[key] === patch[key]) delete remaining[key];
        saveLS(PENDING, remaining);
        if (active.current) setPending(remaining);
      }
      saveLS(CACHED, next);
      // A remote invalidation must not re-publish unchanged snapshots, which
      // would create a broadcast -> publish -> broadcast feedback loop.
      if (resetPublication !== false) signature.current = null;
      if (active.current) { setProfile(next); setError(''); setRevision(r => r + 1); }
    });
  }, [owner, isOnline, queue]);
  useEffect(() => { refresh(); }, [refresh, syncSignal]);
  useEffect(() => {
    if (!owner || !isOnline || !live) { setLiveStatus(isOnline ? 'refreshing' : 'offline'); return; }
    let timer = null;
    let refreshing = false;
    let again = false;
    let stopped = false;
    const invalidate = () => {
      if (stopped || document.visibilityState === 'hidden') return;
      if (refreshing) { again = true; return; }
      if (timer) return;
      timer = setTimeout(async () => {
        timer = null; refreshing = true;
        await refresh(false);
        refreshing = false;
        if (again) { again = false; invalidate(); }
      }, 200);
    };
    const unsubscribe = subscribeCommunity(owner, invalidate, status => { if (!stopped) setLiveStatus(status); });
    // Recovers missed events, admin-side deletions and interrupted sockets.
    const poll = setInterval(invalidate, 15000);
    document.addEventListener('visibilitychange', invalidate);
    return () => { stopped = true; clearTimeout(timer); clearInterval(poll);
      document.removeEventListener('visibilitychange', invalidate); unsubscribe(); };
  }, [owner, isOnline, live, refresh]);

  const update = useCallback(patch => {
    if (!ownsLocalSession(owner)) return;
    const next = { ...(loadLS(PENDING) || {}), ...patch };
    if (!saveLS(PENDING, next)) { setError('Could not save your sharing preference on this device.'); return; }
    setPending(next);
    refresh();
  }, [owner, refresh]);
  const publish = useCallback((achievements, peaks, progress = []) => {
    if (!isOnline || !owner) return;
    const nextSignature = JSON.stringify([achievements, peaks, progress]);
    return queue(async () => {
      const current = loadLS(CACHED);
      const patch = loadLS(PENDING) || {};
      if (!current?.sharing_enabled || Object.keys(patch).length || signature.current === nextSignature) return;
      await syncCommunity(owner, achievements, peaks, progress);
      signature.current = nextSignature;
      if (active.current) { setError(''); setRevision(r => r + 1); }
    });
  }, [owner, isOnline, queue]);
  const effective = profile?.user_id === owner ? { ...profile, ...pending } : null;
  return { owner, profile: effective, sharing: pending.sharing_enabled ?? effective?.sharing_enabled ?? true, pending: Object.keys(pending).length > 0,
    error, revision, update, publish, refresh, isOnline, liveStatus };
}
