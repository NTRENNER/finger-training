// Sessions always open with the left hand. A day that already has recorded
// reps keeps whichever hand that day actually opened with, so resuming or
// reloading mid-session doesn't flip the active hand.
import { isSeedArtifactRep } from './load.js';

export const otherHand = hand => hand === 'R' ? 'L' : 'R';

export function startingHandForDay(history = [], day) {
  const daily = history
    .filter(r => r?.date === day && ['L', 'R'].includes(r.hand)
      && Number(r.actual_time_s) > 0 && !isSeedArtifactRep(r))
    .sort((a, b) =>
      String(a.session_started_at || a.date).localeCompare(String(b.session_started_at || b.date))
      || (a.rep_timing?.started_at_ms ?? Infinity) - (b.rep_timing?.started_at_ms ?? Infinity)
      || String(a.id || '').localeCompare(String(b.id || '')));
  if (!daily.length) return 'L';
  const recorded = daily.find(r => ['L', 'R'].includes(r.force_recording?.hand_order?.first_hand));
  return recorded?.force_recording.hand_order.first_hand
    || (daily.some(r => r.hand === 'L') ? 'L' : 'R');
}

export const handOrderMetadata = (firstHand, date) => ({ version: 1, first_hand: firstHand, date });
