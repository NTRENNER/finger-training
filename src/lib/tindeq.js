// ─────────────────────────────────────────────────────────────
// TINDEQ PROGRESSOR BLE HOOK
// ─────────────────────────────────────────────────────────────
// Web-Bluetooth wrapper around the Progressor force-measurement
// device. Exposes a React hook (`useTindeq`) plus helper constants
// for the BLE service/characteristic UUIDs and the small command
// codes for tare / start / stop.
//
// The hook returns:
//   { connected, reconnecting, force, peak, avgForce, bleError,
//     connect, startMeasuring, stopMeasuring, resetPeak, tare,
//     targetKgRef, setAutoFailCallback, startAutoDetect,
//     stopAutoDetect }
//
// Two measurement modes are supported:
//   1. Manual mode (used by ActiveSessionView). The view drives
//      tare → startMeasuring → user pulls → stopMeasuring; force /
//      avgForce / peak update live. After stopMeasuring the rep's
//      peak is read from `peak` and persisted alongside avg.
//   2. Auto-detect mode (used by AutoRepSessionView). The hook
//      watches the force stream and fires onRepStart / onRepEnd
//      callbacks when it crosses configurable thresholds — for
//      spring-strap setups where the user can't tap a button. The
//      onRepEnd payload includes `peakForce` (this rep's max
//      sample) so the view doesn't have to read peak before the
//      next rep resets it.
//
// Auto-fail: if the measured force drops below 95% of targetKgRef
// for >1.5 s during a manual rep, autoFailCallbackRef fires so the
// view can end the rep and mark it as failed without user input.
//
// No app-layer keepalive: the OS/link layer already keeps BLE alive,
// and writing CMD_TARE every 25 s (which we used to do) actually
// caused drops on Chrome/Android by racing with user actions.

import { useCallback, useRef, useState } from "react";

// ─────────────────────────────────────────────────────────────
// Tindeq Progressor BLE UUIDs & commands
// ─────────────────────────────────────────────────────────────
// NOTE: If your Progressor firmware uses a different packet format,
//       adjust parseTindeqPacket() below.
export const TINDEQ_SERVICE = "7e4e1701-1ea6-40c9-9dcc-13d34ffead57";
export const TINDEQ_NOTIFY  = "7e4e1702-1ea6-40c9-9dcc-13d34ffead57";
export const TINDEQ_WRITE   = "7e4e1703-1ea6-40c9-9dcc-13d34ffead57";
export const CMD_TARE  = new Uint8Array([0x64]); // zero/tare the scale
export const CMD_START = new Uint8Array([0x65]); // start weight measurement
export const CMD_STOP  = new Uint8Array([0x66]); // stop weight measurement
export const RESPONSE_WEIGHT = 0x01;

// ─────────────────────────────────────────────────────────────
// BLE PACKET PARSER
// ─────────────────────────────────────────────────────────────
// BLE packet format (Progressor firmware):
//   Byte 0     : response code (0x01 = weight data)
//   Byte  1    : payload length in bytes (0x78 = 120 = 15 samples × 8 bytes)
//   Bytes 2..N : samples, each 8 bytes:
//                  [0..3] float32 LE — weight in kg
//                  [4..7] uint32  LE — timestamp in µs from session start
//
// Sanity-checked at 0–500 kg per sample (anything outside is dropped).
export function parseTindeqPacket(dataView, onSample) {
  if (dataView.byteLength < 2) return;

  if (dataView.getUint8(0) !== RESPONSE_WEIGHT) return;
  // Byte 1 is payload length; samples start at byte 2
  let offset = 2;
  while (offset + 8 <= dataView.byteLength) {
    const kg = dataView.getFloat32(offset, /* littleEndian= */ true);
    const ts = dataView.getUint32(offset + 4, true); // µs

    // Sanity check — valid finger-training forces are 0–500 kg
    if (!isFinite(kg) || kg > 500 || kg < -10) {
      offset += 8;
      continue;
    }

    onSample({ kg: Math.max(0, kg), ts });
    offset += 8;
  }
}

