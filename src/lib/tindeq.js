import { recordForce } from "../model/forceRecording.js";
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
// Auto-fail: if the measured force drops below the hybrid threshold
// (see AUTOFAIL_ABS_SAG_KG below) for >1.5 s during a manual rep,
// autoFailCallbackRef fires so the view can end the rep and mark it
// as failed without user input.
//
// No app-layer keepalive: the OS/link layer already keeps BLE alive,
// and writing CMD_TARE every 25 s (which we used to do) actually
// caused drops on Chrome/Android by racing with user actions.

import { useCallback, useEffect, useRef, useState } from "react";

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
// PLATEAU-TRIMMED AVERAGE
// ─────────────────────────────────────────────────────────────
// Replaces the running 0.85×target gate with a rep-end plateau
// detector. Works identically with or without a target, since the
// threshold floats with what the user actually held rather than what
// they were prescribed.
//
//   1. Find rep-peak (max kg).
//   2. Plateau threshold = 0.80 × peak. Ramp-up and release-tail
//      samples sit below this; the steady hold sits above.
//   3. Find first plateau-eligible sample → window start.
//      Skip an additional PLATEAU_LEAD_IN_MS to swallow the curl-up
//      from threshold-cross to a fully stable hold.
//   4. Find last plateau-eligible sample → window end. Trim back
//      PLATEAU_TAIL_MS to clip the brief release decay between
//      "first dip" and the auto-detect end threshold.
//   5. Average the surviving window. Fallback chain (in order):
//        a. Plateau-trimmed mean (the steady hold between lead-in
//           and tail trim).
//        b. Raw mean of all positive samples — when the trim window
//           collapses (rep too short, or never settled into a real
//           plateau), the unfiltered mean is still a reasonable
//           central tendency for the rep. Includes ramp-up and
//           release samples, but those are bounded by the rep's own
//           decay shape so the average won't be wildly inflated.
//        c. Peak as a last resort — only if there are no positive
//           samples at all (effectively never; a plateau-eligible
//           rep always has positive force at peak time).
//      The intermediate (b) step matters for short / ugly reps —
//      jumping straight from plateau to peak overstates sustained
//      force on a 2-second hold where the trim window swallows the
//      entire signal.
//
// All three conditions where the older 0.85×target gate fell short
// are now handled uniformly:
//   * No-target / manual sessions get plateau detection too.
//   * Below-target attempts (user can't sustain prescribed load)
//     produce a meaningful average instead of falling back to peak.
//   * The release tail (samples between 0.85×target and AD_END_KG)
//     no longer drags the mean down on long reps.
const PLATEAU_THRESHOLD_FRAC = 0.80; // fraction of rep-peak considered "on the plateau"
const PLATEAU_LEAD_IN_MS     = 500;  // skip the first 0.5s after entering the plateau
const PLATEAU_TAIL_MS        = 200;  // drop the last 0.2s before the final plateau-edge sample

// Raw mean of all positive samples — fallback (b) in the chain above.
// Used when the plateau trim collapses to an empty window (short or
// ugly reps). Better than peak because peak is a single sample;
// raw mean still reflects the rep's central tendency even when the
// trim heuristics can't isolate a clean steady-hold region.
function rawPositiveMean(samples) {
  let sum = 0, count = 0;
  for (const s of samples) {
    if (s.kg > 0) { sum += s.kg; count += 1; }
  }
  return count > 0 ? sum / count : 0;
}

