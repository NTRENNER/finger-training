import { createPullMeasurement, displayedRepTime, editedRepTime } from '../pullMeasurement.js';
import { recordForce, recordCapacityForce } from '../forceRecording.js';

test('first target crossing latches the average, including later undershoots and overshoots', () => {
  const measurement = createPullMeasurement(20);
  const samples = [{ ts: 0, kg: 4 }, { ts: 100, kg: 10 }, { ts: 500, kg: 22 },
    { ts: 600, kg: 18 }, { ts: 900, kg: 21 }, { ts: 1500, kg: 20 }, { ts: 2000, kg: 0 }];
  samples.forEach(sample => measurement.push(sample));
  expect(measurement.pullStartTs).toBe(0);
  expect(measurement.averageStartTs).toBe(500);
  for (const end of [750, 1400, 2000]) {
    expect(measurement.average(end)).toBeCloseTo(recordForce(samples.slice(2), end).avgForce, 10);
  }
  expect(measurement.average(400)).toBeNull();
});

test('new display duration includes ramp; older records retain their displayed time', () => {
  expect(displayedRepTime(27, { pull_duration_s: 30 })).toBe(30);
  expect(displayedRepTime(27, { acquisition_s: 3 })).toBe(27);
  expect(displayedRepTime(27, null)).toBe(27);
});

test('editing displayed time retains the separate averaging interval', () => {
  const rep = { actual_time_s: 27, force_recording: { pull_duration_s: 30, ramp_duration_s: 3 } };
  expect(editedRepTime(rep, 35)).toMatchObject({ actual_time_s: 32,
    force_recording: { pull_duration_s: 35, duration_s: 32, ramp_duration_s: 3 } });
  expect(editedRepTime(rep, 2)).toMatchObject({ actual_time_s: 0, failure_valid: false,
    force_recording: { pull_duration_s: 2, capacity_eligible: false } });
  expect(editedRepTime({ actual_time_s: 27 }, 35)).toEqual({ actual_time_s: 35 });
});

test('a brief target crossing cannot bypass sustained acquisition', () => {
  const samples = [{ ts: 0, kg: 4 }, { ts: 100, kg: 20 }, { ts: 200, kg: 0 }, { ts: 300, kg: 0 }];
  const decision = { startTs: null, endTs: 200, activityEndTs: 200, stopReason: 'release',
    pullStartTs: 0, averageStartTs: 100 };
  expect(recordCapacityForce(samples, 200, 20, decision)).toMatchObject({ failureValid: false,
    endReason: 'target_not_reached', forceRecording: { pull_duration_s: 0.2, capacity_eligible: false } });
  expect(recordCapacityForce(samples, 200, 20, { ...decision, averageStartTs: null,
    stopReason: 'equipment_interruption' })).toMatchObject({ failureValid: false, endReason: 'equipment_interruption' });
});