// ─────────────────────────────────────────────────────────────
// useTindeq() — React hook wrapper around the BLE GATT API
// ─────────────────────────────────────────────────────────────
export function useTindeq() {
  const [connected,     setConnected]     = useState(false);
  const [reconnecting,  setReconnecting]  = useState(false);
  const [force,         setForce]         = useState(0);
  const [peak,          setPeak]          = useState(0);
  const [avgForce,      setAvgForce]      = useState(0);
  const [bleError,      setBleError]      = useState(null);

  const ctrlRef             = useRef(null);
  const deviceRef           = useRef(null);   // kept for auto-reconnect
  const reconnectingRef     = useRef(false);  // guard against concurrent reconnects
  const peakRef             = useRef(0);
  const sumRef              = useRef(0);   // running sum for average
  const countRef            = useRef(0);   // sample count for average
  const belowSinceRef       = useRef(null);
  const measuringRef        = useRef(false);
  const autoFailCallbackRef = useRef(null); // set by ActiveSessionView
  const targetKgRef         = useRef(null); // set by ActiveSessionView each rep

  // ── Auto-detect mode (spring-strap / no-hands-needed workflow) ───────────
  const adOnStartRef    = useRef(null);   // () => void — called when pull begins
  const adOnEndRef      = useRef(null);   // ({actualTime, avgForce}) => void — called when rep ends
  const adActiveRef     = useRef(false);  // true while a rep is in progress
  const adStartTimeRef  = useRef(null);   // Date.now() when pull began
  const adSumRef        = useRef(0);      // accumulating force sum
  const adCountRef      = useRef(0);      // sample count
  const adBelowRef      = useRef(null);   // timestamp when force first dipped below end-threshold
  const AD_START_KG  = 4;    // force must exceed this to begin auto-rep
  const AD_END_KG    = 3;    // force must drop below this to end auto-rep
  const AD_END_MS    = 500;  // ms below end-threshold before rep is confirmed done
  const AD_MIN_MS    = 1500; // minimum rep duration — filters noise

  // Stable setter — lets views register/clear the callback without prop drilling
  const setAutoFailCallback = useCallback((fn) => {
    autoFailCallbackRef.current = fn ?? null;
  }, []);

  // ── Packet handler — defined once, reused across reconnects ──
  //
  // RAMP-UP EXCLUSION (added Phase B, May 2026)
  // Originally this averaged every sample where kg > 0. For short reps
  // (Power, ~7s target) the 1-2s pull-to-target ramp-up artificially
  // dragged the average down by ~14% — F(short T) on the curve was
  // systematically conservative. Quantified bias:
  //   Power 7s:     avg ≈ 0.86 × target (14% under)
  //   Strength 45s: avg ≈ 0.98 × target (2% under)
  //   Endurance 120s: avg ≈ 0.99 × target (<1% under)
  // Fix: only count samples toward the average when force is above 85%
  // of targetKgRef — i.e., the user is actually at the prescribed hold
  // load, not still ramping up to it. When no target is set (manual
  // sessions, BLE-disconnected workouts), fall back to the original
  // "any non-zero force" threshold to preserve old behavior.
  // peak_force_kg is unchanged — peak is the max instantaneous force
  // and never had the bias.
  const handlePacket = useCallback((evt) => {
    parseTindeqPacket(evt.target.value, ({ kg }) => {
      setForce(kg);
      if (kg > peakRef.current) { peakRef.current = kg; setPeak(kg); }

      // Stable-hold threshold for averaging. When a target is set, only
      // include samples ≥ 85% of target. Otherwise (no target available)
      // include any positive sample, matching legacy behavior.
      const tgtForAvg = targetKgRef.current;
      const stableThreshold = (tgtForAvg && tgtForAvg > 0) ? 0.85 * tgtForAvg : 0;
      const isStableSample = stableThreshold > 0 ? kg >= stableThreshold : kg > 0;

      if (measuringRef.current && isStableSample) {
        sumRef.current   += kg;
        countRef.current += 1;
        setAvgForce(sumRef.current / countRef.current);
      }

      if (measuringRef.current) {
        const tgt = targetKgRef.current;
        if (tgt != null && tgt > 0) {
          const threshold = tgt * 0.95;
          if (kg < threshold) {
            if (belowSinceRef.current === null) belowSinceRef.current = Date.now();
            else if (Date.now() - belowSinceRef.current > 1500) {
              belowSinceRef.current = null;
              autoFailCallbackRef.current?.();
            }
          } else {
            belowSinceRef.current = null;
          }
        }
      }

      if (adOnStartRef.current || adOnEndRef.current) {
        const now = Date.now();
        if (!adActiveRef.current) {
          if (kg >= AD_START_KG) {
            adActiveRef.current    = true;
            adStartTimeRef.current = now;
            // Initialize sum/count to ZERO — wait for stable samples
            // (≥0.85×target) before accumulating. The first sample at
            // AD_START_KG (4 kg) is in ramp-up, not hold, so excluding
            // it is correct.
            adSumRef.current       = 0;
            adCountRef.current     = 0;
            adBelowRef.current     = null;
            peakRef.current = kg; setPeak(kg);
            setAvgForce(0);
            adOnStartRef.current?.();
          }
        } else {
          // Only accumulate when force is at the stable hold level.
          // Ramp-up samples (below 0.85×target) get excluded.
          if (isStableSample) {
            adSumRef.current  += kg;
            adCountRef.current += 1;
            setAvgForce(adSumRef.current / adCountRef.current);
          }
          if (kg < AD_END_KG) {
            if (adBelowRef.current === null) adBelowRef.current = now;
            else if (now - adBelowRef.current >= AD_END_MS) {
              const actualTime = (adBelowRef.current - adStartTimeRef.current) / 1000;
              if (actualTime * 1000 >= AD_MIN_MS) {
                // Compute avg from stable samples. Edge case: if the
                // user never reached 85% of target (rep was a sub-threshold
                // attempt), fall back to peak as the best available force
                // estimate so we don't persist a 0.
                const avg = adCountRef.current > 0
                  ? adSumRef.current / adCountRef.current
                  : peakRef.current;
                // Read peak BEFORE clearing — peakRef gets reset
                // on the next rep's start.
                const peakF = peakRef.current;
                const cb   = adOnEndRef.current;
                adActiveRef.current    = false;
                adStartTimeRef.current = null;
                adSumRef.current       = 0;
                adCountRef.current     = 0;
                adBelowRef.current     = null;
                cb?.({ actualTime, avgForce: avg, peakForce: peakF });
              } else {
                adActiveRef.current    = false;
                adStartTimeRef.current = null;
                adSumRef.current       = 0;
                adCountRef.current     = 0;
                adBelowRef.current     = null;
              }
            }
          } else {
            adBelowRef.current = null;
          }
        }
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── GATT setup — called on initial connect and every reconnect ──
  const setupGatt = useCallback(async (device) => {
    const server = await device.gatt.connect();
    const svc    = await server.getPrimaryService(TINDEQ_SERVICE);
    const dataC  = await svc.getCharacteristic(TINDEQ_NOTIFY);
    ctrlRef.current = await svc.getCharacteristic(TINDEQ_WRITE);
    dataC.addEventListener("characteristicvaluechanged", handlePacket);
    await dataC.startNotifications();
    // If a rep was in progress when we dropped, restart the measurement stream
    if (measuringRef.current) {
      await ctrlRef.current.writeValue(CMD_START);
    }
  }, [handlePacket]);

  // NOTE: No app-layer keepalive — the OS/link layer already keeps BLE alive.
  // Writing CMD_TARE every 25 s used to race with user actions on Chrome/Android
  // and actually caused drops rather than preventing them.

  const connect = useCallback(async () => {
    setBleError(null);
    if (!navigator?.bluetooth) {
      setBleError("Web Bluetooth unavailable — open in Chrome on desktop or Android.");
      return false;
    }
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: "Progressor" }],
        optionalServices: [TINDEQ_SERVICE],
      });
      deviceRef.current = device;

      // Single-shot reconnect after 1.5 s to handle brief signal blips.
      // Aggressive retry loops can poison the adapter state on Android —
      // if this one try fails, surface a clean error and let the user reconnect.
      device.addEventListener("gattserverdisconnected", async () => {
        setConnected(false);
        if (reconnectingRef.current) return;
        reconnectingRef.current = true;
        setReconnecting(true);
        await new Promise(r => setTimeout(r, 1500));
        try {
          await setupGatt(device);
          setConnected(true);
        } catch {
          setBleError("Connection lost — tap Connect BLE to reconnect.");
        } finally {
          setReconnecting(false);
          reconnectingRef.current = false;
        }
      });

      await setupGatt(device);
      setConnected(true);
      return true;
    } catch (err) {
      setBleError(err.message || "Connection failed");
      return false;
    }
  }, [setupGatt]);

  const startMeasuring = useCallback(async () => {
    peakRef.current  = 0;  setPeak(0);
    sumRef.current   = 0;
    countRef.current = 0;  setAvgForce(0);
    setForce(0);
    belowSinceRef.current = null;
    measuringRef.current  = true;
    if (ctrlRef.current) await ctrlRef.current.writeValue(CMD_START);
  }, []);

  const stopMeasuring = useCallback(async () => {
    measuringRef.current = false;
    if (ctrlRef.current) await ctrlRef.current.writeValue(CMD_STOP);
  }, []);

  const resetPeak = useCallback(() => {
    peakRef.current = 0; setPeak(0);
  }, []);

  const tare = useCallback(async () => {
    if (ctrlRef.current) await ctrlRef.current.writeValue(CMD_TARE);
    peakRef.current = 0; setPeak(0); setForce(0);
  }, []);

  // Start auto-detect mode: Tindeq streams continuously, reps are detected by
  // force threshold crossings. onRepStart fires when a pull begins; onRepEnd
  // fires with { actualTime, avgForce } when the force drops back to baseline.
  const startAutoDetect = useCallback(async (onRepStart, onRepEnd) => {
    adActiveRef.current    = false;
    adStartTimeRef.current = null;
    adSumRef.current       = 0;
    adCountRef.current     = 0;
    adBelowRef.current     = null;
    adOnStartRef.current   = onRepStart ?? null;
    adOnEndRef.current     = onRepEnd   ?? null;
    if (ctrlRef.current) await ctrlRef.current.writeValue(CMD_START);
  }, []);

  const stopAutoDetect = useCallback(async () => {
    adOnStartRef.current = null;
    adOnEndRef.current   = null;
    adActiveRef.current  = false;
    if (ctrlRef.current) await ctrlRef.current.writeValue(CMD_STOP);
  }, []);

  return { connected, reconnecting, force, peak, avgForce, bleError, connect, startMeasuring, stopMeasuring, resetPeak, tare, targetKgRef, setAutoFailCallback, startAutoDetect, stopAutoDetect };
}
