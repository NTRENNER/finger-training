import { isSeedArtifactRep } from './firstSessionEvidence.js';
import { isValidFailureRep, loadProvenance } from './forceRecording.js';
import { isValidPeakMeasurement } from './peakTest.js';
import { sustainedMaxKg } from './sustainedMax.js';

// Display-only records. Older hold averages keep their actual duration and
// provenance; they are never fabricated into two-second windows or model data.
export function historicalForceRecords(history = [], valueForRecord = record => record.kg) {
  // Rank in the displayed scale, so relative records and their chart agree.
  // This callback is display-only and never changes saved force measurements.
  const better = (candidate, previous) => !previous || valueForRecord(candidate) > valueForRecord(previous)
    || (valueForRecord(candidate) === valueForRecord(previous) && candidate.date < previous.date);
  const records = new Map();
  for (const rep of history) {
    if (!rep?.grip || !['L', 'R'].includes(rep.hand) || !rep.date || isSeedArtifactRep(rep)) continue;
    const key = JSON.stringify([rep.grip, rep.hand]);
    const record = records.get(key) || { grip: rep.grip, hand: rep.hand,
      best: null, twoSecond: null, trackingSince: null, observations: [], dates: new Set() };
    record.dates.add(rep.date);
    const windowKg = sustainedMaxKg(rep);
    if (windowKg != null) {
      const candidate = { kg: windowKg, date: rep.date, durationS: 2, basis: 'two_second_window' };
      record.observations.push(candidate);
      if (better(candidate, record.twoSecond)) record.twoSecond = candidate;
      if (better(candidate, record.best)) record.best = candidate;
      if (!record.trackingSince || rep.date < record.trackingSince) record.trackingSince = rep.date;
    }
    const kg = Number(rep.avg_force_kg), durationS = Number(rep.actual_time_s);
    const recording = rep.force_recording;
    const measured = ['measured_force', 'legacy_measured'].includes(loadProvenance(rep));
    const intact = (isValidFailureRep(rep) || isValidPeakMeasurement(rep))
      && !['equipment_interruption', 'interrupted', 'user_interruption', 'target_not_reached'].includes(rep.end_reason)
      && recording?.signal_quality !== 'incomplete' && recording?.continuity !== 'intermittent'
      && recording?.duration_basis !== 'elapsed_activity_estimate';
    if (measured && intact && Number.isFinite(kg) && kg > 0 && kg < 200
        && Number.isFinite(durationS) && durationS >= 2) {
      const candidate = { kg, date: rep.date, durationS, basis: 'hold_average' };
      record.observations.push(candidate);
      if (better(candidate, record.best)) record.best = candidate;
    }
    records.set(key, record);
  }
  return [...records.values()].filter(record => record.best).map(({ observations, dates, ...record }) => {
    const daily = new Map();
    for (const observation of observations) {
      if (better(observation, daily.get(observation.date))) daily.set(observation.date, observation);
    }
    let best = null;
    const progress = [...dates].sort().map(date => {
      const candidate = daily.get(date);
      if (candidate && better(candidate, best)) best = candidate;
      return { date, best };
    });
    return { ...record, progress };
  }).sort((a, b) => a.grip.localeCompare(b.grip) || a.hand.localeCompare(b.hand));
}

// Carry each personal best forward, without inventing a value before its first
// eligible measurement. All training dates remain on the full-history axis.
export function historicalForceTimeline(records = []) {
  const dates = [...new Set(records.flatMap(r => r.progress.map(p => p.date)))].sort();
  const daily = records.map(r => new Map(r.progress.map(p => [p.date, p.best])));
  const current = records.map(() => null);
  return dates.map(date => {
    const point = { date, timestamp: Date.parse(`${date}T12:00:00Z`) };
    records.forEach((record, index) => {
      if (daily[index].has(date)) current[index] = daily[index].get(date);
      point[`series${index}`] = current[index]?.kg ?? null;
      point[`record${index}`] = current[index];
    });
    return point;
  });
}
