import { createTargetFailureDetector, RELEASE_BACKSTOP_POLICY, repDetectionThresholds } from "../model/targetFailure.js";
import { recordCapacityForce as recordForce } from "../model/forceRecording.js";
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
// Targeted manual and automatic reps share the targetFailure detector.
// Confirmed loss fixes the capacity endpoint; physical release ends activity.
// See docs/rep-force-loss.md for acquisition, recovery and release timings.
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
export const CMD_BATTERY = new Uint8Array([0x6f]); // battery voltage, millivolts
export const RESPONSE_WEIGHT = 0x01;
export const RESPONSE_COMMAND = 0x00;
export const RESPONSE_LOW_BATTERY = 0x04;
const BATTERY_RESPONSE_TIMEOUT_MS = 2000;
const emptyBattery = () => ({ status: "unavailable", voltage_mv: null, voltage_read_at_ms: null,
  low_battery_warning: false, low_battery_warning_at_ms: null });

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

// Force and time are recorded over matching device-clock intervals by
// recordCapacityForce; the obsolete peak-relative plateau helper is removed.
export const AUTO_RELEASE_CONFIRM_MS = 1000;
// Delivery can pause without losing device samples. Allow catch-up before
// ending a rep, but never interpolate a missing interval in device time.
export const STREAM_RECOVERY_MS = 5000;

// ─────────────────────────────────────────────────────────────
// useTindeq() — React hook wrapper around the BLE GATT API
// ─────────────────────────────────────────────────────────────
function forceDecision(detector, endTs, stopReason) {
  return detector && Number.isFinite(endTs) ? { ...detector.finish(endTs), activityEndTs: endTs,
    stopReason, summary: detector.snapshot() } : null;
}

