// src/App.js  — Finger Training v3
// Rep-based sessions · Three-Compartment Fatigue Model · Tindeq Progressor BLE · Gamification
import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import { supabase } from "./lib/supabase";
// UI primitives (theme, formatters, shared components). See src/ui/.
import { C, base } from "./ui/theme.js";
import { Card, Btn } from "./ui/components.js";
import { fmtW } from "./ui/format.js";

// Top-level views extracted from this file. See src/views/.
import { BadgesView } from "./views/BadgesView.js";
import { TrendsView } from "./views/TrendsView.js";
import { ClimbingTab } from "./views/ClimbingTab.js";
import { HistoryView } from "./views/HistoryView.js";
import { SettingsView } from "./views/SettingsView.js";
import { AnalysisView } from "./views/AnalysisView.js";
import { SetupView } from "./views/SetupView.js";
import {
  ActiveSessionView, AutoRepSessionView,
  RestView, SwitchHandsView, AltSwitchView,
  BetweenSetsView, SessionSummaryView,
} from "./views/ActiveSessionViews.js";
import { WorkoutTab, DEFAULT_WORKOUTS } from "./views/WorkoutTab.js";

// Shared lib helpers (storage, trip dates, CSV). See src/lib/.
import {
  loadLS, saveLS,
  LS_BW_LOG_KEY, LS_WORKOUT_LOG_KEY,
  LS_WORKOUT_SYNCED_KEY, LS_WORKOUT_DELETED_KEY,
} from "./lib/storage.js";
import { DEFAULT_TRIP } from "./lib/trip.js";
import { downloadCSV, downloadWorkoutCSV } from "./lib/csv.js";

// Model layer — pure JS, testable in isolation. See src/model/*.js.
import { today } from "./util.js";
import { computeReadiness } from "./model/readiness.js";
import {
  getBaseline, getBestLoad, calcLevel,
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
const LS_TRIP_KEY      = "ft_trip";      // { date: "YYYY-MM-DD", name } — user-configurable target date

// LEVEL_STEP and LEVEL_EMOJIS now live in src/model/levels.js and
// src/views/ActiveSessionViews.js respectively (imported above).

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

// BigTimer now lives in src/views/ActiveSessionViews.js (imported above).
// ForceGauge now lives in src/views/ActiveSessionViews.js (imported above).
// RepDots now lives in src/views/ActiveSessionViews.js (imported above).

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
// ActiveSessionView now lives in src/views/ActiveSessionViews.js (imported above).
// playBeep now lives in src/views/ActiveSessionViews.js (imported above).
// RestView now lives in src/views/ActiveSessionViews.js (imported above).
// SwitchHandsView now lives in src/views/ActiveSessionViews.js (imported above).
// AltSwitchView now lives in src/views/ActiveSessionViews.js (imported above).
// BetweenSetsView now lives in src/views/ActiveSessionViews.js (imported above).
// SessionSummaryView now lives in src/views/ActiveSessionViews.js (imported above).
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
// AutoRepSessionView now lives in src/views/ActiveSessionViews.js (imported above).
// ─────────────────────────────────────────────────────────────
// DEFAULT_TRIP, parseTripDate, weeksToTrip, tripCountdown now live in
// src/lib/trip.js (imported above).
// WorkoutTab + its private support code (DEFAULT_WORKOUTS,
// WTypeBadge, ExerciseRow, SessionExRow, WorkoutEditor, plus
// LS_WORKOUT_PLAN_KEY/STATE_KEY/TRIP_KEY, WK_ROTATION,
// WTYPE_META, EXERCISE_SUBSTITUTES) now lives in
// src/views/WorkoutTab.js (imported above).
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
