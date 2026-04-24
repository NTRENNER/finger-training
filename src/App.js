// src/App.js  — Finger Training v3
// Rep-based sessions · Three-Compartment Fatigue Model · Tindeq Progressor BLE · Gamification
import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import { supabase } from "./lib/supabase";
// UI primitives (theme, formatters, shared components). See src/ui/.
import { C, base } from "./ui/theme.js";
import { Card, Btn, Label } from "./ui/components.js";
import { fmtW, fmtTime, fromDisp } from "./ui/format.js";

// Top-level views extracted from this file. See src/views/.
import { BadgesView } from "./views/BadgesView.js";
import { TrendsView } from "./views/TrendsView.js";
import { ClimbingTab } from "./views/ClimbingTab.js";
import { HistoryView } from "./views/HistoryView.js";
import { SettingsView } from "./views/SettingsView.js";
import { AnalysisView } from "./views/AnalysisView.js";
import { SetupView, BwPrompt } from "./views/SetupView.js";

// Shared lib helpers (storage, trip dates, CSV). See src/lib/.
import {
  loadLS, saveLS,
  LS_BW_LOG_KEY, LS_WORKOUT_LOG_KEY,
  LS_WORKOUT_SYNCED_KEY, LS_WORKOUT_DELETED_KEY,
} from "./lib/storage.js";
import {
  DEFAULT_TRIP, weeksToTrip, tripCountdown,
} from "./lib/trip.js";
import { downloadCSV, downloadWorkoutCSV } from "./lib/csv.js";

// Model layer — pure JS, testable in isolation. See src/model/*.js.
import { clamp, today } from "./util.js";
import { computeReadiness } from "./model/readiness.js";
import {
  getBaseline, getBestLoad, calcLevel, levelTitle,
} from "./model/levels.js";
import {
  PHYS_MODEL_DEFAULT,
  fatigueDose, fatigueAfterRest,
} from "./model/fatigue.js";
import {
  fitCF,
  computeAUC, fitAdaptiveHandCurve,
} from "./model/monod.js";
import { buildThreeExpPriors } from "./model/threeExp.js";

// Prescription layer — used at session-start to decide rep-1 weight.
// See src/model/prescription.js.
import {
  isShortfall,
  buildFreshLoadMap, fitDoseK,
  estimateRefWeight,
  prescribedLoad,
  empiricalPrescription,
  suggestWeight,
} from "./model/prescription.js";

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────
const LS_KEY       = "ft_v3";
const LS_QUEUE_KEY = "ft_push_queue"; // reps that failed to reach Supabase

// Tindeq Progressor BLE UUIDs & commands
// NOTE: If your Progressor firmware uses a different packet format,
//       adjust parseTindeqPacket() below.
const TINDEQ_SERVICE = "7e4e1701-1ea6-40c9-9dcc-13d34ffead57";
const TINDEQ_NOTIFY  = "7e4e1702-1ea6-40c9-9dcc-13d34ffead57";
const TINDEQ_WRITE   = "7e4e1703-1ea6-40c9-9dcc-13d34ffead57";
const CMD_TARE  = new Uint8Array([0x64]); // zero/tare the scale
const CMD_START = new Uint8Array([0x65]); // start weight measurement
const CMD_STOP  = new Uint8Array([0x66]); // stop weight measurement
const RESPONSE_WEIGHT = 0x01;

const TARGET_OPTIONS = [
  { label: "Power",     seconds: 10  },
  { label: "Strength",  seconds: 45  },
  { label: "Capacity",  seconds: 120 },
];

const GRIP_PRESETS = ["Crusher", "Micro", "Thunder"];

// PHYS_MODEL_DEFAULT and DEF_FAT now live in src/model/fatigue.js (imported above).

const LS_NOTES_KEY     = "ft_notes";     // { [session_id]: string }
const LS_BW_KEY        = "ft_bw";        // body weight in kg (number)
// LS_BW_LOG_KEY now lives in src/lib/storage.js (imported above).
const LS_READINESS_KEY = "ft_readiness"; // { [date]: 1-5 } subjective daily rating
const LS_BASELINE_KEY  = "ft_baseline";  // { date, CF, W } — permanent first-calibration snapshot
const LS_ACTIVITY_KEY  = "ft_activity";  // [{ id, date, type: "climbing", discipline, grade, ascent }] — legacy entries may carry { duration_min, intensity } instead
const LS_GENESIS_KEY   = "ft_genesis";   // { date, CF, W, auc } — snapshot when first all-zone coverage earned

// LEVEL_STEP now lives in src/model/levels.js (imported above).

// Level display — numeric only, no old badge names. Stays in App.js
// because it's a pure UI flourish used only by SessionSummaryView's
// level-up animation.
const LEVEL_EMOJIS = ["🌱","🏛️","📈","⚡","⚙️","🔥","🏔️","⭐","💎","🏆","🌟"];

// ─────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────
const uid     = () => Math.random().toString(36).slice(2, 10);
// ymdLocal and today now live in src/util.js (imported above).
const nowISO      = () => new Date().toISOString();
// fmtClock and bwOnDate now live in src/ui/format.js (imported above).
// fmt0, fmt1, fmtW, fmtTime, toDisp, fromDisp, KG_TO_LBS now live in
// src/ui/format.js (imported above).

// loadLS and saveLS now live in src/lib/storage.js (imported above).

// toCSV, downloadCSV, downloadWorkoutCSV now live in src/lib/csv.js
// (imported above).

// All model-layer math (Monod fits, three-exp fits, fatigue, prescription,
// coaching) lives under src/model/*.js — imported above. App.js holds only
// the React shell, BLE handling, view components, and per-component memos.

// Per-session relative response of the two Monod parameters to each
// training protocol — the POPULATION PRIOR. Values are fractional
// (% of current); ratios within a row and among rows matter, not the
// overall magnitude, since we only compare protocols.
//
// Physiological story (CF = F-D asymptote, W′ = finite reserve above it):
//   • Power (short max efforts) primarily builds W′ — the anaerobic
//     reserve — with minor CF carry-over via MVC neural gains.
//   • Strength (mid-duration max hangs, 1RM work) raises the absolute
//     force ceiling. Since CF typically sits ~60–70% of max, lifting
//     the ceiling lifts CF proportionally — the "ceiling effect."
//     Largest CF-response of the three.
//   • Capacity (sustained threshold work) raises CF as a fraction of
//     the existing ceiling — the "ratio effect." Real but bounded;
//     once you're near the trainable CF:max ratio ceiling, further
//     gains require lifting max itself (i.e., strength work).
//
// PROTOCOL_RESPONSE, AUC_T_MIN, AUC_T_MAX, computePersonalResponse
// now live in src/model/personal-response.js (imported above).

// computeReadiness now lives in src/model/readiness.js (imported above).
// recoveryLabel/FEEL_OPTIONS/subjToScore are UI-coupled (theme colors,
// emoji) and travel with SetupView in src/views/SetupView.js.

// ZONE5, classifyZone5, dominantZone5, GOAL_TO_ZONE5 now live in
// src/model/zones.js (imported above).

// isQualifyingRep, groupSessions, getBaseline, getBestLoad, calcLevel,
// levelTitle, nextLevelTarget, LEVEL_STEP now live in src/model/levels.js
// (imported above).