export function useTindeq() {
  const [connected,     setConnected]     = useState(false);
  const [reconnecting,  setReconnecting]  = useState(false);
  const [force,         setForce]         = useState(0);
  const [peak,          setPeak]          = useState(0);
  const [avgForce,      setAvgForce]      = useState(0);
  const [bleError,      setBleError]      = useState(null);
  const [signalRecovering, setSignalRecovering] = useState(false);
  const transportRef = useRef({ version: 1 });
  const [forceLoss, setForceLoss] = useState(null);
  const forceLossStatusRef = useRef(null);
  const latestForceLossRef = useRef(null);
  const publishForceLoss = useCallback((detector, observedTs = null, releaseTs = null) => {
    const state = detector?.snapshot(false);
    const pendingEndTs = state && releaseTs != null
      ? Math.min(state.pendingEndTs ?? releaseTs, releaseTs) : state?.pendingEndTs;
    const next = state ? { ...state, observedTs, pendingEndTs } : null;
    latestForceLossRef.current = next;
    // Acquisition changes the credited clock even while status stays holding.
    // Device-time ticks ride the existing coalesced force-display update.
    const signature = next ? `${next.status}|${next.startTs}|${next.endTs}|${next.pendingEndTs}` : null;
    if (signature !== forceLossStatusRef.current) {
      forceLossStatusRef.current = signature;
      setForceLoss(next);
    }
  }, []);
  const [battery, setBattery] = useState(emptyBattery);
  const batteryRef = useRef(emptyBattery());
  const batteryRequestRef = useRef(null);
  const updateBattery = useCallback(patch => {
    batteryRef.current = { ...batteryRef.current, ...patch };
    setBattery(batteryRef.current);
  }, []);
  const recordWithBattery = useCallback((...args) => {
    const stats = recordForce(...args);
    return { ...stats, forceRecording: { ...stats.forceRecording,
      battery: { ...batteryRef.current }, transport: { ...transportRef.current } } };
  }, []);

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
    setForceLoss(latestForceLossRef.current);
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
  // Chrome permits one outstanding GATT operation per connection. Share this
  // queue across setup and every control command, including effect cleanup.
  const gattQueueRef = useRef(Promise.resolve());
  const connectionGenerationRef = useRef(0);
  const enqueueGatt = useCallback(operation => {
    const pending = gattQueueRef.current.then(operation);
    gattQueueRef.current = pending.catch(() => {}); // a failed command must not poison the queue
    return pending;
  }, []);
  const writeCommand = useCallback(command => {
    const control = ctrlRef.current;
    const generation = connectionGenerationRef.current;
    if (!control) return Promise.reject(new Error("Tindeq is not connected."));
    return enqueueGatt(async () => {
      if (generation !== connectionGenerationRef.current || control !== ctrlRef.current) {
        throw new Error("Tindeq connection changed. Reconnect and try again.");
      }
      await control.writeValue(command);
    });
  }, [enqueueGatt]);
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
  const measurementInterruptedRef = useRef(false);
  const autoFailCallbackRef = useRef(null); // set by ActiveSessionView
  const targetKgRef         = useRef(null); // set by ActiveSessionView each rep

  // ── Auto-detect mode (spring-strap / no-hands-needed workflow) ───────────
  const adEndOnTargetDropRef = useRef(true); // timed warmups opt out of failure detection
  const adStreamGenerationRef = useRef(0);
  const adOnStartRef    = useRef(null);   // () => void — called when pull begins
  const adOnEndRef      = useRef(null);   // ({actualTime, avgForce}) => void — called when rep ends
  const adActiveRef     = useRef(false);  // true while a rep is in progress
  const adStartTimeRef  = useRef(null);   // device milliseconds when pull began
  const adSumRef        = useRef(0);      // running sum for live avg display
  const adCountRef      = useRef(0);      // sample count for live avg display
  const adSamplesRef    = useRef([]);     // raw {kg, ts} buffer for full-effort integration
  const deviceClockRef = useRef({ raw: null, elapsed: 0 });
  const lastPacketAtRef = useRef(null);
  const targetDetectorRef = useRef(null);
  const manualTargetDetectorRef = useRef(null);
  const manualReleaseKgRef = useRef(3);
  const manualBackstopRef = useRef(false);
  const releaseCheckRef = useRef(false);
  const [releaseCheckRequired, setReleaseCheckRequired] = useState(false);
  const zeroingRef = useRef(false);
  const [zeroing, setZeroing] = useState(false);
  const zeroSamplesRef = useRef(false);
  const zeroBelowRef = useRef(null);
  const zeroTimerRef = useRef(null);
  const zeroGenerationRef = useRef(0);
  const requireReleaseCheck = useCallback(() => {
    releaseCheckRef.current = true;
    setReleaseCheckRequired(true);
  }, []);
  useEffect(() => () => {
    zeroGenerationRef.current++;
    clearTimeout(zeroTimerRef.current);
  }, []);
  const adReleaseKgRef = useRef(3);
  const adBelowRef      = useRef(null);   // timestamp when force first dipped below end-threshold
  // Set true by endRepAndRequireRelease() — used by the adaptive
  // warmup when it auto-ends a hang at target time while the user is
  // still pulling. Blocks onRepStart from firing on the user's
  // continued grip; cleared automatically once force drops below
  // the completed pull’s release threshold (a real release).
  const adAwaitReleaseRef = useRef(false);
  const [awaitingRelease, setAwaitingRelease] = useState(false);
  const releaseWatchTimerRef = useRef(null);
  const markAwaitingRelease = useCallback(value => {
    adAwaitReleaseRef.current = value;
    setAwaitingRelease(value);
  }, []);
  const cancelReleaseWatch = useCallback(() => {
    clearTimeout(releaseWatchTimerRef.current);
    releaseWatchTimerRef.current = null;
  }, []);
  useEffect(() => () => cancelReleaseWatch(), [cancelReleaseWatch]);
  // A full second prevents a brief unload or sensor wobble from ending a
  // valid rep while still excluding the confirmation tail from its result.
  const AD_END_MS    = AUTO_RELEASE_CONFIRM_MS;
  const AD_MIN_MS    = 1500; // minimum rep duration — filters noise

  // Target loss uses the tolerance policy; the separate release threshold
  // also ends untargeted or never-acquired pulls after confirmation.

  // Stable setter — lets views register/clear the callback without prop drilling
  const setAutoFailCallback = useCallback((fn) => {
    autoFailCallbackRef.current = fn ?? null;
  }, []);

  // Query only during connection setup. Await the write before making the
  // device available to the UI; a missing/unsupported reply is not a failure
  // to connect. No battery polling or control writes during a live rep.
  const readBatteryOnConnect = useCallback(async () => {
    if (batteryRequestRef.current) clearTimeout(batteryRequestRef.current.timer);
    updateBattery({ status: "checking" });
    const request = {};
    batteryRequestRef.current = request;
    const unavailable = () => {
      if (batteryRequestRef.current !== request) return;
      clearTimeout(request.timer);
      batteryRequestRef.current = null;
      updateBattery({ status: "unavailable" });
    };
    request.timer = setTimeout(unavailable, BATTERY_RESPONSE_TIMEOUT_MS);
    try { await ctrlRef.current.writeValue(CMD_BATTERY); }
    catch { unavailable(); }
  }, [updateBattery]);

  // ── Packet handler — defined once, reused across reconnects ──
  //
  // AVERAGE = PLATEAU-TRIMMED MEAN (May 2026)
  // Use device time for every sample. The display includes all work;
  // the saved measurement integrates the same complete effort interval.
  const handlePacket = useCallback((evt) => {
    const data = evt.target.value;
    if (!data?.byteLength) return;
    const response = data.getUint8(0);
    if (response === RESPONSE_LOW_BATTERY) {
      updateBattery({ low_battery_warning: true, low_battery_warning_at_ms: Date.now() });
      return;
    }
    if (response === RESPONSE_COMMAND) {
      // Command responses do not echo the command ID. Accept voltage only
      // while our sole query is pending, with the documented uint32 payload.
      const request = batteryRequestRef.current;
      if (request && data.byteLength === 6 && data.getUint8(1) === 4) {
        const mv = data.getUint32(2, true);
        if (mv >= 100 && mv <= 10000) {
          clearTimeout(request.timer);
          batteryRequestRef.current = null;
          updateBattery({ status: "available", voltage_mv: mv, voltage_read_at_ms: Date.now() });
        }
      }
      return;
    }
    const packetSamples = [];
    parseTindeqPacket(data, sample => packetSamples.push(sample));
    // Battery messages and malformed packets cannot keep a stalled force
    // stream alive or alter device timing / force integration.
    if (!packetSamples.length) return;
    if ((adActiveRef.current || measuringRef.current) && lastPacketAtRef.current != null) {
      transportRef.current.max_delivery_gap_ms = Math.max(transportRef.current.max_delivery_gap_ms || 0,
        Date.now() - lastPacketAtRef.current);
    }
    setSignalRecovering(false);
    lastPacketAtRef.current = Date.now();
    const packetLastTs = packetSamples.at(-1)?.ts;
    packetSamples.forEach(({ kg, ts }) => {
      const at = lastPacketAtRef.current - ((packetLastTs - ts + 4294967296) % 4294967296) / 1000;
      const clock = deviceClockRef.current;
      const delta = clock.raw === null ? 0 : (ts - clock.raw + 4294967296) % 4294967296;
      clock.elapsed += delta / 1000;
      clock.raw = ts;
      const now = clock.elapsed;
      if ((measuringRef.current || adActiveRef.current) && delta > 1000000) {
        transportRef.current.interruption = 'device_sample_gap';
        transportRef.current.device_gap_ms = delta / 1000;
      }
      if (measuringRef.current && samplesRef.current.length && delta > 1000000) {
        measurementInterruptedRef.current = true;
        autoFailCallbackRef.current?.();
      }
      if (adActiveRef.current && delta > 1000000) {
        const stats = recordWithBattery(adSamplesRef.current, undefined, targetKgRef.current,
          forceDecision(targetDetectorRef.current, adSamplesRef.current.at(-1)?.ts, 'equipment_interruption'));
        adActiveRef.current = false;
        markAwaitingRelease(true);
        adOnEndRef.current?.({ ...stats, failureValid: false, endReason: "equipment_interruption" });
        adSamplesRef.current = [];
        return;
      }
      latestKgRef.current = kg;
      if (kg > peakRef.current) peakRef.current = kg;
      scheduleUiFlush();  // state mirror updates at most once per frame

      // Observe release even between views or while START is still pending.
      // A completed rep must not keep its release gate latched through rest.
      const wasAwaitingRelease = adAwaitReleaseRef.current;
      if (wasAwaitingRelease && !releaseCheckRef.current && !zeroingRef.current && kg < adReleaseKgRef.current) {
        markAwaitingRelease(false);
        if (releaseWatchTimerRef.current !== null) {
          cancelReleaseWatch();
          writeCommand(CMD_STOP).catch(() => {});
        }
      }

      // Zeroing is an explicit unloaded-handle action, never an automatic
      // command during a pull. Verify a fresh, stable zero before re-arming.
      if (zeroingRef.current) {
        if (delta > 1000000) zeroBelowRef.current = null;
        if (zeroSamplesRef.current && Math.abs(kg) < Math.min(0.25, adReleaseKgRef.current)) {
          if (zeroBelowRef.current === null) zeroBelowRef.current = now;
          if (now - zeroBelowRef.current >= 500) {
            clearTimeout(zeroTimerRef.current);
            zeroingRef.current = false; setZeroing(false);
            zeroSamplesRef.current = false;
            releaseCheckRef.current = false; setReleaseCheckRequired(false);
            markAwaitingRelease(false);
            setBleError(null);
            // The rest screen has no detector callbacks and doesn't need
            // an idle stream after the zero has been verified.
            if (!adOnStartRef.current && !adOnEndRef.current) writeCommand(CMD_STOP).catch(() => {});
          }
        } else zeroBelowRef.current = null;
        return;
      }

      if (measuringRef.current) {
        // Keep the full force trace, including below-target work.
        samplesRef.current.push({ kg, ts: now, at });
        sumRef.current += kg;
        countRef.current += 1;
      }

      if (measuringRef.current) {
        const failure = manualTargetDetectorRef.current?.({ kg, ts: now });
        if (kg < manualReleaseKgRef.current) {
          if (belowSinceRef.current === null) belowSinceRef.current = now;
          else if (now - belowSinceRef.current >= AD_END_MS) autoFailCallbackRef.current?.();
        } else belowSinceRef.current = null;
        publishForceLoss(manualTargetDetectorRef.current, now, belowSinceRef.current);
        if (measuringRef.current && !manualBackstopRef.current && failure
            && now - failure.confirmedTs >= RELEASE_BACKSTOP_POLICY.after_confirmation_ms) {
          manualBackstopRef.current = true;
          requireReleaseCheck();
          autoFailCallbackRef.current?.();
        }
      }

      if (adOnStartRef.current || adOnEndRef.current) {
        if (!adActiveRef.current) {
          // "Await release" guard. Set by endRepAndRequireRelease()
          // — the warmup uses it when it auto-ends a hang at target
          // while the user is still pulling. We don't want their
          // continued grip to trigger an immediate new rep on the
          // next hand; wait for force to drop below this pull’s release
          // threshold before re-arming.
          if (wasAwaitingRelease || releaseCheckRef.current) {
            // Either way, skip the start check this packet.
          } else {
            const thresholds = repDetectionThresholds(adEndOnTargetDropRef.current ? targetKgRef.current : null);
            if (!(kg >= thresholds.startKg)) return;
            adReleaseKgRef.current = thresholds.releaseKg;
            targetDetectorRef.current = adEndOnTargetDropRef.current && targetKgRef.current > 0
              ? createTargetFailureDetector(targetKgRef.current) : null;
            publishForceLoss(null);
            targetDetectorRef.current?.({ kg, ts: now });
            publishForceLoss(targetDetectorRef.current, now);
            transportRef.current = { version: 1 };
            adActiveRef.current    = true;
            adStartTimeRef.current = now;
            // Start the force and time interval at the same sample.
            adSumRef.current       = 0;
            adCountRef.current     = 0;
            adSamplesRef.current   = [{ kg, ts: now, at }];
            adBelowRef.current     = null;
            peakRef.current = kg;
            scheduleUiFlush();
            adOnStartRef.current?.();
          }
        } else {
          // Include weaker work and transient fluctuations.
          adSamplesRef.current.push({ kg, ts: now, at });
          adSumRef.current += kg;
          adCountRef.current += 1;
          const failure = targetDetectorRef.current?.({ kg, ts: now });
          if (kg < adReleaseKgRef.current) {
            if (adBelowRef.current === null) adBelowRef.current = now;
          } else adBelowRef.current = null;
          publishForceLoss(targetDetectorRef.current, now, adBelowRef.current);
          const released = adBelowRef.current !== null && now - adBelowRef.current >= AD_END_MS;
          const backstop = !released && failure && now - failure.confirmedTs >= RELEASE_BACKSTOP_POLICY.after_confirmation_ms;
          if (released || backstop) {
            const activityEnd = released ? adBelowRef.current : now;
            const actualTime = (activityEnd - adStartTimeRef.current) / 1000;
            const decision = forceDecision(targetDetectorRef.current, activityEnd,
              released ? 'release' : 'release_not_observed');
            const stats = recordWithBattery(adSamplesRef.current,
              decision?.endTs ?? activityEnd, targetKgRef.current, decision);
            if (actualTime * 1000 < AD_MIN_MS) {
              stats.failureValid = false;
              stats.endReason = 'interrupted';
              stats.forceRecording.capacity_eligible = false;
            }
            if (backstop) { requireReleaseCheck(); markAwaitingRelease(true); }
            const cb = adOnEndRef.current;
            adActiveRef.current = false;
            adStartTimeRef.current = null;
            adSumRef.current = 0;
            adCountRef.current = 0;
            adSamplesRef.current = [];
            adBelowRef.current = null;
            cb?.(stats);
          }
        }
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const timer = setInterval(() => {
      if ((!measuringRef.current && !adActiveRef.current) || lastPacketAtRef.current == null
          || (measurementInterruptedRef.current && !adActiveRef.current)) return;
      const silence = Date.now() - lastPacketAtRef.current;
      if (silence <= 1500) return;
      setSignalRecovering(true);
      // Timed warmups advance on a wall-clock deadline, so they must pause
      // promptly rather than run that clock through an unobserved interval.
      const grace = adActiveRef.current && !adEndOnTargetDropRef.current ? 1500 : STREAM_RECOVERY_MS;
      if (silence <= grace) return;
      transportRef.current.interruption = 'stream_timeout';
      transportRef.current.silence_ms = silence;
      setSignalRecovering(false);
      if (measuringRef.current && !measurementInterruptedRef.current) {
        measurementInterruptedRef.current = true;
        autoFailCallbackRef.current?.();
      }
      if (!adActiveRef.current) return;
      const stats = recordWithBattery(adSamplesRef.current, undefined, targetKgRef.current,
          forceDecision(targetDetectorRef.current, adSamplesRef.current.at(-1)?.ts, 'equipment_interruption'));
      adActiveRef.current = false;
      markAwaitingRelease(true);
      adOnEndRef.current?.({ ...stats, failureValid: false, endReason: "equipment_interruption" });
      adSamplesRef.current = [];
    }, 250);
    return () => clearInterval(timer);
  }, [recordWithBattery, markAwaitingRelease]);

  // ── GATT setup — called on initial connect and every reconnect ──
  const setupGatt = useCallback((device) => enqueueGatt(async () => {
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
    // Preserve the active rep's battery receipt across a reconnect.
    if (!measuringRef.current && !adActiveRef.current) updateBattery(emptyBattery());
    await dataC.startNotifications();
    if (!measuringRef.current && !adActiveRef.current) await readBatteryOnConnect();
    // If a rep was in progress when we dropped, restart the measurement stream
    if (measuringRef.current || adOnStartRef.current || adOnEndRef.current) {
      await ctrlRef.current.writeValue(CMD_START);
    }
  }), [enqueueGatt, handlePacket, readBatteryOnConnect, updateBattery]);

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
        if (reconnectingRef.current) return;
        connectionGenerationRef.current += 1;
        zeroGenerationRef.current++;
        clearTimeout(zeroTimerRef.current);
        zeroingRef.current = false; setZeroing(false);
        zeroSamplesRef.current = false; zeroBelowRef.current = null;
        ctrlRef.current = null;
        if (adActiveRef.current && !adEndOnTargetDropRef.current) {
          transportRef.current.interruption = 'disconnect';
          const stats = recordWithBattery(adSamplesRef.current, undefined, targetKgRef.current,
            forceDecision(targetDetectorRef.current, adSamplesRef.current.at(-1)?.ts, 'equipment_interruption'));
          adActiveRef.current = false;
          markAwaitingRelease(true);
          adOnEndRef.current?.({ ...stats, failureValid: false, endReason: 'equipment_interruption' });
          adSamplesRef.current = [];
        }
        // Keep the rep and callbacks through one bounded reconnect attempt.
        // Returning device timestamps must still prove continuous coverage;
        // otherwise the gap handler saves the observed effort as interrupted.
        if (measuringRef.current || adActiveRef.current) {
          transportRef.current.disconnect_count = (transportRef.current.disconnect_count || 0) + 1;
          setSignalRecovering(true);
        }
        setConnected(false);
        reconnectingRef.current = true;
        setReconnecting(true);
        const generation = connectionGenerationRef.current;
        await new Promise(r => setTimeout(r, 1500));
        if (generation !== connectionGenerationRef.current || device !== deviceRef.current) return;
        try {
          await setupGatt(device);
          setConnected(true);
        } catch {
          transportRef.current.interruption = 'reconnect_failed';
          if (measuringRef.current && !measurementInterruptedRef.current) {
            measurementInterruptedRef.current = true;
            autoFailCallbackRef.current?.();
          }
          if (adActiveRef.current) {
            const stats = recordWithBattery(adSamplesRef.current, undefined, targetKgRef.current,
              forceDecision(targetDetectorRef.current, adSamplesRef.current.at(-1)?.ts, 'equipment_interruption'));
            adActiveRef.current = false;
            markAwaitingRelease(true);
            adOnEndRef.current?.({ ...stats, failureValid: false, endReason: 'equipment_interruption' });
            adSamplesRef.current = [];
          }
          setSignalRecovering(false);
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
  }, [setupGatt, recordWithBattery, markAwaitingRelease]);

  // ── Unmount cleanup ──
  // Chrome keeps the same BluetoothDevice/characteristic objects alive
  // across hook lifetimes, so listeners left behind here would keep
  // firing into a dead component — and stack with the next mount's
  // listeners, processing each packet N times. Tear everything down.
  useEffect(() => {
    return () => {
      connectionGenerationRef.current += 1;
      ctrlRef.current = null;
      if (batteryRequestRef.current) clearTimeout(batteryRequestRef.current.timer);
      batteryRequestRef.current = null;
      const dataC = dataCharRef.current;
      if (dataC && packetHandlerRef.current) {
        dataC.removeEventListener("characteristicvaluechanged", packetHandlerRef.current);
        packetHandlerRef.current = null;
        // Disconnect below ends notifications without racing a final GATT write.
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
    if (releaseCheckRef.current || zeroingRef.current) throw new Error('Release and zero the handle before starting another rep.');
    cancelReleaseWatch();
    transportRef.current = { version: 1 };
    setSignalRecovering(false);
    measurementInterruptedRef.current = false;
    manualBackstopRef.current = false;
    lastPacketAtRef.current = Date.now();
    manualTargetDetectorRef.current = targetKgRef.current > 0 ? createTargetFailureDetector(targetKgRef.current) : null;
    manualReleaseKgRef.current = repDetectionThresholds(targetKgRef.current).releaseKg;
    publishForceLoss(null);
    peakRef.current      = 0;  setPeak(0);
    sumRef.current       = 0;
    countRef.current     = 0;  setAvgForce(0);
    samplesRef.current   = [];
    latestKgRef.current = 0;
    setForce(0);
    belowSinceRef.current = null;
    measuringRef.current  = true;
    try { await writeCommand(CMD_START); }
    catch (error) {
      measuringRef.current = false;
      measurementInterruptedRef.current = true;
      throw error;
    }
  }, [writeCommand, cancelReleaseWatch, publishForceLoss]);

  // Return force, matched device duration, and measurement validity together.
  const stopMeasuring = useCallback(async () => {
    measuringRef.current = false;
    if (reconnectingRef.current || (lastPacketAtRef.current != null && Date.now() - lastPacketAtRef.current > 1500)) measurementInterruptedRef.current = true;
    setSignalRecovering(false);
    const detector = manualTargetDetectorRef.current;
    const activityEndTs = manualBackstopRef.current ? samplesRef.current.at(-1)?.ts
      : belowSinceRef.current ?? samplesRef.current.at(-1)?.ts;
    const decision = forceDecision(detector, activityEndTs,
      measurementInterruptedRef.current ? 'equipment_interruption' : manualBackstopRef.current ? 'release_not_observed' : belowSinceRef.current != null ? 'release' : 'manual_stop');
    const stats = recordWithBattery(samplesRef.current, decision?.endTs ?? activityEndTs,
      targetKgRef.current, decision);
    if (measurementInterruptedRef.current) {
      stats.failureValid = false;
      stats.endReason = "equipment_interruption";
      stats.forceRecording.capacity_eligible = false;
    }
    if (ctrlRef.current) { try { await writeCommand(CMD_STOP); } catch {} }
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
  }, [cancelUiFlush, recordWithBattery, writeCommand]);

  const resetPeak = useCallback(() => {
    peakRef.current = 0; setPeak(0);
  }, []);

  const tare = useCallback(async () => {
    try {
      await writeCommand(CMD_TARE);
      peakRef.current = 0; latestKgRef.current = 0; setPeak(0); setForce(0);
      setBleError(null);
      return true;
    } catch {
      setBleError("Could not zero the Tindeq. Reconnect and try again.");
      return false;
    }
  }, [writeCommand]);

  const zeroForNextRep = useCallback(async () => {
    if (adActiveRef.current || measuringRef.current || zeroingRef.current) return false;
    cancelReleaseWatch();
    const generation = ++zeroGenerationRef.current;
    requireReleaseCheck();
    zeroingRef.current = true; setZeroing(true);
    zeroSamplesRef.current = false; zeroBelowRef.current = null;
    const fail = () => {
      if (generation !== zeroGenerationRef.current) return;
      zeroingRef.current = false; setZeroing(false);
      zeroSamplesRef.current = false;
      setBleError('Zero not confirmed. Keep the handle unloaded and try again.');
    };
    try {
      await writeCommand(CMD_TARE);
      if (generation !== zeroGenerationRef.current) return false;
      await writeCommand(CMD_START);
      if (generation !== zeroGenerationRef.current) return false;
      zeroSamplesRef.current = true;
      zeroTimerRef.current = setTimeout(fail, 5000);
      return true;
    } catch { fail(); return false; }
  }, [writeCommand, cancelReleaseWatch, requireReleaseCheck]);

  // Start auto-detect mode: Tindeq streams continuously, reps are detected by
  // force threshold crossings. onRepStart fires when a pull begins; onRepEnd
  // fires with { actualTime, avgForce } when the force drops back to baseline.
  const startAutoDetect = useCallback(async (onRepStart, onRepEnd, { endOnTargetDrop = true } = {}) => {
    cancelReleaseWatch();
    const generation = ++adStreamGenerationRef.current;
    setSignalRecovering(false);
    adOnStartRef.current = null;
    adOnEndRef.current = null;
    adEndOnTargetDropRef.current = endOnTargetDrop;
    targetDetectorRef.current = null;
    adActiveRef.current    = false;
    adStartTimeRef.current = null;
    adSumRef.current       = 0;
    adCountRef.current     = 0;
    adSamplesRef.current   = [];
    adBelowRef.current     = null;
    await writeCommand(CMD_START);
    // A superseded or failed start must not arm callbacks for a newer view.
    if (generation !== adStreamGenerationRef.current) return;
    adOnStartRef.current = onRepStart ?? null;
    adOnEndRef.current = onRepEnd ?? null;
  }, [writeCommand, cancelReleaseWatch]);

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
  const endRepAndRequireRelease = useCallback(({ requireZero = false } = {}) => {
    const stats = recordWithBattery(adSamplesRef.current, undefined, targetKgRef.current,
          forceDecision(targetDetectorRef.current, adSamplesRef.current.at(-1)?.ts, 'manual_stop'));
    const { actualTime, avgForce: avg } = stats;
    const peakF = peakRef.current;
    adActiveRef.current     = false;
    adStartTimeRef.current  = null;
    adSumRef.current        = 0;
    adCountRef.current      = 0;
    adSamplesRef.current    = [];
    adBelowRef.current      = null;
    markAwaitingRelease(true);
    if (requireZero) requireReleaseCheck();
    return { ...stats, actualTime, avgForce: avg, peakForce: peakF };
  }, [recordWithBattery, markAwaitingRelease, requireReleaseCheck]);

  const stopAutoDetect = useCallback(async ({ observeRelease = false } = {}) => {
    cancelReleaseWatch();
    const generation = ++adStreamGenerationRef.current;
    setSignalRecovering(false);
    adOnStartRef.current = null;
    adOnEndRef.current   = null;
    adActiveRef.current  = false;
    if (observeRelease && adAwaitReleaseRef.current && ctrlRef.current) {
      // Listen only for release, never for a new rep, during the handoff to
      // rest. Stop promptly on release; bound this to 10s if no samples arrive
      // or the handle stays loaded. A later START cancels the pending stop.
      releaseWatchTimerRef.current = setTimeout(() => {
        releaseWatchTimerRef.current = null;
        if (generation === adStreamGenerationRef.current && ctrlRef.current) {
          writeCommand(CMD_STOP).catch(() => {});
        }
      }, 10000);
      return;
    }
    if (ctrlRef.current) await writeCommand(CMD_STOP);
  }, [writeCommand, cancelReleaseWatch]);

  return { connected, reconnecting, signalRecovering, force, peak, avgForce, bleError, battery, awaitingRelease, forceLoss, releaseCheckRequired, zeroing, zeroForNextRep, connect, startMeasuring, stopMeasuring, resetPeak, tare, targetKgRef, setAutoFailCallback, startAutoDetect, stopAutoDetect, endRepAndRequireRelease };
}
