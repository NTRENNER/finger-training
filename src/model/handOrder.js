// Rotation follows recorded training days, not calendar parity or app launches.
// The first session freezes the day's order in every saved rep, which also
// preserves it across reloads and devices when history is synchronized.
export const otherHand = hand => hand === 'R' ? 'L' : 'R';

export function startingHandForDay(history = [], day) {
  const rows = history.filter(r => r?.date && r.date <= day && ['L', 'R'].includes(r.hand)
    && Number(r.actual_time_s) > 0 && !r.is_seed);
  const latestDay = rows.reduce((latest, r) => r.date > latest ? r.date : latest, '');
  if (!latestDay) return 'L';
  const daily = rows.filter(r => r.date === latestDay).sort((a, b) =>
    String(a.session_started_at || a.date).localeCompare(String(b.session_started_at || b.date))
    || (a.rep_timing?.started_at_ms ?? Infinity) - (b.rep_timing?.started_at_ms ?? Infinity)
    || String(a.id || '').localeCompare(String(b.id || '')));
  const recorded = daily.find(r => ['L', 'R'].includes(r.force_recording?.hand_order?.first_hand));
  // Historical two-hand workouts always started left. Do not infer their
  // order from array order: cloud results may be sorted by hand or rep number.
  const first = recorded?.force_recording.hand_order.first_hand
    || (daily.some(r => r.hand === 'L') ? 'L' : 'R');
  return latestDay === day ? first : otherHand(first);
}

export const handOrderMetadata = (firstHand, date) => ({ version: 1, first_hand: firstHand, date });
