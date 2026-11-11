import { loadLS, saveLS, LS_REP_SLOT_DELETE_QUEUE_KEY } from './storage.js';
import { pushRepSlotTombstones, repSlotKey } from './sync.js';

export function pendingRepSlotDeletions() {
  return loadLS(LS_REP_SLOT_DELETE_QUEUE_KEY) || [];
}

// Write ahead of deleting either the local or remote row: afterwards its
// slot may no longer be recoverable from history on either device.
export function enqueueRepSlotDeletions(reps) {
  const slots = new Map(pendingRepSlotDeletions().map(s => [repSlotKey(s), s]));
  for (const r of reps) {
    if (!r.session_id || r.set_num == null || r.rep_num == null || !r.hand) continue;
    const slot = { session_id: r.session_id, set_num: r.set_num, rep_num: r.rep_num, hand: r.hand };
    slots.set(repSlotKey(slot), slot);
  }
  saveLS(LS_REP_SLOT_DELETE_QUEUE_KEY, [...slots.values()]);
}

let flushing = null;
export function flushRepSlotDeletions() {
  if (flushing) return flushing;
  flushing = (async () => {
    const batch = pendingRepSlotDeletions();
    if (!batch.length) return;
    if (await pushRepSlotTombstones(batch)) {
      const acknowledged = new Set(batch.map(repSlotKey));
      // A concurrent deletion may have queued a different slot during IO.
      saveLS(LS_REP_SLOT_DELETE_QUEUE_KEY,
        pendingRepSlotDeletions().filter(s => !acknowledged.has(repSlotKey(s))));
    }
  })().finally(() => { flushing = null; });
  return flushing;
}