export function computePlateauAvg(samples) {
  if (!samples || samples.length === 0) return 0;
  let peak = 0;
  for (const s of samples) if (s.kg > peak) peak = s.kg;
  if (peak <= 0) return 0;
  const threshold = peak * PLATEAU_THRESHOLD_FRAC;
  let firstIdx = -1, lastIdx = -1;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].kg >= threshold) {
      if (firstIdx === -1) firstIdx = i;
      lastIdx = i;
    }
  }
  // Fallback chain — see header comment for the rationale.
  if (firstIdx === -1) return rawPositiveMean(samples) || peak;
  const startTs = samples[firstIdx].ts + PLATEAU_LEAD_IN_MS;
  const endTs   = samples[lastIdx].ts  - PLATEAU_TAIL_MS;
  let sum = 0, count = 0;
  for (let i = firstIdx; i <= lastIdx; i++) {
    const s = samples[i];
    if (s.ts >= startTs && s.ts <= endTs && s.kg >= threshold) {
      sum += s.kg;
      count += 1;
    }
  }
  if (count > 0) return sum / count;
  // Plateau window collapsed — fall back to raw positive mean before
  // peak. For short/ugly reps this preserves the central tendency
  // instead of overstating sustained force with a single max sample.
  const raw = rawPositiveMean(samples);
  return raw > 0 ? raw : peak;
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

  // ── UI flush coalescing (added 2026-07-01) ──────────────
  // The Tindeq streams ~15 samples/packet at ~5-10 packets/s, and
  // this hook lives at the App level — so per-sample setForce()
  // re-rendered the ENTIRE app tree hundreds of times a minute while
  // connected, stacking on the active view's own 100ms elapsed-timer
  // and two live recharts. All measurement math stays SAMPLE-ACCURATE
  // in refs (peak, avg accumulators, auto-fail, auto-detect below);
  // only the React state mirror is coalesced to one update per
  // animation frame — the fastest rate a human can perceive anyway.
  const rafRef      = useRef(0);   // pending rAF id; 0 = none scheduled
  const latestKgRef = useRef(0);   // last sample, for the next flush
  const flushUi = useCallback(() => {
    rafRef.current = 0;
    setForce(latestKgRef.current);
    setPeak(peakRef.current);
    const c = countRef.current, adC = adCountRef.current;
    if (adC > 0)     setAvgForce(adSumRef.current / adC);
    else if (c > 0)  setAvgForce(sumRef.current / c);
  }, []);
  const scheduleUiFlush = useCallback(() => {
    if (rafRef.current) return;  // one flush per frame
    if (typeof requestAnimationFrame === "function") {
      rafRef.current = requestAnimationFrame(flushUi);
    } else {
      rafRef.current = setTimeout(flushUi, 66);  // test envs / very old browsers
    }
  }, [flushUi]);
  const cancelUiFlush = useCallback(() => {
    if (rafRef.current) {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(rafRef.current);
      else clearTimeout(rafRef.current);
      rafRef.current = 0;
    }
  }, []);
  // Cancel any pending flush on unmount so it can't fire into an
  // unmounted component.
  useEffect(() => () => { cancelUiFlush(); }, [cancelUiFlush]);

  const ctrlRef             = useRef(null);
  const deviceRef           = useRef(null);   // kept for auto-reconnect
  const dataCharRef         = useRef(null);   // notify characteristic — for listener/notification cleanup
  // Handler identities kept in refs so removeEventListener actually
  // matches what addEventListener registered. Chrome returns the SAME
  // BluetoothDevice/characteristic objects for the same physical
  // device, so re-adding a fresh closure on every (re)connect stacks
  // duplicate listeners — each packet then gets processed N times.
  const packetHandlerRef     = useRef(null);
  const disconnectHandlerRef = useRef(null);
  const reconnectingRef     = useRef(false);  // guard against concurrent reconnects
  const peakRef             = useRef(0);
  const sumRef              = useRef(0);   // running sum for live avg display
  const countRef            = useRef(0);   // sample count for live avg display
  const samplesRef          = useRef([]);  // raw {kg, ts} buffer for full-effort integration
  const belowSinceRef       = useRef(null);
  const measuringRef        = useRef(false);
  const autoFailCallbackRef = useRef(null); // set by ActiveSessionView
  const targetKgRef         = useRef(null); // set by ActiveSessionView each rep

  // ── Auto-detect mode (spring-strap / no-hands-needed workflow) ───────────
  const adOnStartRef    = useRef(null);   // () => void — called when pull begins
  const adOnEndRef      = useRef(null);   // ({actualTime, avgForce}) => void — called when rep ends
  const adActiveRef     = useRef(false);  // true while a rep is in progress
  const adStartTimeRef  = useRef(null);   // device milliseconds when pull began
  const adSumRef        = useRef(0);      // running sum for live avg display
  const adCountRef      = useRef(0);      // sample count for live avg display
  const adSamplesRef    = useRef([]);     // raw {kg, ts} buffer for full-effort integration
  const deviceClockRef = useRef({ raw: null, elapsed: 0 });
  const lastPacketAtRef = useRef(null);
  const adBelowRef      = useRef(null);   // timestamp when force first dipped below end-threshold
  // Set true by endRepAndRequireRelease() — used by the adaptive
  // warmup when it auto-ends a hang at target time while the user is
  // still pulling. Blocks onRepStart from firing on the user's
  // continued grip; cleared automatically once force drops below
  // AD_END_KG (a real release).
  const adAwaitReleaseRef = useRef(false);
  const AD_START_KG  = 4;    // force must exceed this to begin auto-rep
  const AD_END_KG    = 3;    // force must drop below this to end auto-rep
  const AD_END_MS    = 500;  // ms below end-threshold before rep is confirmed done
  const AD_MIN_MS    = 1500; // minimum rep duration — filters noise

  // Force below the release threshold ends the rep. Falling below the
  // prescribed load alone must not truncate a weaker continued pull.

  // Stable setter — lets views register/clear the callback without prop drilling
  const setAutoFailCallback = useCallback((fn) => {
    autoFailCallbackRef.current = fn ?? null;
  }, []);

  // ── Packet handler — defined once, reused across reconnects ──
  //
  // AVERAGE = PLATEAU-TRIMMED MEAN (May 2026)
  // Use device time for every sample. The display includes all work;
  // the saved measurement integrates the same complete effort interval.
  const handlePacket = useCallback((evt) => {
    lastPacketAtRef.current = Date.now();
    parseTindeqPacket(evt.target.value, ({ kg, ts }) => {
      const clock = deviceClockRef.current;
      const delta = clock.raw === null ? 0 : (ts - clock.raw + 4294967296) % 4294967296;
      clock.elapsed += delta / 1000;
      clock.raw = ts;
      const now = clock.elapsed;
      if (adActiveRef.current && delta > 1000000) {
        const stats = recordForce(adSamplesRef.current);
        adActiveRef.current = false;
        adAwaitReleaseRef.current = true;
        adOnEndRef.current?.({ ...stats, failureValid: false, endReason: "equipment_interruption" });
        adSamplesRef.current = [];
        return;
      }
      latestKgRef.current = kg;
      if (kg > peakRef.current) peakRef.current = kg;
      scheduleUiFlush();  // state mirror updates at most once per frame

      if (measuringRef.current) {
        // Keep the full force trace, including below-target work.
        samplesRef.current.push({ kg, ts: now });
        sumRef.current += kg;
        countRef.current += 1;
      }

      if (measuringRef.current) {
        if (kg < AD_END_KG) {
          if (belowSinceRef.current === null) belowSinceRef.current = now;
          else if (now - belowSinceRef.current >= AD_END_MS) autoFailCallbackRef.current?.();
        } else belowSinceRef.current = null;
      }

      if (adOnStartRef.current || adOnEndRef.current) {
        if (!adActiveRef.current) {
          // "Await release" guard. Set by endRepAndRequireRelease()
          // — the warmup uses it when it auto-ends a hang at target
          // while the user is still pulling. We don't want their
          // continued grip to trigger an immediate new rep on the
          // next hand; we wait for force to drop below AD_END_KG
          // (real release) before re-arming.
          if (adAwaitReleaseRef.current) {
            if (kg < AD_END_KG) adAwaitReleaseRef.current = false;
            // Either way, skip the AD_START_KG check this packet.
          } else if (kg >= AD_START_KG) {
            adActiveRef.current    = true;
            adStartTimeRef.current = now;
            // Start the force and time interval at the same sample.
            adSumRef.current       = 0;
            adCountRef.current     = 0;
            adSamplesRef.current   = [{ kg, ts: now }];
            adBelowRef.current     = null;
            peakRef.current = kg;
            scheduleUiFlush();
            adOnStartRef.current?.();
          }
        } else {
          // Include weaker work and transient fluctuations.
          adSamplesRef.current.push({ kg, ts: now });
          adSumRef.current += kg;
          adCountRef.current += 1;
          if (kg < AD_END_KG) {
            if (adBelowRef.current === null) adBelowRef.current = now;
            else if (now - adBelowRef.current >= AD_END_MS) {
              const actualTime = (adBelowRef.current - adStartTimeRef.current) / 1000;
              if (actualTime * 1000 >= AD_MIN_MS) {
                // Exclude release confirmation time from both force and duration.
                const stats = recordForce(adSamplesRef.current, adBelowRef.current);
                const avg = stats.avgForce;
                // Read peak BEFORE clearing — peakRef gets reset
                // on the next rep's start.
                const peakF = peakRef.current;
                const cb   = adOnEndRef.current;
                adActiveRef.current    = false;
                adStartTimeRef.current = null;
                adSumRef.current       = 0;
                adCountRef.current     = 0;
                adSamplesRef.current   = [];
                adBelowRef.current     = null;
                cb?.({ ...stats, actualTime, avgForce: avg, peakForce: peakF });
              } else {
                adActiveRef.current    = false;
                adStartTimeRef.current = null;
                adSumRef.current       = 0;
                adCountRef.current     = 0;
                adSamplesRef.current   = [];
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

  useEffect(() => {
    const timer = setInterval(() => {
      if (!adActiveRef.current || lastPacketAtRef.current == null
          || Date.now() - lastPacketAtRef.current <= 1500) return;
      const stats = recordForce(adSamplesRef.current);
      adActiveRef.current = false;
      adAwaitReleaseRef.current = true;
      adOnEndRef.current?.({ ...stats, failureValid: false, endReason: "equipment_interruption" });
      adSamplesRef.current = [];
    }, 250);
    return () => clearInterval(timer);
  }, []);

  // ── GATT setup — called on initial connect and every reconnect ──
  const setupGatt = useCallback(async (device) => {
    const server = await device.gatt.connect();
    const svc    = await server.getPrimaryService(TINDEQ_SERVICE);
    const dataC  = await svc.getCharacteristic(TINDEQ_NOTIFY);
    ctrlRef.current = await svc.getCharacteristic(TINDEQ_WRITE);
    // Chrome hands back the SAME characteristic object across
    // reconnects, so adding without removing stacks duplicate
    // listeners — every packet then runs through handlePacket N
    // times, inflating the live-average counts and duplicating
    // plateau-buffer samples. Remove-then-add keeps it to one.
    if (packetHandlerRef.current) {
      dataC.removeEventListener("characteristicvaluechanged", packetHandlerRef.current);
    }
    packetHandlerRef.current = handlePacket;
    dataC.addEventListener("characteristicvaluechanged", handlePacket);
    dataCharRef.current = dataC;
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
      const onDisconnected = async () => {
        if (adActiveRef.current) {
          const stats = recordForce(adSamplesRef.current);
          adActiveRef.current = false;
          adAwaitReleaseRef.current = true;
          adOnEndRef.current?.({ ...stats, failureValid: false, endReason: "equipment_interruption" });
          adSamplesRef.current = [];
        }
        setConnected(false);
        if (reconnectingRef.current) return;
        reconnectingRef.current = true;
        setReconnecting(true);
        await new Promise(r => setTimeout(r, 1500));
        try {
          await setupGatt(device);
          setConnected(true);
        } catch {
          setBleError("Connection lost — tap Connect Tindeq to reconnect.");
        } finally {
          setReconnecting(false);
          reconnectingRef.current = false;
        }
      };
      // Chrome returns the SAME BluetoothDevice object for the same
      // physical device, so a manual re-connect would stack a second
      // disconnect listener (and a second reconnect race). Remove the
      // previous handler (kept in a ref) before adding the new one.
      if (disconnectHandlerRef.current) {
        device.removeEventListener("gattserverdisconnected", disconnectHandlerRef.current);
      }
      disconnectHandlerRef.current = onDisconnected;
      device.addEventListener("gattserverdisconnected", onDisconnected);

      await setupGatt(device);
      setConnected(true);
      return true;
    } catch (err) {
      setBleError(err.message || "Connection failed");
      return false;
    }
  }, [setupGatt]);

  // ── Unmount cleanup ──
  // Chrome keeps the same BluetoothDevice/characteristic objects alive
  // across hook lifetimes, so listeners left behind here would keep
  // firing into a dead component — and stack with the next mount's
  // listeners, processing each packet N times. Tear everything down.
  useEffect(() => {
    return () => {
      const dataC = dataCharRef.current;
      if (dataC && packetHandlerRef.current) {
        dataC.removeEventListener("characteristicvaluechanged", packetHandlerRef.current);
        packetHandlerRef.current = null;
        // stopNotifications throws (or rejects) if the device is already gone
        try { dataC.stopNotifications().catch(() => {}); } catch { /* device gone */ }
      }
      const device = deviceRef.current;
      if (device) {
        if (disconnectHandlerRef.current) {
          device.removeEventListener("gattserverdisconnected", disconnectHandlerRef.current);
          disconnectHandlerRef.current = null;
        }
        if (device.gatt?.connected) device.gatt.disconnect();
      }
    };
  }, []);

  const startMeasuring = useCallback(async () => {
    peakRef.current      = 0;  setPeak(0);
    sumRef.current       = 0;
    countRef.current     = 0;  setAvgForce(0);
    samplesRef.current   = [];
    latestKgRef.current = 0;
    setForce(0);
    belowSinceRef.current = null;
    measuringRef.current  = true;
    if (ctrlRef.current) await ctrlRef.current.writeValue(CMD_START);
  }, []);

  // Return force, matched device duration, and measurement validity together.
  const stopMeasuring = useCallback(async () => {
    measuringRef.current = false;
    const stats = recordForce(samplesRef.current, belowSinceRef.current ?? undefined);
    if (ctrlRef.current) { try { await ctrlRef.current.writeValue(CMD_STOP); } catch {} }
    const avg = stats.avgForce;
    const peakF = peakRef.current;
    samplesRef.current = [];
    // Final avg is authoritative: kill any queued frame flush and
    // retire the live accumulators so no later flush recomputes a
    // running avg over this rep's samples and overwrites the
    // measured value.
    cancelUiFlush();
    sumRef.current = 0;
    countRef.current = 0;
    setAvgForce(avg);
    return { ...stats, avgForce: avg, peakForce: peakF };
  }, [cancelUiFlush]);

  const resetPeak = useCallback(() => {
    peakRef.current = 0; setPeak(0);
  }, []);

  const tare = useCallback(async () => {
    if (ctrlRef.current) await ctrlRef.current.writeValue(CMD_TARE);
    peakRef.current = 0; latestKgRef.current = 0; setPeak(0); setForce(0);
  }, []);

  // Start auto-detect mode: Tindeq streams continuously, reps are detected by
  // force threshold crossings. onRepStart fires when a pull begins; onRepEnd
  // fires with { actualTime, avgForce } when the force drops back to baseline.
  const startAutoDetect = useCallback(async (onRepStart, onRepEnd) => {
    adActiveRef.current    = false;
    adStartTimeRef.current = null;
    adSumRef.current       = 0;
    adCountRef.current     = 0;
    adSamplesRef.current   = [];
    adBelowRef.current     = null;
    adOnStartRef.current   = onRepStart ?? null;
    adOnEndRef.current     = onRepEnd   ?? null;
    if (ctrlRef.current) await ctrlRef.current.writeValue(CMD_START);
  }, []);

  // Programmatically end the current auto-detect rep and require the
  // user to fully release before the next pull is treated as a new
  // rep. Used by the adaptive warmup when it auto-advances at the
  // prescribed hold target time while the user is still gripping —
  // without the "await release" guard, the user's continued force
  // would immediately retrigger onRepStart for the next hand.
  //
  // Does NOT writeValue(CMD_STOP) — keeps the BLE stream alive so
  // tindeq.force keeps updating during the hand swap. Returns the
  // same { actualTime, avgForce, peakForce } shape as the natural
  // rep-end callback so the caller can record the rep if it wants
  // (the warmup doesn't, but the contract stays consistent).
  const endRepAndRequireRelease = useCallback(() => {
    const stats = recordForce(adSamplesRef.current);
    const { actualTime, avgForce: avg } = stats;
    const peakF = peakRef.current;
    adActiveRef.current     = false;
    adStartTimeRef.current  = null;
    adSumRef.current        = 0;
    adCountRef.current      = 0;
    adSamplesRef.current    = [];
    adBelowRef.current      = null;
    adAwaitReleaseRef.current = true;
    return { ...stats, actualTime, avgForce: avg, peakForce: peakF };
  }, []);

  const stopAutoDetect = useCallback(async () => {
    adOnStartRef.current = null;
    adOnEndRef.current   = null;
    adActiveRef.current  = false;
    adAwaitReleaseRef.current = false;
    if (ctrlRef.current) await ctrlRef.current.writeValue(CMD_STOP);
  }, []);

  return { connected, reconnecting, force, peak, avgForce, bleError, connect, startMeasuring, stopMeasuring, resetPeak, tare, targetKgRef, setAutoFailCallback, startAutoDetect, stopAutoDetect, endRepAndRequireRelease };
}
