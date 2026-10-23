import {
  buildPotentiationSpeedTrend,
  isPotentiationMeasurement,
  measurePotentiationRfd,
  potentiationMeasurementRecord,
} from "../potentiationRfd.js";

function rapidSamples({ gap = false } = {}) {
  const rows = [];
  for (let ms = -300; ms <= 900; ms += 20) {
    if (gap && ms > 100 && ms < 340) continue;
    rows.push({ ts: ms, kg: ms <= 0 ? 0 : Math.min(25, ms * 0.05) });
  }
  return rows;
}

test("measures a buffered 200 ms force rise from onset", () => {
  const result = measurePotentiationRfd(rapidSamples(), { targetKg: 20, triggerTs: 100 });
  expect(result.valid).toBe(true);
  expect(result.rfd_100_kg_s).toBeCloseTo(50, 4);
  expect(result.rfd_200_kg_s).toBeCloseTo(50, 4);
  expect(result.time_to_target_ms).toBeCloseTo(390, 4);
  expect(result.impulse_500_kg_s).toBeGreaterThan(6);
});

test("rejects a force-rise window with missing samples", () => {
  const result = measurePotentiationRfd(rapidSamples({ gap: true }), { targetKg: 20, triggerTs: 100 });
  expect(result).toMatchObject({ valid: false, reason: "sample_gap" });
});

test("builds hidden measurement rows that cannot become curve evidence", () => {
  const measurement = measurePotentiationRfd(rapidSamples(), { targetKg: 20, triggerTs: 100 });
  const rep = potentiationMeasurementRecord({
    stats: { actualTime: 0.8, peakForce: 25, potentiationRfd: measurement, forceRecording: {} },
    hand: "L", grip: "Micro", sessionId: "pot-1", date: "2026-10-23",
    startedAt: "2026-10-23T12:00:00.000Z", targetLoadKg: 20, position: 1, restSec: 20,
  });
  expect(isPotentiationMeasurement(rep)).toBe(true);
  expect(rep).toMatchObject({ set_num: 0, target_duration: 0, failure_valid: false,
    end_reason: "potentiation_complete", force_recording: { capacity_eligible: false, peak_valid: false } });
});

test("aggregates pulls by warm-up and waits for six sessions before adding a trend", () => {
  const history = [];
  for (let day = 1; day <= 6; day += 1) {
    for (const value of [day * 10, day * 10 + 4]) {
      history.push({
        date: `2026-10-${String(day).padStart(2, "0")}`,
        grip: "Crusher", hand: value % 2 ? "R" : "L", session_id: `s${day}`,
        force_recording: {
          session_protocol: { id: "warmup_potentiation", version: 1 },
          potentiation_rfd: { valid: true, rfd_200_kg_s: value },
        },
      });
    }
  }
  const trend = buildPotentiationSpeedTrend(history, { grips: ["Crusher"] });
  expect(trend.sessionCount).toBe(6);
  expect(trend.rows[0].Crusher).toBe(12);
  expect(trend.rows.at(-1).Crusher_trend).toBe(52);
});