// ─────────────────────────────────────────────────────────────
// TINDEQ PROGRESSOR BLUETOOTH HOOK
// ─────────────────────────────────────────────────────────────
// BLE packet format (Progressor firmware):
//   Byte 0     : response code (0x01 = weight data)
//   Byte  1    : payload length in bytes (0x78 = 120 = 15 samples × 8 bytes)
//   Bytes 2..N : samples, each 8 bytes:
//                  [0..3] float32 LE — weight in kg
//                  [4..7] uint32  LE — timestamp in µs from session start
//
// If your device uses a different format, update parseTindeqPacket().
function parseTindeqPacket(dataView, onSample) {
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

function useTindeq() {
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
  const handlePacket = useCallback((evt) => {
    parseTindeqPacket(evt.target.value, ({ kg }) => {
      setForce(kg);
      if (kg > peakRef.current) { peakRef.current = kg; setPeak(kg); }

      if (measuringRef.current && kg > 0) {
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
            adSumRef.current       = kg;
            adCountRef.current     = 1;
            adBelowRef.current     = null;
            // Reset peak and live average when a new auto-rep begins
            // so the gauge shows this-rep stats rather than carryover
            // from the previous one.
            peakRef.current = kg; setPeak(kg);
            setAvgForce(kg);
            adOnStartRef.current?.();
          }
        } else {
          adSumRef.current  += kg;
          adCountRef.current += 1;
          // Live running average so the in-rep ForceGauge can show it.
          setAvgForce(adSumRef.current / adCountRef.current);
          if (kg < AD_END_KG) {
            if (adBelowRef.current === null) adBelowRef.current = now;
            else if (now - adBelowRef.current >= AD_END_MS) {
              const actualTime = (adBelowRef.current - adStartTimeRef.current) / 1000;
              if (actualTime * 1000 >= AD_MIN_MS) {
                const avg = adSumRef.current / adCountRef.current;
                const cb  = adOnEndRef.current;
                adActiveRef.current    = false;
                adStartTimeRef.current = null;
                adSumRef.current       = 0;
                adCountRef.current     = 0;
                adBelowRef.current     = null;
                cb?.({ actualTime, avgForce: avg });
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

// ─────────────────────────────────────────────────────────────
// SUPABASE HELPERS
// ─────────────────────────────────────────────────────────────
// workout_sessions table — run once in Supabase SQL editor:
//   CREATE TABLE workout_sessions (
//     id text PRIMARY KEY,
//     date text, workout text, session_number integer,
//     exercises jsonb,
//     created_at timestamptz DEFAULT now()
//   );
//   ALTER TABLE workout_sessions ENABLE ROW LEVEL SECURITY;
//   CREATE POLICY "auth_all" ON workout_sessions FOR ALL USING (auth.uid() IS NOT NULL);

async function pushWorkoutSession(session) {
  try {
    const { error } = await supabase.from("workout_sessions").upsert({
      id:             session.id,
      date:           session.date,
      completed_at:   session.completedAt ?? null,
      workout:        session.workout,
      session_number: session.sessionNumber,
      exercises:      session.exercises,
    }, { onConflict: "id" });
    if (error) { console.warn("Supabase workout push:", error.message); return false; }
    return true;
  } catch (e) {
    console.warn("Supabase workout push exception:", e.message);
    return false;
  }
}

async function fetchWorkoutSessions() {
  const { data, error } = await supabase
    .from("workout_sessions")
    .select("*")
    .order("date", { ascending: false });
  if (error) { console.warn("Supabase workout fetch:", error.message); return null; }
  return (data || []).map(s => ({
    id:            s.id,
    date:          s.date,
    completedAt:   s.completed_at ?? null,
    workout:       s.workout,
    sessionNumber: s.session_number,
    exercises:     s.exercises || {},
  }));
}

async function deleteWorkoutSession(id) {
  try {
    const { error } = await supabase.from("workout_sessions").delete().eq("id", id);
    if (error) { console.warn("Supabase workout delete:", error.message); return false; }
    return true;
  } catch (e) {
    console.warn("Supabase workout delete exception:", e.message);
    return false;
  }
}

// The new schema uses a `reps` table. Create it with:
//   CREATE TABLE reps (
//     id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
//     created_at timestamptz DEFAULT now(),
//     date text, grip text, hand text,
//     target_duration integer, weight_kg real, actual_time_s real,
//     avg_force_kg real, peak_force_kg real,
//     set_num integer, rep_num integer,
//     rest_s integer, session_id text,
//     failed boolean DEFAULT false
//   );
//   ALTER TABLE reps ENABLE ROW LEVEL SECURITY;
//   CREATE POLICY "auth_all" ON reps FOR ALL USING (auth.uid() IS NOT NULL);
function repPayload(rep) {
  return {
    date: rep.date, grip: rep.grip, hand: rep.hand,
    target_duration: rep.target_duration, weight_kg: rep.weight_kg,
    actual_time_s: rep.actual_time_s, avg_force_kg: rep.avg_force_kg,
    peak_force_kg: rep.peak_force_kg ?? 0,
    set_num: rep.set_num, rep_num: rep.rep_num,
    rest_s: rep.rest_s, session_id: rep.session_id,
    failed: rep.failed ?? false,
    session_started_at: rep.session_started_at ?? null,
  };
}

// Returns true on success, false on failure (caller should queue the rep).
async function pushRep(rep) {
  try {
    const { error } = await supabase.from("reps").insert([repPayload(rep)]);
    if (error) { console.warn("Supabase push:", error.message); return false; }
    return true;
  } catch (e) {
    console.warn("Supabase push exception:", e.message);
    return false;
  }
}

// Add reps to the local retry queue.
function enqueueReps(reps) {
  const q = loadLS(LS_QUEUE_KEY) || [];
  const existing = new Set(q.map(r => r.id));
  const toAdd = reps.filter(r => r.id && !existing.has(r.id));
  if (toAdd.length > 0) saveLS(LS_QUEUE_KEY, [...q, ...toAdd]);
}

// Attempt to push all queued reps; remove each one on success.
async function flushQueue() {
  const q = loadLS(LS_QUEUE_KEY) || [];
  if (q.length === 0) return 0;
  let remaining = [...q];
  let flushed = 0;
  for (const rep of q) {
    const ok = await pushRep(rep);
    if (ok) {
      remaining = remaining.filter(r => r.id !== rep.id);
      flushed++;
    }
  }
  saveLS(LS_QUEUE_KEY, remaining);
  return flushed;
}

async function fetchReps() {
  const { data, error } = await supabase
    .from("reps").select("*").order("date", { ascending: false });
  if (error) { console.warn("Supabase fetch:", error.message); return null; }
  return (data || []).map(r => ({
    id: r.id, date: r.date ?? today(),
    grip: r.grip ?? "", hand: r.hand ?? "L",
    target_duration: Number(r.target_duration) || 45,
    weight_kg: Number(r.weight_kg) || 0,
    actual_time_s: Number(r.actual_time_s) || 0,
    avg_force_kg: Number(r.avg_force_kg) || 0,
    peak_force_kg: Number(r.peak_force_kg) || 0,
    set_num: Number(r.set_num) || 1,
    rep_num: Number(r.rep_num) || 1,
    rest_s: Number(r.rest_s) || 20,
    session_id: r.session_id ?? "",
    failed: r.failed ?? false,
    session_started_at: r.session_started_at ?? null,
  }));
}

// Theme (C, base) and shared components (Card, Btn, Sect, Label) now live
// in src/ui/ — see imports at the top of this file.

// BwPrompt now lives in src/views/SetupView.js (imported above).

function BigTimer({ seconds, targetSeconds, running }) {
  const pct = targetSeconds ? Math.min(seconds / targetSeconds, 1) : 0;
  const over = seconds >= targetSeconds;
  const color = running ? (over ? C.green : C.blue) : C.muted;
  return (
    <div style={{ textAlign: "center", padding: "24px 0" }}>
      <div style={{ fontSize: 108, fontWeight: 800, fontVariantNumeric: "tabular-nums", color, lineHeight: 1 }}>
        {fmtTime(seconds)}
      </div>
      <div style={{ marginTop: 12, fontSize: 13, color: C.muted }}>
        target: {fmtTime(targetSeconds)}
      </div>
      <div style={{ marginTop: 10, height: 6, background: C.border, borderRadius: 3, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct * 100}%`, background: color, borderRadius: 3, transition: "width 0.2s" }} />
      </div>
    </div>
  );
}

// targetKg: the weight the user is aiming to hit (suggested or manual, in kg)
function ForceGauge({ force, avg, peak, targetKg = null, maxDisplay = 50, unit = "lbs" }) {
  const fPct    = clamp(force / maxDisplay, 0, 1);
  const avgPct  = clamp(avg   / maxDisplay, 0, 1);
  const tgtPct  = targetKg != null ? clamp(targetKg / maxDisplay, 0, 1) : null;

  // Color zones relative to target:
  //   below target         → orange
  //   at/above target      → green
  //   10%+ above target    → purple
  let barColor = C.blue; // no target = neutral blue
  let numColor = C.blue;
  if (targetKg != null && targetKg > 0) {
    if (force >= targetKg * 1.10) { barColor = C.purple; numColor = C.purple; }
    else if (force >= targetKg * 0.99) { barColor = C.green;  numColor = C.green;  }
    else                               { barColor = C.orange; numColor = C.orange; }
  }

  return (
    <div style={{ marginTop: 8 }}>
      {/* Large live-force number, same scale as BigTimer */}
      <div style={{ textAlign: "center", fontSize: 108, fontWeight: 800, fontVariantNumeric: "tabular-nums", color: numColor, lineHeight: 1 }}>
        {fmtW(force, unit)}
      </div>
      <div style={{ textAlign: "center", fontSize: 13, color: C.muted, marginTop: 4, marginBottom: 10 }}>
        live {unit}{targetKg != null ? ` · target ${fmtW(targetKg, unit)} ${unit}` : ""}
      </div>
      {/* Stats row — running averages over the active rep so user can
          see at a glance how steady their pull has been (avg) and
          where they peaked (max). Labels are explicit about which is
          which since the big number above is "live current force." */}
      <div style={{ display: "flex", justifyContent: "space-around", fontSize: 12, color: C.muted, marginBottom: 6 }}>
        <span>Avg: <b style={{ color: C.green, fontVariantNumeric: "tabular-nums" }}>{fmtW(avg, unit)}</b></span>
        <span>Max: <b style={{ color: C.orange, fontVariantNumeric: "tabular-nums" }}>{fmtW(peak, unit)}</b></span>
      </div>
      {/* Bar */}
      <div style={{ position: "relative", height: 28, background: C.border, borderRadius: 6, overflow: "hidden" }}>
        <div style={{ position: "absolute", height: "100%", width: `${fPct * 100}%`, background: barColor, borderRadius: 6, transition: "width 0.05s" }} />
        <div style={{ position: "absolute", top: 0, bottom: 0, left: `${avgPct * 100}%`, width: 3, background: C.green }} />
        {tgtPct != null && (
          <div style={{ position: "absolute", top: 0, bottom: 0, left: `${tgtPct * 100}%`, width: 2, background: "#ffffff60" }} />
        )}
      </div>
    </div>
  );
}

function RepDots({ total, done, current }) {
  return (
    <div style={{ display: "flex", gap: 8, justifyContent: "center", margin: "16px 0" }}>
      {Array.from({ length: total }, (_, i) => {
        const isDone = i < done;
        const isCur  = i === done;
        return (
          <div key={i} style={{
            width: 16, height: 16, borderRadius: "50%",
            background: isDone ? C.green : isCur ? C.blue : C.border,
            border: isCur ? `2px solid ${C.blue}` : "2px solid transparent",
            boxShadow: isCur ? `0 0 8px ${C.blue}` : "none",
            transition: "all 0.2s",
          }} />
        );
      })}
    </div>
  );
}


// ─────────────────────────────────────────────────────────────
// SESSION PLANNER CARD
// ─────────────────────────────────────────────────────────────
// Shows a goal picker + predicted per-rep fatigue curve + "Use this plan" button.
// Requires a live CF/W′ estimate fitted from training history.
// Uniform protocol: 20s rest between every hang, 4–6 hangs per session
// depending on zone. The set count is chosen so per-hang hold-time
// converges to its asymptote (you've drained to compartment-3 steady state).
// Power drains only the fast pool which refills ~75% in 20s, so it takes ~6
// hangs to hit the tail. Capacity drains all three pools per hang, so the tail
// is reached in ~4 hangs. Strength sits between.
const GOAL_CONFIG = {
  power: {
    label: "Power", emoji: "⚡", color: "#e05560",
    refTime: 7, restDefault: 20, repsDefault: 6, setsDefault: 1, setRestDefault: 0,
    intensity: "6 × 5–7s max · 20s rest",
    setsRationale: "Power protocol: 6 hangs of 5–7s at near-max load with 20s rest. 20s refills ~75% of PCr (τ₁≈15s) between hangs — enough to keep output high but not enough to fully recover. Six hangs reaches the asymptote where subsequent hangs would produce similar output; beyond that you're spinning your wheels. Use as a pre-climbing warm-up; primes neural drive without shredding you. Load auto-prescribed from CF + W'/7.",
  },
  strength: {
    label: "Strength", emoji: "💪", color: "#e07a30",
    refTime: 45, restDefault: 20, repsDefault: 5, setsDefault: 1, setRestDefault: 0,
    intensity: "45s + 4 to failure · 20s rest",
    setsRationale: "Strength protocol: hang 1 targets 45s, hangs 2–5 go to failure, 20s rest between. 20s refills PCr but barely touches the glycolytic pool (τ₂≈90s → ~20% recovery), so fatigue compounds and each subsequent hang falls short of the last. Stop at 5 hangs: you've reached the compartment-2 + 3 steady state. The rep-time decay curve is a personal τ₂ probe — watch it flatten over weeks as glycolytic recovery improves. Load auto-prescribed from CF + W'/45.",
  },
  endurance: {
    label: "Capacity", emoji: "🏔️", color: "#3b82f6",
    refTime: 120, restDefault: 20, repsDefault: 4, setsDefault: 1, setRestDefault: 0,
    intensity: "120s + 3 to failure · 20s rest · just above CF",
    setsRationale: "Capacity protocol at load ≈ CF + W'/120 (a hair above Critical Force). Hang 1 targets 120s continuous; hangs 2–4 go to failure with 20s rest. Each hang drains all three pools; 20s rest refills the fast pool but leaves medium and slow heavily depleted, so hold-time drops fast toward the CF asymptote. Stop at 4 hangs — subsequent hangs would be nearly flat on the tail. Trains CF / capillarity / mitochondrial density. Load auto-prescribed from CF + W'/120.",
  },
};

// BADGE_CONFIG now lives in src/views/BadgesView.js (imported above).

// SessionPlannerCard now lives in src/views/SetupView.js
// (imported above) — only ever rendered from SetupView.
// ─────────────────────────────────────────────────────────────
// ZONE COVERAGE CARD
// Rolling 30-day count of Power / Strength / Capacity sessions.
// Shows which zone is undertrained and should be trained next.
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// CLIMBING LOG
// Each logged entry = one climb (discipline, grade, ascent style).
// Climbing is tracked for readiness / context but is intentionally
// NOT credited to zone coverage (see computeZoneCoverage note).
// ─────────────────────────────────────────────────────────────
// CLIMB_DISCIPLINES, ASCENT_STYLES, disciplineMeta, ascentMeta,
// describeClimb, gradesFor, defaultGradeFor now live in
// src/lib/climbing-grades.js (imported above).

// ClimbingHistoryList now lives in src/views/ClimbingHistoryList.js (imported above).

// ClimbingLogWidget now lives in src/views/ClimbingTab.js (imported above).

// ─────────────────────────────────────────────────────────────
// 1RM legacy — the OneRMWidget has been removed from the UI now that
// the power protocol (6 × 5–7s max hangs at 20s rest) is used as the
// pre-climb warm-up and replaces a standalone 1RM test.
// RM_GRIPS stays so the 1RM PR tracker on the Analysis tab can render
// historical data; computeZoneCoverage still treats any existing
// `type: "oneRM"` activity entries as Power credit.
// ─────────────────────────────────────────────────────────────
const RM_GRIPS = ["Micro", "Crusher"];

// computeZoneCoverage now lives in src/model/zones.js (imported above).
// Climbing sessions are intentionally NOT credited to any zone — the
// old heuristic (hard→strength, easy→capacity, boulder→power) over-
// counted climbing toward finger-specific zones it didn't really
// stimulate. Legacy 1RM activities still credit Power.

// Physiological limiter: which compartment is the user's capacity
// shortfall relative to their own force-duration curve?
// Returns { zone, grip } | null. Null means no/ambiguous data — caller
// should fall back to coverage.
//
// WHY SEGMENT BY GRIP.
// Absolute force on Crusher (~30 kg CF) and Micro (~10 kg CF) are not
// on the same scale — different joint, different skin, different
// tendon moment arm. Pooling them into one Monod fit produces a fit
// pulled toward the average and residuals that reflect tool choice
// rather than physiology. Each grip gets its own CF/W' fit, just as
// prescribedLoad already does for load prescription.
//
// PRIMARY SIGNAL — Monod cross-zone residual.
// Within a single grip, for each zone Z, fit F = CF + W'/T on rep-1
// failures from the OTHER two zones, then predict force at each of
// Z's actual_time_s values. The residual = predicted − actual is the
// capacity shortfall in Z relative to the curve implied by the other
// two zones. The zone with the biggest positive residual is the one
// that falls farthest below the user's own curve for that grip.
//
// Why Monod and not true three-compartment decay?
// Three-compartment (F = F_max × Σ A_i·e^(-T/τ_i)) either (a) assumes
// textbook A_i/τ_i and reintroduces the reference-athlete bias, or
// (b) frees all 6+ parameters and needs far more data to fit stably.
// Monod is a 2-parameter linear fit (via fitCF) that closely
// approximates the three-compartment shape over 5s–300s and is
// numerically stable at the data volumes we actually see.
//
// FALLBACK — failure-count distribution within the same grip.
// If a grip has data but not enough for cross-zone CV (e.g. only two
// zones trained), fall back to the least-trained zone by rep-1
// failure count within that grip. Under RPE-10 every session ends in
// failure by design — fail RATE saturates near 1.0 so count is the
// only usable summary statistic.
//
// GRIP SELECTION.
// If the user trains multiple grips, we rank grips by recent rep-1
// failure volume (most-trained grip = user's current focus) and
// return the recommendation for the first grip whose data supports
// one. A grip with a balanced curve is skipped — we try the next.
//
// Why only rep 1?  Reps 2+ in strength/capacity are to-failure by
// protocol design — their failed flag is ~100% true regardless of
// physiology. Rep 1 is the clean probe of "did you meet the zone's
// demand".
//
// Why bucket by target_duration?  A failing rep of a strength session
// may drop to 10s (power by actual_time_s), but it's still strength-
// protocol data. target_duration reflects intended zone.
// computeLimiterZone (and its LIMITER_* constants) now lives in
// src/model/limiter.js (imported above).

// ── Personalized response calibration ───────────────────────────────
// Fits per-zone CF/W′ response rates from the user's own training log
// and shrinks them toward the PROTOCOL_RESPONSE prior with Bayesian
// shrinkage. Early on (thin data) the returned coefficients equal the
// prior; as training-under-tension accumulates in a given zone, the
// fit pulls toward the observed personal rate. A zone needs at least
// MIN_SESSIONS effective session-equivalents before any personal
// signal is blended in.
//
// Attribution: proportional by time-under-tension (TUT), not by rep
// count or dominant zone. A day with 15s of power warm-up + 180s of
// strength work gets 8% / 92% attribution, not all-or-nothing to the
// dominant zone. This correctly handles the common case where a user
// does a short max-effort warm-up (power) before their main training
// block — the warm-up gets its proportional share, the main block
// gets most of it. No user-facing toggle required: if power always
// comes in small TUT doses, its effective-n stays small and its
// personal calibration stays near prior.
//
// Per-day loop: for each calendar day with failures, refit Monod on
// all data up to that day vs. through the previous day. Fractional
// ΔCF and ΔW′ are split across zones proportional to that day's TUT
// per zone, then accumulated as weighted observations. Noise in
// single-day deltas averages out over many weighted observations.
// Negative observed rates are floored at zero (likely confounds:
// illness, taper, bad mount) rather than propagated as "training
// hurt me" into a negative coefficient.
//
// Shrinkage: posterior = (k₀·prior + n_eff·weighted_mean) / (k₀ + n_eff).
// With k₀ = PERSONAL_RESPONSE_PRIOR_WEIGHT, a zone needs roughly k₀
// session-equivalents of evidence before personal rates dominate. n_eff
// is fractional: a warm-up contributing 8% TUT counts as 0.08 sessions.
// PERSONAL_RESPONSE_PRIOR_WEIGHT/MIN_SESSIONS and computePersonalResponse
// now live in src/model/personal-response.js (imported above).

// Zone Workout Summary — neutral 30-day volume breakdown. Does NOT
// prescribe training: the SessionPlanner owns the recommendation
// (per-grip Monod cross-zone residual). This card is purely a log.
// computeZoneCoverage still returns .recommended because the planner
// uses it as a fallback when there's too little failure data for the
// curve-residual signal; we just don't display that prescription here.
// ZoneCoverageCard now lives in src/views/SetupView.js
// (imported above) — only ever rendered from SetupView.
// SetupView now lives in src/views/SetupView.js (imported above).
// ─────────────────────────────────────────────────────────────
// ACTIVE SESSION VIEW
// ─────────────────────────────────────────────────────────────
function ActiveSessionView({ session, onRepDone, onAbort, tindeq, autoStart = false, unit = "lbs" }) {
  const { config, currentSet, currentRep, activeHand } = session;

  // repPhase: 'ready' (show Start button, first rep only)
  //           'countdown' (3-2-1)
  //           'active' (rep in progress)
  const [repPhase,     setRepPhase]    = useState(autoStart ? "active" : "ready");
  const [countdown,    setCountdown]   = useState(3);
  const [elapsed,      setElapsed]     = useState(0);
  const [manualWeight, setManualWeight] = useState(null);
  const startTimeRef = useRef(null);
  const timerRef     = useRef(null);

  // Suggested weight per hand — held CONSTANT within a set. We don't
  // fatigue-discount the displayed weight; the user holds the same load
  // each rep and we track how actual_time_s decays. See also AutoRepSessionView.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const suggestions = useMemo(() => {
    const handList = config.hand === "Both" ? ["L", "R"] : [config.hand];
    return Object.fromEntries(
      handList.map(h => [h, {
        suggested: suggestWeight(session.refWeights?.[h] ?? null, 0),
      }])
    );
  }, [config.hand, session.refWeights]);

  // Actually start recording the rep
  const startRep = useCallback(async () => {
    setElapsed(0);
    startTimeRef.current = Date.now();
    setRepPhase("active");
    if (tindeq.connected) {
      await tindeq.tare();
      await tindeq.startMeasuring();
    }
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 100);
  }, [tindeq]);

  // Auto-start on mount when autoStart=true
  useEffect(() => {
    if (autoStart) { startRep(); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 3-2-1 countdown
  useEffect(() => {
    if (repPhase !== "countdown") return;
    if (countdown <= 0) { startRep(); return; }
    const t = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [repPhase, countdown, startRep]);

  // Tracks whether this rep was ended by auto-failure (vs manual tap).
  const autoFailedRef = useRef(false);

  // End rep — called by manual tap (failed=false) or auto-failure (failed=true).
  const endRep = useCallback(async () => {
    if (!startTimeRef.current) return;
    const failed = autoFailedRef.current;
    autoFailedRef.current = false;
    clearInterval(timerRef.current);
    const actualTime = (Date.now() - startTimeRef.current) / 1000;
    startTimeRef.current = null;
    setRepPhase("ready");
    if (tindeq.connected) await tindeq.stopMeasuring();
    onRepDone({ actualTime, avgForce: tindeq.avgForce, failed });
  }, [tindeq, onRepDone]);

  // Wire auto-failure → endRep for the duration of an active rep only.
  // Cleanup nulls the callback whenever phase changes or the component unmounts,
  // eliminating the stale-ref gap that caused auto-fail to silently stop working
  // after the first rep.
  useEffect(() => {
    if (repPhase !== "active") {
      tindeq.setAutoFailCallback(null);
      return;
    }
    tindeq.setAutoFailCallback(() => {
      autoFailedRef.current = true;
      endRep();
    });
    return () => tindeq.setAutoFailCallback(null);
  }, [tindeq, repPhase, endRep]);

  useEffect(() => () => clearInterval(timerRef.current), []);

  // Active suggestion follows the active hand (or the only configured hand)
  const activeSugHand = config.hand === "Both" ? activeHand : config.hand;
  const sug = suggestions[activeSugHand] ?? null;

  // Effective target weight in kg for color-coding and auto-failure threshold
  const targetKg = manualWeight ?? sug?.suggested ?? null;

  // Keep the Tindeq hook's target ref in sync so auto-failure uses the right threshold
  useEffect(() => {
    tindeq.targetKgRef.current = repPhase === "active" ? targetKg : null;
  }, [tindeq, repPhase, targetKg]);

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 13, color: C.muted }}>Set {currentSet + 1} of {config.numSets}</div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>
            {config.grip} · {config.hand === "Both"
              ? (activeHand === "L" ? "Left Hand" : "Right Hand")
              : config.hand === "L" ? "Left" : "Right"}
          </div>
        </div>
        <Btn small color={C.red} onClick={onAbort}>End Session</Btn>
      </div>

      <RepDots total={config.repsPerSet} done={currentRep} current={currentRep} />

      {/* Countdown overlay */}
      {repPhase === "countdown" && (
        <Card style={{ textAlign: "center", padding: "40px 0" }}>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 8 }}>Get ready…</div>
          <div style={{ fontSize: 96, fontWeight: 900, color: C.yellow, lineHeight: 1 }}>
            {countdown === 0 ? "GO" : countdown}
          </div>
          <div style={{ fontSize: 14, color: C.muted, marginTop: 8 }}>
            {fmtW(sug?.suggested ?? 0, unit)} {unit}
          </div>
        </Card>
      )}

      {/* Timer (shown during active rep) */}
      {repPhase === "active" && (
        <Card>
          <BigTimer seconds={elapsed} targetSeconds={config.targetTime} running={true} />
          {tindeq.connected ? (
            <ForceGauge force={tindeq.force} avg={tindeq.avgForce} peak={tindeq.peak} targetKg={targetKg} unit={unit} />
          ) : (
            <div style={{ fontSize: 12, color: C.muted, textAlign: "center", marginTop: 8 }}>
              No Tindeq — tap Done when you let go.
            </div>
          )}
        </Card>
      )}

      {/* Weight suggestion (shown when ready) */}
      {repPhase === "ready" && (
        <Card>
          {/* Big active-hand indicator so it's obvious which hand to use */}
          {config.hand === "Both" && (
            <div style={{ textAlign: "center", marginBottom: 12 }}>
              <div style={{
                fontSize: 13, color: C.muted, letterSpacing: 1.2,
                textTransform: "uppercase", marginBottom: 2,
              }}>Use your</div>
              <div style={{
                fontSize: 26, fontWeight: 900,
                color: activeHand === "R" ? C.orange : C.blue,
              }}>
                {activeHand === "R" ? "✋ Right Hand" : "🤚 Left Hand"}
              </div>
            </div>
          )}
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 8 }}>
            Rep {currentRep + 1} suggested weight
          </div>
          <div style={{ fontSize: 36, fontWeight: 800, color: C.blue }}>
            {sug?.suggested != null ? `${fmtW(sug.suggested, unit)} ${unit}` : "—"}
          </div>
          <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="number" min={0} step={0.5}
              value={manualWeight != null ? fmtW(manualWeight, unit) : ""}
              onChange={e => setManualWeight(e.target.value === "" ? null : fromDisp(Number(e.target.value), unit))}
              placeholder={`Override ${unit}…`}
              style={{ width: 120, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px", color: C.text, fontSize: 15 }}
            />
            <span style={{ fontSize: 12, color: C.muted }}>{unit} (override)</span>
          </div>
        </Card>
      )}

      {/* Controls */}
      <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
        {repPhase === "ready" && (
          <Btn
            onClick={() => { setCountdown(3); setRepPhase("countdown"); }}
            style={{ flex: 1, padding: "18px 0", fontSize: 18, borderRadius: 12 }}
            color={C.green}
          >
            ▶ Start Rep
          </Btn>
        )}
        {repPhase === "active" && (
          <Btn
            onClick={endRep}
            style={{ flex: 1, padding: "18px 0", fontSize: 18, borderRadius: 12 }}
            color={C.red}
          >
            ✕ Done
          </Btn>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// REST VIEW
// ─────────────────────────────────────────────────────────────
function playBeep(freq = 880, duration = 0.12, volume = 0.4) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
    osc.onended = () => ctx.close();
  } catch (e) { /* audio not available */ }
}

function RestView({ lastRep, nextWeight, restSeconds, onRestDone, setNum, numSets, repNum, repsPerSet, unit = "lbs" }) {
  const [remaining, setRemaining] = useState(restSeconds);
  const intervalRef = useRef(null);

  useEffect(() => {
    setRemaining(restSeconds);
    intervalRef.current = setInterval(() => {
      setRemaining(r => {
        if (r <= 1) { clearInterval(intervalRef.current); onRestDone(); return 0; }
        const next = r - 1;
        if (next <= 3 && next >= 1) playBeep(next === 1 ? 1100 : 880);
        return next;
      });
    }, 1000);
    return () => clearInterval(intervalRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restSeconds]);

  const pct = remaining / restSeconds;
  const isLastRepInSet = repNum >= repsPerSet;
  const isLastSet      = setNum >= numSets;

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
      <Card>
        <div style={{ textAlign: "center", paddingBottom: 8 }}>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 4 }}>
            {isLastRepInSet
              ? (isLastSet ? "Last set complete!" : "Set complete — rest before next set")
              : `Rest — rep ${repNum} of ${repsPerSet}`}
          </div>
          <div style={{ fontSize: 64, fontWeight: 800, color: pct > 0.3 ? C.green : C.orange, lineHeight: 1 }}>
            {remaining}s
          </div>
          <div style={{ marginTop: 10, height: 6, background: C.border, borderRadius: 3, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${pct * 100}%`, background: C.green, borderRadius: 3, transition: "width 1s linear" }} />
          </div>
        </div>
      </Card>

      {lastRep && (
        <Card>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 8 }}>Last rep result</div>
          <div style={{ display: "flex", gap: 32 }}>
            <div>
              <Label>Time</Label>
              <span style={{
                fontSize: 28, fontWeight: 700,
                color: lastRep.actualTime >= lastRep.targetTime ? C.green : C.red,
              }}>
                {Math.round(lastRep.actualTime)}s
              </span>
              <div style={{ fontSize: 11, color: C.muted }}>target {lastRep.targetTime}s</div>
            </div>
            {lastRep.peakForce > 0 && (
              <div>
                <Label>Peak Force</Label>
                <span style={{ fontSize: 28, fontWeight: 700, color: C.orange }}>
                  {fmtW(lastRep.peakForce, unit)} {unit}
                </span>
              </div>
            )}
          </div>
        </Card>
      )}

      {nextWeight != null && !isLastRepInSet && (
        <Card style={{ borderColor: C.blue }}>
          <Label>Next rep suggested weight</Label>
          <div style={{ fontSize: 36, fontWeight: 800, color: C.blue }}>
            {fmtW(nextWeight, unit)} {unit}
          </div>
        </Card>
      )}

      <Btn
        onClick={() => { clearInterval(intervalRef.current); onRestDone(); }}
        style={{ width: "100%", padding: "14px 0", fontSize: 16, borderRadius: 12 }}
        color={C.muted}
      >
        Skip rest →
      </Btn>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// BETWEEN-SETS VIEW
// ─────────────────────────────────────────────────────────────
function SwitchHandsView({ onReady }) {
  const [remaining, setRemaining] = useState(10);
  const intervalRef = useRef(null);

  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setRemaining(r => {
        if (r <= 1) { clearInterval(intervalRef.current); onReady(); return 0; }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(intervalRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "40px 16px", textAlign: "center" }}>
      <div style={{ fontSize: 56 }}>🤚➡️✋</div>
      <h2 style={{ margin: "16px 0 8px" }}>Switch to Right Hand</h2>
      <p style={{ color: C.muted, marginBottom: 24 }}>Left hand complete. Get ready to train right hand.</p>
      <div style={{ fontSize: 80, fontWeight: 900, color: remaining > 3 ? C.green : C.orange, lineHeight: 1, marginBottom: 24 }}>
        {remaining}
      </div>
      <Btn onClick={() => { clearInterval(intervalRef.current); onReady(); }}
        style={{ padding: "14px 40px", fontSize: 16, borderRadius: 12 }}>
        Ready →
      </Btn>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// ALT-HAND SWITCH VIEW (alternating mode: quick hand swap prompt)
// ─────────────────────────────────────────────────────────────
function AltSwitchView({ toHand, onReady }) {
  const handName  = toHand === "L" ? "Left" : "Right";
  const handEmoji = toHand === "L" ? "🤚" : "✋";
  const [remaining, setRemaining] = useState(3);
  const intervalRef = useRef(null);

  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setRemaining(r => {
        if (r <= 1) { clearInterval(intervalRef.current); onReady(); return 0; }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(intervalRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "40px 16px", textAlign: "center" }}>
      <div style={{ fontSize: 64 }}>{handEmoji}</div>
      <h2 style={{ margin: "16px 0 8px" }}>Switch to {handName} Hand</h2>
      <p style={{ color: C.muted, marginBottom: 24 }}>Get in position — rep starts in…</p>
      <div style={{ fontSize: 80, fontWeight: 900, color: remaining > 1 ? C.green : C.orange, lineHeight: 1, marginBottom: 32 }}>
        {remaining}
      </div>
      <Btn
        onClick={() => { clearInterval(intervalRef.current); onReady(); }}
        style={{ padding: "14px 40px", fontSize: 16, borderRadius: 12 }}
      >
        Ready →
      </Btn>
    </div>
  );
}

function BetweenSetsView({ completedSet, totalSets, onNextSet, setRestTime = 180 }) {
  const [remaining, setRemaining] = useState(setRestTime);
  const intervalRef = useRef(null);

  useEffect(() => {
    setRemaining(setRestTime);
    intervalRef.current = setInterval(() => {
      setRemaining(r => {
        if (r <= 1) { clearInterval(intervalRef.current); onNextSet(); return 0; }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(intervalRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setRestTime]);

  const pct = remaining / setRestTime;

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "40px 16px", textAlign: "center" }}>
      <div style={{ fontSize: 48 }}>🏔️</div>
      <h2 style={{ margin: "12px 0 4px" }}>Set {completedSet} of {totalSets} done!</h2>
      <p style={{ color: C.muted, marginBottom: 24 }}>Rest between sets</p>
      <div style={{ fontSize: 72, fontWeight: 900, color: pct > 0.3 ? C.green : C.orange, lineHeight: 1, marginBottom: 16 }}>
        {remaining}s
      </div>
      <div style={{ height: 8, background: C.border, borderRadius: 4, overflow: "hidden", marginBottom: 32, maxWidth: 300, margin: "0 auto 32px" }}>
        <div style={{ height: "100%", width: `${pct * 100}%`, background: pct > 0.3 ? C.green : C.orange, borderRadius: 4, transition: "width 1s linear" }} />
      </div>
      {completedSet < totalSets && (
        <Btn
          onClick={() => { clearInterval(intervalRef.current); onNextSet(); }}
          style={{ padding: "16px 48px", fontSize: 17, borderRadius: 12 }}
        >
          Start Set {completedSet + 1} →
        </Btn>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// SESSION SUMMARY
// ─────────────────────────────────────────────────────────────
function SessionSummaryView({ reps, config, leveledUp, newLevel, onDone, unit = "lbs" }) {
  const sets = useMemo(() => {
    const groups = {};
    for (const r of reps) {
      const k = r.set_num;
      if (!groups[k]) groups[k] = [];
      groups[k].push(r);
    }
    return Object.entries(groups).map(([s, rs]) => ({ setNum: Number(s), reps: rs }));
  }, [reps]);

  const totalReps  = reps.length;
  const avgTime    = totalReps > 0 ? reps.reduce((a, r) => a + r.actual_time_s, 0) / totalReps : 0;
  const maxWeight  = Math.max(...reps.map(r => r.weight_kg), 0);
  const hasForce   = reps.some(r => r.avg_force_kg > 0 && r.avg_force_kg < 500);

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
      {leveledUp && (
        <Card style={{ background: "#1c1f0a", borderColor: C.green, marginBottom: 20 }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 48 }}>{LEVEL_EMOJIS[Math.min(newLevel - 1, LEVEL_EMOJIS.length - 1)]}</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: C.green }}>Level Up!</div>
            <div style={{ fontSize: 16, color: C.text, marginTop: 4 }}>
              {levelTitle(newLevel)}
            </div>
            <div style={{ fontSize: 13, color: C.muted, marginTop: 6 }}>
              5% load improvement — keep going
            </div>
          </div>
        </Card>
      )}

      <h2 style={{ margin: "0 0 16px", fontSize: 22 }}>Session Complete</h2>

      <Card>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, textAlign: "center" }}>
          <div>
            <Label>Total Reps</Label>
            <div style={{ fontSize: 28, fontWeight: 700 }}>{totalReps}</div>
          </div>
          <div>
            <Label>Avg Time</Label>
            <div style={{ fontSize: 28, fontWeight: 700 }}>{fmtTime(avgTime)}</div>
          </div>
          <div>
            <Label>Top Weight</Label>
            <div style={{ fontSize: 28, fontWeight: 700 }}>{fmtW(maxWeight, unit)} {unit}</div>
          </div>
          {hasForce && (
            <div style={{ gridColumn: "1 / -1" }}>
              <Label>Avg Force (Tindeq)</Label>
              <div style={{ fontSize: 22, fontWeight: 700, color: C.green }}>
                {fmtW(reps.reduce((a, r) => a + (r.avg_force_kg || 0), 0) / reps.filter(r => r.avg_force_kg > 0).length, unit)} {unit}
              </div>
            </div>
          )}
        </div>
      </Card>

      {sets.map(({ setNum, reps: sReps }) => (
        <Card key={setNum}>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 10 }}>Set {setNum}</div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ color: C.muted }}>
                <th style={{ textAlign: "left", paddingBottom: 6 }}>Rep</th>
                <th style={{ textAlign: "right", paddingBottom: 6 }}>Weight</th>
                <th style={{ textAlign: "right", paddingBottom: 6 }}>Time</th>
                {hasForce && <th style={{ textAlign: "right", paddingBottom: 6 }}>Avg F</th>}
              </tr>
            </thead>
            <tbody>
              {sReps.map(r => (
                <tr key={r.rep_num} style={{ borderTop: `1px solid ${C.border}` }}>
                  <td style={{ padding: "6px 0" }}>{r.rep_num}</td>
                  <td style={{ textAlign: "right" }}>{fmtW(r.weight_kg, unit)} {unit}</td>
                  <td style={{ textAlign: "right", color: r.actual_time_s >= config.targetTime ? C.green : C.red }}>
                    {fmtTime(r.actual_time_s)}
                  </td>
                  {hasForce && (
                    <td style={{ textAlign: "right", color: C.green }}>
                      {r.avg_force_kg > 0 ? `${fmtW(r.avg_force_kg, unit)} ${unit}` : "—"}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ))}

      <div style={{ display: "flex", gap: 12 }}>
        <Btn onClick={() => downloadCSV(reps)} color={C.muted} style={{ flex: 1 }}>
          ↓ Export CSV
        </Btn>
        <Btn onClick={onDone} style={{ flex: 2 }}>
          Back to Setup
        </Btn>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// HISTORY VIEW
// WorkoutHistoryView now lives in src/views/WorkoutHistoryView.js (imported above).

// HistoryView now lives in src/views/HistoryView.js (imported above).

// All four Trends sub-views (TrendsView wrapper + WorkoutTrendsView,
// BodyWeightTrendsView, ClimbingTrendsView) and the weekKey helper now
// live in src/views/TrendsView.js (imported above).

// AnalysisView (and its private helpers ZONE_DETAILS + buildRecFromFit)
// now lives in src/views/AnalysisView.js (imported above).

// ─────────────────────────────────────────────────────────────
// SETTINGS VIEW
// ─────────────────────────────────────────────────────────────
// SettingsView now lives in src/views/SettingsView.js (imported above).

// ─────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────
// BadgesView now lives in src/views/BadgesView.js (imported above).

// ─────────────────────────────────────────────────────────────
// AUTO REP SESSION VIEW
// ─────────────────────────────────────────────────────────────
// Touchless session mode for spring-strap / pre-calibrated setups.
// Tindeq detects pull start and release automatically — no button taps needed.
// Each detected rep calls onRepDone with {actualTime, avgForce, failed:false}.
function AutoRepSessionView({ session, onRepDone, onAbort, tindeq, unit = "lbs" }) {
  const { config, currentSet, currentRep, activeHand, refWeights } = session;
  const handLabel = config.hand === "Both"
    ? (activeHand === "L" ? "Left Hand" : "Right Hand")
    : config.hand === "L" ? "Left Hand" : "Right Hand";

  // Program-recommended target weight for the active hand.
  // Held CONSTANT within a set — the user hangs the same load each rep and
  // we record how actual_time_s changes. Those rep-time curves then feed
  // the next session's prescription via the Monod fit. We intentionally do
  // NOT discount the suggested weight by within-set fatigue.
  const suggestedKg = useMemo(
    () => suggestWeight(refWeights?.[activeHand] ?? null, 0),
    [refWeights, activeHand]
  );

  // Keep Tindeq's target ref in sync so the force gauge & auto-fail threshold
  // reflect the program recommendation during the rep.
  useEffect(() => {
    tindeq.targetKgRef.current = suggestedKg;
    return () => { tindeq.targetKgRef.current = null; };
  }, [tindeq, suggestedKg]);

  const [repActive, setRepActive] = useState(false);
  const [elapsed,   setElapsed]   = useState(0);
  const startTimeRef = useRef(null);
  const timerRef     = useRef(null);

  const handleRepEnd = useCallback(({ actualTime, avgForce }) => {
    clearInterval(timerRef.current);
    setRepActive(false);
    setElapsed(0);
    startTimeRef.current = null;
    onRepDone({ actualTime, avgForce, failed: false });
  }, [onRepDone]);

  const handleRepStart = useCallback(() => {
    startTimeRef.current = Date.now();
    setRepActive(true);
    setElapsed(0);
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 100);
  }, []);

  useEffect(() => {
    tindeq.startAutoDetect(handleRepStart, handleRepEnd);
    return () => {
      tindeq.stopAutoDetect();
      clearInterval(timerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);  // mount/unmount only — handleRepStart/End are stable refs

  const targetReached = elapsed >= config.targetTime;

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 13, color: C.muted }}>Set {currentSet + 1} of {config.numSets}</div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{config.grip} · {handLabel}</div>
        </div>
        <Btn small color={C.red} onClick={onAbort}>End Session</Btn>
      </div>

      <RepDots total={config.repsPerSet} done={currentRep} current={currentRep} />

      {/* Status card */}
      <Card style={{ textAlign: "center", padding: "32px 16px", marginTop: 12 }}>
        {repActive ? (
          <>
            <div style={{ fontSize: 13, color: C.muted, marginBottom: 8 }}>Holding — release when done</div>
            <div style={{
              fontSize: 96, fontWeight: 900, lineHeight: 1,
              color: targetReached ? C.green : C.blue,
              fontVariantNumeric: "tabular-nums",
            }}>
              {elapsed}s
            </div>
            <div style={{ fontSize: 13, color: C.muted, marginTop: 8 }}>
              target {config.targetTime}s
              {targetReached && <span style={{ color: C.green, marginLeft: 8 }}>✓ target reached</span>}
            </div>
          </>
        ) : (
          <>
            <div style={{
              fontSize: 13, color: C.muted, letterSpacing: 1.2,
              textTransform: "uppercase", marginBottom: 4,
            }}>Use your</div>
            <div style={{
              fontSize: 32, fontWeight: 900,
              color: activeHand === "R" ? C.orange : C.blue,
              marginBottom: 14,
            }}>
              {activeHand === "R" ? "✋ Right Hand" : "🤚 Left Hand"}
            </div>

            {/* Program-recommended target weight */}
            <div style={{
              fontSize: 11, color: C.muted, letterSpacing: 1.2,
              textTransform: "uppercase", marginBottom: 2,
            }}>
              Program target
            </div>
            <div style={{
              fontSize: 44, fontWeight: 900, color: C.blue,
              lineHeight: 1, marginBottom: 14,
              fontVariantNumeric: "tabular-nums",
            }}>
              {suggestedKg != null ? `${fmtW(suggestedKg, unit)} ${unit}` : "—"}
            </div>

            <div style={{ fontSize: 40, marginBottom: 8 }}>⬇</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: C.text }}>Pull to begin rep {currentRep + 1}</div>
            <div style={{ fontSize: 13, color: C.muted, marginTop: 8 }}>
              Target: <strong>{config.targetTime}s</strong> · Release when done
            </div>
          </>
        )}
      </Card>

      {/* Live force */}
      {tindeq.connected && (
        <Card style={{ marginTop: 12 }}>
          <ForceGauge
            force={tindeq.force}
            avg={tindeq.avgForce}
            peak={tindeq.peak}
            targetKg={suggestedKg}
            unit={unit}
          />
        </Card>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// WORKOUT PLAN
// ─────────────────────────────────────────────────────────────
const LS_WORKOUT_PLAN_KEY    = "ft_workout_plan";
const LS_WORKOUT_STATE_KEY   = "ft_workout_state";
// LS_WORKOUT_LOG_KEY, LS_WORKOUT_SYNCED_KEY, LS_WORKOUT_DELETED_KEY,
// LS_HISTORY_DOMAIN_KEY now live in src/lib/storage.js (imported above).
const LS_TRIP_KEY            = "ft_trip";            // { date: "YYYY-MM-DD", name: "Tensleep" }

// DEFAULT_TRIP, parseTripDate, weeksToTrip, tripCountdown now live in
// src/lib/trip.js (imported above).

// 3-day workout rotation: F (Fingers/Power) → S (Strength) → H (Hypertrophy).
const WK_ROTATION = ["A", "B", "C"];

const WTYPE_META = {
  F: { label: "F", bg: "#1a2d4a", color: "#58a6ff" },
  S: { label: "S", bg: "#2d1f00", color: "#e3b341" },
  H: { label: "H", bg: "#2d0000", color: "#f85149" },
  P: { label: "P", bg: "#2d1200", color: "#f0883e" },
  C: { label: "C", bg: "#002d10", color: "#3fb950" },
  X: { label: "↔", bg: "#1e1e2e", color: "#8b949e" },
};

// Exercise substitution options — shown during a live session when equipment is unavailable.
// Keys are exercise IDs from DEFAULT_WORKOUTS; values are arrays of alternatives.
// Swaps are session-only and do not modify the plan template.
const EXERCISE_SUBSTITUTES = {
  bench_press:   [
    { id: "ohp",           name: "Overhead press",         type: "S", reps: "5",       logWeight: true,  note: "KB or barbell" },
    { id: "kb_press",      name: "KB press",               type: "S", reps: "5",       logWeight: true,  note: "Good shoulder stability option" },
    { id: "push_ups",      name: "Push-ups",               type: "S", reps: "8–12",    logWeight: false, note: "Weighted vest if bodyweight is easy" },
  ],
  ohp:           [
    { id: "bench_press",   name: "Bench press",            type: "S", reps: "5",       logWeight: true,  note: "" },
    { id: "kb_press",      name: "KB press",               type: "S", reps: "5",       logWeight: true,  note: "" },
    { id: "push_ups",      name: "Push-ups",               type: "S", reps: "8–12",    logWeight: false, note: "Weighted vest if bodyweight is easy" },
  ],
  pull_ups:      [
    { id: "lat_pulldown",  name: "Lat pulldown",           type: "S", reps: "5",       logWeight: true,  note: "" },
    { id: "ring_rows",     name: "Ring rows",              type: "S", reps: "8–10",    logWeight: false, note: "Elevate feet to increase difficulty" },
    { id: "band_pullups",  name: "Band-assisted pull-ups", type: "S", reps: "5",       logWeight: false, note: "" },
  ],
  landmine_rows: [
    { id: "db_rows",       name: "DB rows",                type: "S", reps: "5/side",  logWeight: true,  note: "" },
    { id: "cable_rows",    name: "Cable rows",             type: "S", reps: "5",       logWeight: true,  note: "" },
    { id: "trx_rows",      name: "TRX rows",               type: "S", reps: "8–10",    logWeight: false, note: "Feet elevated for more load" },
  ],
  dips:          [
    { id: "close_bench",   name: "Close-grip bench",       type: "S", reps: "5",       logWeight: true,  note: "" },
    { id: "tricep_ext",    name: "Tricep extension",       type: "S", reps: "8–10",    logWeight: true,  note: "Cable or DB" },
    { id: "kb_press",      name: "KB press",               type: "S", reps: "5",       logWeight: true,  note: "" },
  ],
  rdl:           [
    { id: "good_morning",  name: "Good mornings",          type: "H", reps: "5",       logWeight: true,  note: "" },
    { id: "kb_deadlift",   name: "KB deadlift",            type: "H", reps: "5",       logWeight: true,  note: "" },
    { id: "hip_hinge",     name: "Hip hinge (band)",       type: "H", reps: "8–10",    logWeight: false, note: "Band around hips, hinge toward wall" },
  ],
  trx_ham_curl:  [
    { id: "nordic_curl",   name: "Nordic curl",            type: "H", reps: "3–5",     logWeight: false, note: "Slow lowering; add 1 rep/1–2 wks" },
    { id: "sb_ham_curl",   name: "Stability ball curl",    type: "H", reps: "8–10",    logWeight: false, note: "" },
    { id: "glute_bridge",  name: "Single-leg glute bridge",type: "H", reps: "10/side", logWeight: false, note: "" },
  ],
  goblet_squat:  [
    { id: "step_up",       name: "Step-up",                type: "S", reps: "6–8/side",logWeight: true,  note: "Climbing & hiking strength" },
    { id: "box_squat",     name: "Box squat",              type: "S", reps: "5",       logWeight: true,  note: "" },
    { id: "split_squat",   name: "Bulgarian split squat",  type: "S", reps: "6/side",  logWeight: true,  note: "" },
  ],
  step_up:       [
    { id: "goblet_squat",  name: "Goblet squat",           type: "S", reps: "8",       logWeight: true,  note: "Joint health — keep load moderate" },
    { id: "split_squat",   name: "Bulgarian split squat",  type: "S", reps: "6/side",  logWeight: true,  note: "" },
    { id: "lunge",         name: "Reverse lunge",          type: "S", reps: "8/side",  logWeight: true,  note: "" },
  ],
  bicep_curls:   [
    { id: "hammer_curls",  name: "Hammer curls",           type: "S", reps: "8",       logWeight: true,  note: "Brachialis emphasis" },
    { id: "band_curls",    name: "Band curls",             type: "S", reps: "10–12",   logWeight: false, note: "" },
    { id: "chin_up",       name: "Chin-ups (supinated)",   type: "S", reps: "5",       logWeight: true,  note: "Direct bicep transfer" },
  ],
  slam_balls:    [
    { id: "med_ball",      name: "Medicine ball throw",    type: "P", reps: "8–10",    logWeight: true,  note: "" },
    { id: "broad_jump",    name: "Broad jump",             type: "P", reps: "6–8",     logWeight: false, note: "" },
    { id: "box_jump",      name: "Box jump",               type: "P", reps: "6–8",     logWeight: false, note: "" },
  ],
  kb_snatch:     [
    { id: "kb_swing",      name: "KB swing",               type: "P", reps: "10",      logWeight: true,  note: "" },
    { id: "db_snatch",     name: "DB snatch",              type: "P", reps: "5/side",  logWeight: true,  note: "" },
    { id: "power_clean",   name: "Power clean",            type: "P", reps: "5",       logWeight: true,  note: "" },
  ],
};

const DEFAULT_WORKOUTS = {
  A: {
    name: "Lift Day 1 (Push + Pull)",
    exercises: [
      { id: "pull_ups",      name: "Weighted pull-ups",     type: "S", sets: 2,    reps: "5",      logWeight: true,  note: "Add weight when all reps clean" },
      { id: "landmine_rows", name: "One-arm landmine rows", type: "S", sets: 2,    reps: "5/side", logWeight: true,  note: "Alternate sides" },
      { id: "bench_press",   name: "Bench press",           type: "S", sets: 2,    reps: "5",      logWeight: true,  note: "" },
      { id: "dips",          name: "Dips",                  type: "S", sets: 2,    reps: "5",      logWeight: true,  note: "Weighted when bodyweight is easy" },
      { id: "bicep_curls",   name: "Bicep curls",           type: "S", sets: 2,    reps: "8",      logWeight: true,  note: "Undercling strength" },
      { id: "rdl",           name: "RDL",                   type: "H", sets: 2,    reps: "3–5",    logWeight: true,  note: "Heavy — load in lengthened position" },
      { id: "trx_ham_curl",  name: "TRX hamstring curl",    type: "H", sets: 2,    reps: "6–8",    logWeight: false, note: "Slow eccentric; single-leg when ready" },
      { id: "goblet_squat",  name: "Goblet squat",          type: "S", sets: 1,    reps: "8",      logWeight: true,  note: "Joint health — keep load moderate" },
      { id: "stretch",       name: "Stretching",            type: "X", sets: null, reps: null,     logWeight: false, note: "Couch · Splits machine · Hamstring lockout · Forearms · Lat" },
    ],
  },
  B: {
    name: "Lift Day 2 (Push + Pull)",
    exercises: [
      { id: "pull_ups",      name: "Weighted pull-ups",     type: "S", sets: 2,    reps: "5",      logWeight: true,  note: "Add weight when all reps clean" },
      { id: "landmine_rows", name: "One-arm landmine rows", type: "S", sets: 2,    reps: "5/side", logWeight: true,  note: "Alternate sides" },
      { id: "ohp",           name: "Overhead press",        type: "S", sets: 2,    reps: "5",      logWeight: true,  note: "KB or barbell" },
      { id: "dips",          name: "Dips",                  type: "S", sets: 2,    reps: "5",      logWeight: true,  note: "Weighted when bodyweight is easy" },
      { id: "bicep_curls",   name: "Bicep curls",           type: "S", sets: 2,    reps: "8",      logWeight: true,  note: "Undercling strength" },
      { id: "rdl",           name: "RDL",                   type: "H", sets: 2,    reps: "3–5",    logWeight: true,  note: "Heavy — load in lengthened position" },
      { id: "trx_ham_curl",  name: "TRX hamstring curl",    type: "H", sets: 2,    reps: "6–8",    logWeight: false, note: "Slow eccentric; single-leg when ready" },
      { id: "step_up",       name: "Step-up",               type: "S", sets: 1,    reps: "6–8/side", logWeight: true, note: "Climbing & hiking strength — load when bodyweight easy" },
      { id: "stretch",       name: "Stretching",            type: "X", sets: null, reps: null,     logWeight: false, note: "Couch · Splits machine · Hamstring lockout · Forearms · Lat" },
    ],
  },
  C: {
    name: "Power",
    exercises: [
      { id: "slam_balls",  name: "Slam balls", type: "P", sets: 2,    reps: "8–10",   logWeight: true,  note: "Advance weight when 10 reps hold full speed" },
      { id: "kb_snatch",   name: "KB snatch",  type: "P", sets: 2,    reps: "5/side", logWeight: true,  note: "Full hip snap, crisp catch" },
      { id: "stretch",     name: "Stretching", type: "X", sets: null, reps: null,     logWeight: false, note: "Couch · Splits machine · Hamstring lockout · Forearms · Lat" },
    ],
  },
};

// ── Type badge ────────────────────────────────────────────────
function WTypeBadge({ type }) {
  const m = WTYPE_META[type] || WTYPE_META.X;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      width: 30, height: 30, borderRadius: "50%", flexShrink: 0,
      background: m.bg, color: m.color, fontSize: 11, fontWeight: 700,
    }}>{m.label}</span>
  );
}

// ── Exercise row (read-only) ──────────────────────────────────
function ExerciseRow({ ex, last }) {
  const setsReps = [ex.sets && `${ex.sets}×`, ex.reps].filter(Boolean).join(" ");
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12,
      padding: "11px 0",
      borderBottom: last ? "none" : `1px solid ${C.border}`,
    }}>
      <WTypeBadge type={ex.type} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, color: C.text }}>{ex.name}</div>
        {ex.note ? <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{ex.note}</div> : null}
      </div>
      {setsReps && (
        <div style={{ fontSize: 13, color: C.muted, whiteSpace: "nowrap" }}>{setsReps}</div>
      )}
    </div>
  );
}

// ── Session logging row ───────────────────────────────────────
function SessionExRow({ ex, unit, prevSets, setsData, onSetsChange, done, onToggle, last }) {
  const allSetsDone = ex.logWeight && setsData?.sets
    ? setsData.sets.every(s => s.done)
    : !!done;
  const inputStyle = {
    width: 72, background: C.bg, border: `1px solid ${C.border}`,
    color: C.text, borderRadius: 6, padding: "4px 7px", fontSize: 14,
    textAlign: "center",
  };
  const doneBtn = (isDone, onPress) => (
    <button onClick={onPress} style={{
      width: 28, height: 28, borderRadius: "50%", flexShrink: 0,
      background: isDone ? C.green : "transparent",
      border: `2px solid ${isDone ? C.green : C.border}`,
      color: isDone ? "#000" : C.muted,
      cursor: "pointer", fontSize: 12, display: "flex",
      alignItems: "center", justifyContent: "center",
    }}>{isDone ? "✓" : ""}</button>
  );
  return (
    <div style={{
      padding: "12px 0",
      borderBottom: last ? "none" : `1px solid ${C.border}`,
      opacity: allSetsDone ? 0.55 : 1,
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <WTypeBadge type={ex.type} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, color: C.text }}>{ex.name}</div>
          {ex.note ? <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{ex.note}</div> : null}

          {ex.logWeight && setsData?.sets ? (
            // ── Per-set rows ──
            <div style={{ marginTop: 10 }}>
              {/* Column headers */}
              <div style={{ display: "flex", gap: 8, marginBottom: 6, alignItems: "center" }}>
                <span style={{ fontSize: 11, color: C.muted, width: 36, flexShrink: 0 }}></span>
                <span style={{ fontSize: 11, color: C.muted, width: 48, textAlign: "center" }}>reps</span>
                <span style={{ fontSize: 11, color: C.muted, width: 72, textAlign: "center" }}>weight</span>
                {prevSets?.length > 0 && (
                  <span style={{ fontSize: 11, color: C.muted, width: 44, textAlign: "center" }}>prev</span>
                )}
              </div>

              {setsData.sets.map((s, i) => {
                const isExtra = i >= (ex.sets || 0);
                return (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    {/* Set label */}
                    <span style={{ fontSize: 12, color: isExtra ? C.orange : C.muted, width: 36, flexShrink: 0 }}>
                      S{i + 1}
                    </span>
                    {/* Reps input */}
                    <input
                      type="text" inputMode="text"
                      value={s.reps ?? ex.reps ?? ""}
                      onChange={e => {
                        const next = [...setsData.sets];
                        next[i] = { ...next[i], reps: e.target.value };
                        onSetsChange({ sets: next });
                      }}
                      style={{ ...inputStyle, width: 48, fontSize: 13 }}
                      placeholder={ex.reps || ""}
                    />
                    {/* Weight input */}
                    <input
                      type="number" inputMode="decimal"
                      value={s.weight}
                      onChange={e => {
                        const next = [...setsData.sets];
                        next[i] = { ...next[i], weight: e.target.value };
                        onSetsChange({ sets: next });
                      }}
                      style={inputStyle}
                    />
                    <span style={{ fontSize: 12, color: C.muted }}>{unit}</span>
                    {/* Prev weight */}
                    {prevSets?.[i] ? (
                      <span style={{ fontSize: 12, color: C.muted, width: 44 }}>{prevSets[i]}</span>
                    ) : prevSets?.length > 0 ? (
                      <span style={{ width: 44 }} />
                    ) : null}
                    {/* Done button */}
                    {doneBtn(s.done, () => {
                      const next = [...setsData.sets];
                      next[i] = { ...next[i], done: !next[i].done };
                      onSetsChange({ sets: next });
                    })}
                    {/* Remove extra set */}
                    {isExtra && (
                      <button
                        onClick={() => onSetsChange({ sets: setsData.sets.filter((_, j) => j !== i) })}
                        style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 14, padding: "0 2px", lineHeight: 1 }}
                        title="Remove this set"
                      >−</button>
                    )}
                  </div>
                );
              })}

              {/* Add set button */}
              <button
                onClick={() => onSetsChange({
                  sets: [...setsData.sets, { weight: "", reps: ex.reps || "", done: false }]
                })}
                style={{
                  marginTop: 4, width: "100%", padding: "5px 0",
                  background: "none", border: `1px dashed ${C.border}`,
                  color: C.muted, borderRadius: 6, fontSize: 12, cursor: "pointer",
                }}
              >+ Set</button>
            </div>
          ) : (
            // ── No weight, just reps label ──
            <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>
              {[ex.sets && `${ex.sets}×`, ex.reps].filter(Boolean).join(" ")}
            </div>
          )}
        </div>
        {/* Single done button for non-weight exercises */}
        {!ex.logWeight && doneBtn(!!done, onToggle)}
      </div>
    </div>
  );
}

// ── Plan editor for one workout ───────────────────────────────
function WorkoutEditor({ wKey, workout, onSave, onClose, onReset }) {
  const [exercises, setExercises] = useState(() => workout.exercises.map(e => ({ ...e })));
  const [name, setName] = useState(workout.name);

  const updateEx = (idx, field, val) => {
    setExercises(prev => prev.map((e, i) => i === idx ? { ...e, [field]: val } : e));
  };
  const addEx = () => setExercises(prev => [...prev, {
    id: `ex_${Date.now()}`, name: "New exercise", type: "S",
    sets: 3, reps: "5", logWeight: true, note: "",
  }]);
  const removeEx = (idx) => setExercises(prev => prev.filter((_, i) => i !== idx));
  const moveEx = (idx, dir) => {
    const next = [...exercises];
    const swapIdx = idx + dir;
    if (swapIdx < 0 || swapIdx >= next.length) return;
    [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
    setExercises(next);
  };

  const inputStyle = {
    background: C.bg, border: `1px solid ${C.border}`,
    color: C.text, borderRadius: 6, padding: "4px 8px", fontSize: 13,
  };

  return (
    <div style={{ padding: "0 16px 32px" }}>
      {/* Workout name */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 4 }}>Workout name</div>
        <input
          value={name} onChange={e => setName(e.target.value)}
          style={{ ...inputStyle, width: "100%", fontSize: 15 }}
        />
      </div>

      {/* Exercise rows */}
      {exercises.map((ex, idx) => (
        <div key={ex.id} style={{
          background: C.card, border: `1px solid ${C.border}`,
          borderRadius: 8, padding: 12, marginBottom: 8,
        }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
            {/* Type selector */}
            <select
              value={ex.type}
              onChange={e => updateEx(idx, "type", e.target.value)}
              style={{ ...inputStyle, width: 52 }}
            >
              {Object.keys(WTYPE_META).map(t => (
                <option key={t} value={t}>{WTYPE_META[t].label}</option>
              ))}
            </select>
            {/* Name */}
            <input
              value={ex.name}
              onChange={e => updateEx(idx, "name", e.target.value)}
              style={{ ...inputStyle, flex: 1 }}
            />
            {/* Move up/down */}
            <button onClick={() => moveEx(idx, -1)} style={{ ...inputStyle, padding: "4px 7px", cursor: "pointer" }}>↑</button>
            <button onClick={() => moveEx(idx, 1)}  style={{ ...inputStyle, padding: "4px 7px", cursor: "pointer" }}>↓</button>
            {/* Delete */}
            <button onClick={() => removeEx(idx)} style={{ ...inputStyle, padding: "4px 7px", color: C.red, cursor: "pointer" }}>✕</button>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 12, color: C.muted }}>Sets</span>
              <input
                type="number" value={ex.sets ?? ""}
                onChange={e => updateEx(idx, "sets", e.target.value ? Number(e.target.value) : null)}
                style={{ ...inputStyle, width: 48 }}
              />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 12, color: C.muted }}>Reps</span>
              <input
                value={ex.reps ?? ""}
                onChange={e => updateEx(idx, "reps", e.target.value || null)}
                style={{ ...inputStyle, width: 72 }}
              />
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.muted, cursor: "pointer" }}>
              <input
                type="checkbox" checked={!!ex.logWeight}
                onChange={e => updateEx(idx, "logWeight", e.target.checked)}
              />
              Log weight
            </label>
          </div>
          <div style={{ marginTop: 8 }}>
            <input
              value={ex.note || ""}
              onChange={e => updateEx(idx, "note", e.target.value)}
              placeholder="Note (optional)"
              style={{ ...inputStyle, width: "100%", fontSize: 12 }}
            />
          </div>
        </div>
      ))}

      <button onClick={addEx} style={{
        width: "100%", padding: "10px", marginBottom: 8,
        background: "transparent", border: `1px dashed ${C.border}`,
        color: C.muted, borderRadius: 8, cursor: "pointer", fontSize: 14,
      }}>+ Add exercise</button>

      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button onClick={() => onSave(name, exercises)} style={{
          flex: 1, padding: "11px", background: C.blue, color: "#000",
          border: "none", borderRadius: 8, fontWeight: 700, cursor: "pointer", fontSize: 14,
        }}>Save</button>
        <button onClick={onClose} style={{
          flex: 1, padding: "11px", background: C.bg, color: C.text,
          border: `1px solid ${C.border}`, borderRadius: 8, cursor: "pointer", fontSize: 14,
        }}>Cancel</button>
        <button onClick={onReset} style={{
          padding: "11px 14px", background: C.bg, color: C.red,
          border: `1px solid ${C.red}`, borderRadius: 8, cursor: "pointer", fontSize: 13,
        }}>Reset</button>
      </div>
    </div>
  );
}

