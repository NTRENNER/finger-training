// Tests for src/lib/tindeq.js — exported pure helpers only.
// The hook itself isn't unit-tested here (no BLE in jsdom), but
// computePlateauAvg() is the new persisted-average path and is
// worth pinning down with concrete sample sequences.

import { computePlateauAvg } from "../tindeq.js";

// Build a sample series: ramp-up → plateau → release-tail.
// Each sample is 10 ms apart so 1000 ms = 100 samples.
function buildRep({ ramp = 1000, hold = 4000, release = 500, holdKg = 25, peakKg = null }) {
  const samples = [];
  let t = 0;
  const step = 10; // ms between samples
  // Ramp from 0 → holdKg over `ramp` ms
  const rampSamples = Math.floor(ramp / step);
  for (let i = 0; i < rampSamples; i++) {
    samples.push({ kg: (holdKg * (i + 1)) / rampSamples, ts: t });
    t += step;
  }
  // Hold: roughly stable around holdKg, with the peak landing mid-hold
  const holdSamples = Math.floor(hold / step);
  const top = peakKg ?? holdKg;
  for (let i = 0; i < holdSamples; i++) {
    // Bell-shape so peak lands ~middle of hold
    const phase = i / holdSamples;
    const kg = holdKg + (top - holdKg) * Math.sin(phase * Math.PI);
    samples.push({ kg, ts: t });
    t += step;
  }
  // Release: decay from holdKg → 0 over `release` ms
  const releaseSamples = Math.floor(release / step);
  for (let i = 0; i < releaseSamples; i++) {
    samples.push({
      kg: holdKg * (1 - (i + 1) / releaseSamples),
      ts: t,
    });
    t += step;
  }
  return samples;
}

describe("computePlateauAvg", () => {
  test("returns 0 for empty input", () => {
    expect(computePlateauAvg([])).toBe(0);
    expect(computePlateauAvg(null)).toBe(0);
    expect(computePlateauAvg(undefined)).toBe(0);
  });

  test("returns 0 when all samples are zero", () => {
    const samples = Array.from({ length: 50 }, (_, i) => ({ kg: 0, ts: i * 10 }));
    expect(computePlateauAvg(samples)).toBe(0);
  });

  test("plateau average is much closer to hold than the naive mean", () => {
    // 1s ramp, 4s flat hold at 25 kg, 0.5s release. Naive mean of all
    // samples is dragged down by the ramp + tail; plateau-trimmed mean
    // should sit very close to 25.
    const samples = buildRep({ ramp: 1000, hold: 4000, release: 500, holdKg: 25 });
    const naive = samples.reduce((s, r) => s + r.kg, 0) / samples.length;
    const plateau = computePlateauAvg(samples);
    // Plateau should be meaningfully higher than naive — confirms the
    // ramp/tail bias is being removed. (Exact gap depends on the
    // ramp:hold:release ratio; on a long hold the naive bias is small,
    // but the trim still recovers a couple of kg.)
    expect(plateau - naive).toBeGreaterThan(2);
    expect(plateau).toBeGreaterThan(24);        // plateau is near the true hold
    expect(plateau).toBeLessThanOrEqual(25.5);
  });

  test("falls back to peak when no sample clears 0.80×peak window", () => {
    // Pathological: a single spike with no plateau. The threshold logic
    // still finds a contiguous window, but the lead-in/tail trim collapses
    // it to nothing → fallback to peak.
    const samples = [
      { kg: 0,  ts: 0 },
      { kg: 30, ts: 10 },   // single peak
      { kg: 0,  ts: 20 },
    ];
    expect(computePlateauAvg(samples)).toBe(30);
  });

  test("handles a sub-target attempt (no fixed reference required)", () => {
    // User tried for 25 kg but only ever held ~18 kg. The plateau detector
    // floats the threshold to 0.80 × 18 = 14.4 kg, so we still get a
    // useful average instead of the legacy fall-back-to-peak behavior.
    const samples = buildRep({ ramp: 800, hold: 3000, release: 400, holdKg: 18 });
    const plateau = computePlateauAvg(samples);
    expect(plateau).toBeGreaterThan(17);
    expect(plateau).toBeLessThan(19);
  });

  test("trims the release tail", () => {
    // Two reps with the same hold but different release lengths.
    // The plateau average should be nearly identical because the tail
    // gets trimmed. Naive mean would diverge significantly.
    const short = buildRep({ ramp: 1000, hold: 3000, release: 100,  holdKg: 25 });
    const long  = buildRep({ ramp: 1000, hold: 3000, release: 2000, holdKg: 25 });
    const pShort = computePlateauAvg(short);
    const pLong  = computePlateauAvg(long);
    expect(Math.abs(pShort - pLong)).toBeLessThan(0.5);
  });
});
