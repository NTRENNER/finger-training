// A demonstrated two-second average is distinct from an instantaneous peak
// and from an exact time-to-failure observation. No raw traces are persisted.
export const SUSTAINED_WINDOW_MS = 2000;
export const SUSTAINED_MAX_GAP_MS = 250;
const sane = kg => Number.isFinite(kg) && kg > 0 && kg < 200;

export function measureSustainedMax(samples = [], endTs = samples.at(-1)?.ts) {
  if (!samples.length || !Number.isFinite(endTs)) return null;
  // Validate order before clipping: a backwards final timestamp must not
  // silently move the endpoint and hide the broken part of the stream.
  if (samples.some((s, i) => !Number.isFinite(s.ts) || (i > 0 && s.ts <= samples[i - 1].ts))) return null;
  const origin = samples[0].ts;
  let best = null, block = [];
  const finish = () => {
    if (block.length < 2 || block.at(-1).ts - block[0].ts < SUSTAINED_WINDOW_MS) { block = []; return; }
    const sums = [0];
    for (let i = 1; i < block.length; i++) sums.push(sums[i - 1] + (block[i].ts - block[i - 1].ts) * block[i - 1].kg);
    const integral = ts => {
      let lo = 0, hi = block.length - 1;
      while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (block[mid].ts <= ts) lo = mid; else hi = mid - 1; }
      return sums[lo] + (ts - block[lo].ts) * block[lo].kg;
    };
    // A moving integral can reach a maximum when either edge crosses a
    // sample boundary. Include both, including nonuniform device intervals.
    for (const s of block) for (const end of [s.ts, s.ts + SUSTAINED_WINDOW_MS]) {
      const start = end - SUSTAINED_WINDOW_MS;
      if (start < block[0].ts || end > block.at(-1).ts) continue;
      const kg = (integral(end) - integral(start)) / SUSTAINED_WINDOW_MS;
      if (sane(kg) && (!best || kg > best.avg_force_kg)) best = {
        version: 1, method: 'time_weighted', window_ms: SUSTAINED_WINDOW_MS,
        max_gap_ms: SUSTAINED_MAX_GAP_MS, signal_quality: 'complete',
        avg_force_kg: kg, start_offset_s: (start - origin) / 1000,
        end_offset_s: (end - origin) / 1000,
      };
    }
    block = [];
  };
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i], prev = samples[i - 1];
    // Reversed or duplicated device time cannot establish a reliable window.
    if (!Number.isFinite(s.ts) || (prev && s.ts <= prev.ts)) return null;
    if (prev && s.ts - prev.ts > SUSTAINED_MAX_GAP_MS) finish();
    if (!Number.isFinite(s.kg) || s.kg < 0 || s.kg >= 200) { finish(); continue; }
    if (s.ts > endTs) {
      if (block.length && prev && s.ts - prev.ts <= SUSTAINED_MAX_GAP_MS)
        block.push({ ts: endTs, kg: prev.kg });
      break;
    }
    block.push(s);
  }
  finish();
  return best;
}

export function sustainedMaxKg(rep) {
  const m = rep?.force_recording?.sustained_max;
  if (m?.version !== 1 || m.method !== 'time_weighted' || m.window_ms !== SUSTAINED_WINDOW_MS
      || m.signal_quality !== 'complete' || m.max_gap_ms !== SUSTAINED_MAX_GAP_MS
      || !Number.isFinite(m.start_offset_s) || m.start_offset_s < 0
      || !Number.isFinite(m.end_offset_s)
      || Math.abs(m.end_offset_s - m.start_offset_s - 2) > 0.000001
      || !sane(m.avg_force_kg)) return null;
  return m.avg_force_kg;
}

export function sustainedMaxRecords(history = []) {
  const records = new Map();
  for (const rep of history) {
    const kg = sustainedMaxKg(rep);
    if (kg == null || !rep.grip || !['L', 'R'].includes(rep.hand) || !rep.date) continue;
    const key = JSON.stringify([rep.grip, rep.hand]);
    const previous = records.get(key);
    if (!previous || kg > previous.kg || (kg === previous.kg && rep.date < previous.date))
      records.set(key, { grip: rep.grip, hand: rep.hand, kg, date: rep.date });
  }
  return [...records.values()].sort((a, b) => a.grip.localeCompare(b.grip) || a.hand.localeCompare(b.hand));
}