// ── Main WorkoutTab ───────────────────────────────────────────
function WorkoutTab({ unit, onSessionSaved, onBwSave = () => {}, trip = DEFAULT_TRIP }) {
  const [subTab, setSubTab]         = useState("today");
  const [plan,   setPlan]           = useState(() => loadLS(LS_WORKOUT_PLAN_KEY)  || DEFAULT_WORKOUTS);
  const [wState, setWState]         = useState(() => loadLS(LS_WORKOUT_STATE_KEY) || { rotationIndex: 0, sessionCount: 0 });
  const [wLog,   setWLog]           = useState(() => loadLS(LS_WORKOUT_LOG_KEY)   || []);
  const [sessionActive,  setSessionActive]  = useState(false);
  const [sessionData,    setSessionData]    = useState({});    // exId → {sets, done}
  const [swaps,          setSwaps]          = useState({});    // originalExId → substituteEx
  const [swapPickerFor,  setSwapPickerFor]  = useState(null);  // originalExId showing picker
  const [editingKey, setEditingKey] = useState(null);          // "A"|"B"|"C"|null

  const savePlan  = (p) => { setPlan(p);  saveLS(LS_WORKOUT_PLAN_KEY,  p); };
  const saveState = (s) => { setWState(s); saveLS(LS_WORKOUT_STATE_KEY, s); };
  const saveLog   = (l) => { setWLog(l);  saveLS(LS_WORKOUT_LOG_KEY,   l); };

  const rotKey    = WK_ROTATION[wState.rotationIndex % WK_ROTATION.length];
  // displayKey: the workout currently being previewed / logged. Defaults to the
  // recommendation (rotKey) but the user can override via the picker below.
  // If the user picks something other than rotKey and completes it, we log the
  // session but do NOT advance the rotation — so the "next up" queue persists.
  const [displayKey, setDisplayKey] = useState(rotKey);
  // If the recommendation changes (after a normal completion), reset the
  // displayed workout back to the new recommendation.
  useEffect(() => { setDisplayKey(rotKey); }, [rotKey]);
  const workout   = plan[displayKey] || plan[rotKey];
  const sessionN  = wState.sessionCount + 1;
  const wtr       = weeksToTrip(trip.date);

  // Switch the previewed workout. Clear any in-flight swaps since they
  // reference exercise IDs from the previous workout.
  const pickWorkout = (k) => {
    if (k === displayKey) return;
    setDisplayKey(k);
    setSwaps({});
    setSwapPickerFor(null);
  };

  // Previous best set weights for an exercise in this workout slot
  const prevBestSets = (exId) => {
    for (let i = wLog.length - 1; i >= 0; i--) {
      const e = wLog[i];
      if (e.workout === displayKey && e.exercises?.[exId]?.sets) {
        return e.exercises[exId].sets.map(s => s.weight).filter(Boolean);
      }
    }
    return [];
  };

  const startSession = () => {
    // Pre-populate weights and reps from last session for this workout
    const prevLog = [...wLog].reverse().find(e => e.workout === displayKey);
    const init = {};
    workout.exercises.forEach(ex => {
      const prevEx = prevLog?.exercises?.[ex.id];
      if (ex.logWeight && ex.sets) {
        init[ex.id] = {
          sets: Array.from({ length: ex.sets }, (_, i) => ({
            weight: prevEx?.sets?.[i]?.weight || "",
            reps:   prevEx?.sets?.[i]?.reps   || ex.reps || "",
            done: false,
          }))
        };
      } else {
        init[ex.id] = { done: false };
      }
    });
    setSessionData(init);
    setSwaps({});
    setSwapPickerFor(null);
    setSessionActive(true);
  };

  // Swap an exercise for the current session only
  const doSwap = (originalEx, substituteEx) => {
    const numSets = originalEx.sets || 2;
    setSessionData(prev => {
      const next = { ...prev };
      delete next[originalEx.id];
      next[substituteEx.id] = substituteEx.logWeight
        ? { sets: Array.from({ length: numSets }, () => ({ weight: "", reps: substituteEx.reps || "", done: false })) }
        : { done: false };
      return next;
    });
    setSwaps(prev => ({ ...prev, [originalEx.id]: { ...substituteEx, sets: numSets } }));
    setSwapPickerFor(null);
  };

  const revertSwap = (originalEx) => {
    const numSets = originalEx.sets || 2;
    const swapped = swaps[originalEx.id];
    setSessionData(prev => {
      const next = { ...prev };
      if (swapped) delete next[swapped.id];
      next[originalEx.id] = originalEx.logWeight
        ? { sets: Array.from({ length: numSets }, () => ({ weight: "", reps: originalEx.reps || "", done: false })) }
        : { done: false };
      return next;
    });
    setSwaps(prev => { const s = { ...prev }; delete s[originalEx.id]; return s; });
    setSwapPickerFor(null);
  };

  const genId = () => {
    try { return crypto.randomUUID(); } catch { return `ws_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`; }
  };

  const completeSession = () => {
    const session = { id: genId(), date: today(), completedAt: nowISO(), workout: displayKey, sessionNumber: sessionN, exercises: sessionData };
    // Read fresh from localStorage rather than the React state snapshot, which may
    // be stale if the migration effect rewrote the log after this component mounted.
    const freshLog = loadLS(LS_WORKOUT_LOG_KEY) || [];
    saveLog([...freshLog, session]);
    if (onSessionSaved) onSessionSaved(session);
    // Only advance the rotation when the recommended workout was actually done.
    // Picking a different workout (one that is not the recommended rotKey) logs
    // the session but leaves the rotation queue alone so nothing gets skipped.
    const didRecommended = displayKey === rotKey && WK_ROTATION.includes(displayKey);
    saveState({
      rotationIndex: didRecommended
        ? (wState.rotationIndex + 1) % WK_ROTATION.length
        : wState.rotationIndex,
      sessionCount: wState.sessionCount + 1,
    });
    setSessionActive(false);
    setSessionData({});
    setSwaps({});
    setSwapPickerFor(null);
  };

  const allDone = workout && workout.exercises.every(ex => {
    const activeId = swaps[ex.id]?.id ?? ex.id;
    const d = sessionData[activeId];
    if (!d) return false;
    if (ex.logWeight && d.sets) return d.sets.every(s => s.done);
    return !!d.done;
  });

  // ── Sub-tab pill bar ──
  const tabPill = (label, key) => (
    <button
      key={key}
      onClick={() => { setSubTab(key); setEditingKey(null); }}
      style={{
        flex: 1, padding: "9px 0", fontSize: 13, fontWeight: subTab === key ? 700 : 400,
        color: subTab === key ? C.blue : C.muted,
        background: "none", border: "none",
        borderBottom: subTab === key ? `2px solid ${C.blue}` : "2px solid transparent",
        cursor: "pointer",
      }}
    >{label}</button>
  );

  // ── Week calendar ──
  const WEEK_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  const WEEK_ROLES  = ["Climb", "Train", "Rest", "Climb+Train", "Rest", "Climb+Train", "Sabbath"];
  const todayDow    = new Date().getDay(); // 0=Sun

  // ── Render ──
  return (
    <div style={{ padding: "16px 16px 80px" }}>
      {/* Sub-tab nav */}
      <div style={{ display: "flex", borderBottom: `1px solid ${C.border}`, marginBottom: 20 }}>
        {tabPill("Today", "today")}
        {tabPill("Plan", "plan")}
      </div>

      {/* ─── TODAY view ─────────────────────────────────────── */}
      {subTab === "today" && !sessionActive && (
        <>
          {/* Workout card */}
          <Card style={{ marginBottom: 12 }}>
            {/* Workout picker — recommended is highlighted; pick any for this session */}
            <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
              {Object.keys(plan).map(k => {
                const isPicked = k === displayKey;
                const isRec    = k === rotKey;
                return (
                  <button key={k} onClick={() => pickWorkout(k)} style={{
                    flex: 1, padding: "10px 4px", borderRadius: 10, cursor: "pointer",
                    background: isPicked ? C.blue : C.border,
                    color:      isPicked ? "#000" : C.muted,
                    fontWeight: 700, fontSize: 14,
                    border: isRec ? `2px solid ${C.blue}` : "2px solid transparent",
                    position: "relative", transition: "all 0.15s",
                  }}>
                    {isRec && (
                      <div style={{
                        position: "absolute", top: -8, left: "50%", transform: "translateX(-50%)",
                        fontSize: 9, fontWeight: 700, background: C.blue, color: "#000",
                        padding: "1px 6px", borderRadius: 6, whiteSpace: "nowrap",
                        letterSpacing: "0.06em",
                      }}>
                        NEXT UP
                      </div>
                    )}
                    {k}
                  </button>
                );
              })}
            </div>

            <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 14 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: C.muted, marginBottom: 2 }}>
                  WORKOUT {displayKey}
                  {displayKey === rotKey
                    ? "  ·  NEXT UP"
                    : <span style={{ color: C.orange }}>  ·  OUT OF ORDER — queue still starts with {rotKey}</span>
                  }
                </div>
                <div style={{ fontSize: 20, fontWeight: 700, color: C.text }}>{workout.name}</div>
                <div style={{ fontSize: 12, color: C.muted, marginTop: 3 }}>
                  {workout.exercises.filter(e => e.type !== "X").map(e => e.name).join(" · ")}
                </div>
              </div>
            </div>

            {/* Metrics row */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
              {[["Session #", sessionN], ["Weeks to trip", wtr]].map(([label, val]) => (
                <div key={label} style={{
                  background: C.bg, borderRadius: 8, padding: "10px 14px",
                  border: `1px solid ${C.border}`,
                }}>
                  <div style={{ fontSize: 11, color: C.muted }}>{label}</div>
                  <div style={{ fontSize: 24, fontWeight: 700, color: C.text }}>{val}</div>
                </div>
              ))}
            </div>

            {/* Exercise list — with swap UI on the preview card, so equipment
                substitutions can be set before starting the session. */}
            <div>
              {workout.exercises.map((ex, i) => {
                const isSwapped  = !!swaps[ex.id];
                const activeEx   = isSwapped ? { ...swaps[ex.id] } : ex;
                const subs       = EXERCISE_SUBSTITUTES[ex.id] || [];
                const pickerOpen = swapPickerFor === ex.id;
                const isLast     = i === workout.exercises.length - 1;
                return (
                  <div key={ex.id}>
                    {subs.length > 0 && (
                      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 2 }}>
                        <button
                          onClick={() => setSwapPickerFor(pickerOpen ? null : ex.id)}
                          style={{
                            fontSize: 11, padding: "2px 8px", borderRadius: 4, cursor: "pointer",
                            background: "none", border: `1px solid ${isSwapped ? C.orange : C.border}`,
                            color: isSwapped ? C.orange : C.muted,
                          }}
                        >
                          {isSwapped ? `⇄ ${activeEx.name} (swapped)` : "⇄ swap"}
                        </button>
                      </div>
                    )}
                    {pickerOpen && (
                      <div style={{
                        background: C.bg, border: `1px solid ${C.border}`,
                        borderRadius: 8, padding: "10px 12px", marginBottom: 8,
                      }}>
                        <div style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>
                          Substitute for <strong style={{ color: C.text }}>{ex.name}</strong>:
                        </div>
                        {isSwapped && (
                          <button
                            onClick={() => revertSwap(ex)}
                            style={{
                              display: "block", width: "100%", textAlign: "left",
                              padding: "8px 10px", marginBottom: 4, borderRadius: 6,
                              background: C.border, border: "none", cursor: "pointer",
                              fontSize: 13, color: C.text, fontWeight: 600,
                            }}
                          >
                            ↩ {ex.name} <span style={{ color: C.muted, fontWeight: 400 }}>(revert to original)</span>
                          </button>
                        )}
                        {subs.map(sub => (
                          <button
                            key={sub.id}
                            onClick={() => doSwap(ex, sub)}
                            style={{
                              display: "block", width: "100%", textAlign: "left",
                              padding: "8px 10px", marginBottom: 4, borderRadius: 6,
                              background: activeEx.id === sub.id ? C.orange + "22" : C.card,
                              border: `1px solid ${activeEx.id === sub.id ? C.orange : C.border}`,
                              cursor: "pointer", fontSize: 13, color: C.text,
                            }}
                          >
                            <span style={{ fontWeight: 600 }}>{sub.name}</span>
                            <span style={{ color: C.muted }}> · {sub.reps}</span>
                            {sub.note && <span style={{ color: C.muted, fontSize: 11 }}> — {sub.note}</span>}
                          </button>
                        ))}
                      </div>
                    )}
                    <ExerciseRow ex={activeEx} last={isLast} />
                  </div>
                );
              })}
            </div>

            <div style={{ marginTop: 16 }}>
              <BwPrompt unit={unit} onSave={onBwSave} />
            </div>
            <button
              onClick={startSession}
              style={{
                width: "100%", padding: "14px",
                background: C.blue, color: "#000",
                border: "none", borderRadius: 10, fontWeight: 700,
                fontSize: 16, cursor: "pointer",
              }}
            >Start session</button>
          </Card>

          {/* Week calendar */}
          <Card>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, marginBottom: 12, letterSpacing: 1 }}>THIS WEEK</div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              {WEEK_LABELS.map((lbl, i) => {
                const isToday = i === todayDow;
                const role = WEEK_ROLES[i];
                const abbr = role === "Climb+Train" ? "CT" : role === "Sabbath" ? "S" : role[0];
                return (
                  <div key={lbl} style={{ textAlign: "center", flex: 1 }}>
                    <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>{lbl}</div>
                    <div style={{
                      width: 34, height: 34, borderRadius: "50%", margin: "0 auto",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      border: isToday ? `2px solid ${C.blue}` : `1px solid ${C.border}`,
                      background: isToday ? "#1a2d4a" : C.bg,
                      fontSize: 11, fontWeight: isToday ? 700 : 400,
                      color: isToday ? C.blue : C.muted,
                    }}>{abbr}</div>
                  </div>
                );
              })}
            </div>
          </Card>
        </>
      )}

      {/* ─── SESSION ACTIVE view ────────────────────────────── */}
      {subTab === "today" && sessionActive && (
        <Card>
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: C.muted }}>WORKOUT {rotKey}  ·  SESSION #{sessionN}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: C.text }}>{workout.name}</div>
          </div>

          {workout.exercises.map((ex, i) => {
            const isSwapped  = !!swaps[ex.id];
            const activeEx   = isSwapped ? { ...swaps[ex.id] } : ex;
            const sKey       = activeEx.id;
            const subs       = EXERCISE_SUBSTITUTES[ex.id] || [];
            const pickerOpen = swapPickerFor === ex.id;
            const isLast     = i === workout.exercises.length - 1;

            return (
              <div key={ex.id}>
                {/* Swap button row */}
                {subs.length > 0 && (
                  <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 2 }}>
                    <button
                      onClick={() => setSwapPickerFor(pickerOpen ? null : ex.id)}
                      style={{
                        fontSize: 11, padding: "2px 8px", borderRadius: 4, cursor: "pointer",
                        background: "none", border: `1px solid ${isSwapped ? C.orange : C.border}`,
                        color: isSwapped ? C.orange : C.muted,
                      }}
                    >
                      {isSwapped ? `⇄ ${activeEx.name} (swapped)` : "⇄ swap"}
                    </button>
                  </div>
                )}

                {/* Inline swap picker */}
                {pickerOpen && (
                  <div style={{
                    background: C.bg, border: `1px solid ${C.border}`,
                    borderRadius: 8, padding: "10px 12px", marginBottom: 8,
                  }}>
                    <div style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>
                      Substitute for <strong style={{ color: C.text }}>{ex.name}</strong>:
                    </div>
                    {isSwapped && (
                      <button
                        onClick={() => revertSwap(ex)}
                        style={{
                          display: "block", width: "100%", textAlign: "left",
                          padding: "8px 10px", marginBottom: 4, borderRadius: 6,
                          background: C.border, border: "none", cursor: "pointer",
                          fontSize: 13, color: C.text, fontWeight: 600,
                        }}
                      >
                        ↩ {ex.name} <span style={{ color: C.muted, fontWeight: 400 }}>(revert to original)</span>
                      </button>
                    )}
                    {subs.map(sub => (
                      <button
                        key={sub.id}
                        onClick={() => doSwap(ex, sub)}
                        style={{
                          display: "block", width: "100%", textAlign: "left",
                          padding: "8px 10px", marginBottom: 4, borderRadius: 6,
                          background: activeEx.id === sub.id ? C.orange + "22" : C.card,
                          border: `1px solid ${activeEx.id === sub.id ? C.orange : C.border}`,
                          cursor: "pointer", fontSize: 13, color: C.text,
                        }}
                      >
                        <span style={{ fontWeight: 600 }}>{sub.name}</span>
                        <span style={{ color: C.muted }}> · {sub.reps}</span>
                        {sub.note && <span style={{ color: C.muted, fontSize: 11 }}> — {sub.note}</span>}
                      </button>
                    ))}
                  </div>
                )}

                <SessionExRow
                  ex={activeEx}
                  unit={unit}
                  prevSets={prevBestSets(sKey)}
                  setsData={sessionData[sKey]}
                  onSetsChange={(val) => setSessionData(prev => ({ ...prev, [sKey]: val }))}
                  done={!!sessionData[sKey]?.done}
                  onToggle={() => setSessionData(prev => ({
                    ...prev,
                    [sKey]: { ...prev[sKey], done: !prev[sKey]?.done },
                  }))}
                  last={isLast && !pickerOpen}
                />
              </div>
            );
          })}

          <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
            <button
              onClick={() => {
                if (allDone) {
                  completeSession();
                } else if (window.confirm("Some exercises aren't fully checked off — finish session anyway?")) {
                  completeSession();
                }
              }}
              style={{
                flex: 1, padding: "13px",
                background: allDone ? C.green : C.blue,
                color: "#000",
                border: "none", borderRadius: 10, fontWeight: 700,
                fontSize: 15, cursor: "pointer",
              }}
            >{allDone ? "Complete session ✓" : "Finish session →"}</button>
            <button
              onClick={() => { setSessionActive(false); setSessionData({}); setSwaps({}); setSwapPickerFor(null); }}
              style={{
                padding: "13px 16px", background: "transparent",
                border: `1px solid ${C.border}`, color: C.muted,
                borderRadius: 10, cursor: "pointer", fontSize: 14,
              }}
            >Abandon</button>
          </div>
        </Card>
      )}

      {/* ─── PLAN view ──────────────────────────────────────── */}
      {subTab === "plan" && (
        <>
          {editingKey ? (
            <WorkoutEditor
              wKey={editingKey}
              workout={plan[editingKey]}
              onSave={(name, exercises) => {
                savePlan({ ...plan, [editingKey]: { name, exercises } });
                setEditingKey(null);
              }}
              onClose={() => setEditingKey(null)}
              onReset={() => {
                if (window.confirm(`Reset Workout ${editingKey} to defaults?`)) {
                  savePlan({ ...plan, [editingKey]: DEFAULT_WORKOUTS[editingKey] });
                  setEditingKey(null);
                }
              }}
            />
          ) : (
            <>
              {/* Sequence rule callout */}
              <div style={{
                background: "#1a2d1a", border: `1px solid ${C.green}`,
                borderRadius: 8, padding: "10px 14px", marginBottom: 16,
                fontSize: 13, color: C.green,
              }}>
                <strong>A → B → C</strong>
                <span style={{ color: C.muted, fontWeight: 400 }}> · session-sequenced, not day-specific · C requires a rest day before climbing</span>
              </div>

              {/* Workout cards */}
              {["A", "B", "C"].map(key => {
                const wk = plan[key];
                const isNext = key === rotKey;
                return (
                  <Card key={key} style={{ marginBottom: 10, borderColor: isNext ? C.blue : C.border }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
                      <div style={{
                        width: 36, height: 36, borderRadius: 8, flexShrink: 0,
                        background: isNext ? "#1a2d4a" : C.bg,
                        border: `1px solid ${isNext ? C.blue : C.border}`,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 16, fontWeight: 800, color: isNext ? C.blue : C.muted,
                      }}>{key}</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{wk.name}</div>
                        <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
                          {wk.exercises.filter(e => e.type !== "X").map(e => e.name).join(" · ")}
                        </div>
                      </div>
                      <button
                        onClick={() => setEditingKey(key)}
                        style={{
                          padding: "6px 12px", background: "transparent",
                          border: `1px solid ${C.border}`, color: C.muted,
                          borderRadius: 6, cursor: "pointer", fontSize: 12,
                        }}
                      >Edit</button>
                    </div>
                    {wk.exercises.map((ex, i) => (
                      <ExerciseRow key={ex.id} ex={ex} last={i === wk.exercises.length - 1} />
                    ))}
                  </Card>
                );
              })}

              {/* Trip countdown — conjugate-friendly: countdown + taper window only */}
              {(() => {
                const cd = tripCountdown(trip.date);
                if (!cd) return null;
                const tripName = trip.name || "Trip";
                return (
                  <Card style={{ marginTop: 4 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, marginBottom: 10, letterSpacing: 1 }}>
                      {tripName.toUpperCase()} COUNTDOWN
                    </div>
                    {cd.past ? (
                      <div style={{ fontSize: 13, color: C.muted }}>
                        {cd.tripLabel} — trip date is in the past. Edit in Settings.
                      </div>
                    ) : (
                      <>
                        <div style={{ display: "flex", gap: 10, padding: "7px 0", borderBottom: `1px solid ${C.border}` }}>
                          <div style={{ fontSize: 13, color: C.yellow, fontWeight: 600, minWidth: 90 }}>
                            {cd.weeks}wk · {cd.days}d
                          </div>
                          <div style={{ fontSize: 13, color: C.muted }}>
                            Until {tripName} ({cd.tripLabel})
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 10, padding: "7px 0" }}>
                          <div style={{
                            fontSize: 13,
                            color: cd.inTaper ? C.red : C.yellow,
                            fontWeight: 600, minWidth: 90,
                          }}>
                            {cd.inTaper ? "TAPER" : cd.taperLabel}
                          </div>
                          <div style={{ fontSize: 13, color: C.muted }}>
                            {cd.inTaper
                              ? "Cut volume 40%, hold intensity"
                              : "Taper window starts (T−7d)"}
                          </div>
                        </div>
                      </>
                    )}
                  </Card>
                );
              })()}
            </>
          )}
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// CLIMBING TAB
// Dedicated home for logging individual climbs and reviewing
// climbing history (discipline / grade / ascent style). Separate
// from finger-training zone coverage by design — climbing is not
// credited to Power / Strength / Capacity buckets.
// ─────────────────────────────────────────────────────────────
// ClimbingTab now lives in src/views/ClimbingTab.js (imported above).

const TABS = ["Fingers", "Analysis", "Journey", "Workout", "Climbing", "History", "Trends", "Settings"];

export default function App() {
  // ── Auth ──────────────────────────────────────────────────
  const [user,       setUser]       = useState(null);
  const [loginEmail, setLoginEmail] = useState("");

  // ── Unit preference ───────────────────────────────────────
  const [unit, setUnit] = useState(() => loadLS("unit_pref") || "lbs");
  const saveUnit = (u) => { setUnit(u); saveLS("unit_pref", u); };

  // ── Body weight ───────────────────────────────────────────
  const [bodyWeight, setBodyWeight] = useState(() => loadLS(LS_BW_KEY) ?? null);
  const saveBW = (kg) => {
    setBodyWeight(kg);
    saveLS(LS_BW_KEY, kg);
    if (kg != null) {
      const log = loadLS(LS_BW_LOG_KEY) || [];
      const d = today();
      // Replace existing entry for today if present, otherwise append
      const updated = log.filter(e => e.date !== d);
      saveLS(LS_BW_LOG_KEY, [...updated, { date: d, kg }].sort((a, b) => a.date < b.date ? -1 : 1));
    }
  };

  // ── Trip (user-editable target trip) ──────────────────────
  const [trip, setTrip] = useState(() => {
    const stored = loadLS(LS_TRIP_KEY);
    return (stored && typeof stored === "object" && stored.date) ? stored : DEFAULT_TRIP;
  });
  const saveTrip = (next) => {
    const merged = { ...trip, ...next };
    setTrip(merged);
    saveLS(LS_TRIP_KEY, merged);
  };

  // ── Session notes ─────────────────────────────────────────
  const [notes, setNotes] = useState(() => loadLS(LS_NOTES_KEY) || {});
  const handleNoteChange = useCallback((sessKey, text) => {
    setNotes(prev => {
      const updated = text ? { ...prev, [sessKey]: text } : Object.fromEntries(
        Object.entries(prev).filter(([k]) => k !== sessKey)
      );
      saveLS(LS_NOTES_KEY, updated);
      return updated;
    });
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setUser(data.session?.user ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setUser(s?.user ?? null));
    return () => sub.subscription.unsubscribe();
  }, []);

  // ── History (all reps) ───────────────────────────────────
  const [history, setHistory] = useState(() => loadLS(LS_KEY) || []);
  useEffect(() => saveLS(LS_KEY, history), [history]);

  // App-level freshMap (fatigue-adjusted load lookup per rep). Lifted out
  // of SetupView so the in-workout startSession path uses the SAME memo
  // — without this, SetupView's prescription would compute with the
  // user-fitted doseK while startSession would fall back to DEF_DOSE_K
  // and produce a 1-2 lb discrepancy between Setup's "Prescribed load"
  // card and the in-workout "Rep 1 suggested weight." Sharing the memo
  // makes the two views byte-identical.
  const freshMapFp = useMemo(() => {
    const last = history[history.length - 1];
    return `${history.length}|${last?.id ?? ""}|${last?.date ?? ""}`;
  }, [history]);
  const freshMap = useMemo(() => {
    const k = fitDoseK(history) ?? PHYS_MODEL_DEFAULT.doseK;
    return buildFreshLoadMap(history, { doseK: k });
  }, [freshMapFp]); // eslint-disable-line react-hooks/exhaustive-deps

  // App-level three-exp per-grip priors. Hoisted out of SetupView /
  // AnalysisView so all three callers (Setup card, Analysis chart,
  // in-workout startSession) share one memo and pass the same priors
  // into prescribedLoad/empiricalPrescription/prescriptionPotential.
  // Without this, startSession was falling through to the Monod cold-
  // start fallback even when SetupView already had a usable prior,
  // producing different prescriptions between the two views.
  const threeExpPriors = useMemo(() => buildThreeExpPriors(history), [freshMapFp]); // eslint-disable-line react-hooks/exhaustive-deps

  // Track how many reps are waiting to be synced to Supabase.
  const [pendingCount, setPendingCount] = useState(() => (loadLS(LS_QUEUE_KEY) || []).length);
  const refreshPending = () => setPendingCount((loadLS(LS_QUEUE_KEY) || []).length);

  // Load from Supabase when signed in; reconcile any offline reps first.
  //
  // Flow:
  //   1. flushQueue() — retry reps that failed a previous authenticated push.
  //   2. fetchReps() — grab the current remote state.
  //   3. Reconcile — find local reps not present remotely (identified by
  //      session_id + set_num + rep_num + hand) and push those. This is
  //      the critical step: reps added while logged out live only in LS,
  //      and without this step they'd be overwritten by setHistory(remote).
  //   4. Re-fetch after pushes so state reflects the full merged set.
  //
  // Only replace local history if Supabase actually returned rows — an empty
  // response (expired JWT silently blocked by RLS, network hiccup, etc.) must
  // never wipe out a good local cache.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      const flushed = await flushQueue();
      if (!cancelled && flushed > 0) refreshPending();

      const remote = await fetchReps();
      if (cancelled) return;

      if (remote) {
        // Reconcile local-only reps (offline sessions) up to the cloud.
        const localReps = loadLS(LS_KEY) || [];
        const keyFor = r => `${r.session_id || r.date}|${r.set_num}|${r.rep_num}|${r.hand}`;
        const remoteKeys = new Set(remote.map(keyFor));
        const toSync = localReps.filter(r => !remoteKeys.has(keyFor(r)));

        let pushedAny = false;
        for (const rep of toSync) {
          const ok = await pushRep(rep);
          if (ok) pushedAny = true;
          else enqueueReps([rep]);
        }
        if (cancelled) return;

        // If we pushed offline reps, refetch so state includes them with
        // proper server-assigned ids. Otherwise use the first fetch.
        const finalReps = pushedAny ? (await fetchReps()) : remote;
        if (cancelled) return;
        if (finalReps && finalReps.length > 0) setHistory(finalReps);
      }

      if (!cancelled) refreshPending();
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // ── Workout session sync ─────────────────────────────────
  const markSynced = (id) => {
    if (!id) return;
    const s = new Set(loadLS(LS_WORKOUT_SYNCED_KEY) || []);
    s.add(id);
    saveLS(LS_WORKOUT_SYNCED_KEY, [...s]);
  };

  const handleWorkoutSessionSaved = useCallback(async (session) => {
    if (!user) return;
    const ok = await pushWorkoutSession(session);
    if (ok) markSynced(session.id);
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!user) return;
    fetchWorkoutSessions().then(async (remote) => {
      const local = loadLS(LS_WORKOUT_LOG_KEY) || [];

      // Mark all remote sessions as synced
      const remoteIds = new Set((remote || []).map(s => s.id).filter(Boolean));
      const synced = new Set(loadLS(LS_WORKOUT_SYNCED_KEY) || []);
      remoteIds.forEach(id => synced.add(id));

      // Merge any remote sessions not yet in local, skipping tombstoned deletions
      const localIds = new Set(local.map(s => s.id).filter(Boolean));
      const deletedIds = new Set(loadLS(LS_WORKOUT_DELETED_KEY) || []);
      const merged = [...local, ...(remote || []).filter(s => !localIds.has(s.id) && !deletedIds.has(s.id))];
      if (merged.length > local.length) saveLS(LS_WORKOUT_LOG_KEY, merged);

      // ── One-time migration: push local sessions missing from Supabase ──
      // Assign IDs to old sessions that never got one, then push all unsynced
      let changed = false;
      const genId = () => { try { return crypto.randomUUID(); } catch { return `ws_${Date.now()}_${Math.random().toString(36).slice(2,9)}`; } };
      const toMigrate = merged.map(s => {
        if (!s.id) { changed = true; return { ...s, id: genId() }; }
        return s;
      });
      if (changed) saveLS(LS_WORKOUT_LOG_KEY, toMigrate);

      for (const s of toMigrate) {
        if (!remoteIds.has(s.id) && !deletedIds.has(s.id)) {
          const ok = await pushWorkoutSession(s);
          if (ok) synced.add(s.id);
        }
      }

      saveLS(LS_WORKOUT_SYNCED_KEY, [...synced]);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const addReps = useCallback((newReps) => {
    setHistory(h => {
      const existing = new Set(h.map(r => r.id));
      const fresh    = newReps.filter(r => !existing.has(r.id));
      return [...fresh, ...h];
    });
    if (user) {
      // Push each rep; enqueue any that fail for later retry.
      newReps.forEach(rep => {
        pushRep(rep).then(ok => {
          if (!ok) { enqueueReps([rep]); refreshPending(); }
        });
      });
    }
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateSession = useCallback(async (sessionKey, updates) => {
    // updates: { hand?, grip?, target_duration? }
    setHistory(h => h.map(r =>
      (r.session_id || r.date) === sessionKey ? { ...r, ...updates } : r
    ));
    if (user) {
      const { error } = await supabase.from("reps")
        .update(updates)
        .eq("session_id", sessionKey);
      if (error) console.warn("Supabase update:", error.message);
    }
  }, [user]);

  // Rep-level identity: prefer Supabase id, fall back to composite key
  const repMatchKey = (r) =>
    r.id ? `id:${r.id}` : `${r.session_id || r.date}|${r.set_num}|${r.rep_num}`;

  const deleteRep = useCallback(async (rep) => {
    const k = repMatchKey(rep);
    setHistory(h => h.filter(r => repMatchKey(r) !== k));
    if (user && rep.id) {
      const { error } = await supabase.from("reps").delete().eq("id", rep.id);
      if (error) console.warn("Supabase deleteRep:", error.message);
    }
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateRep = useCallback(async (rep, updates) => {
    const k = repMatchKey(rep);
    setHistory(h => h.map(r => repMatchKey(r) === k ? { ...r, ...updates } : r));
    if (user && rep.id) {
      const { error } = await supabase.from("reps").update(updates).eq("id", rep.id);
      if (error) console.warn("Supabase updateRep:", error.message);
    }
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  const deleteSession = useCallback(async (sessionKey) => {
    // sessionKey is session_id or date (same key used in grouping)
    setHistory(h => h.filter(r => (r.session_id || r.date) !== sessionKey));
    if (user) {
      // Fetch the ids to delete (already removed from state, use a snapshot)
      // Delete from Supabase by session_id if available, else by date
      const { error } = await supabase.from("reps").delete()
        .or(`session_id.eq.${sessionKey},and(session_id.is.null,date.eq.${sessionKey})`);
      if (error) console.warn("Supabase delete:", error.message);
    }
  }, [user]);

  // ── Tab ───────────────────────────────────────────────────
  const [tab, setTab] = useState(0);

  // ── Readiness score ───────────────────────────────────────
  const computedReadiness = useMemo(() => computeReadiness(history), [history]);

  // Subjective daily check-in: { [date]: 1-5 }
  const [subjReadiness, setSubjReadiness] = useState(() => loadLS(LS_READINESS_KEY) || {});
  const todaySubj = subjReadiness[today()] ?? null; // null = not rated yet today

  const handleSubjReadiness = useCallback((val) => {
    setSubjReadiness(prev => {
      const updated = { ...prev, [today()]: val };
      saveLS(LS_READINESS_KEY, updated);
      return updated;
    });
  }, []);

  // Displayed readiness: subjective (1-5 scale → 1-10) if rated today,
  // otherwise the computed estimate from training history.
  const readiness = todaySubj != null ? todaySubj * 2 : computedReadiness;

  // ── Live CF/W′ estimate (all failure reps, both hands, all grips) ─────────────
  // Used by SessionPlannerCard and AnalysisView. Updates as training data grows.
  // All-grip adaptive fit — used as the overall curve when no single
  // grip is in focus (e.g. Badges view, fallback when user hasn't yet
  // picked a grip in Setup).
  //
  // Depends on freshMapFp (length+lastId+lastDate) instead of [history]
  // directly, same as freshMap, so unrelated state churn (cloud syncs
  // that touch the array reference without changing data) doesn't
  // re-fire the O(N) fit.
  const liveEstimate = useMemo(() => {
    const allFails = history.filter(r => r.failed && r.avg_force_kg > 0 && r.actual_time_s > 0);
    return fitAdaptiveHandCurve(allFails);
  }, [freshMapFp]); // eslint-disable-line react-hooks/exhaustive-deps

  // Per-grip adaptive fits. FDP and FDS are different muscles (pinch /
  // open-hand roller vs crush roller) with separate force-duration
  // curves; pooling them hides per-muscle training decisions. Each
  // grip gets its own Monod fit so the recommendation engine can pick
  // the right zone for the specific muscle being trained. Same
  // freshMapFp memoization rationale as liveEstimate above.
  const gripEstimates = useMemo(() => {
    const fails = history.filter(r => r.failed && r.grip && r.avg_force_kg > 0 && r.actual_time_s > 0);
    const byGrip = {};
    for (const r of fails) {
      if (!byGrip[r.grip]) byGrip[r.grip] = [];
      byGrip[r.grip].push(r);
    }
    const out = {};
    for (const [grip, rows] of Object.entries(byGrip)) {
      const fit = fitAdaptiveHandCurve(rows);
      if (fit) out[grip] = fit;
    }
    return out;
  }, [freshMapFp]); // eslint-disable-line react-hooks/exhaustive-deps

  // Permanent baseline snapshot — set once from the earliest training data,
  // never overwritten. Seeded automatically (below) from the first few
  // failure reps spanning ≥2 zones.
  const [baseline, setBaseline] = useState(() => loadLS(LS_BASELINE_KEY));
  const [activities, setActivities] = useState(() => loadLS(LS_ACTIVITY_KEY) || []);

  // ── Auto-baseline ─────────────────────────────────────────
  // Seed the CF/W′ reference point from real training data instead of
  // requiring a formal calibration session. Fires once we have ≥3 failure
  // reps spanning ≥2 distinct target durations (so the Monod-Scherrer fit
  // has some spread to work with). The snapshot is dated to the earliest
  // rep in the seed set so "improvement" counts from when you started.
  useEffect(() => {
    if (baseline) return;
    const failures = history
      .filter(r =>
        r.failed &&
        r.avg_force_kg > 0 && r.avg_force_kg < 500 &&
        r.actual_time_s > 0
      )
      .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    const acc = [];
    const durs = new Set();
    for (const r of failures) {
      acc.push(r);
      durs.add(r.target_duration);
      if (acc.length >= 3 && durs.size >= 2) {
        const pts = acc.map(x => ({ x: 1 / x.actual_time_s, y: x.avg_force_kg }));
        const fit = fitCF(pts);
        if (fit) {
          const snap = { date: acc[0].date, CF: fit.CF, W: fit.W };
          saveLS(LS_BASELINE_KEY, snap);
          setBaseline(snap);
        }
        return;
      }
    }
  }, [history, baseline]);

  // Genesis badge snapshot — saved the first time all 3 zones have a session.
  // Must be declared BEFORE the detection useEffect below.
  const [genesisSnap, setGenesisSnap] = useState(() => loadLS(LS_GENESIS_KEY));

  // ── Genesis badge detection ───────────────────────────────
  // Snapshot CF/W′ the first time the user has logged at least one session
  // in each zone (Power 10s, Strength 45s, Capacity 120s). This becomes
  // the immutable baseline for all subsequent badge progress calculations.
  useEffect(() => {
    if (genesisSnap) return;           // already earned
    if (!liveEstimate) return;         // no curve yet
    const hasPower    = history.some(r => r.target_duration === 10);
    const hasStrength = history.some(r => r.target_duration === 45);
    const hasCapacity = history.some(r => r.target_duration === 120);
    if (hasPower && hasStrength && hasCapacity) {
      const auc  = computeAUC(liveEstimate.CF, liveEstimate.W);
      const snap = { date: today(), CF: liveEstimate.CF, W: liveEstimate.W, auc };
      saveLS(LS_GENESIS_KEY, snap);
      setGenesisSnap(snap);
    }
  }, [history, liveEstimate, genesisSnap]);

  const addActivity = useCallback((act) => {
    setActivities(prev => {
      const next = [...prev, { ...act, id: uid() }];
      saveLS(LS_ACTIVITY_KEY, next);
      return next;
    });
  }, []);

  const deleteActivity = useCallback((id) => {
    setActivities(prev => {
      const next = prev.filter(a => a.id !== id);
      saveLS(LS_ACTIVITY_KEY, next);
      return next;
    });
  }, []);

  // ── Session Config ────────────────────────────────────────
  // hand is hard-coded to "Both": the user always trains both hands, either
  // alternating per rep or doing all-L-then-all-R. There's no UI toggle for
  // this anymore; it lives in config only so existing downstream code keeps
  // working.
  //
  // altMode is NOT stored here anymore — it's derived from restTime and
  // targetTime via configWithDerived below. Storing it as state was a bug
  // surface: any callsite doing setConfig({...altMode: true}) would have
  // its value silently overwritten on the next render, hiding the change.
  // Compute-on-read removes that footgun entirely.
  const [rawConfig, setConfig] = useState(() => ({
    hand:       "Both",
    grip:       "",
    goal:       "",  // "power" | "strength" | "endurance" — set when SessionPlanner plan is applied
    repsPerSet: 5,
    numSets:    3,
    targetTime: 45,
    restTime:   20,
    setRestTime: 180,
  }));

  // Augment rawConfig with derived altMode so every downstream reader
  // (handleRepDone, handleRestDone, SessionPlanner ETA, SetupView, etc.)
  // sees the right value without anyone having to remember to derive it.
  // setConfig still operates on rawConfig — any caller that tries to
  // setConfig({altMode: ...}) will be silently no-oped on the altMode
  // key, which is the desired behavior since altMode is fully derived
  // from restTime/targetTime. Worth doing this rather than a useEffect
  // that overwrites altMode in state, which had a stale-write race.
  const config = useMemo(() => ({
    ...rawConfig,
    altMode: rawConfig.restTime >= rawConfig.targetTime,
  }), [rawConfig]);

  // ── Session State Machine ─────────────────────────────────
  // phase: 'idle' | 'rep_ready' | 'rep_active' | 'resting' | 'between_sets' | 'switch_hands' | 'alt_switch' | 'done'
  const [phase,       setPhase]       = useState("idle");
  const [currentSet,  setCurrentSet]  = useState(0);
  const [currentRep,  setCurrentRep]  = useState(0);
  const [fatigue,     setFatigue]     = useState(0);
  const [sessionReps, setSessionReps] = useState([]);
  const [sessionId,        setSessionId]        = useState("");
  const [sessionStartedAt, setSessionStartedAt] = useState("");
  const [refWeights,       setRefWeights]        = useState({});
  const [lastRepResult, setLastRepResult] = useState(null);
  const [leveledUp,   setLeveledUp]   = useState(false);
  const [newLevel,    setNewLevel]    = useState(1);
  const [activeHand,  setActiveHand]  = useState("L"); // tracks current hand in Both mode
  const [altHandRep,  setAltHandRep]  = useState(false); // true while doing the interleaved alt-hand rep
  const [altRestTime, setAltRestTime] = useState(0);     // rest after alt rep = restTime − actual alt rep time

  // Max strength estimate (for fatigue dose calculation)
  // Use post-session-1 best; fall back to baseline (first session); then 20 kg if no data
  const sMaxL = useMemo(() => {
    const best = getBestLoad(history, "L", config.grip, config.targetTime)
               || getBaseline(history, "L", config.grip, config.targetTime);
    return best ? best * 1.2 : 20;
  }, [history, config.grip, config.targetTime]);
  const sMaxR = useMemo(() => {
    const best = getBestLoad(history, "R", config.grip, config.targetTime)
               || getBaseline(history, "R", config.grip, config.targetTime);
    return best ? best * 1.2 : 20;
  }, [history, config.grip, config.targetTime]);

  // ── Tindeq ────────────────────────────────────────────────
  const tindeq = useTindeq();

  // ── Start session ─────────────────────────────────────────
  // refWeights drives the in-workout "Rep 1 suggested weight" display
  // and the weight that gets recorded against each rep. Prescribed via
  // the same model-based path as the Setup card (prescribedLoad,
  // i.e. Monod CF + W'/T) so the two views agree. Falls back to the
  // older empirical historical-average estimate when there isn't
  // enough data to fit Monod, then to whatever the user configured
  // as a last resort.
  const startSession = useCallback(() => {
    const sid = uid();
    const rw = {};
    // Empirical-first prescription path (matches the Setup card's
    // "Train at" cell). Cold-start fallbacks: per-grip Monod, then
    // cross-grip Monod, then historical average. Same chain the
    // Setup card uses, so the in-workout suggested weight matches
    // the Setup card to the kg.
    ["L", "R"].forEach(h => {
      rw[h] = empiricalPrescription(history, h, config.grip, config.targetTime, { threeExpPriors })
           ?? prescribedLoad(history, h, config.grip, config.targetTime, freshMap, { threeExpPriors })
           ?? prescribedLoad(history, h, null,        config.targetTime, freshMap, { threeExpPriors })
           ?? estimateRefWeight(history, h, config.grip, config.targetTime);
    });
    const startedAt = nowISO();
    setSessionId(sid);
    setSessionStartedAt(startedAt);
    setRefWeights(rw);
    setSessionReps([]);
    setCurrentSet(0);
    setCurrentRep(0);
    setFatigue(0);
    setLeveledUp(false);
    setLastRepResult(null);
    setActiveHand(config.hand === "Both" ? "L" : config.hand);
    setAltHandRep(false);
    setPhase("rep_ready");
    setTab(0); // stay on Train tab
  }, [history, config, freshMap, threeExpPriors]);

  // ── Handle rep completion ─────────────────────────────────
  const handleRepDone = useCallback(({ actualTime, avgForce, failed = false }) => {
    const effectiveHand = config.hand === "Both" ? activeHand : config.hand;
    // Weight is constant across the set — no within-set fatigue discount.
    // The rep-time curve (actual_time_s) is what reflects fatigue and feeds
    // the next session's prescription via Monod.
    const weight = (() => {
      const ws = [suggestWeight(refWeights[effectiveHand], 0)].filter(Boolean);
      return ws.length > 0 ? ws[0] : 0;
    })();

    const roundedActual = Math.round(actualTime * 10) / 10;
    const derivedFailed = failed || isShortfall(roundedActual, config.targetTime);
    const repRecord = {
      id:              uid(),
      date:            today(),
      grip:            config.grip,
      hand:            effectiveHand,
      target_duration: config.targetTime,
      weight_kg:       Math.round(weight * 10) / 10,
      actual_time_s:   roundedActual,
      avg_force_kg:    (isFinite(avgForce) && avgForce > 0 && avgForce < 500)
                         ? Math.round(avgForce * 10) / 10
                         : null,
      set_num:         currentSet + 1,
      rep_num:         currentRep + 1,
      rest_s:             config.restTime,
      session_id:         sessionId,
      failed:             derivedFailed,
      session_started_at: sessionStartedAt || null,
    };

    setLastRepResult({ actualTime, avgForce, targetTime: config.targetTime });
    setSessionReps(reps => [...reps, repRecord]);
    addReps([repRecord]);

    // Update fatigue
    const sMax = config.hand === "R" ? sMaxR : sMaxL;
    const dose = fatigueDose(weight, actualTime, sMax);
    setFatigue(f => Math.min(f + dose, 0.95));

    // ── Alternating mode: interleave both hands rep-by-rep ────
    if (config.altMode && config.hand === "Both") {
      if (!altHandRep) {
        // Just finished primary hand — immediately switch to alt hand (no rest yet)
        setAltHandRep(true);
        setActiveHand(h => h === "L" ? "R" : "L");
        setPhase("alt_switch");
      } else {
        // Just finished alt hand — rest for (restTime − actual alt rep time), then back to primary
        setAltHandRep(false);
        setActiveHand(h => h === "L" ? "R" : "L"); // back to primary
        const rest = Math.max(5, config.restTime - Math.round(repRecord.actual_time_s));
        setAltRestTime(rest);
        const nextRep = currentRep + 1;
        if (nextRep >= config.repsPerSet) {
          const nextSet = currentSet + 1;
          if (nextSet >= config.numSets) {
            finishSession([...sessionReps, repRecord]);
          } else {
            setCurrentSet(nextSet);
            setCurrentRep(0);
            setFatigue(0);
            setPhase("between_sets");
          }
        } else {
          setCurrentRep(nextRep);
          setPhase("resting");
        }
      }
      return;
    }

    // ── Standard mode ─────────────────────────────────────────
    const nextRep = currentRep + 1;
    if (nextRep >= config.repsPerSet) {
      // Set complete
      const nextSet = currentSet + 1;
      if (nextSet >= config.numSets) {
        // All sets done for this hand
        if (config.hand === "Both" && activeHand === "L") {
          // Switch to right hand
          setCurrentSet(0);
          setCurrentRep(0);
          setFatigue(0);
          setActiveHand("R");
          setPhase("switch_hands");
        } else {
          finishSession([...sessionReps, repRecord]);
        }
      } else {
        setCurrentSet(nextSet);
        setCurrentRep(0);
        setFatigue(0);
        setPhase("between_sets");
      }
    } else {
      setCurrentRep(nextRep);
      setPhase("resting");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, currentRep, currentSet, fatigue, refWeights, sessionId, sessionStartedAt, sessionReps, addReps, sMaxL, sMaxR, activeHand]);

  const finishSession = useCallback((allReps) => {
    // Check for level up
    const hands = config.hand === "Both" ? ["L","R"] : [config.hand];
    let leveled = false;
    let maxNewLevel = 1;
    for (const h of hands) {
      const combined = [...history, ...allReps.filter(r => r.hand === h || r.hand === "B")];
      const oldLevel = calcLevel(history, h, config.grip, config.targetTime);
      const newLvl   = calcLevel(combined, h, config.grip, config.targetTime);
      if (newLvl > oldLevel) { leveled = true; maxNewLevel = Math.max(maxNewLevel, newLvl); }
    }
    setLeveledUp(leveled);
    setNewLevel(maxNewLevel);
    setPhase("done");
  }, [config, history]);

  const handleRestDone = useCallback(() => {
    const restUsed = config.altMode && config.hand === "Both" ? altRestTime : config.restTime;
    setFatigue(f => fatigueAfterRest(f, restUsed));
    // When Tindeq is connected, go to rep_ready so AutoRepSessionView can arm
    // auto-detection and wait for the next pull. When not connected, auto-start
    // the countdown so the user doesn't need to tap Start Rep.
    setPhase(tindeq.connected ? "rep_ready" : "rep_active");
  }, [config.altMode, config.hand, config.restTime, altRestTime, tindeq.connected]);

  const handleNextSet = useCallback(() => {
    setFatigue(0);
    setPhase("rep_ready");
  }, []);

  const handleAbort = useCallback(() => {
    if (sessionReps.length > 0) finishSession(sessionReps);
    else setPhase("idle");
  }, [sessionReps, finishSession]);

  // Compute next rep suggestion for rest screen — same constant set weight.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const nextWeight = useMemo(() => {
    if (phase !== "resting") return null;
    const hand = config.hand === "Both" ? activeHand : config.hand;
    return suggestWeight(refWeights[hand], 0);
  }, [phase, config.hand, refWeights, activeHand]);

  // ── Manual cloud pull ─────────────────────────────────────
  // User-triggered refresh. Flushes any queued local reps first, then
  // refetches reps + workout_sessions from Supabase and merges into state.
  // Without this, devices only fetch once at auth; a workout pushed from
  // device A is invisible on device B until B is reloaded.
  const [pullStatus, setPullStatus] = useState("idle"); // 'idle' | 'pulling' | 'ok' | 'err'
  const [lastPulledAt, setLastPulledAt] = useState(null);
  const pullFromCloud = useCallback(async () => {
    if (!user) return;
    setPullStatus("pulling");
    try {
      const flushed = await flushQueue();
      if (flushed > 0) refreshPending();

      // Reps — reconcile any local-only reps before overwriting state.
      const remoteReps = await fetchReps();
      if (remoteReps) {
        const localReps = loadLS(LS_KEY) || [];
        const keyFor = r => `${r.session_id || r.date}|${r.set_num}|${r.rep_num}|${r.hand}`;
        const remoteKeys = new Set(remoteReps.map(keyFor));
        const toSync = localReps.filter(r => !remoteKeys.has(keyFor(r)));
        let pushedAny = false;
        for (const rep of toSync) {
          const ok = await pushRep(rep);
          if (ok) pushedAny = true;
          else enqueueReps([rep]);
        }
        const finalReps = pushedAny ? (await fetchReps()) : remoteReps;
        if (finalReps && finalReps.length > 0) setHistory(finalReps);
      }

      // Workout sessions — merge into localStorage (skipping tombstoned ids).
      // WorkoutView re-reads LS on mount, so new workouts appear once the
      // user next navigates there; we trigger a reload below to make them
      // visible immediately across all tabs that use those memos.
      let workoutChanged = false;
      const remote = await fetchWorkoutSessions();
      if (remote) {
        const local      = loadLS(LS_WORKOUT_LOG_KEY) || [];
        const localIds   = new Set(local.map(s => s.id).filter(Boolean));
        const deletedIds = new Set(loadLS(LS_WORKOUT_DELETED_KEY) || []);
        const additions  = remote.filter(s => !localIds.has(s.id) && !deletedIds.has(s.id));
        if (additions.length > 0) {
          saveLS(LS_WORKOUT_LOG_KEY, [...local, ...additions]);
          workoutChanged = true;
        }
        const synced = new Set(loadLS(LS_WORKOUT_SYNCED_KEY) || []);
        remote.forEach(s => s.id && synced.add(s.id));
        saveLS(LS_WORKOUT_SYNCED_KEY, [...synced]);
      }

      refreshPending();
      setLastPulledAt(Date.now());
      setPullStatus("ok");

      // If we merged in new workout_sessions from the cloud, reload so the
      // WorkoutView (which reads LS on mount) picks them up immediately.
      // Reps/history live in App state so they appear without reload.
      if (workoutChanged) {
        setTimeout(() => window.location.reload(), 400);
      }
    } catch (e) {
      console.warn("pullFromCloud failed:", e?.message);
      setPullStatus("err");
    }
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auth helpers (6-digit OTP) ────────────────────────────
  // We intentionally don't pass emailRedirectTo: users type the 6-digit
  // code into the app instead of clicking a magic link. This avoids the
  // Android "link opens in Gmail's in-app browser, session never reaches
  // Chrome" class of failures.
  //
  // IMPORTANT: Requires the Supabase "Magic Link" email template to
  // include {{ .Token }} so users actually see the code in their email.
  // Update at: Supabase dashboard -> Authentication -> Email Templates.
  const [otpSent,  setOtpSent]  = useState(false);
  const [otpCode,  setOtpCode]  = useState("");
  const [otpBusy,  setOtpBusy]  = useState(false);
  const [otpError, setOtpError] = useState(null);

  const sendOtp = async () => {
    if (!loginEmail || otpBusy) return;
    setOtpBusy(true);
    setOtpError(null);
    const { error } = await supabase.auth.signInWithOtp({
      email: loginEmail,
      options: { shouldCreateUser: true },
    });
    setOtpBusy(false);
    if (error) { setOtpError(error.message); return; }
    setOtpSent(true);
    setOtpCode("");
  };

  const verifyOtp = async () => {
    const token = (otpCode || "").replace(/\s+/g, "");
    if (!loginEmail || !token || otpBusy) return;
    setOtpBusy(true);
    setOtpError(null);
    const { error } = await supabase.auth.verifyOtp({
      email: loginEmail,
      token,
      type: "email",
    });
    setOtpBusy(false);
    if (error) { setOtpError(error.message); return; }
    // Success: onAuthStateChange will set `user` and trigger the history fetch.
    setOtpSent(false);
    setOtpCode("");
  };

  const cancelOtp = () => {
    setOtpSent(false);
    setOtpCode("");
    setOtpError(null);
  };

  const signOut = async () => { await supabase.auth.signOut(); };

  // ── Render ────────────────────────────────────────────────
  return (
    <div style={base}>
      {/* Top nav */}
      <div style={{
        background: C.card, borderBottom: `1px solid ${C.border}`,
        display: "flex", alignItems: "center", padding: "0 16px",
        position: "sticky", top: 0, zIndex: 100,
      }}>
        <div style={{ fontSize: 16, fontWeight: 800, color: C.blue, marginRight: 16, padding: "14px 0" }}>
          🧗 Finger
        </div>
        {TABS.map((t, i) => (
          <button
            key={t}
            onClick={() => { setTab(i); if (i === 0 && phase !== "idle") {/* stay in session */} }}
            style={{
              padding: "14px 12px", fontSize: 13, fontWeight: tab === i ? 700 : 400,
              color: tab === i ? C.blue : C.muted, background: "none", border: "none",
              borderBottom: tab === i ? `2px solid ${C.blue}` : "2px solid transparent",
              cursor: "pointer", whiteSpace: "nowrap",
            }}
          >
            {t}
            {t === "Fingers" && phase !== "idle" && (
              <span style={{ marginLeft: 4, background: C.red, color: "#fff", borderRadius: 10, fontSize: 10, padding: "1px 5px" }}>●</span>
            )}
          </button>
        ))}
        {tindeq.connected && (
          <div style={{ marginLeft: "auto", fontSize: 11, color: C.green }}>⚡ Tindeq</div>
        )}
      </div>

      {/* Unsaved reps warning banner */}
      {pendingCount > 0 && (
        <div style={{
          background: "#3a1f00", borderBottom: `1px solid ${C.orange}`,
          padding: "8px 16px", display: "flex", alignItems: "center", gap: 10,
          fontSize: 13, color: C.orange,
        }}>
          <span>⚠️</span>
          <span>
            {pendingCount} rep{pendingCount !== 1 ? "s" : ""} couldn't sync to the cloud.
            {user ? " Retrying…" : " Sign in to retry."}
          </span>
          {user && (
            <button onClick={() => flushQueue().then(refreshPending)} style={{
              marginLeft: "auto", background: "none", border: `1px solid ${C.orange}`,
              color: C.orange, borderRadius: 6, padding: "2px 10px", cursor: "pointer", fontSize: 12,
            }}>Retry now</button>
          )}
        </div>
      )}

      {/* Train tab */}
      {tab === 0 && (() => {
        if (phase === "idle") {
          const tindeqConnectCard = (
            <div style={{ marginBottom: 12 }}>
              <Card>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>Tindeq Progressor</div>
                    <div style={{ fontSize: 12, color: C.muted }}>
                      {tindeq.connected ? "Connected ✓" : tindeq.reconnecting ? "Reconnecting…" : tindeq.bleError || "Not connected"}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    {tindeq.connected && (
                      <Btn small onClick={tindeq.tare} color={C.muted}>Tare</Btn>
                    )}
                    <Btn
                      small
                      onClick={tindeq.connect}
                      disabled={tindeq.connected || tindeq.reconnecting}
                      color={tindeq.connected ? C.green : tindeq.reconnecting ? C.orange : C.blue}
                    >
                      {tindeq.connected ? "Connected" : tindeq.reconnecting ? "Reconnecting…" : "Connect BLE"}
                    </Btn>
                  </div>
                </div>
                {tindeq.connected && (
                  <div style={{ marginTop: 8, fontSize: 13, color: C.text }}>
                    Live force: <b style={{ color: C.blue }}>{fmtW(tindeq.force, unit)} {unit}</b>
                    <span style={{ marginLeft: 12, color: C.muted, fontSize: 12 }}>
                      (tap Tare to zero before your session)
                    </span>
                  </div>
                )}
                {tindeq.bleError && (
                  <div style={{ marginTop: 8, fontSize: 12, color: C.red }}>{tindeq.bleError}</div>
                )}
              </Card>
            </div>
          );
          return (
            <SetupView
              config={config}
              setConfig={setConfig}
              onStart={startSession}
              history={history}
              freshMap={freshMap}
              unit={unit}
              onBwSave={saveBW}
              readiness={readiness}
              todaySubj={todaySubj}
              onSubjReadiness={handleSubjReadiness}
              isEstimated={todaySubj == null}
              liveEstimate={liveEstimate}
              gripEstimates={gripEstimates}
              activities={activities}
              onLogActivity={addActivity}
              connectSlot={tindeqConnectCard}
              GOAL_CONFIG={GOAL_CONFIG}
              GRIP_PRESETS={GRIP_PRESETS}
            />
          );
        }

        if (phase === "rep_ready" || phase === "rep_active") {
          // When Tindeq is connected, use touchless auto-detect mode:
          // reps start and end automatically from force threshold crossings.
          // When not connected, fall back to the manual tap flow.
          if (tindeq.connected && phase === "rep_ready") {
            return (
              <AutoRepSessionView
                key={`auto-${activeHand}-${currentSet}-${currentRep}`}
                session={{ config, currentSet, currentRep, fatigue, sessionId, refWeights, activeHand }}
                onRepDone={handleRepDone}
                onAbort={handleAbort}
                tindeq={tindeq}
                unit={unit}
              />
            );
          }
          return (
            <ActiveSessionView
              key={`${activeHand}-${currentSet}-${currentRep}-${phase}`}
              session={{ config, currentSet, currentRep, fatigue, sessionId, refWeights, activeHand }}
              onRepDone={handleRepDone}
              onAbort={handleAbort}
              tindeq={tindeq}
              autoStart={phase === "rep_active"}
              unit={unit}
            />
          );
        }

        if (phase === "switch_hands") {
          return <SwitchHandsView onReady={() => setPhase("rep_ready")} />;
        }

        if (phase === "alt_switch") {
          // Brief 3-second countdown before the interleaved alt-hand rep
          return (
            <AltSwitchView
              toHand={activeHand}
              onReady={() => setPhase(tindeq.connected ? "rep_ready" : "rep_active")}
            />
          );
        }

        if (phase === "resting") {
          const restSecs = config.altMode && config.hand === "Both" ? altRestTime : config.restTime;
          return (
            <RestView
              lastRep={lastRepResult}
              nextWeight={nextWeight}
              restSeconds={restSecs}
              onRestDone={handleRestDone}
              setNum={currentSet + 1}
              numSets={config.numSets}
              repNum={currentRep}
              repsPerSet={config.repsPerSet}
              unit={unit}
            />
          );
        }

        if (phase === "between_sets") {
          return (
            <BetweenSetsView
              completedSet={currentSet}
              totalSets={config.numSets}
              onNextSet={handleNextSet}
              setRestTime={config.setRestTime}
            />
          );
        }

        if (phase === "done") {
          return (
            <SessionSummaryView
              reps={sessionReps}
              config={config}
              leveledUp={leveledUp}
              newLevel={newLevel}
              onDone={() => setPhase("idle")}
              unit={unit}
            />
          );
        }

        return null;
      })()}

      {tab === 1 && (
        <AnalysisView
          history={history}
          unit={unit}
          bodyWeight={bodyWeight}
          baseline={baseline}
          activities={activities}
          liveEstimate={liveEstimate}
          gripEstimates={gripEstimates}
          freshMap={freshMap}
          readiness={readiness}
          GOAL_CONFIG={GOAL_CONFIG}
          RM_GRIPS={RM_GRIPS}
        />
      )}
      {tab === 2 && <BadgesView history={history} liveEstimate={liveEstimate} genesisSnap={genesisSnap} />}
      {tab === 3 && <WorkoutTab unit={unit} onSessionSaved={handleWorkoutSessionSaved} onBwSave={saveBW} trip={trip} />}
      {tab === 4 && <ClimbingTab activities={activities} onLogActivity={addActivity} onDeleteActivity={deleteActivity} />}
      {tab === 5 && (
        <HistoryView
          history={history}
          onDownload={() => downloadCSV(history)}
          unit={unit}
          bodyWeight={bodyWeight}
          onDeleteSession={deleteSession}
          onUpdateSession={updateSession}
          onDeleteRep={deleteRep}
          onUpdateRep={updateRep}
          onAddRep={(rep) => addReps(Array.isArray(rep) ? rep : [rep])}
          notes={notes}
          onNoteChange={handleNoteChange}
          activities={activities}
          onDeleteActivity={deleteActivity}
          defaultWorkouts={DEFAULT_WORKOUTS}
          onDeleteWorkoutSession={deleteWorkoutSession}
          onDownloadWorkoutCSV={downloadWorkoutCSV}
          targetOptions={TARGET_OPTIONS}
          gripPresets={GRIP_PRESETS}
        />
      )}
      {tab === 6 && <TrendsView history={history} unit={unit} activities={activities} defaultWorkouts={DEFAULT_WORKOUTS} />}
      {tab === 7 && (
        <SettingsView
          user={user}
          loginEmail={loginEmail}
          setLoginEmail={setLoginEmail}
          onSendOtp={sendOtp}
          onVerifyOtp={verifyOtp}
          onCancelOtp={cancelOtp}
          otpSent={otpSent}
          otpCode={otpCode}
          setOtpCode={setOtpCode}
          otpBusy={otpBusy}
          otpError={otpError}
          onSignOut={signOut}
          unit={unit}
          onUnitChange={saveUnit}
          bodyWeight={bodyWeight}
          onBWChange={saveBW}
          trip={trip}
          onTripChange={saveTrip}
          onPullFromCloud={pullFromCloud}
          pullStatus={pullStatus}
          lastPulledAt={lastPulledAt}
        />
      )}
    </div>
  );
}
