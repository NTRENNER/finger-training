import { supabase } from './supabase.js';
import { ownsLocalSession } from './sync.js';

// The channel carries only invalidations. All data still comes through the
// owned HTTP boundary and database RLS; ignore any payload a sender supplies.
export function subscribeCommunity(owner, onChange, onStatus) {
  let closed = false;
  let channel = null;
  const current = () => !closed && ownsLocalSession(owner);
  (async () => {
    if (!current() || !supabase.realtime?.setAuth || !supabase.channel) {
      if (current()) onStatus('refreshing');
      return;
    }
    await supabase.realtime.setAuth();
    if (!current()) return;
    channel = supabase.channel('community', { config: { private: true } })
      .on('broadcast', { event: 'changed' }, () => { if (current()) onChange(); })
      .subscribe(status => {
        if (!current()) return;
        onStatus(status === 'SUBSCRIBED' ? 'live' : 'refreshing');
        if (status === 'SUBSCRIBED') onChange(); // Close the initial fetch/subscribe gap.
      });
  })().catch(() => { if (current()) onStatus('refreshing'); });
  return () => {
    closed = true;
    if (channel) Promise.resolve(supabase.removeChannel(channel)).catch(() => {});
  };
}
