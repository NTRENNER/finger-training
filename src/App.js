// src/App.js  — Finger Training v3
// Rep-based sessions · Three-Compartment Fatigue Model · Tindeq Progressor BLE · Gamification
import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import { supabase } from "./lib/supabase";
import {
  ResponsiveContainer, LineChart, Line, ComposedChart, Scatter,
  BarChart, Bar,
  XAxis, YAxis, Tooltip, CartesianGrid, Legend,
  ReferenceLine, ReferenceArea,
} from "recharts";

// UI primitives (theme, formatters, shared components). See src/ui/.
import { C, base } from "./ui/theme.js";
import { Card, Btn, Sect, Label } from "./ui/components.js";
import {
  KG_TO_LBS, fmt0, fmt1, fmtW, fmtTime, toDisp, fromDisp,
} from "./ui/format.js";

// Top-level views extracted from this file. See src/views/.
import { BadgesView } from "./views/BadgesView.js";
import { TrendsView } from "./views/TrendsView.js";
import { ClimbingTab } from "./views/ClimbingTab.js";
import { HistoryView } from "./views/HistoryView.js";
import { SettingsView } from "./views/SettingsView.js";

// Shared lib helpers (storage, trip dates). See src/lib/.
import {
  loadLS, saveLS,
  LS_BW_LOG_KEY, LS_WORKOUT_LOG_KEY,
  LS_WORKOUT_SYNCED_KEY, LS_WORKOUT_DELETED_KEY,
} from "./lib/storage.js";
import {
  DEFAULT_TRIP, weeksToTrip, tripCountdown,
} from "./lib/trip.js";

// Model layer — pure JS, testable in isolation. See src/model/*.js.
import { clamp, ymdLocal, today } from "./util.js";
import { POWER_MAX, STRENGTH_MAX } from "./model/zones.js";
import {
  PHYS_MODEL_DEFAULT,
  fatigueDose, fatigueAfterRest,
  predictRepTimes,
} from "./model/fatigue.js";
import {
  fitCF, fitCFWithSuccessFloor,
  predForce, computeAUC, fitAdaptiveHandCurve,
} from "./model/monod.js";
import {
  THREE_EXP_LAMBDA_DEFAULT, fitThreeExpAmps, predForceThreeExp,
  buildThreeExpPriors,
} from "./model/threeExp.js";
// Prescription layer — what to train at, what's possible, the gap diagnostic.
// See src/model/prescription.js.
import {
  effectiveLoad,
  isShortfall,
  buildFreshLoadMap, fitDoseK,
  sessionCompartmentAUC,
  estimateRefWeight,
  prescribedLoad,
  empiricalPrescription,
  prescriptionPotential,
  suggestWeight,
} from "./model/prescription.js";
// Coaching engine — picks next zone via gap × intensity × recency × external × residual.
import {
  coachingRecommendation, coachingRationale,
} from "./model/coaching.js";

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

const LEVEL_STEP = 1.05; // 5% improvement per level

// Level display — numeric only, no old badge names
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

function toCSV(reps) {
  const cols = ["id","date","grip","hand","target_duration","weight_kg",
                "actual_time_s","peak_force_kg","set_num","rep_num","rest_s","session_id"];
  const esc  = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; };
  return [cols.join(","), ...reps.map(r => cols.map(c => esc(r[c])).join(","))].join("\n");
}
function downloadCSV(reps) {
  const blob = new Blob([toCSV(reps)], { type: "text/csv" });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob), download: "finger-training-history.csv",
  });
  a.click();
}

function downloadWorkoutCSV(log) {
  // Flatten sessions → one row per set
  const rows = [];
  for (const s of log) {
    for (const [exId, exData] of Object.entries(s.exercises || {})) {
      const exName = exId.replace(/_/g, " ");
      if (exData.sets && exData.sets.length > 0) {
        exData.sets.forEach((set, i) => {
          rows.push([s.date, s.completedAt || "", s.workout || "", s.sessionNumber || "", exName, i + 1, set.reps ?? "", set.weight ?? "", set.done ? "yes" : "no"]);
        });
      } else {
        rows.push([s.date, s.completedAt || "", s.workout || "", s.sessionNumber || "", exName, "", "", "", exData.done ? "yes" : "no"]);
      }
    }
  }
  const header = ["date", "completed_at", "workout", "session_number", "exercise", "set", "reps", "weight", "done"];
  const csv = [header, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob), download: "workout-history.csv",
  });
  a.click();
}

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
// These are priors, not truths. computePersonalResponse() fits them to
// the user's own CF/W' trajectory and shrinks the prior toward the
// observed rate as evidence accumulates.
const PROTOCOL_RESPONSE = {
  power:     { cf: 0.010, w: 0.060 },  // W′-dominant, tiny CF via MVC
  strength:  { cf: 0.045, w: 0.015 },  // CF-dominant via ceiling effect
  endurance: { cf: 0.030, w: 0.008 },  // CF via ratio effect, small W′
};

// Integration window for the "climbing-relevant" AUC — covers power
// through capacity durations. CF is weighted (tMax−tMin) = 110; W′ is
// weighted ln(tMax/tMin) ≈ 2.485, so CF dominates AUC by ~44×. This
// matches the climbing-grade literature: sustainable finger force
// (CF) is a stronger predictor of grade than finite reserve (W′).
const AUC_T_MIN = 10;
const AUC_T_MAX = 120;

// ─────────────────────────────────────────────────────────────
// READINESS / RECOVERY HELPERS
// ─────────────────────────────────────────────────────────────
// Computes a 1-10 readiness score from recent training history.
// Uses an exponential decay model with ~24h recovery half-life.
// Score 10 = fully fresh; 1 = extremely fatigued.
function computeReadiness(history) {
  if (!history || history.length === 0) return 10;
  const todayStr = today();

  // Session load = sum of normalized rep doses (weight/refW × sqrt(dur/refDur))
  const byDate = {};
  for (const r of history) {
    if (!r.date) continue;
    if (!byDate[r.date]) byDate[r.date] = [];
    byDate[r.date].push(r);
  }

  let totalRemaining = 0;
  for (const [date, reps] of Object.entries(byDate)) {
    const load = reps.reduce((sum, r) => {
      const w = effectiveLoad(r) || r.weight_kg || 10;
      const d = r.actual_time_s || 10;
      return sum + (w / 20) * Math.sqrt(d / 45);
    }, 0);

    // Estimate hours since this session (no time-of-day stored, approximate)
    const hoursAgo = date === todayStr
      ? 3                          // trained today — assume a few hours ago
      : (new Date(todayStr) - new Date(date)) / (1000 * 3600 * 24) * 24 + 8;

    // Exponential decay: ~50% remaining after 24h
    totalRemaining += load * Math.exp(-hoursAgo / 24);
  }

  // Reference: a heavy session of 15 reps at baseline → load ≈ 15
  // 15 remaining = max fatigue (score 1); 0 = fully fresh (score 10)
  return Math.max(1, Math.round(10 - clamp(totalRemaining / 15 * 9, 0, 9)));
}

function recoveryLabel(score) {
  if (score >= 8) return { text: "Good day to push",            color: C.green,  emoji: "🟢" };
  if (score >= 5) return { text: "Quality volume day",          color: C.yellow, emoji: "🟡" };
  return              { text: "Consider light work or rest",   color: C.red,    emoji: "🔴" };
}

// 5-point subjective feeling scale → 1-10 score + label
const FEEL_OPTIONS = [
  { val: 1, emoji: "😴", label: "Wrecked"    },
  { val: 2, emoji: "😓", label: "Tired"      },
  { val: 3, emoji: "😐", label: "OK"         },
  { val: 4, emoji: "💪", label: "Good"       },
  { val: 5, emoji: "🔥", label: "Fired up"   },
];
// Map 1-5 subjective → 1-10 display score
const subjToScore = (v) => v * 2;

// ─────────────────────────────────────────────────────────────
// 5-zone classifier: categorises a single hang by its
// time-under-tension. The 45s boundaries come from 15 × 3s pulse
// framing; we treat them as TUT thresholds.
// Boundaries: <45s power, 45–81s pwr-str, 84–129s str,
//             132–177s str-end, 180s+ end.
// Returns { key, label, short, color } or null for zero/invalid reps.
// ─────────────────────────────────────────────────────────────
const ZONE5 = [
  { key: "power",              label: "Power",              short: "Pwr",   color: "#e05560", min:   0, max:  45 },
  { key: "power_strength",     label: "Power-Strength",     short: "Pwr-Str", color: "#e68a48", min:  45, max:  82 },
  { key: "strength",           label: "Strength",           short: "Str",   color: "#e07a30", min:  82, max: 130 },
  { key: "strength_endurance", label: "Strength-Capacity",  short: "Str-Cap", color: "#7aa0d8", min: 130, max: 178 },
  { key: "endurance",          label: "Capacity",           short: "Cap",   color: "#3b82f6", min: 178, max: Infinity },
];
function classifyZone5(durationSec) {
  if (!durationSec || durationSec <= 0) return null;
  return ZONE5.find(z => durationSec >= z.min && durationSec < z.max) ?? ZONE5[ZONE5.length - 1];
}
// Majority-zone for a set of reps (by count). Returns a ZONE5 entry or null.
function dominantZone5(reps) {
  const counts = Object.fromEntries(ZONE5.map(z => [z.key, 0]));
  for (const r of reps || []) {
    const z = classifyZone5(r.actual_time_s);
    if (z) counts[z.key] += 1;
  }
  const entries = Object.entries(counts).filter(([, n]) => n > 0);
  if (!entries.length) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return ZONE5.find(z => z.key === entries[0][0]);
}
// Convert the intended goal key from GOAL_CONFIG (power / strength / endurance)
// into a ZONE5 key so we can compare intended vs. landed zone.
// eslint-disable-next-line no-unused-vars
const GOAL_TO_ZONE5 = { power: "power", strength: "strength", endurance: "endurance" };

// ─────────────────────────────────────────────────────────────
// GAMIFICATION
// ─────────────────────────────────────────────────────────────

// A rep counts toward badges only if the athlete completed at least
// 80% of the target duration (screens out bailed reps).
function isQualifyingRep(r, targetDuration) {
  if (!r.actual_time_s || !targetDuration) return true; // no time data → don't exclude
  return r.actual_time_s >= targetDuration * 0.98;
}

// Group reps into sessions by their session_id (or date as fallback),
// returning an array of { sessionKey, date, reps[] } sorted oldest first.
function groupSessions(history, hand, grip, targetDuration) {
  const matches = history.filter(r =>
    r.hand === hand &&
    (!grip || r.grip === grip) &&
    r.target_duration === targetDuration &&
    effectiveLoad(r) > 0 &&
    isQualifyingRep(r, targetDuration)
  );
  const map = new Map();
  matches.forEach(r => {
    const key = r.session_id || r.date;
    if (!map.has(key)) map.set(key, { key, date: r.date, reps: [] });
    map.get(key).reps.push(r);
  });
  return [...map.values()].sort((a, b) => a.date < b.date ? -1 : 1);
}

// Baseline = best qualifying rep from the FIRST session only.
function getBaseline(history, hand, grip, targetDuration) {
  const sessions = groupSessions(history, hand, grip, targetDuration);
  if (sessions.length === 0) return null;
  const firstReps = sessions[0].reps;
  return Math.max(...firstReps.map(r => effectiveLoad(r)));
}

// Best load = best qualifying rep from sessions AFTER the first.
// (First session always = badge 1 regardless of within-session variance.)
function getBestLoad(history, hand, grip, targetDuration) {
  const sessions = groupSessions(history, hand, grip, targetDuration);
  if (sessions.length < 2) return null; // no improvement sessions yet
  const laterReps = sessions.slice(1).flatMap(s => s.reps);
  if (laterReps.length === 0) return null;
  return Math.max(...laterReps.map(r => effectiveLoad(r)));
}

function calcLevel(history, hand, grip, targetDuration) {
  const baseline = getBaseline(history, hand, grip, targetDuration);
  if (!baseline || baseline <= 0) return 1;
  const best = getBestLoad(history, hand, grip, targetDuration);
  if (!best || best <= baseline) return 1; // first session or no improvement yet
  return Math.max(1, 1 + Math.floor(Math.log(best / baseline) / Math.log(LEVEL_STEP)));
}

function levelTitle(level) {
  return `Level ${level}`;
}

// Next badge threshold = baseline × LEVEL_STEP^(currentLevel)
// eslint-disable-next-line no-unused-vars -- kept for future Journey-tab use; was used by the now-removed Setup-page level card.
function nextLevelTarget(history, hand, grip, targetDuration) {
  const baseline = getBaseline(history, hand, grip, targetDuration);
  if (!baseline) return null;
  const level = calcLevel(history, hand, grip, targetDuration);
  return Math.round(baseline * Math.pow(LEVEL_STEP, level) * 10) / 10;
}

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

// Inline body-weight prompt — shown in session setup when BW is stale (>3 days)
function BwPrompt({ unit = "lbs", onSave }) {
  const bwLog  = loadLS(LS_BW_LOG_KEY) || [];
  const latest = bwLog.length ? bwLog[bwLog.length - 1] : null;
  const daysSince = latest
    ? Math.floor((Date.now() - new Date(latest.date).getTime()) / 864e5)
    : Infinity;

  const [editing,  setEditing]  = useState(false);
  const [inputVal, setInputVal] = useState(() =>
    latest ? fmt0(toDisp(latest.kg, unit)) : ""
  );

  // Only show if stale or never set
  if (daysSince < 3) return null;

  const save = () => {
    // Integer precision — body weight doesn't need decimal accuracy
    const kg = fromDisp(Math.round(parseFloat(inputVal)), unit);
    if (!isNaN(kg) && kg > 0) { onSave(kg); setEditing(false); }
  };

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
      padding: "10px 14px", borderRadius: 10, marginBottom: 14,
      background: C.card, border: `1px solid ${C.border}`,
    }}>
      <span style={{ fontSize: 16 }}>⚖️</span>
      {!editing ? (
        <>
          <span style={{ flex: 1, fontSize: 13, color: C.muted }}>
            {latest
              ? <>Still <b style={{ color: C.text }}>{fmt0(toDisp(latest.kg, unit))} {unit}</b>?</>
              : <span>Body weight not set</span>}
          </span>
          <button onClick={() => setEditing(true)} style={{
            padding: "5px 12px", borderRadius: 8, border: "none", cursor: "pointer",
            background: C.border, color: C.text, fontSize: 12, fontWeight: 600,
          }}>{latest ? "Update" : "Set"}</button>
          {latest && (
            <button onClick={() => onSave(latest.kg)} style={{
              padding: "5px 12px", borderRadius: 8, border: "none", cursor: "pointer",
              background: C.green + "33", color: C.green, fontSize: 12, fontWeight: 600,
            }}>✓ Yes</button>
          )}
        </>
      ) : (
        <>
          <input
            type="number"
            inputMode="numeric"
            step={1}
            min={30}
            max={500}
            value={inputVal}
            onChange={e => setInputVal(e.target.value)}
            onKeyDown={e => e.key === "Enter" && save()}
            autoFocus
            style={{
              flex: 1, background: C.bg, border: `1px solid ${C.border}`,
              borderRadius: 6, color: C.text, fontSize: 14, padding: "5px 8px",
            }}
          />
          <span style={{ fontSize: 12, color: C.muted }}>{unit}</span>
          <button onClick={save} style={{
            padding: "5px 12px", borderRadius: 8, border: "none", cursor: "pointer",
            background: C.blue, color: "#000", fontSize: 12, fontWeight: 700,
          }}>Save</button>
          <button onClick={() => setEditing(false)} style={{
            padding: "5px 8px", borderRadius: 8, border: "none", cursor: "pointer",
            background: C.border, color: C.muted, fontSize: 12,
          }}>✕</button>
        </>
      )}
    </div>
  );
}

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

function SessionPlannerCard({ liveEstimate, onApplyPlan, recommendedZone = null, recommendedGrip = null, recommendedLabel = "recommended", recommendedScope = null, recommendedRationale = "" }) {
  // Default goal to the recommended zone when we know it; fall back to strength
  const initGoal = (recommendedZone && GOAL_CONFIG[recommendedZone]) ? recommendedZone : "strength";
  const [goal,    setGoal]    = useState(initGoal);
  const [numReps, setNumReps] = useState(GOAL_CONFIG[initGoal].repsDefault);
  const [rest,    setRest]    = useState(GOAL_CONFIG[initGoal].restDefault);
  const [numSets,  setNumSets]  = useState(GOAL_CONFIG[initGoal].setsDefault);
  const [setRestS, setSetRestS] = useState(GOAL_CONFIG[initGoal].setRestDefault);

  const handleGoal = (g) => {
    setGoal(g);
    setNumReps(GOAL_CONFIG[g].repsDefault);
    setRest(GOAL_CONFIG[g].restDefault);
    setNumSets(GOAL_CONFIG[g].setsDefault);
    setSetRestS(GOAL_CONFIG[g].setRestDefault);
  };

  const gc = GOAL_CONFIG[goal];
  const firstRepTime = gc.refTime;

  const repTimes = useMemo(
    () => predictRepTimes({ numReps, firstRepTime, restSeconds: rest }),
    [numReps, firstRepTime, rest]
  );

  const chartData = repTimes.map((t, i) => ({ rep: i + 1, time: t }));
  const tail = repTimes.length > 1 ? Math.round((repTimes[repTimes.length - 1] / firstRepTime) * 100) : 100;

  // Total session volume: sum of all predicted hold times across all sets
  const totalVolume = Math.round(repTimes.reduce((s, t) => s + t, 0) * numSets);

  return (
    <Card style={{ marginBottom: 16, border: `1px solid ${gc.color}40` }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>🗓 Session Planner</div>
          {recommendedScope && (
            <div style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>
              Recommendation for <span style={{ color: C.text, fontWeight: 600 }}>{recommendedScope}</span>
            </div>
          )}
        </div>
        {recommendedGrip && (
          <div style={{
            fontSize: 10, fontWeight: 700, letterSpacing: 0.3,
            padding: "2px 8px", borderRadius: 10,
            background: gc.color + "22", color: gc.color,
          }}>
            {recommendedGrip}
          </div>
        )}
      </div>

      {/* Goal picker */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        {Object.entries(GOAL_CONFIG).map(([key, g]) => {
          const isRec = key === recommendedZone;
          return (
            <button key={key} onClick={() => handleGoal(key)} style={{
              flex: 1, padding: "8px 4px", borderRadius: 10, cursor: "pointer",
              background: goal === key ? g.color : C.border,
              color: goal === key ? "#fff" : C.muted,
              fontWeight: 700, fontSize: 12, transition: "all 0.15s",
              border: isRec ? `2px solid ${g.color}` : "2px solid transparent",
              position: "relative",
            }}>
              {isRec && (
                <div style={{
                  position: "absolute", top: -8, left: "50%", transform: "translateX(-50%)",
                  fontSize: 9, fontWeight: 700, background: g.color, color: "#fff",
                  padding: "1px 5px", borderRadius: 6, whiteSpace: "nowrap",
                }}>
                  {recommendedLabel}
                </div>
              )}
              <div style={{ fontSize: 16 }}>{g.emoji}</div>
              <div style={{ marginTop: 2 }}>{g.label}</div>
            </button>
          );
        })}
      </div>

      {/* Coaching rationale — explains WHY this zone was recommended,
          combining the gap diagnostic with readiness/recency/external-load
          context. Only shown when there's something meaningful to say
          (rationale string non-empty). */}
      {recommendedRationale && (
        <div style={{
          fontSize: 11, color: C.muted, marginBottom: 12,
          padding: "8px 10px", background: C.bg, borderRadius: 8,
          border: `1px solid ${gc.color}33`, lineHeight: 1.5,
        }}>
          <span style={{ color: gc.color, fontWeight: 700 }}>Why {gc.label}: </span>
          {recommendedRationale}
        </div>
      )}

      {/* Prescription summary strip */}
      <div style={{
        display: "flex", gap: 6, marginBottom: 14,
        background: C.bg, borderRadius: 10, padding: "10px 14px", alignItems: "center",
      }}>
        {[
          { label: "First rep",  value: `${firstRepTime}s` },
          { label: "Reps",       value: numReps },
          { label: "Sets",       value: numSets },
          { label: "Rep rest",   value: `${rest}s` },
          { label: "Set rest",   value: `${setRestS}s` },
        ].map(({ label, value }, i, arr) => (
          <React.Fragment key={label}>
            <div style={{ textAlign: "center", flex: 1 }}>
              <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: gc.color }}>{value}</div>
            </div>
            {i < arr.length - 1 && <div style={{ color: C.border, fontSize: 16 }}>·</div>}
          </React.Fragment>
        ))}
      </div>

      {/* Sliders — within-set structure */}
      <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
        Within Set
      </div>
      <div style={{ display: "flex", gap: 16, marginBottom: 14 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.muted, marginBottom: 4 }}>
            <span>Reps</span><span style={{ fontWeight: 700, color: C.text }}>{numReps}</span>
          </div>
          <input type="range" min={2} max={12} value={numReps} onChange={e => setNumReps(Number(e.target.value))}
            style={{ width: "100%", accentColor: gc.color }} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.muted, marginBottom: 4 }}>
            <span>Rep rest</span><span style={{ fontWeight: 700, color: C.text }}>{rest}s</span>
          </div>
          <input type="range" min={5} max={300} step={5} value={rest} onChange={e => setRest(Number(e.target.value))}
            style={{ width: "100%", accentColor: gc.color }} />
        </div>
      </div>

      {/* Sliders — between-set structure */}
      <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
        Between Sets
      </div>
      <div style={{ display: "flex", gap: 16, marginBottom: 14 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.muted, marginBottom: 4 }}>
            <span>Sets</span><span style={{ fontWeight: 700, color: C.text }}>{numSets}</span>
          </div>
          <input type="range" min={1} max={8} value={numSets} onChange={e => setNumSets(Number(e.target.value))}
            style={{ width: "100%", accentColor: gc.color }} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.muted, marginBottom: 4 }}>
            <span>Set rest</span><span style={{ fontWeight: 700, color: C.text }}>{setRestS}s</span>
          </div>
          <input type="range" min={60} max={1800} step={60} value={setRestS} onChange={e => setSetRestS(Number(e.target.value))}
            style={{ width: "100%", accentColor: gc.color }} />
        </div>
      </div>

      {/* Sets rationale */}
      <div style={{
        background: gc.color + "12", borderLeft: `3px solid ${gc.color}`,
        borderRadius: "0 8px 8px 0", padding: "8px 12px", marginBottom: 14,
        fontSize: 12, color: C.muted, lineHeight: 1.6,
      }}>
        {gc.setsRationale}
      </div>

      {/* Predicted fatigue curve (within one set) */}
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>
        Predicted hold time per rep · tail at <b style={{ color: gc.color }}>{tail}%</b>
        &nbsp;· total volume ~<b style={{ color: gc.color }}>{totalVolume}s</b> across {numSets} set{numSets !== 1 ? "s" : ""}
      </div>
      <ResponsiveContainer width="100%" height={130}>
        <LineChart data={chartData} margin={{ top: 4, right: 12, bottom: 24, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
          <XAxis dataKey="rep" tick={{ fill: C.muted, fontSize: 11 }}
            label={{ value: "Rep (within set)", position: "insideBottom", offset: -14, fill: C.muted, fontSize: 11 }} />
          <YAxis tick={{ fill: C.muted, fontSize: 10 }} unit="s" width={34} domain={[0, firstRepTime * 1.15]} />
          <ReferenceLine y={firstRepTime} stroke={C.border} strokeDasharray="4 2" />
          <Tooltip
            contentStyle={{ background: C.card, border: `1px solid ${C.border}`, fontSize: 12 }}
            formatter={(val) => [`${val}s`, "Hold"]}
          />
          <Line dataKey="time" stroke={gc.color} strokeWidth={2.5}
            dot={{ fill: gc.color, r: 4, strokeWidth: 0 }} name="Hold" />
        </LineChart>
      </ResponsiveContainer>

      {/* CTA */}
      <Btn
        onClick={() => onApplyPlan({
          goal,
          targetTime: firstRepTime, repsPerSet: numReps, restTime: rest,
          numSets, setRestTime: setRestS,
        })}
        color={gc.color}
        style={{ width: "100%", marginTop: 12, padding: "12px 0", borderRadius: 10, fontSize: 14, fontWeight: 700 }}
      >
        Use This Plan →
      </Btn>
    </Card>
  );
}

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

// Zone coverage counts only grip-training sessions (and legacy 1RM activities,
// which were finger-specific max efforts). Climbing sessions are intentionally
// NOT credited to any zone — the old heuristic (hard→strength, easy→capacity,
// boulder→power) over-counted climbing toward training zones it didn't really
// stimulate in a finger-specific way. ClimbingLogWidget still logs climbs so
// the data is preserved for future fatigue-accounting work, but it no longer
// inflates the Power / Strength / Capacity buckets on the coverage card.
function computeZoneCoverage(history, activities = []) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = ymdLocal(cutoff);

  // Grip-training sessions
  const sessions = {};
  for (const r of history) {
    if ((r.date ?? "") < cutoffStr) continue;
    const sid = r.session_id || r.date;
    if (!sessions[sid]) sessions[sid] = { date: r.date, durations: [] };
    const d = r.target_duration || r.actual_time_s;
    if (d > 0) sessions[sid].durations.push(d);
  }

  let power = 0, strength = 0, endurance = 0;
  for (const s of Object.values(sessions)) {
    if (!s.durations.length) continue;
    const sorted = [...s.durations].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    // Half-open intervals [lo, hi) so boundary values land consistently
    // with computeLimiterZone. A capacity protocol (target 120s) goes to
    // endurance, not strength.
    if (median < POWER_MAX)         power++;     // [0, 20)
    else if (median < STRENGTH_MAX) strength++;  // [20, 120)
    else                            endurance++; // [120, ∞)
  }

  // Legacy 1RM activities still credit Power — they are finger-specific max
  // efforts from before the power protocol was introduced.
  for (const a of activities) {
    if ((a.date ?? "") < cutoffStr) continue;
    if (a.type === "oneRM") power++;
  }

  const total = power + strength + endurance;
  const recommended =
    power <= strength && power <= endurance ? "power" :
    strength <= endurance                    ? "strength" : "endurance";

  return { power, strength, endurance, total, recommended };
}

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
const LIMITER_WINDOW_DAYS      = 30;
const LIMITER_MIN_FAILURES     = 3;    // total within a grip before we trust the signal
const LIMITER_MIN_PTS_TRAIN    = 2;    // each of the two "training" zones needs this many points
const LIMITER_MIN_PTS_HELDOUT  = 1;    // the held-out zone needs at least this many
const LIMITER_RESIDUAL_KG      = 0.5;  // smallest gap we'll call a limiter — below this the curve is balanced
function computeLimiterZone(history) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - LIMITER_WINDOW_DAYS);
  const cutoffStr = ymdLocal(cutoff);

  const allFailures = history.filter(r =>
    r.rep_num === 1 && r.failed &&
    r.avg_force_kg > 0 && r.avg_force_kg < 500 &&
    r.actual_time_s > 0 && r.target_duration > 0 &&
    (r.date || "") >= cutoffStr &&
    r.grip   // require known grip — otherwise we can't attribute
  );
  if (allFailures.length < LIMITER_MIN_FAILURES) return null;

  // Segment by grip. Force scales aren't comparable across grips.
  const byGrip = {};
  for (const r of allFailures) (byGrip[r.grip] ||= []).push(r);

  const zoneOf = (td) =>
    td < POWER_MAX        ? "power"    :
    td < STRENGTH_MAX     ? "strength" :
                            "endurance";

  // Try each grip, most-trained-in-30-days first. Return the first
  // grip whose data supports a recommendation. Skipping a grip with
  // a balanced curve is correct — it means that grip is on-curve,
  // and the next-most-trained grip may still have a deficit.
  const rankedGrips = Object.entries(byGrip)
    .sort(([, a], [, b]) => b.length - a.length);

  for (const [grip, failures] of rankedGrips) {
    if (failures.length < LIMITER_MIN_FAILURES) continue;

    const byZone = { power: [], strength: [], endurance: [] };
    for (const r of failures) byZone[zoneOf(r.target_duration)].push(r);

    // ── Primary: Monod cross-zone residual (per grip) ──
    const zones = ["power", "strength", "endurance"];
    const residuals = {};
    let cvWorked = true;
    for (const Z of zones) {
      const heldOut = byZone[Z];
      const others  = zones.filter(z => z !== Z);
      const bothTrainZonesOk = others.every(z => byZone[z].length >= LIMITER_MIN_PTS_TRAIN);
      if (!bothTrainZonesOk || heldOut.length < LIMITER_MIN_PTS_HELDOUT) {
        cvWorked = false;
        break;
      }
      const trainPts = others
        .flatMap(z => byZone[z])
        .map(r => ({ x: 1 / r.actual_time_s, y: r.avg_force_kg }));
      const fit = fitCF(trainPts);
      if (!fit) { cvWorked = false; break; }

      // Average predicted − actual across all held-out rep-1 failures.
      // Positive = actual fell short of the cross-zone prediction.
      const gaps = heldOut.map(r => predForce(fit, r.actual_time_s) - r.avg_force_kg);
      residuals[Z] = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    }

    if (cvWorked) {
      const ranked = Object.entries(residuals).sort(([, a], [, b]) => b - a);
      // Only return a pick if the top gap is meaningfully positive.
      // Below LIMITER_RESIDUAL_KG this grip's curve is balanced — try
      // the next grip rather than falling through to counts (counts
      // would disagree with a balanced curve and pick noise).
      if (ranked[0][1] > LIMITER_RESIDUAL_KG) return { zone: ranked[0][0], grip };
      continue;
    }

    // ── Fallback: failure-count within this grip ──
    const counts = {
      power:     byZone.power.length,
      strength:  byZone.strength.length,
      endurance: byZone.endurance.length,
    };
    const vals = Object.values(counts);
    if (vals.every(v => v === vals[0])) continue;
    const picked = Object.entries(counts).sort(([, a], [, b]) => a - b)[0][0];
    return { zone: picked, grip };
  }
  return null;
}

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
const PERSONAL_RESPONSE_PRIOR_WEIGHT = 10;  // pseudo-sessions
const PERSONAL_RESPONSE_MIN_SESSIONS = 5;    // hard gate per zone (effective-n)

function computePersonalResponse(history) {
  const zoneOf = (td) =>
    td < POWER_MAX    ? "power"    :
    td < STRENGTH_MAX ? "strength" :
                        "endurance";

  // Default: everyone starts at the prior with source='prior', n=0.
  const result = {
    power:     { ...PROTOCOL_RESPONSE.power,     n: 0, source: "prior" },
    strength:  { ...PROTOCOL_RESPONSE.strength,  n: 0, source: "prior" },
    endurance: { ...PROTOCOL_RESPONSE.endurance, n: 0, source: "prior" },
  };

  if (!history || history.length < 4) return result;

  const failures = history.filter(r =>
    r.failed &&
    r.avg_force_kg > 0 && r.avg_force_kg < 500 &&
    r.actual_time_s > 0 && r.target_duration > 0 && r.date
  );
  if (failures.length < 4) return result;

  // Sort and bucket by date.
  const sorted = [...failures].sort((a, b) => a.date.localeCompare(b.date));
  const byDate = {};
  for (const r of sorted) (byDate[r.date] ||= []).push(r);
  const dates = Object.keys(byDate).sort();

  // Walk dates; at each date with enough prior data, refit before/after
  // and split the fractional delta across zones by TUT proportion.
  // obs[zone] is an array of { weight, dCF, dW } — weight = TUT fraction.
  const obs = { power: [], strength: [], endurance: [] };

  for (const date of dates) {
    const before = sorted.filter(r => r.date < date);
    const after  = sorted.filter(r => r.date <= date);
    if (before.length < 2) continue;

    const fitBefore = fitCF(before.map(r => ({ x: 1 / r.actual_time_s, y: r.avg_force_kg })));
    const fitAfter  = fitCF(after.map(r  => ({ x: 1 / r.actual_time_s, y: r.avg_force_kg })));
    if (!fitBefore || !fitAfter) continue;
    if (fitBefore.CF <= 0) continue;

    const dCF = (fitAfter.CF - fitBefore.CF) / fitBefore.CF;
    const dW  = fitBefore.W > 0 ? (fitAfter.W - fitBefore.W) / fitBefore.W : 0;

    // TUT per zone for the day — sum actual_time_s bucketed by the zone
    // each rep was *targeting* (target_duration), not the zone the rep
    // fell into. A failed capacity-target rep at 60s still attributes
    // to capacity training. Matches the zone-bucketing convention used
    // everywhere else in the app.
    const tut = { power: 0, strength: 0, endurance: 0 };
    for (const r of byDate[date]) tut[zoneOf(r.target_duration)] += r.actual_time_s;
    const totalTUT = tut.power + tut.strength + tut.endurance;
    if (totalTUT <= 0) continue;

    for (const zone of Object.keys(tut)) {
      const w = tut[zone] / totalTUT;
      if (w > 0) obs[zone].push({ weight: w, dCF, dW });
    }
  }

  // Weighted shrinkage. Effective-n = Σ weights (can be fractional).
  const k0 = PERSONAL_RESPONSE_PRIOR_WEIGHT;
  for (const zone of Object.keys(PROTOCOL_RESPONSE)) {
    const zoneObs = obs[zone];
    const nEff = zoneObs.reduce((s, o) => s + o.weight, 0);

    if (nEff < PERSONAL_RESPONSE_MIN_SESSIONS) {
      result[zone] = { ...PROTOCOL_RESPONSE[zone], n: nEff, source: "prior" };
      continue;
    }

    // Weighted mean of observed fractional deltas. Divides by Σweights
    // so each day's total contribution (across all zones) is 1 unit of
    // evidence, split proportionally by that day's TUT distribution.
    const wMeanCF = zoneObs.reduce((s, o) => s + o.weight * o.dCF, 0) / nEff;
    const wMeanW  = zoneObs.reduce((s, o) => s + o.weight * o.dW,  0) / nEff;
    const prior   = PROTOCOL_RESPONSE[zone];

    // Floor at zero: negative observed rate is almost always confounded
    // (illness, injury, mount variance) rather than true anti-response.
    const cfBlended = Math.max(0, (k0 * prior.cf + nEff * wMeanCF) / (k0 + nEff));
    const wBlended  = Math.max(0, (k0 * prior.w  + nEff * wMeanW)  / (k0 + nEff));

    result[zone] = {
      cf: cfBlended,
      w:  wBlended,
      n:  nEff,
      source: "blended",
    };
  }

  return result;
}

// Zone Workout Summary — neutral 30-day volume breakdown. Does NOT
// prescribe training: the SessionPlanner owns the recommendation
// (per-grip Monod cross-zone residual). This card is purely a log.
// computeZoneCoverage still returns .recommended because the planner
// uses it as a fallback when there's too little failure data for the
// curve-residual signal; we just don't display that prescription here.
function ZoneCoverageCard({ history, activities = [] }) {
  const coverage = useMemo(() => computeZoneCoverage(history, activities),
    [history, activities]); // eslint-disable-line react-hooks/exhaustive-deps

  if (coverage.total === 0) return null;

  const zones = [
    { key: "power",     label: "⚡ Power",     val: coverage.power,     color: "#e05560" },
    { key: "strength",  label: "💪 Strength",  val: coverage.strength,  color: "#e07a30" },
    { key: "endurance", label: "🏔️ Capacity",  val: coverage.endurance, color: "#3b82f6" },
  ];
  const maxVal = Math.max(coverage.power, coverage.strength, coverage.endurance, 1);

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>Zone Workout Summary</div>
        <div style={{ fontSize: 11, color: C.muted }}>last 30 days · {coverage.total} sessions</div>
      </div>
      {zones.map(({ key, label, val, color }) => (
        <div key={key} style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
            <div style={{ fontSize: 12, color: C.muted, display: "flex", alignItems: "center", gap: 6 }}>
              {label}
            </div>
            <div style={{ fontSize: 12, fontWeight: 600, color: C.muted }}>{val}</div>
          </div>
          <div style={{ height: 6, background: C.border, borderRadius: 3, overflow: "hidden" }}>
            <div style={{
              height: "100%", borderRadius: 3,
              width: `${(val / maxVal) * 100}%`,
              background: color,
              opacity: 0.85,
            }} />
          </div>
        </div>
      ))}
    </Card>
  );
}

function SetupView({ config, setConfig, onStart, history, freshMap = null, unit = "lbs", onBwSave = () => {}, readiness = null, todaySubj = null, onSubjReadiness = () => {}, isEstimated = false, liveEstimate = null, gripEstimates = {}, activities = [], onLogActivity = () => {}, connectSlot = null }) {
  const [customGrip, setCustomGrip] = useState("");

  const handleGrip = (g) => setConfig(c => ({ ...c, grip: g }));

  // Note: model-prescribed first-rep loads are computed inline in the
  // Prescribed Load card below, where we show all three zones at once
  // (F = CF + W'/refTime(zone)). The fallback chain there is:
  //   1. per-hand × per-grip failure fit (most specific)
  //   2. per-hand, any-grip failure fit (more data, less specific)
  //   3. historical weighted-average weight at similar target time

  // (Level/journey progress vars removed — the Setup-page summary card
  // that consumed these now lives on the Journey tab. nextLevelTarget,
  // calcLevel, getBestLoad are still used elsewhere in the app.)

  // Fatigue-adjusted load index for the prescribed-load card (computed once
  // per history change, then reused across the multiple prescribedLoad calls
  // in the card below). Uses the user's back-fit dose constant when there's
  // enough within-set data; otherwise falls back to the population prior.
  // Stable fingerprint so the 60-step grid search inside fitDoseK
  // doesn't re-run on every history reference change (Supabase syncs,
  // unrelated state updates that touch the App-level history array).
  // Keyed on length + last rep's id + last rep's date — captures the
  // dominant "new rep added" case. Edits to old reps will use the
  // stale k until the next session, which is fine since k varies
  // gently with sample size and the fatigue model isn't sensitive to
  // small k shifts (CV² minimum is broad — see fitDoseK).
  // freshMap is now provided by App via prop so the in-workout
  // startSession path uses the SAME memoized fatigue map (with the
  // user-fitted doseK) — without that sharing, the Setup-card
  // prescription and the in-workout "Rep 1 suggested weight" disagreed
  // by 1-2 lbs because startSession was falling back to DEF_DOSE_K.
  // Three-exp prior memo stays local to SetupView since it isn't
  // currently consumed elsewhere.
  const threeExpPriors = useMemo(() => buildThreeExpPriors(history), [history]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
      <h2 style={{ margin: "0 0 20px", fontSize: 22, fontWeight: 700 }}>Session Setup</h2>

      <Card>
        <Sect title="Grip Type">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
            {GRIP_PRESETS.map(g => (
              <button
                key={g}
                onClick={() => handleGrip(g)}
                style={{
                  padding: "6px 14px", borderRadius: 20, fontSize: 13,
                  cursor: "pointer", fontWeight: 500,
                  background: config.grip === g ? C.orange : C.border,
                  color: config.grip === g ? "#fff" : C.muted,
                  border: "none",
                }}
              >
                {g}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={customGrip}
              onChange={e => setCustomGrip(e.target.value)}
              placeholder="Custom grip…"
              style={{ flex: 1, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px", color: C.text, fontSize: 14 }}
            />
            <Btn small onClick={() => { if (customGrip.trim()) { handleGrip(customGrip.trim()); setCustomGrip(""); } }}>
              Use
            </Btn>
          </div>
        </Sect>
      </Card>

      {/* Zone Workout Summary — neutral 30-day volume breakdown (no prescription) */}
      {/* (Level / journey card removed from setup — lives on the Journey tab now.) */}

      {(history.length > 0 || activities.length > 0) && <ZoneCoverageCard history={history} activities={activities} />}

      {/* Session Planner — always shown; defaults to the limiter zone
          (Monod cross-zone residual: the zone that falls farthest
          below the curve fit on the other two zones' rep-1 failures
          in the last 30 days), falling back to coverage when failure
          data is too sparse for the cross-zone fit. Matches the
          Analysis tab's precedence so the two views never disagree. */}
      {(() => {
        // Coaching engine v2: pick the next zone based on
        //   gap × intensity_match × recency × external_load
        // Falls back to the legacy heuristic chain when there's no grip
        // selected or no scoreable zones (cold start with no data).
        const gripFit = config.grip && gripEstimates[config.grip];
        const fitForRec = gripFit ?? liveEstimate;
        const scopeLabel = gripFit ? config.grip : (config.grip ? `${config.grip} (pooled)` : "overall");

        let zone = null;
        let label = "recommended";
        let rationale = "";
        let recommendedGrip = null;

        const coachRec = config.grip
          ? coachingRecommendation(history, config.grip, {
              freshMap, threeExpPriors,
              readiness: readiness ?? 5,
              activities,
            })
          : null;

        if (coachRec) {
          zone = coachRec.zone;
          recommendedGrip = config.grip;
          // Label captures the dominant reason (gap > 10% → "biggest gap",
          // else fall through to "recommended" as a neutral default).
          label = coachRec.gap > 0.10 ? "biggest gap" : "recommended";
          rationale = coachingRationale(coachRec);
        } else {
          // Legacy fallback: limiter → coverage → ΔAUC.
          const limiter = computeLimiterZone(history);
          recommendedGrip = limiter?.grip ?? null;
          if (fitForRec && fitForRec.CF > 0) {
            const { CF, W } = fitForRec;
            const response = computePersonalResponse(history);
            let bestKey = null, bestGain = -Infinity;
            for (const [key, resp] of Object.entries(response)) {
              const gain = CF * resp.cf * (AUC_T_MAX - AUC_T_MIN)
                         + W  * resp.w  * Math.log(AUC_T_MAX / AUC_T_MIN);
              if (gain > bestGain) { bestGain = gain; bestKey = key; }
            }
            zone = bestKey;
            label = "biggest gain (cold start)";
          } else if (limiter?.zone) {
            zone = limiter.zone;
            label = "limiter";
          } else {
            const cov = computeZoneCoverage(history, activities);
            if (cov.total > 0) {
              zone = cov.recommended;
              label = "least trained";
            }
          }
        }

        return (
          <SessionPlannerCard
            liveEstimate={fitForRec}
            recommendedZone={zone}
            recommendedGrip={recommendedGrip}
            recommendedLabel={label}
            recommendedScope={scopeLabel}
            recommendedRationale={rationale}
            onApplyPlan={({ goal, targetTime, repsPerSet, restTime, numSets, setRestTime }) =>
              setConfig(c => ({ ...c, goal, targetTime, repsPerSet, restTime, numSets, setRestTime }))
            }
          />
        );
      })()}

      {/* Prescribed load — appears once a grip is selected. Shows loads
          for ALL THREE zones side-by-side so the user doesn't have to
          guess which target time the card is reflecting. Load for each
          zone = CF + W'/refTime(zone). Load is CONSTANT across all reps
          of a set: rep 1 hits target, rep 2+ fall short as compartments
          drain. Source label reflects whichever fit (per-grip / cross-
          grip / history) backs the primary zone column. */}
      {config.grip && (() => {
        // Coaching prescription: empirical-first (anchored to user's
        // most recent rep 1 outcome at this exact scope), with the
        // curve-derived "potential" shown alongside as a diagnostic
        // ceiling. The GAP between train-at and potential is the
        // training opportunity — biggest gap = weakest compartment
        // relative to the rest of the user's physiology.
        //
        // Three sources of truth per cell:
        //   - TRAIN AT: empirical or curve-fallback (the load to use)
        //   - POTENTIAL: curve ceiling (Monod or three-exp consensus)
        //   - GAP: (potential − train_at) / train_at as percentage
        //
        // Reliability tiers gate the potential display:
        //   well-supported → show numeric potential confidently
        //   marginal → show potential with "models disagree" caveat
        //   extrapolation → don't show numeric, suggest training the zone

        const cellFor = (hand, t) => {
          // Empirical-first: anchored to user's most recent rep 1
          const emp = empiricalPrescription(history, hand, config.grip, t, { threeExpPriors });
          let trainAt, source;
          if (emp != null) {
            trainAt = emp;
            source = "empirical";
          } else {
            // Cold start: fall back to the curve. Try per-grip first,
            // then cross-grip, then historical average.
            const v1 = prescribedLoad(history, hand, config.grip, t, freshMap, { threeExpPriors });
            if (v1 != null) { trainAt = v1; source = "curve-grip"; }
            else {
              const v2 = prescribedLoad(history, hand, null, t, freshMap, { threeExpPriors });
              if (v2 != null) { trainAt = v2; source = "curve-global"; }
              else {
                const v3 = estimateRefWeight(history, hand, config.grip, t);
                if (v3 != null) { trainAt = v3; source = "history"; }
                else return { trainAt: null, source: null, potential: null };
              }
            }
          }
          // Potential ceiling — curve-derived, with reliability tier.
          const potential = prescriptionPotential(history, hand, config.grip, t, {
            freshMap, threeExpPriors,
          });
          return { trainAt, source, potential };
        };

        const zones = ["power", "strength", "endurance"].map(zoneKey => {
          const t = GOAL_CONFIG[zoneKey].refTime;
          const L = cellFor("L", t);
          const R = cellFor("R", t);
          return { key: zoneKey, cfg: GOAL_CONFIG[zoneKey], t, L, R };
        });
        const anyLoaded = zones.some(z => z.L.trainAt != null || z.R.trainAt != null);
        if (!anyLoaded) return null;

        // Find the widest reliable gap across all (zone, hand) cells —
        // that's the recommendation engine's "biggest leverage" pointer.
        let widestGap = null;
        for (const z of zones) {
          for (const [handLabel, cell] of [["L", z.L], ["R", z.R]]) {
            if (!cell.potential || !cell.trainAt) continue;
            if (cell.potential.reliability === "extrapolation") continue;
            const gap = (cell.potential.value - cell.trainAt) / cell.trainAt;
            if (widestGap == null || gap > widestGap.gap) {
              widestGap = { zoneKey: z.key, zoneLabel: z.cfg.label, hand: handLabel, gap, cell };
            }
          }
        }

        // Format helpers
        const fmtPct = (g) => `${g >= 0 ? "+" : ""}${Math.round(g * 100)}%`;
        const gapColor = (g) => Math.abs(g) < 0.05 ? C.muted
                              : g > 0.20 ? C.red
                              : g > 0.10 ? C.orange
                              : C.green;

        return (
          <Card style={{ borderColor: C.blue }}>
            <div style={{ fontSize: 13, color: C.muted, marginBottom: 4 }}>
              Coaching prescription · {config.grip}
            </div>
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 8, fontStyle: "italic" }}>
              <b style={{ color: C.text, fontStyle: "normal" }}>Train at</b> = what to lift today (anchored to your most recent rep 1 + RPE 10 push).{" "}
              <b style={{ color: C.text, fontStyle: "normal" }}>Potential</b> = what the curve says you could support if your physiology were balanced.{" "}
              <b style={{ color: C.text, fontStyle: "normal" }}>Gap</b> = the training opportunity in that zone.
            </div>
            {widestGap && widestGap.gap > 0.10 && (
              <div style={{ fontSize: 12, color: C.text, background: widestGap.cell.cfg?.color + "20" || C.bg,
                            border: `1px solid ${gapColor(widestGap.gap)}66`, borderRadius: 8,
                            padding: "8px 10px", marginBottom: 10 }}>
                <span style={{ fontWeight: 700, color: gapColor(widestGap.gap) }}>Biggest gap: {widestGap.zoneLabel}</span>
                {" — your "}
                {widestGap.zoneKey === "power" ? "fast (PCr)" : widestGap.zoneKey === "strength" ? "middle (glycolytic)" : "slow (oxidative)"}
                {" compartment is your widest opportunity ("}
                <b>{fmtPct(widestGap.gap)}</b>
                {" headroom on "}
                {widestGap.hand === "L" ? "Left" : "Right"}
                {"). Training there has the most leverage."}
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
              {zones.map(({ key, cfg, t, L, R }) => {
                const isActive = config.goal === key;
                return (
                  <div
                    key={key}
                    style={{
                      padding: "10px 12px",
                      background: isActive ? cfg.color + "22" : C.bg,
                      border: `1px solid ${isActive ? cfg.color : C.border}`,
                      borderRadius: 10,
                    }}
                  >
                    <div style={{ fontSize: 11, fontWeight: 700, color: cfg.color, marginBottom: 2 }}>
                      {cfg.emoji} {cfg.label}
                    </div>
                    <div style={{ fontSize: 10, color: C.muted, marginBottom: 8 }}>
                      target {t}s
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      {[["L", L], ["R", R]].map(([handLabel, cell]) => {
                        const sourceMark = cell.source === "curve-global" ? "°"
                                         : cell.source === "history" ? "ʰ"
                                         : cell.source === "curve-grip" ? "*"
                                         : "";
                        const sourceTitle = cell.source === "curve-global"
                            ? `Cold start: not enough recent ${config.grip} data on ${handLabel} at ${t}s, falling back to cross-grip curve.`
                          : cell.source === "history"
                            ? `Cold start: no model fit available, using historical average on ${handLabel} ${config.grip} at ${t}s.`
                          : cell.source === "curve-grip"
                            ? `Cold start: no recent rep 1 at this target, using ${config.grip} curve fit on ${handLabel}.`
                            : `Empirical: anchored to your most recent rep 1 on ${handLabel} ${config.grip} at ${t}s, with RPE 10 progression.`;
                        const pot = cell.potential;
                        const gap = (pot && cell.trainAt && pot.reliability !== "extrapolation")
                          ? (pot.value - cell.trainAt) / cell.trainAt : null;
                        return (
                          <div key={handLabel} style={{ flex: 1 }}>
                            <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5 }}>{handLabel}</div>
                            <div style={{ fontSize: 16, fontWeight: 700, color: C.blue }} title={sourceTitle}>
                              {cell.trainAt != null ? `${fmtW(cell.trainAt, unit)}` : "—"}
                              {sourceMark && (
                                <span style={{ fontSize: 11, color: C.yellow, marginLeft: 2 }}>
                                  {sourceMark}
                                </span>
                              )}
                            </div>
                            {pot && pot.reliability !== "extrapolation" && (
                              <div style={{ fontSize: 9, color: C.muted, marginTop: 3 }}>
                                pot {pot.reliability === "marginal"
                                  ? `${fmtW(pot.lower, unit)}–${fmtW(pot.upper, unit)}`
                                  : fmtW(pot.value, unit)}
                                {pot.reliability === "marginal" && (
                                  <span title="Monod and three-exp models disagree at this duration — treat the range as the credible band, not a precise number." style={{ color: C.yellow, marginLeft: 2 }}>
                                    ?
                                  </span>
                                )}
                              </div>
                            )}
                            {pot && pot.reliability === "extrapolation" && (
                              <div style={{ fontSize: 9, color: C.muted, marginTop: 3, fontStyle: "italic" }} title={`No failure data within ±50% of ${t}s — the curve is extrapolating. Train this zone to anchor it.`}>
                                pot ?
                              </div>
                            )}
                            {gap != null && (
                              <div style={{ fontSize: 9, fontWeight: 600, color: gapColor(gap), marginTop: 2 }}
                                   title={`Gap: train-at ${fmtW(cell.trainAt, unit)} → potential ${fmtW(pot.value, unit)} = ${fmtPct(gap)} headroom. ${gap > 0.10 ? "Worth training this zone." : "Already close to your modeled potential here."}`}>
                                gap {fmtPct(gap)}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ fontSize: 10, color: C.muted, marginTop: 8, display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <span>
                <span style={{ color: C.muted }}>* = curve fallback (no recent rep 1) · ° = cross-grip · ʰ = historical avg · ? = uncertain potential</span>
              </span>
              <span>values in {unit}</span>
            </div>
          </Card>
        );
      })()}

      {/* Readiness / how-do-you-feel widget */}
      {(() => {
        const rl = readiness != null ? recoveryLabel(readiness) : null;
        const selectedFeel = FEEL_OPTIONS.find(f => f.val === todaySubj);
        return (
          <div style={{
            marginBottom: 16, padding: "14px 16px",
            background: C.card, border: `1px solid ${rl ? rl.color + "44" : C.border}`,
            borderRadius: 12,
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
                How do you feel today?
              </div>
              {readiness != null && rl && (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{
                    width: 36, height: 36, borderRadius: 18,
                    background: rl.color + "22",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 18, fontWeight: 900, color: rl.color,
                  }}>
                    {readiness}
                  </div>
                  <div style={{ fontSize: 12, color: rl.color, fontWeight: 600 }}>{rl.text}</div>
                </div>
              )}
            </div>

            {/* 5-emoji picker */}
            <div style={{ display: "flex", gap: 8 }}>
              {FEEL_OPTIONS.map(f => {
                const selected = todaySubj === f.val;
                return (
                  <button
                    key={f.val}
                    onClick={() => onSubjReadiness(f.val)}
                    title={f.label}
                    style={{
                      flex: 1, padding: "10px 0", borderRadius: 10, cursor: "pointer",
                      border: selected ? `2px solid ${recoveryLabel(subjToScore(f.val)).color}` : `2px solid ${C.border}`,
                      background: selected ? recoveryLabel(subjToScore(f.val)).color + "22" : C.bg,
                      fontSize: 22, lineHeight: 1, transition: "all 0.15s",
                    }}
                  >
                    {f.emoji}
                    <div style={{ fontSize: 9, color: selected ? recoveryLabel(subjToScore(f.val)).color : C.muted, marginTop: 3, fontWeight: selected ? 700 : 400 }}>
                      {f.label}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Source label */}
            <div style={{ marginTop: 9, fontSize: 11, color: C.muted, textAlign: "right" }}>
              {todaySubj != null
                ? `You rated today ${selectedFeel?.emoji} ${selectedFeel?.label} — tap to update`
                : isEstimated
                  ? "Estimated from logged training only — doesn't include climbing or other activity"
                  : ""}
            </div>
          </div>
        );
      })()}

      <BwPrompt unit={unit} onSave={onBwSave} />

      {/* Tindeq Connect slot — rendered just above the Start button */}
      {connectSlot}

      <Btn
        onClick={onStart}
        disabled={!config.grip}
        style={{ width: "100%", padding: "16px 0", fontSize: 17, borderRadius: 12 }}
      >
        {config.grip ? "Start Session →" : "Select a grip to start"}
      </Btn>
    </div>
  );
}

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

// ─────────────────────────────────────────────────────────────
// ANALYSIS VIEW  — Force-Duration Curve + Training Recommendations
// ─────────────────────────────────────────────────────────────
// POWER_MAX, STRENGTH_MAX now live in src/model/zones.js (imported above).

// Shared recommendation metadata — used by both the pooled/selGrip-scoped
// `recommendation` useMemo and the per-grip `gripRecs` useMemo so the
// title/color/caption shown for "Train Power / Strength / Capacity" stay
// consistent between scopes.
const ZONE_DETAILS = {
  power: {
    title: "Train Power", color: C.red,
    caption: "short, high-force efforts that develop W′, the finite anaerobic reserve above your CF asymptote.",
  },
  strength: {
    title: "Train Strength", color: C.orange,
    caption: "mid-duration max hangs that lift the force ceiling — and with it, CF.",
  },
  endurance: {
    title: "Train Capacity", color: C.blue,
    caption: "sustained threshold holds that raise CF as a fraction of your existing ceiling.",
  },
};

// Pure helper: given a {CF, W} fit and personalResponse map, compute the
// projected ΔAUC for each protocol and return the rec payload. Separate
// from the React memos so it can be called once per grip.
function buildRecFromFit(fit, personalResponse, unit) {
  if (!fit) return null;
  const { CF, W } = fit;
  const gains = {};
  for (const [key, resp] of Object.entries(personalResponse)) {
    const dCF = CF * resp.cf;
    const dW  = W  * resp.w;
    const gainKg = dCF * (AUC_T_MAX - AUC_T_MIN) + dW * Math.log(AUC_T_MAX / AUC_T_MIN);
    gains[key] = toDisp(gainKg, unit);
  }
  const bestKey = Object.entries(gains).reduce((a, b) => b[1] > a[1] ? b : a)[0];
  const d = ZONE_DETAILS[bestKey];
  const responseSource = {};
  for (const key of Object.keys(personalResponse)) {
    responseSource[key] = {
      source: personalResponse[key].source,
      n:      personalResponse[key].n,
    };
  }
  return {
    key:     bestKey,
    title:   d.title,
    color:   d.color,
    insight: `Largest projected AUC gain from ${d.caption}`,
    gains,
    aucGain: gains[bestKey],
    responseSource,
  };
}

function AnalysisView({ history, unit = "lbs", bodyWeight = null, baseline = null, activities = [], liveEstimate = null, gripEstimates = {}, freshMap = null, readiness = 5 }) {
  const [selHand,   setSelHand]   = useState("");   // "" = Both (pool L+R for the F-D chart)
  const [selGrip,   setSelGrip]   = useState("");
  const [relMode,   setRelMode]   = useState(false); // relative strength toggle

  const grips = useMemo(() =>
    [...new Set(history.map(r => r.grip).filter(Boolean))].sort(),
    [history]
  );

  // All reps with usable force + time data for the selected filters.
  // selHand === "" means Both — pool L+R for the F-D chart's at-a-glance
  // view. Per-hand prescriptions still iterate L and R explicitly elsewhere.
  const reps = useMemo(() => history.filter(r =>
    (!selHand || r.hand === selHand) &&
    (!selGrip || r.grip === selGrip) &&
    r.avg_force_kg > 0 && r.avg_force_kg < 500 &&
    r.actual_time_s > 0
  ), [history, selHand, selGrip]);

  const failures  = reps.filter(r => r.failed);
  const successes = reps.filter(r => !r.failed);

  const maxDur = Math.max(...reps.map(r => r.actual_time_s), STRENGTH_MAX + 60);

  // Per-grip three-exp priors. Used by the gap-narrowing tracker and
  // the prescription-potential calculation (since three-exp is now the
  // primary potential value when well-supported). Same memo as in
  // SetupView; could be lifted to App if it becomes hot.
  const threeExpPriors = useMemo(() => buildThreeExpPriors(history), [history]);

  // ── Critical Force estimation via Monod-Scherrer linearization ──
  // Failure-only fit on RAW force (no freshMap, no success-floor). This
  // is intentionally the "what your failures actually show" curve, not
  // the "what your prescription engine wants to push you to" curve.
  //
  // Why not use the prescription fit (with success-floor + freshMap)?
  // We tried it. Hard success-floor constraints + Monod's hyperbolic
  // shape can't satisfy both "your high-force short-duration successes"
  // AND "your moderate-force middle-duration failures" because Monod
  // doesn't have enough flexibility — the success-floor wins and the
  // resulting curve overshoots the failure cluster by 5-30 kg in the
  // middle, making the chart misleading. The failure-only fit shows
  // the data honestly; the prescription engine separately uses the
  // empirical-first path (anchored to recent rep 1) which produces
  // the right next-session loads without forcing the chart to lie.
  //
  // The dots above the curve = above-curve performance (strong zone).
  // Dots below the curve = below-curve performance (limiter zone).
  // That's the visual diagnosis Nathan called out as "where the magic
  // happens" — and it only works if the curve is honest about the data.
  const cfEstimate = useMemo(() => {
    if (failures.length < 2) return null;
    const pts = failures.map(r => ({ x: 1 / r.actual_time_s, y: r.avg_force_kg }));
    return fitCF(pts);
  }, [failures]);

  // ── Capacity improvement % vs baseline ──
  // Reference durations for each domain (seconds)
  const REF = { power: 10, strength: 45, endurance: 180 };

  // Reusable: compute {power, strength, endurance, total} Δ% for a
  // current fit against a reference fit. The reference is injected so
  // the pooled path and per-grip path can each compare apples-to-
  // apples (pooled-current vs pooled-baseline; Micro-now vs Micro-
  // then; Crusher-now vs Crusher-then).
  const improvementForFit = (fit, ref) => {
    if (!ref || !fit) return null;
    const pct = (t) => {
      const cur  = predForce(fit, t);
      const base = predForce(ref, t);
      if (base <= 0) return null;
      return Math.round((cur / base - 1) * 100);
    };
    const p = pct(REF.power);
    const s = pct(REF.strength);
    const e = pct(REF.endurance);
    if (p == null || s == null || e == null) return null;
    return { power: p, strength: s, endurance: e, total: Math.round((p + s + e) / 3) };
  };

  const improvement = useMemo(
    () => improvementForFit(cfEstimate, baseline),
    [baseline, cfEstimate] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Per-grip baselines — for each grip, find the earliest window of
  // failure reps (≥5 reps, ≥3 distinct target durations) and fit a
  // Monod-Scherrer snapshot from just that grip's reps. This mirrors
  // the global auto-baseline seeding logic (App-level useEffect) but
  // scoped per grip, with a tighter threshold:
  //   - ≥5 reps (vs 3 globally) to damp W' estimate variance
  //   - ≥3 distinct durations (vs 2 globally) so the Monod fit has
  //     real spread along the 1/T axis instead of a 2-point line
  // Small-N Monod fits have high variance in W' — the anaerobic
  // numerator — and that noise is amplified at short T by the 1/T
  // factor. A 3-rep baseline across 2 durations was producing
  // optimistic W' values that later fits naturally pulled down,
  // showing up as phantom "Power regression" of -50% or so. 5 reps
  // across 3 durations gives a far more stable intercept+slope.
  const gripBaselines = useMemo(() => {
    const out = {};
    const byGrip = {};
    for (const r of history) {
      if (!r.failed || !r.grip) continue;
      if (!(r.avg_force_kg > 0 && r.avg_force_kg < 500)) continue;
      if (!(r.actual_time_s > 0)) continue;
      if (!byGrip[r.grip]) byGrip[r.grip] = [];
      byGrip[r.grip].push(r);
    }
    for (const [grip, reps] of Object.entries(byGrip)) {
      reps.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
      const acc = [];
      const durs = new Set();
      for (const r of reps) {
        acc.push(r);
        durs.add(r.target_duration);
        if (acc.length >= 5 && durs.size >= 3) {
          const fit = fitCF(acc.map(x => ({ x: 1 / x.actual_time_s, y: x.avg_force_kg })));
          if (fit) out[grip] = { date: acc[0].date, CF: fit.CF, W: fit.W };
          break;
        }
      }
    }
    return out;
  }, [history]);

  // Per-grip capacity improvement — each grip's current fit vs its
  // own per-grip baseline. Only emitted for grips that have both a
  // per-grip baseline AND a per-grip current fit, so the card never
  // shows a misleading cross-muscle comparison.
  const gripImprovement = useMemo(() => {
    const out = {};
    for (const [grip, fit] of Object.entries(gripEstimates)) {
      const ref = gripBaselines[grip];
      if (!ref) continue;
      const imp = improvementForFit(fit, ref);
      if (imp) out[grip] = { ...imp, baselineDate: ref.date };
    }
    return out;
  }, [gripBaselines, gripEstimates]); // eslint-disable-line react-hooks/exhaustive-deps


  // ── Per-hand × per-grip baselines ──
  // Same seeding logic as gripBaselines but scoped to a single hand on
  // a single grip. Needed because Monod W' has high variance at small
  // N — if we compared each (grip,hand) fit against the POOLED global
  // baseline, cross-muscle (FDP vs FDS) and cross-hand asymmetries
  // contaminated the reference and produced phantom regressions on
  // whichever hand/grip combo started above the pooled mean. With a
  // per-(grip,hand) baseline, Δ% is an apples-to-apples comparison.
  // Threshold: ≥5 failures across ≥3 distinct durations per combo.
  const perHandGripBaselines = useMemo(() => {
    const out = {};
    const byKey = {};
    for (const r of history) {
      if (!r.failed || !r.grip || !r.hand || r.hand === "Both") continue;
      if (!(r.avg_force_kg > 0 && r.avg_force_kg < 500)) continue;
      if (!(r.actual_time_s > 0)) continue;
      const key = `${r.grip}|${r.hand}`;
      if (!byKey[key]) byKey[key] = [];
      byKey[key].push(r);
    }
    for (const [key, reps] of Object.entries(byKey)) {
      reps.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
      const acc = [];
      const durs = new Set();
      for (const r of reps) {
        acc.push(r);
        durs.add(r.target_duration);
        if (acc.length >= 5 && durs.size >= 3) {
          const fit = fitCF(acc.map(x => ({ x: 1 / x.actual_time_s, y: x.avg_force_kg })));
          if (fit) out[key] = { date: acc[0].date, CF: fit.CF, W: fit.W };
          break;
        }
      }
    }
    return out;
  }, [history]);

  // Progress toward unlocking a per-grip (or per-grip × hand) baseline.
  // Returns {failures, distinctDurations, ready} so UI placeholders can
  // show "3 of 5 failures · 2 of 3 durations" instead of the static
  // "need ≥5 failures across ≥3 target durations" — the user can see
  // exactly how close they are to a stable comparison being unlocked.
  // Hand is optional; pass null/undefined to count across both hands.
  const FAIL_THRESHOLD = 5;
  const DUR_THRESHOLD  = 3;
  const baselineProgress = (grip, hand = null) => {
    let failures = 0;
    const durs = new Set();
    for (const r of history) {
      if (!r.failed || r.grip !== grip) continue;
      if (hand && r.hand !== hand) continue;
      if (!(r.avg_force_kg > 0 && r.avg_force_kg < 500)) continue;
      if (!(r.actual_time_s > 0)) continue;
      failures += 1;
      if (r.target_duration) durs.add(r.target_duration);
    }
    return {
      failures,
      distinctDurations: durs.size,
      ready: failures >= FAIL_THRESHOLD && durs.size >= DUR_THRESHOLD,
    };
  };

  // ── Per-hand / per-grip CF & W' breakdown ──
  // Groups failure reps by grip × hand, fits Monod (F = CF + W'/T) for
  // each group, and reports CF and W' alongside their delta vs that
  // same (grip,hand)'s own baseline snapshot (see perHandGripBaselines
  // above for why per-hand-per-grip, not pooled). When a combo doesn't
  // yet qualify for a stable baseline, we still emit the row but with
  // cfPct=null so the UI can show current CF without a misleading Δ%.
  // Kept for future per-hand diagnostic use; the Per-Hand CF card that
  // consumed this was removed because it duplicated the Critical Force
  // Estimate cards' per-grip view.
  // eslint-disable-next-line no-unused-vars
  const perHandImprovement = useMemo(() => {
    const groups = {};
    for (const r of history) {
      if (!r.failed || !r.grip || !r.hand || r.hand === "Both") continue;
      if (r.avg_force_kg <= 0 || r.actual_time_s <= 0) continue;
      const key = `${r.grip}|${r.hand}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(r);
    }
    const result = {};
    for (const [key, reps] of Object.entries(groups)) {
      if (reps.length < 2) continue;
      const curPts = reps.map(r => ({ x: 1 / r.actual_time_s, y: r.avg_force_kg }));
      const cur    = fitCF(curPts);
      if (!cur) continue;
      const [grip, hand] = key.split("|");
      const ref = perHandGripBaselines[key];
      const cfPct = ref && ref.CF > 0 ? Math.round((cur.CF / ref.CF - 1) * 100) : null;
      const wPct  = ref && ref.W  > 0 ? Math.round((cur.W  / ref.W  - 1) * 100) : null;
      result[key] = {
        grip, hand, n: reps.length,
        cf: cur.CF, w: cur.W,
        cfPct, wPct,
        baselineDate: ref?.date ?? null,
        hasBaseline: !!ref,
      };
    }
    return Object.keys(result).length > 0 ? result : null;
  }, [history, perHandGripBaselines]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Curve parameters over time ──
  // For each date with failure data, refit Monod (F = CF + W'/T) using
  // all failures up to that date and record CF and W' directly. Plotted
  // on dual axes: CF (force units) tracks the slow aerobic asymptote,
  // W' (force·s) tracks the faster anaerobic capacity. Showing the two
  // raw fit parameters is more legible than the three derived zone %s.
  const cumulativeData = useMemo(() => {
    if (failures.length < 2) return [];
    const sorted = [...failures].sort((a, b) => a.date.localeCompare(b.date));
    const dates  = [...new Set(sorted.map(r => r.date))];
    // Reuse selGrip if set so the three-exp prior is well-scoped.
    return dates.map(date => {
      const upTo = sorted.filter(r => r.date <= date);
      if (upTo.length < 2) return null;
      const fit = fitCF(upTo.map(r => ({ x: 1 / r.actual_time_s, y: r.avg_force_kg })));
      if (!fit) return null;
      // Three-exp predicted force at T=120s on the same cumulative
      // dataset. Useful as a parallel "long-duration capacity" track
      // since three-exp captures the steeper drop-off Monod's hyperbolic
      // shape misses at the extremes. Only computed when selGrip is set
      // so we have a sensible per-grip prior.
      let teePot120 = null;
      if (selGrip && threeExpPriors && threeExpPriors.get) {
        const prior = threeExpPriors.get(selGrip);
        if (prior && upTo.length >= 2) {
          const pts = upTo.map(r => ({ T: r.actual_time_s, F: r.avg_force_kg }));
          const lambda = THREE_EXP_LAMBDA_DEFAULT / Math.max(upTo.length, 1);
          const amps = fitThreeExpAmps(pts, { prior, lambda });
          if (amps[0] + amps[1] + amps[2] > 0) {
            const f = predForceThreeExp(amps, 120);
            if (f > 0) teePot120 = toDisp(f, unit);
          }
        }
      }
      return {
        date,
        cf: toDisp(fit.CF, unit),
        w:  toDisp(fit.W,  unit),  // W' has units of force·s; same linear conversion as force
        teePot120,
      };
    }).filter(Boolean);
  }, [failures, unit, selGrip, threeExpPriors]); // eslint-disable-line react-hooks/exhaustive-deps

  // Per-grip cumulative CF, used by CF Over Time when no grip filter
  // is active. Without this split, a Micro-heavy session pulls the
  // pooled CF curve down (FDP CF ~6 kg vs FDS CF ~25 kg) and looks
  // like a regression even though both grips might be improving in
  // isolation. Same scope rules as the pooled version: respects
  // selHand, requires ≥2 failures per grip up to each cumulative
  // date, returns one merged Recharts dataset keyed by date with
  // per-grip CF columns (e.g. {date, "Micro_cf": 6.1, "Crusher_cf": 24.3}).
  const cumulativeDataByGrip = useMemo(() => {
    if (selGrip) return null; // pooled chart already correct when scoped
    const byGrip = {};
    for (const r of history) {
      if (!r.failed || !r.grip) continue;
      if (selHand && r.hand !== selHand) continue;
      if (!(r.avg_force_kg > 0 && r.avg_force_kg < 500)) continue;
      if (!(r.actual_time_s > 0)) continue;
      if (!byGrip[r.grip]) byGrip[r.grip] = [];
      byGrip[r.grip].push(r);
    }
    const grips = Object.keys(byGrip).filter(g => byGrip[g].length >= 2);
    if (grips.length < 2) return null; // single-grip user — pooled is fine
    const allDates = [...new Set(history.filter(r => r.failed).map(r => r.date))].sort();
    const rows = [];
    for (const date of allDates) {
      const row = { date };
      let any = false;
      for (const grip of grips) {
        const upTo = byGrip[grip].filter(r => r.date <= date);
        if (upTo.length < 2) continue;
        const fit = fitCF(upTo.map(r => ({ x: 1 / r.actual_time_s, y: r.avg_force_kg })));
        if (!fit) continue;
        row[`${grip}_cf`] = toDisp(fit.CF, unit);
        any = true;
      }
      if (any) rows.push(row);
    }
    return { rows, grips };
  }, [history, selHand, selGrip, unit]); // eslint-disable-line react-hooks/exhaustive-deps

  // Note: AUC values used to live here (aucEstimate / aucBaseline /
  // aucHistory) backing a dedicated "Climbing Capacity · AUC" card.
  // That card was removed because the Capacity Improvement card
  // already shows each grip's Total % (which IS the AUC % gain) and
  // the CF & W' Over Time chart already shows trajectory. AUC math
  // still lives in computeAUC and is used by the recommendation
  // engine and ΔAUC ranking.

  // Fitted force-duration curve points for overlay.
  // Clipped at T≥5s — the Monod asymptote F = CF + W'/T diverges as
  // T→0, which exploded the Y-axis with ~6-figure forces. Below ~5s
  // we're outside the Monod validity range anyway (MVC ceiling, neural
  // rather than metabolic limitation), so nothing is lost by clipping.
  const F_D_T_MIN = 5;
  const curveData = useMemo(() => {
    if (!cfEstimate) return [];
    const { CF, W } = cfEstimate;
    const tMax = Math.max(maxDur, F_D_T_MIN + 10);
    return Array.from({ length: 80 }, (_, i) => {
      const t = F_D_T_MIN + ((tMax - F_D_T_MIN) / 79) * i;
      return { x: t, y: toDisp(Math.max(CF + W / t, CF), unit) };
    });
  }, [cfEstimate, maxDur, unit]);

  // Per-grip Monod curves + dots, used in the F-D chart when no grip
  // filter is active. Pooling Micro and Crusher onto one chart conflates
  // two different muscles (FDP pinch vs FDS crush) — the cross-muscle
  // amplitude difference dominates and the user can't see what's
  // happening to each grip individually. When ≥2 grips have ≥2
  // failures (and no selGrip), splitMode renders both.
  const fdSplitData = useMemo(() => {
    if (selGrip) return null;
    const byGrip = {};
    for (const r of history) {
      if (!r.grip) continue;
      if (selHand && r.hand !== selHand) continue;
      if (!(r.avg_force_kg > 0 && r.avg_force_kg < 500)) continue;
      if (!(r.actual_time_s > 0)) continue;
      if (!byGrip[r.grip]) byGrip[r.grip] = { failures: [], successes: [] };
      const bucket = r.failed ? "failures" : "successes";
      // Successes only count toward the chart when they hit target —
      // partial holds without a fail flag are ambiguous (matches the
      // existing prescribedLoad scope).
      if (bucket === "successes" && !(r.target_duration > 0 && r.actual_time_s >= r.target_duration)) continue;
      byGrip[r.grip][bucket].push(r);
    }
    const grips = Object.keys(byGrip).filter(g => byGrip[g].failures.length >= 2);
    if (grips.length < 2) return null;
    const tMax = Math.max(maxDur, F_D_T_MIN + 10);
    const out = {};
    for (const grip of grips) {
      const fail = byGrip[grip].failures;
      const succ = byGrip[grip].successes;
      const fit = fitCFWithSuccessFloor(
        fail.map(r => ({ x: 1 / r.actual_time_s, y: r.avg_force_kg })),
        succ.map(r => ({ x: 1 / r.actual_time_s, y: r.avg_force_kg })),
      );
      if (!fit) continue;
      const curve = Array.from({ length: 80 }, (_, i) => {
        const t = F_D_T_MIN + ((tMax - F_D_T_MIN) / 79) * i;
        return { x: t, y: toDisp(Math.max(fit.CF + fit.W / t, fit.CF), unit) };
      });
      out[grip] = {
        fit,
        curve,
        failures: fail.map(r => ({ x: r.actual_time_s, y: toDisp(r.avg_force_kg, unit), date: r.date, grip: r.grip })),
        successes: succ.map(r => ({ x: r.actual_time_s, y: toDisp(r.avg_force_kg, unit), date: r.date, grip: r.grip })),
      };
    }
    return Object.keys(out).length >= 2 ? out : null;
  }, [history, selHand, selGrip, maxDur, unit]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Gap-narrowing tracker over time ──
  // For each session date, compute the gap between empirical (what user
  // actually trained at) and potential (curve-derived ceiling) per zone,
  // using only data UP TO that date. Series shows whether the user is
  // closing the gap in each compartment over time — the real "am I
  // building toward potential" progress signal, much more actionable
  // than absolute CF over time.
  //
  // Scope: requires a grip filter (cross-grip gap is meaningless).
  // When selHand is set, computes per-hand. When unset, pools both hands
  // (the curve fit is grip-scoped, the empirical anchor is most-recent
  // rep 1 across both hands).
  const gapHistory = useMemo(() => {
    if (!selGrip) return null;
    const targets = [
      { key: "power",     T: GOAL_CONFIG.power.refTime,     color: GOAL_CONFIG.power.color },
      { key: "strength",  T: GOAL_CONFIG.strength.refTime,  color: GOAL_CONFIG.strength.color },
      { key: "endurance", T: GOAL_CONFIG.endurance.refTime, color: GOAL_CONFIG.endurance.color },
    ];
    // Snapshot dates: every distinct date the user trained this grip
    // (with the active hand filter applied if any). Keeps the chart
    // sparse but representative.
    const handFn = (r) => !selHand || r.hand === selHand;
    const datesSet = new Set();
    for (const r of history) {
      if (r.grip !== selGrip || !handFn(r) || !r.date) continue;
      if (!(r.actual_time_s > 0)) continue;
      datesSet.add(r.date);
    }
    const dates = [...datesSet].sort();
    if (dates.length < 2) return null;
    const rows = [];
    for (const date of dates) {
      const upTo = history.filter(r => (r.date || "") <= date);
      const row = { date };
      for (const { key, T } of targets) {
        let bestGap = null;
        const handsToCheck = selHand ? [selHand] : ["L", "R"];
        for (const h of handsToCheck) {
          const trainAt = empiricalPrescription(upTo, h, selGrip, T, { threeExpPriors });
          const pot = prescriptionPotential(upTo, h, selGrip, T, { threeExpPriors });
          if (trainAt == null || !pot || pot.reliability === "extrapolation") continue;
          const gap = (pot.value - trainAt) / trainAt;
          if (bestGap == null || gap > bestGap) bestGap = gap;
        }
        row[`${key}_gap`] = bestGap != null ? Math.round(bestGap * 100) : null;
      }
      // Only include rows where at least one zone had a computable gap
      if (targets.some(({key}) => row[`${key}_gap`] != null)) rows.push(row);
    }
    return rows.length >= 2 ? rows : null;
  }, [history, selHand, selGrip, threeExpPriors]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Three-exp F-D fit (governing model — see src/model/threeExp.js) ──
  // threeExpPriors memoized earlier in AnalysisView so gapHistory,
  // prescriptionPotential, and the chart curve all share one fit basis.

  // Three-exp fit for the current (selHand, selGrip) scope. Uses the
  // same `failures` array that backs cfEstimate, so the fits are
  // directly comparable. When no grip is selected, we can't pick a
  // prior — fall back to no-shrinkage fit (which validation showed
  // loses to Monod by ~3% on aggregate, fine as a degenerate case).
  const threeExpFit = useMemo(() => {
    if (failures.length < 2) return null;
    const pts = failures.map(r => ({ T: r.actual_time_s, F: r.avg_force_kg }));
    const prior = selGrip ? (threeExpPriors.get(selGrip) || [0,0,0]) : [0,0,0];
    const lambda = selGrip ? THREE_EXP_LAMBDA_DEFAULT / Math.max(failures.length, 1) : 0;
    const amps = fitThreeExpAmps(pts, { prior, lambda });
    if (amps[0] + amps[1] + amps[2] <= 0) return null;
    return { amps, prior, lambda };
  }, [failures, selGrip, threeExpPriors]);

  // Predicted curve for chart overlay — same T grid as curveData so the
  // two lines align visually.
  const threeExpCurveData = useMemo(() => {
    if (!threeExpFit) return [];
    const tMax = Math.max(maxDur, F_D_T_MIN + 10);
    return Array.from({ length: 80 }, (_, i) => {
      const t = F_D_T_MIN + ((tMax - F_D_T_MIN) / 79) * i;
      const f = predForceThreeExp(threeExpFit.amps, t);
      return { x: t, y: toDisp(Math.max(f, 0), unit) };
    });
  }, [threeExpFit, maxDur, unit]);

  // Three-exp doesn't have a true asymptote (decays to 0), so there is
  // no direct analog to Monod's CF. The closest physiologically meaningful
  // "long-duration sustainable force" reference is F(180s) — well past
  // the glycolytic dominance window (τ₂=30s drained 6× over) where the
  // slow oxidative compartment carries essentially the whole load. Used
  // as the dashed horizontal reference on the F-D chart, replacing the
  // CF line that came from Monod.
  const threeExpRef180 = useMemo(() => {
    if (!threeExpFit) return null;
    return predForceThreeExp(threeExpFit.amps, 180);
  }, [threeExpFit]);

  // Train RMSE on the failure points for both models — directional
  // signal of fit quality. NOTE: this is training RMSE not holdout, so
  // it's biased optimistic for both; the relative comparison between
  // the two models on the SAME data is still meaningful. Holdout
  // validation lives in the offline sim (validate_three_exp_v3.js).
  const modelRMSE = useMemo(() => {
    if (failures.length < 2 || !cfEstimate || !threeExpFit) return null;
    let mErr = 0, eErr = 0;
    for (const r of failures) {
      const T = r.actual_time_s, F = r.avg_force_kg;
      const mPred = cfEstimate.CF + cfEstimate.W / T;
      const ePred = predForceThreeExp(threeExpFit.amps, T);
      mErr += (mPred - F) ** 2;
      eErr += (ePred - F) ** 2;
    }
    return {
      monod:    Math.sqrt(mErr / failures.length),
      threeExp: Math.sqrt(eErr / failures.length),
      n:        failures.length,
    };
  }, [failures, cfEstimate, threeExpFit]);

  // (Per-hand L vs R overlay curves were here. Removed — added visual
  // noise to the F-D chart without enough insight to justify it. Per-
  // hand asymmetry is surfaced more clearly on the Per-Hand CF card
  // below the chart.)

  // Bootstrap confidence band around the three-exp F-D curve — resample
  // failure points with replacement, refit each sample, take 5th/95th
  // percentile of predicted force at each T. Band narrows as more data
  // accumulates, so users can see when the fit is actually trustworthy.
  // Deterministic RNG seeded from the data so the band is stable across
  // renders. Bootstrapped against three-exp (now the primary curve) so
  // the band represents uncertainty in the curve we're actually showing.
  const confidenceBand = useMemo(() => {
    if (!failures || failures.length < 3) return null;
    const tePts = failures.map(r => ({ T: r.actual_time_s, F: r.avg_force_kg }));
    const prior = selGrip ? (threeExpPriors.get(selGrip) || [0,0,0]) : [0,0,0];
    const lambda = selGrip ? THREE_EXP_LAMBDA_DEFAULT / Math.max(failures.length, 1) : 0;
    const N = 150;
    const tMax = Math.max(maxDur, F_D_T_MIN + 10);
    const nSamples = 60;
    const ts = Array.from({ length: nSamples }, (_, i) =>
      F_D_T_MIN + ((tMax - F_D_T_MIN) / (nSamples - 1)) * i
    );
    let seed = (failures.length * 1000 + Math.floor((failures[0].actual_time_s || 1) * 1e6)) >>> 0;
    const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const curves = [];
    for (let i = 0; i < N; i++) {
      const sample = Array.from({ length: tePts.length }, () => tePts[Math.floor(rng() * tePts.length)]);
      const amps = fitThreeExpAmps(sample, { prior, lambda });
      if (amps[0] + amps[1] + amps[2] > 0) {
        curves.push(ts.map(t => Math.max(predForceThreeExp(amps, t), 0)));
      }
    }
    if (curves.length < 20) return null;
    return ts.map((t, j) => {
      const vals = curves.map(c => c[j]).sort((a, b) => a - b);
      const p5  = vals[Math.floor(vals.length * 0.05)];
      const p95 = vals[Math.min(Math.floor(vals.length * 0.95), vals.length - 1)];
      return { x: t, lowKg: p5, highKg: p95 };
    });
  }, [failures, maxDur, selGrip, threeExpPriors]);

  // Limiter zone (the zone that falls farthest below the F-D curve
  // predicted by the other two zones). Drives the saturated background
  // highlight on the F-D chart — visual echo of the SessionPlanner's
  // recommendation, so the chart and the planner tell the same story.
  const limiterZoneBounds = useMemo(() => {
    const lim = computeLimiterZone(history);
    if (!lim) return null;
    const zoneMap = {
      power:     { x1: 0,            x2: POWER_MAX,    color: C.red,    label: "Limiter: Power"    },
      strength:  { x1: POWER_MAX,    x2: STRENGTH_MAX, color: C.orange, label: "Limiter: Strength" },
      endurance: { x1: STRENGTH_MAX, x2: maxDur + 10,  color: C.blue,   label: "Limiter: Capacity" },
    };
    return zoneMap[lim.zone] || null;
  }, [history, maxDur]);

  // ── Relative strength helpers ──
  const useRel = relMode && bodyWeight != null && bodyWeight > 0;
  // Convert a kg force value to the display value (abs or relative)
  const fmtForce = (kg) => {
    if (kg == null) return "—";
    if (useRel) return fmt1(kg / bodyWeight);     // unitless ratio
    return fmtW(kg, unit);
  };
  const forceUnit = useRel ? "× BW" : unit;

  // Scatter data — recalculated when relMode toggles
  const successDotsRel = successes.map(r => ({
    x: r.actual_time_s,
    y: useRel ? r.avg_force_kg / bodyWeight : toDisp(r.avg_force_kg, unit),
    date: r.date, grip: r.grip,
  }));
  const failureDotsRel = failures.map(r => ({
    x: r.actual_time_s,
    y: useRel ? r.avg_force_kg / bodyWeight : toDisp(r.avg_force_kg, unit),
    date: r.date, grip: r.grip,
  }));
  const curveDataRel = curveData.map(d => ({
    x: d.x,
    y: useRel && bodyWeight > 0 ? d.y / (bodyWeight * (unit === "lbs" ? KG_TO_LBS : 1)) : d.y,
  }));
  const threeExpCurveDataRel = threeExpCurveData.map(d => ({
    x: d.x,
    y: useRel && bodyWeight > 0 ? d.y / (bodyWeight * (unit === "lbs" ? KG_TO_LBS : 1)) : d.y,
  }));
  // Unit-transform helper for memos that hold values in kg (confidenceBand):
  // converts to display unit or × BW depending on relMode.
  const kgToDisp = (kg) => useRel && bodyWeight > 0 ? kg / bodyWeight : toDisp(kg, unit);
  const confidenceBandRel = confidenceBand ? confidenceBand.map(d => ({
    x: d.x, low: kgToDisp(d.lowKg), high: kgToDisp(d.highKg),
  })) : null;
  const maxForceRel = Math.max(
    ...(useRel
      ? reps.map(r => r.avg_force_kg / bodyWeight)
      : reps.map(r => toDisp(r.avg_force_kg, unit))),
    useRel ? 0.5 : 40
  );

  // ── Zone breakdown (power / strength / capacity) ──
  // Buckets each rep by target_duration (what zone it was *training*),
  // not actual_time_s, so a failed Capacity-target hang that broke at
  // 60s still counts as a Capacity failure. Without this, Capacity
  // failures are structurally impossible when the target sits exactly
  // on the zone boundary (120s). Falls back to actual_time_s when a
  // rep has no target_duration (legacy data).
  //
  // Failure detection is computed live from actual_time_s < target_duration
  // to match the red/green rendering in History. The stored r.failed flag
  // only flips on auto-failure (Tindeq force-drop); manually-ended short
  // hangs leave r.failed=false even though the rep clearly failed.
  const zones = useMemo(() => {
    const zoneStats = (lo, hi) => {
      const z = reps.filter(r => {
        const t = r.target_duration > 0 ? r.target_duration : r.actual_time_s;
        return t >= lo && t < hi;
      });
      const f = z.filter(r => {
        if (r.target_duration > 0) return r.actual_time_s < r.target_duration;
        return r.failed;
      }).length;
      return { total: z.length, failures: f, successes: z.length - f,
               failRate: z.length > 0 ? f / z.length : null };
    };
    return {
      power:     { ...zoneStats(0, POWER_MAX),                label: "Power",     color: C.red,    desc: "0–20s",    system: "Phosphocreatine",  tau: `τ₁ ≈ ${PHYS_MODEL_DEFAULT.tauR.fast}s`   },
      strength:  { ...zoneStats(POWER_MAX, STRENGTH_MAX),     label: "Strength",  color: C.orange, desc: "20–120s",  system: "Glycolytic",       tau: `τ₂ ≈ ${PHYS_MODEL_DEFAULT.tauR.medium}s` },
      endurance: { ...zoneStats(STRENGTH_MAX, Infinity),      label: "Capacity",  color: C.blue,   desc: "120s+",    system: "Oxidative",        tau: `τ₃ ≈ ${PHYS_MODEL_DEFAULT.tauR.slow}s`   },
    };
  }, [reps]);

  // ── Personal response calibration ──
  // Fits CF/W′ response rates per zone from the user's own history and
  // shrinks toward PROTOCOL_RESPONSE. Used by the recommendation engine
  // instead of the raw prior so the engine's "what grows AUC fastest"
  // adapts to this climber's actual measured response.
  const personalResponse = useMemo(
    () => computePersonalResponse(history),
    [history]
  );

  // ── Unified training recommendation ──
  // Primary signal: marginal AUC gain. For each protocol (power /
  // strength / capacity), take the PERSONAL response rates (prior if
  // thin data, blended with observed otherwise), project ΔCF and ΔW′
  // at current parameter values, and integrate to a projected ΔAUC
  // over the climbing-relevant 10–120s window. Pick the protocol with
  // the largest projected ΔAUC.
  //
  // Secondary: Monod cross-zone residual (limiter) and zone coverage,
  // kept as diagnostics alongside the ΔAUC ranking so users can see
  // where the curve is lopsided and which zones are under-trained.
  const recommendation = useMemo(() => {
    // Limiter (curve shape) — kept as secondary diagnostic
    const limiter = computeLimiterZone(history);
    const limiterKey  = limiter?.zone ?? null;
    const limiterGrip = limiter?.grip ?? null;

    // Coverage (training distribution) — kept as tertiary diagnostic
    const coverage = computeZoneCoverage(history, activities);
    const coverageKey = coverage.total > 0 ? coverage.recommended : null;

    // Primary path: coaching engine v2 (gap × intensity × recency ×
    // external) when a grip is selected. For the no-grip-selected case
    // there's no meaningful single recommendation (gap requires a grip
    // scope), so we fall back to the legacy ΔAUC ranking on liveEstimate.
    if (selGrip) {
      const coach = coachingRecommendation(history, selGrip, {
        freshMap, threeExpPriors, readiness, activities,
      });
      if (coach) {
        const d = ZONE_DETAILS[coach.zone];
        // Compute per-zone gap landscape for the bars
        const zones = ["power", "strength", "endurance"];
        const zoneGaps = {};
        for (const zoneKey of zones) {
          const t = GOAL_CONFIG[zoneKey].refTime;
          let bestGap = null;
          for (const h of ["L", "R"]) {
            const trainAt = empiricalPrescription(history, h, selGrip, t, { threeExpPriors })
                         ?? prescribedLoad(history, h, selGrip, t, freshMap, { threeExpPriors });
            const pot = prescriptionPotential(history, h, selGrip, t, { freshMap, threeExpPriors });
            if (trainAt == null || !pot || pot.reliability === "extrapolation") continue;
            const gap = (pot.value - trainAt) / trainAt;
            if (bestGap == null || gap > bestGap) bestGap = gap;
          }
          zoneGaps[zoneKey] = bestGap;
        }
        return {
          key: coach.zone, title: d.title, color: d.color,
          rationale: coachingRationale(coach),
          coach, zoneGaps,
          limiterKey, limiterGrip, coverageKey,
          agree: !limiterKey || limiterKey === coach.zone,
          coverageZoneLabel: coverageKey ? ZONE_DETAILS[coverageKey].title.replace("Train ", "") : null,
        };
      }
    }

    // Fallback path: legacy ΔAUC ranking on the pooled / available fit.
    // Used when no grip is selected (pooled recommendation across grips)
    // or when the coaching engine has no scoreable zones for the picked
    // grip yet (cold start with no recent reps at this scope).
    const gripFit = selGrip ? gripEstimates[selGrip] : null;
    const fitForRec = gripFit ?? liveEstimate ?? cfEstimate;
    if (!fitForRec) {
      const fallbackKey = limiterKey ?? coverageKey;
      if (!fallbackKey) return null;
      const d = ZONE_DETAILS[fallbackKey];
      return {
        key: fallbackKey,
        title: d.title, color: d.color,
        insight: `Need 2+ failures across different durations to rank protocols by projected AUC gain. For now: ${d.caption}`,
        gains: null, aucGain: null, zoneGaps: null,
        limiterKey, limiterGrip, coverageKey,
        agree: true, responseSource: null,
        coverageZoneLabel: coverageKey ? ZONE_DETAILS[coverageKey].title.replace("Train ", "") : null,
      };
    }
    const base = buildRecFromFit(fitForRec, personalResponse, unit);
    const agree = !limiterKey || limiterKey === base.key;
    return {
      ...base, zoneGaps: null,
      limiterKey, limiterGrip, coverageKey, agree,
      coverageZoneLabel: coverageKey ? ZONE_DETAILS[coverageKey].title.replace("Train ", "") : null,
    };
  }, [liveEstimate, gripEstimates, selGrip, history, activities, unit, personalResponse, freshMap, threeExpPriors, readiness]); // eslint-disable-line react-hooks/exhaustive-deps

  // Per-grip recommendations — one rec per grip with enough data for
  // a coaching call. Uses the v2 coaching engine: gap × intensity ×
  // recency × external_load. The card shows the recommended zone, the
  // coaching rationale, and per-zone gap bars (so the user sees the
  // full landscape of opportunities, not just the winner).
  const gripRecs = useMemo(() => {
    const zones = ["power", "strength", "endurance"];
    const out = {};
    for (const [grip, fit] of Object.entries(gripEstimates)) {
      const coach = coachingRecommendation(history, grip, {
        freshMap, threeExpPriors, readiness, activities,
      });
      if (!coach) continue;
      // Compute per-zone gaps so the bars can show the whole landscape.
      const zoneGaps = {};
      for (const zoneKey of zones) {
        const t = GOAL_CONFIG[zoneKey].refTime;
        let bestGap = null;
        for (const h of ["L", "R"]) {
          const trainAt = empiricalPrescription(history, h, grip, t, { threeExpPriors })
                       ?? prescribedLoad(history, h, grip, t, freshMap, { threeExpPriors });
          const pot = prescriptionPotential(history, h, grip, t, { freshMap, threeExpPriors });
          if (trainAt == null || !pot || pot.reliability === "extrapolation") continue;
          const gap = (pot.value - trainAt) / trainAt;
          if (bestGap == null || gap > bestGap) bestGap = gap;
        }
        zoneGaps[zoneKey] = bestGap;
      }
      const d = ZONE_DETAILS[coach.zone];
      out[grip] = {
        grip,
        key:       coach.zone,
        title:     d.title,
        color:     d.color,
        rationale: coachingRationale(coach),
        coach,
        zoneGaps,
        CF: fit.CF, W: fit.W, n: fit.n,
      };
    }
    return out;
  }, [gripEstimates, history, freshMap, threeExpPriors, readiness, activities]);

  const unexplored = Object.entries(zones)
    .filter(([, z]) => z.total === 0)
    .map(([, z]) => z.label);

  // Custom tooltip for scatter chart
  const ScatterTooltip = ({ active, payload, unit: tipUnit }) => {
    if (!active || !payload?.[0]) return null;
    const d = payload[0].payload;
    const u = tipUnit || unit;
    return (
      <div style={{ background: C.card, border: `1px solid ${C.border}`, padding: "8px 12px", borderRadius: 8, fontSize: 12 }}>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>{d.date}{d.grip ? ` · ${d.grip}` : ""}</div>
        <div>Duration: <b>{fmt1(d.x)}s</b></div>
        <div>Force: <b>{fmt1(d.y)} {u}</b></div>
      </div>
    );
  };

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 22 }}>Force-Duration Analysis</h2>
      <p style={{ margin: "0 0 16px", fontSize: 13, color: C.muted, lineHeight: 1.5 }}>
        Where failures fall on the fatigue curve reveals which energy system is your limiter — and what to train next.
      </p>

      {/* Filters */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: grips.length ? 10 : 0 }}>
          {/* Both = pool L+R for the F-D chart's at-a-glance view (one
              curve fit on the combined data). Per-hand prescriptions and
              the coaching engine still iterate L and R separately, so
              "Both" only affects the visual aggregation here. */}
          <button onClick={() => setSelHand("")} style={{
            padding: "6px 18px", borderRadius: 20, cursor: "pointer",
            fontWeight: 600, border: "none",
            background: !selHand ? C.purple : C.border,
            color: !selHand ? "#fff" : C.muted,
          }}>Both</button>
          {["L", "R"].map(h => (
            <button key={h} onClick={() => setSelHand(h)} style={{
              padding: "6px 18px", borderRadius: 20, cursor: "pointer",
              fontWeight: 600, border: "none",
              background: selHand === h ? C.purple : C.border,
              color: selHand === h ? "#fff" : C.muted,
            }}>{h === "L" ? "Left" : "Right"}</button>
          ))}
        </div>
        {grips.length > 0 && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={() => setSelGrip("")} style={{
              padding: "4px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer", border: "none",
              background: !selGrip ? C.orange : C.border, color: !selGrip ? "#fff" : C.muted,
            }}>All Grips</button>
            {grips.map(g => (
              <button key={g} onClick={() => setSelGrip(g)} style={{
                padding: "4px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer", border: "none",
                background: selGrip === g ? C.orange : C.border, color: selGrip === g ? "#fff" : C.muted,
              }}>{g}</button>
            ))}
          </div>
        )}
      </Card>

      {/* F-D chart hoisted to the top of AnalysisView — most important
          visual on this view. Empty-state placeholder still appears
          below in the {reps.length === 0 ? ...} block. */}
      {reps.length > 0 && (<>
        {/* ── Force-Duration scatter ── */}
        <Card style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4, flexWrap: "wrap", gap: 6 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Force vs. Duration</div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {/* Grip selection lives on the filter card above (All Grips /
                  Micro / Crusher) — no duplicate toggle here. Only the
                  display-mode (Absolute / × Bodyweight) toggle stays in
                  the chart header since it's chart-specific. */}
              {bodyWeight != null && ["Absolute", "Relative"].map(mode => (
                <button key={mode} onClick={() => setRelMode(mode === "Relative")} style={{
                  padding: "3px 10px", borderRadius: 12, fontSize: 11, cursor: "pointer", border: "none", fontWeight: 600,
                  background: (mode === "Relative") === relMode ? C.purple : C.border,
                  color: (mode === "Relative") === relMode ? "#fff" : C.muted,
                }}>{mode}</button>
              ))}
            </div>
          </div>
          {(() => {
            const splitMode = !!fdSplitData;
            const FD_GRIP_COLORS = { Micro: "#e05560", Crusher: C.orange };
            return (
              <div style={{ display: "flex", gap: 16, fontSize: 11, color: C.muted, marginBottom: 10, flexWrap: "wrap" }}>
                <span><span style={{ color: C.green }}>●</span> Completed</span>
                <span><span style={{ color: C.red }}>●</span> Auto-failed</span>
                {!splitMode && threeExpCurveDataRel.length > 0 && <span title="Three-exp model: governing F-D curve. Sum of three exponentials with depletion-tau basis (PCr/glycolytic/oxidative)."><span style={{ color: C.purple }}>―</span> F-D curve (3-exp)</span>}
                {!splitMode && threeExpRef180 != null && <span title="Three-exp prediction at T=180s — the slow/oxidative compartment dominates here. The closest analog to a 'sustainable force' reference."><span style={{ color: C.purple }}>╌</span> 3-min sustainable</span>}
                {!splitMode && cfEstimate && <span title="Monod-Scherrer (CF + W'/T) curve, kept as a second-opinion overlay. Three-exp drives prescriptions; Monod is for diagnostic comparison."><span style={{ color: C.muted, opacity: 0.7 }}>╌</span> Monod (2nd opinion)</span>}
                {!splitMode && confidenceBandRel && <span title="Bootstrap 90% band around the three-exp curve."><span style={{ color: C.purple, opacity: 0.4 }}>▓</span> 90% band</span>}
                {splitMode && Object.keys(fdSplitData).map(g => (
                  <span key={g}>
                    <span style={{ color: FD_GRIP_COLORS[g] || C.blue }}>―</span> {g}
                    <span style={{ color: FD_GRIP_COLORS[g] || C.blue, opacity: 0.7 }}> ╌</span> 3-min
                  </span>
                ))}
                {splitMode && <span title="Monod-Scherrer overlay per grip — kept as a thin desaturated 'second opinion' line. Three-exp drives prescriptions."><span style={{ color: C.muted, opacity: 0.6 }}>╌</span> Monod (2nd opinion, per grip)</span>}
                {!splitMode && limiterZoneBounds && <span style={{ color: limiterZoneBounds.color, fontWeight: 600 }}>● {limiterZoneBounds.label}</span>}
                {useRel && <span style={{ color: C.purple }}>× bodyweight ({fmtW(bodyWeight, unit)} {unit})</span>}
              </div>
            );
          })()}
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart margin={{ top: 10, right: 16, bottom: 28, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
              <XAxis
                type="number" dataKey="x"
                domain={[0, maxDur + 10]}
                label={{ value: "Duration (s)", position: "insideBottom", offset: -16, fill: C.muted, fontSize: 11 }}
                tick={{ fill: C.muted, fontSize: 11 }}
              />
              <YAxis
                type="number"
                domain={[0, Math.ceil(maxForceRel * 1.15 / (useRel ? 0.1 : 10)) * (useRel ? 0.1 : 10)]}
                tick={{ fill: C.muted, fontSize: 11 }}
                unit={useRel ? "" : ` ${unit}`}
                width={42}
              />
              <Tooltip content={<ScatterTooltip unit={forceUnit} />} />
              {/* Zone backgrounds — neutral tint for non-limiter zones,
                  extra saturation on the limiter zone so the chart
                  echoes the SessionPlanner recommendation. */}
              <ReferenceArea x1={0}            x2={POWER_MAX}    fill={C.red}    fillOpacity={limiterZoneBounds?.x1 === 0            ? 0.22 : 0.07} />
              <ReferenceArea x1={POWER_MAX}    x2={STRENGTH_MAX} fill={C.orange} fillOpacity={limiterZoneBounds?.x1 === POWER_MAX    ? 0.22 : 0.07} />
              <ReferenceArea x1={STRENGTH_MAX} x2={maxDur + 10}  fill={C.blue}   fillOpacity={limiterZoneBounds?.x1 === STRENGTH_MAX ? 0.22 : 0.07} />
              {/* Single-fit overlays only when NOT in per-grip split mode.
                  In split mode they'd be ambiguous (which grip's CF? which
                  3-exp? which 90% band?). Per-grip rendering takes over. */}
              {!fdSplitData && confidenceBandRel && (
                <Line data={confidenceBandRel} dataKey="low"  stroke={C.purple} strokeOpacity={0.35}
                      strokeDasharray="3 3" strokeWidth={1} dot={false} legendType="none" isAnimationActive={false} />
              )}
              {!fdSplitData && confidenceBandRel && (
                <Line data={confidenceBandRel} dataKey="high" stroke={C.purple} strokeOpacity={0.35}
                      strokeDasharray="3 3" strokeWidth={1} dot={false} legendType="none" isAnimationActive={false} />
              )}
              {/* 3-min sustainable reference from three-exp at T=180s
                  (replaces the Monod CF asymptote, since three-exp has
                  no true asymptote — it decays to 0). At 180s the slow
                  oxidative compartment dominates; this is the closest
                  physiological analog to "what you can sustain". */}
              {!fdSplitData && threeExpRef180 != null && (
                <ReferenceLine
                  y={useRel ? threeExpRef180 / bodyWeight : toDisp(threeExpRef180, unit)}
                  stroke={C.purple} strokeDasharray="6 3" strokeWidth={1.5}
                  label={{ value: `3-min ${fmtForce(threeExpRef180)} ${forceUnit}`, position: "insideTopRight", fill: C.purple, fontSize: 10 }}
                />
              )}
              {/* Monod overlay — kept as a thin desaturated dashed line
                  for diagnostic comparison ("second opinion"). Not used
                  in any prescription path; just visible context for
                  where the hyperbolic fit would land vs three-exp. */}
              {!fdSplitData && curveDataRel.length > 0 && (
                <Line data={curveDataRel} dataKey="y" stroke={C.muted}
                      strokeWidth={1} strokeDasharray="4 3" strokeOpacity={0.7}
                      dot={false} legendType="none" isAnimationActive={false} />
              )}
              {/* Primary curve — three-exp F-D. Bold purple solid; this
                  is the curve the rest of the engine optimizes against. */}
              {!fdSplitData && threeExpCurveDataRel.length > 0 && (
                <Line data={threeExpCurveDataRel} dataKey="y" stroke={C.purple}
                      strokeWidth={2} dot={false}
                      legendType="none" isAnimationActive={false} />
              )}
              {!fdSplitData && (
                <Scatter data={successDotsRel} dataKey="y" fill={C.green} opacity={0.85} name="Completed" />
              )}
              {!fdSplitData && (
                <Scatter data={failureDotsRel} dataKey="y" fill={C.red} opacity={0.95} name="Auto-failed" />
              )}
              {/* Per-grip split mode: one curve + one set of dots per grip.
                  Avoids the cross-muscle mudding (Micro FDP pinch ~5-10kg vs
                  Crusher FDS crush ~15-30kg on a single curve). Failure dots
                  retain their red/green meaning, but get a colored OUTLINE
                  matching the grip so you can tell which is which. */}
              {fdSplitData && (() => {
                const FD_GRIP_COLORS = { Micro: "#e05560", Crusher: C.orange };
                const grips = Object.keys(fdSplitData);
                const elements = [];
                const tMax = Math.max(maxDur, F_D_T_MIN + 10);
                for (const grip of grips) {
                  const color = FD_GRIP_COLORS[grip] || C.blue;
                  const data = fdSplitData[grip];
                  // Monod overlay — thin desaturated dashed line for
                  // diagnostic comparison ("second opinion"). Drawn first
                  // so the three-exp primary sits on top.
                  const monodRel = data.curve.map(d => ({
                    x: d.x,
                    y: useRel && bodyWeight > 0 ? d.y / (bodyWeight * (unit === "lbs" ? KG_TO_LBS : 1)) : d.y,
                  }));
                  elements.push(
                    <Line key={`${grip}-monod`} data={monodRel} dataKey="y"
                      stroke={color} strokeWidth={1} strokeDasharray="4 3"
                      strokeOpacity={0.45} dot={false}
                      legendType="none" isAnimationActive={false} />
                  );
                  // Three-exp PRIMARY curve — bold solid grip color. This
                  // is the curve the engine optimizes against; Monod
                  // (above) is just for visual comparison. Also emits a
                  // per-grip "3-min sustainable" reference line so split
                  // mode shows the same overlays as single-grip mode.
                  if (threeExpPriors && threeExpPriors.get) {
                    const prior = threeExpPriors.get(grip);
                    const failures = (history || []).filter(r =>
                      r.failed && r.grip === grip
                      && r.actual_time_s > 0 && r.avg_force_kg > 0 && r.avg_force_kg < 500
                    );
                    if (prior && failures.length >= 2) {
                      const pts = failures.map(r => ({ T: r.actual_time_s, F: r.avg_force_kg }));
                      const lambda = THREE_EXP_LAMBDA_DEFAULT / Math.max(failures.length, 1);
                      const amps = fitThreeExpAmps(pts, { prior, lambda });
                      if (amps[0] + amps[1] + amps[2] > 0) {
                        const teeCurve = Array.from({ length: 80 }, (_, i) => {
                          const t = F_D_T_MIN + ((tMax - F_D_T_MIN) / 79) * i;
                          const f = predForceThreeExp(amps, t);
                          return {
                            x: t,
                            y: useRel && bodyWeight > 0
                              ? toDisp(Math.max(f, 0), unit) / (bodyWeight * (unit === "lbs" ? KG_TO_LBS : 1))
                              : toDisp(Math.max(f, 0), unit),
                          };
                        });
                        elements.push(
                          <Line key={`${grip}-tee`} data={teeCurve} dataKey="y"
                            stroke={color} strokeWidth={2} dot={false}
                            legendType="none" isAnimationActive={false} />
                        );
                        // 3-min sustainable reference for this grip — analog
                        // of the dashed horizontal line in single-grip mode.
                        const teeRef180 = predForceThreeExp(amps, 180);
                        if (teeRef180 > 0) {
                          const refY = useRel && bodyWeight > 0
                            ? teeRef180 / bodyWeight
                            : toDisp(teeRef180, unit);
                          elements.push(
                            <ReferenceLine key={`${grip}-ref180`} y={refY}
                              stroke={color} strokeDasharray="6 3" strokeWidth={1}
                              strokeOpacity={0.7}
                              label={{ value: `${grip} 3-min ${fmtForce(teeRef180)} ${forceUnit}`,
                                position: "insideRight", fill: color, fontSize: 9 }}
                            />
                          );
                        }
                      }
                    }
                  }
                  // Dots: red fill for failures, green for completes — same
                  // semantic as single-fit mode. The grip identity is read
                  // from position relative to its own colored curve.
                  const failRel = data.failures.map(d => ({
                    x: d.x,
                    y: useRel && bodyWeight > 0 ? d.y / (bodyWeight * (unit === "lbs" ? KG_TO_LBS : 1)) : d.y,
                    grip, date: d.date,
                  }));
                  const succRel = data.successes.map(d => ({
                    x: d.x,
                    y: useRel && bodyWeight > 0 ? d.y / (bodyWeight * (unit === "lbs" ? KG_TO_LBS : 1)) : d.y,
                    grip, date: d.date,
                  }));
                  elements.push(
                    <Scatter key={`${grip}-fail`} data={failRel} dataKey="y"
                      fill={C.red} stroke={color} strokeWidth={1.5} opacity={0.95} />
                  );
                  elements.push(
                    <Scatter key={`${grip}-succ`} data={succRel} dataKey="y"
                      fill={C.green} stroke={color} strokeWidth={1.5} opacity={0.85} />
                  );
                }
                return elements;
              })()}
            </ComposedChart>
          </ResponsiveContainer>
          {/* Zone labels */}
          <div style={{ display: "flex", justifyContent: "space-around", marginTop: 4, fontSize: 10, color: C.muted }}>
            <span style={{ color: C.red }}>⚡ Power &lt;20s</span>
            <span style={{ color: C.orange }}>💪 Strength 20–120s</span>
            <span style={{ color: C.blue }}>🔄 Capacity 120s+</span>
          </div>
          {/* Model-fit diagnostic — training RMSE comparison of three-exp
              (the primary curve) against Monod (the second-opinion overlay).
              Training RMSE is biased optimistic for both, but the relative
              comparison on the SAME data is meaningful. Holdout LOO-CV
              validation lives in scripts/validate_taur_vs_taud.js. */}
          {modelRMSE && (
            <div style={{ marginTop: 8, padding: "6px 8px", background: C.bg, borderRadius: 6, fontSize: 10, color: C.muted, lineHeight: 1.5 }}>
              <span style={{ color: C.purple, fontWeight: 600 }}>Fit diagnostic</span>
              {" · 3-exp RMSE "}
              <span style={{ color: modelRMSE.threeExp < modelRMSE.monod ? C.green : C.text, fontWeight: 600 }}>
                {modelRMSE.threeExp.toFixed(2)} kg
              </span>
              {" · Monod RMSE "}
              <span style={{ color: C.text }}>{modelRMSE.monod.toFixed(2)} kg</span>
              {" · N="}{modelRMSE.n}
              {" · "}
              <span style={{ fontStyle: "italic" }}>
                training fit, not holdout
              </span>
            </div>
          )}
        </Card>
      </>)}

      {/* ── 1RM PR tracker ── */}
      {(() => {
        const rmReps = activities.filter(a => a.type === "oneRM" && a.weight_kg > 0);
        if (rmReps.length === 0) return null;

        // Build per-grip datasets
        const GRIP_COLORS = { Micro: "#e05560", Crusher: C.orange };
        const allDates = [...new Set(rmReps.map(a => a.date))].sort();
        const gripData = {};
        for (const g of RM_GRIPS) {
          const byDate = {};
          for (const a of rmReps.filter(r => r.grip === g || (!r.grip && g === "Micro"))) {
            if (!byDate[a.date] || a.weight_kg > byDate[a.date]) byDate[a.date] = a.weight_kg;
          }
          if (Object.keys(byDate).length > 0) {
            gripData[g] = {
              pr: Math.max(...Object.values(byDate)),
              latest: byDate[allDates.filter(d => byDate[d]).at(-1)] ?? 0,
              byDate,
            };
          }
        }
        if (Object.keys(gripData).length === 0) return null;

        // Merge into chart data — one row per date, one column per grip
        const chartData = allDates.map(date => {
          const row = { date };
          for (const g of RM_GRIPS) {
            if (gripData[g]?.byDate[date]) row[g] = toDisp(gripData[g].byDate[date], unit);
          }
          return row;
        });
        const hasChart = chartData.length >= 2;

        return (
          <Card style={{ marginBottom: 16, border: `1px solid ${"#e05560"}30` }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>🏋️ 1RM Progress</div>

            {/* PR summary per grip */}
            <div style={{ display: "flex", gap: 16, marginBottom: 12 }}>
              {RM_GRIPS.filter(g => gripData[g]).map(g => {
                const { pr, latest } = gripData[g];
                const isPR = latest >= pr;
                return (
                  <div key={g}>
                    <div style={{ fontSize: 11, color: C.muted }}>{g} PR</div>
                    <div style={{ fontSize: 20, fontWeight: 800, color: GRIP_COLORS[g], lineHeight: 1.1 }}>
                      {fmtW(pr, unit)} {unit}
                    </div>
                    {isPR && chartData.length > 1 && (
                      <div style={{ fontSize: 11, color: GRIP_COLORS[g], fontWeight: 600 }}>🎉 PR today!</div>
                    )}
                  </div>
                );
              })}
            </div>

            {hasChart && (
              <ResponsiveContainer width="100%" height={110}>
                <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                  <XAxis dataKey="date" tick={{ fill: C.muted, fontSize: 9 }}
                    tickFormatter={d => d.slice(5)} interval="preserveStartEnd" />
                  <YAxis hide domain={["auto", "auto"]} />
                  <Tooltip
                    contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }}
                    formatter={(v, name) => [`${fmt1(v)} ${unit}`, name]}
                    labelFormatter={d => d}
                  />
                  {RM_GRIPS.filter(g => gripData[g]).map(g => (
                    <Line key={g} type="monotone" dataKey={g}
                      stroke={GRIP_COLORS[g]} strokeWidth={2.5}
                      dot={{ r: 3, fill: GRIP_COLORS[g] }} connectNulls />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            )}
            <div style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>
              Max single effort · logged pre-climb
            </div>
          </Card>
        );
      })()}

      {/* ── Capacity Improvement summary ──
          When no grip filter is active AND ≥2 grips have fits, split
          the card into per-grip sections so Micro (FDP) and Crusher
          (FDS) each show their own Δ% against the shared baseline. */}
      {baseline && (improvement || Object.keys(gripImprovement).length > 0) && (() => {
        // Reusable row renderer — one header + one Power/Strength/Capacity
        // row of three Δ% tiles.
        const renderRow = (label, imp) => (
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
              {label && (
                <div style={{ fontSize: 12, fontWeight: 700, color: C.text }}>
                  {label}
                </div>
              )}
              <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginLeft: "auto" }}>
                <div style={{ fontSize: 26, fontWeight: 900, color: imp.total >= 0 ? C.green : C.red, lineHeight: 1 }}>
                  {imp.total >= 0 ? "+" : ""}{imp.total}%
                </div>
                <div style={{ fontSize: 11, color: C.muted }}>total</div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {[
                { label: "⚡ Power",     val: imp.power,     color: C.red    },
                { label: "💪 Strength",  val: imp.strength,  color: C.orange },
                { label: "🏔️ Capacity",  val: imp.endurance, color: C.blue   },
              ].map(({ label, val, color }) => (
                <div key={label} style={{
                  flex: 1, background: C.bg, borderRadius: 10, padding: "8px 6px", textAlign: "center",
                  border: `1px solid ${color}30`,
                }}>
                  <div style={{ fontSize: 10, color: C.muted, marginBottom: 3 }}>{label}</div>
                  <div style={{ fontSize: 17, fontWeight: 800, color: val >= 0 ? color : C.red }}>
                    {val >= 0 ? "+" : ""}{val}%
                  </div>
                </div>
              ))}
            </div>
          </div>
        );

        // perGripMode is keyed off having multiple per-grip CURRENT fits,
        // not improvements — so users mid-data-collection see an honest
        // "early days" message instead of falling back to the pooled
        // improvement number, which would re-introduce the same cross-
        // muscle artifact (Crusher's high-CF reps inflating Micro's
        // baseline) that motivated the per-grip split in the first
        // place.
        const perGripMode = !selGrip && Object.keys(gripEstimates).length >= 2;
        const gripImpEntries = Object.entries(gripImprovement);

        // When a grip filter is active, cfEstimate is scoped to that
        // grip AND to selHand (via the `failures` filter). Comparing
        // it against a baseline of a different scope produces an
        // apples-to-oranges comparison. We have three baselines to
        // pick from, listed by tightness:
        //   1. perHandGripBaselines[grip|hand]  — exact scope match
        //   2. gripBaselines[grip]               — pools hands, per-grip
        //   3. (fall through to early-days)
        //
        // To keep the comparison apples-to-apples, the LHS (current
        // fit) is recomputed at the SAME scope as whichever baseline
        // we end up using, instead of always using the hand-scoped
        // cfEstimate. Without this, a (Micro, Left) current vs
        // (Micro pooled-hands) baseline still mixes hand asymmetry
        // into the Δ% — same flavor as the cross-muscle artifact,
        // just smaller.
        let scopedImp = null;
        let scopedBaselineDate = null;
        let scopedScopeLabel = null;
        if (selGrip) {
          const phgKey = selHand && selHand !== "Both" ? `${selGrip}|${selHand}` : null;
          const phgRef = phgKey ? perHandGripBaselines[phgKey] : null;
          const gRef   = gripBaselines[selGrip];
          if (phgRef) {
            // Tightest match: use cfEstimate (already hand+grip scoped) vs
            // per-hand-grip baseline.
            scopedImp = improvementForFit(cfEstimate, phgRef);
            scopedBaselineDate = phgRef.date;
            scopedScopeLabel = `${selGrip} · ${selHand === "L" ? "Left" : "Right"}`;
          } else if (gRef && gripEstimates[selGrip]) {
            // Fallback: per-hand-grip baseline doesn't exist yet, but the
            // grip-pooled baseline does. Use the grip-pooled CURRENT fit
            // (gripEstimates[selGrip], which pools both hands) so both
            // sides of the comparison live in the same scope.
            scopedImp = improvementForFit(gripEstimates[selGrip], gRef);
            scopedBaselineDate = gRef.date;
            scopedScopeLabel = `${selGrip} (both hands)`;
          }
        }

        return (
          <Card style={{ marginBottom: 16, border: `1px solid ${C.purple}40` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>Capacity Improvement</div>
              {!perGripMode && !selGrip && (
                <div style={{ fontSize: 11, color: C.muted }}>since {baseline.date}</div>
              )}
              {selGrip && scopedImp && (
                <div style={{ fontSize: 11, color: C.muted }}>since {scopedBaselineDate}</div>
              )}
            </div>
            {perGripMode ? (
              gripImpEntries.length > 0 ? (
                <>
                  {gripImpEntries.map(([grip, imp], i, arr) => (
                    <div key={grip} style={{
                      paddingBottom: i < arr.length - 1 ? 12 : 0,
                      borderBottom: i < arr.length - 1 ? `1px solid ${C.border}` : "none",
                      marginBottom: i < arr.length - 1 ? 12 : 0,
                    }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: C.text }}>{grip}</div>
                        <div style={{ fontSize: 10, color: C.muted }}>since {imp.baselineDate}</div>
                      </div>
                      {renderRow(null, imp)}
                    </div>
                  ))}
                  {/* Show an "early days" placeholder for any grip with a
                      current fit but no qualifying per-grip baseline yet,
                      so the user knows we're aware of it and waiting on
                      more data rather than silently dropping it. */}
                  {Object.keys(gripEstimates).filter(g => !gripImprovement[g]).map(grip => {
                    const p = baselineProgress(grip);
                    return (
                      <div key={grip} style={{
                        paddingTop: 12, marginTop: 12, borderTop: `1px solid ${C.border}`,
                        fontSize: 11, color: C.muted, lineHeight: 1.5,
                      }}>
                        <b style={{ color: C.text }}>{grip}</b>{" · "}
                        <span style={{ color: p.failures >= FAIL_THRESHOLD ? C.green : C.text }}>
                          {Math.min(p.failures, FAIL_THRESHOLD)} of {FAIL_THRESHOLD} failures
                        </span>
                        {" · "}
                        <span style={{ color: p.distinctDurations >= DUR_THRESHOLD ? C.green : C.text }}>
                          {Math.min(p.distinctDurations, DUR_THRESHOLD)} of {DUR_THRESHOLD} durations
                        </span>
                      </div>
                    );
                  })}
                </>
              ) : (
                <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
                  Need ≥5 failures across ≥3 target durations <i>per grip</i> to seed a stable per-grip baseline. Until then the comparison is too noisy to be useful (small-sample Monod fits have high W′ variance, which inflates predicted force at short durations).
                </div>
              )
            ) : selGrip ? (
              scopedImp ? (
                <>
                  <div style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>
                    {scopedScopeLabel} vs {scopedScopeLabel} baseline
                  </div>
                  {renderRow(null, scopedImp)}
                </>
              ) : (() => {
                const handForProg = selHand && selHand !== "Both" ? selHand : null;
                const p = baselineProgress(selGrip, handForProg);
                const handLabel = handForProg ? (handForProg === "L" ? "Left" : "Right") : null;
                return (
                  <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
                    Need ≥{FAIL_THRESHOLD} failures across ≥{DUR_THRESHOLD} target durations on <b>{selGrip}</b>{handLabel ? ` (${handLabel})` : ""} for a fair apples-to-apples comparison. Pooled global baseline isn't shown here — it mixes muscle groups (FDP pinch vs FDS crush) and would produce misleading Δ%.
                    <div style={{ marginTop: 6, fontSize: 11 }}>
                      Progress:{" "}
                      <span style={{ color: p.failures >= FAIL_THRESHOLD ? C.green : C.text, fontWeight: 600 }}>
                        {Math.min(p.failures, FAIL_THRESHOLD)} of {FAIL_THRESHOLD} failures
                      </span>
                      {" · "}
                      <span style={{ color: p.distinctDurations >= DUR_THRESHOLD ? C.green : C.text, fontWeight: 600 }}>
                        {Math.min(p.distinctDurations, DUR_THRESHOLD)} of {DUR_THRESHOLD} durations
                      </span>
                    </div>
                  </div>
                );
              })()
            ) : improvement ? (
              renderRow(null, improvement)
            ) : null}
          </Card>
        );
      })()}

      {/* ── Curve parameters over time ── */}
      {cumulativeData.length >= 2 && (() => {
        // When no grip filter is active and ≥2 grips have data, split
        // into per-grip lines. The pooled CF can otherwise drift down
        // on Micro-heavy sessions (FDP CF ~6 kg dragging the average
        // away from FDS CF ~25 kg) and read as a regression even when
        // both grips are individually improving — same cross-muscle
        // artifact the Capacity Improvement card was fixed for.
        const splitMode = cumulativeDataByGrip && cumulativeDataByGrip.rows.length >= 2;
        const GRIP_COLORS = { Micro: "#e05560", Crusher: C.orange };
        return (
          <Card style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>CF Over Time</div>
            <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>
              {splitMode
                ? <>Critical force per grip — recomputed after every failure. Split avoids mixing FDP (Micro) and FDS (Crusher) CF on the same line.</>
                : <>Your critical force — the sustainable aerobic asymptote of the force-duration fit — recomputed after every failure.</>}
            </div>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={splitMode ? cumulativeDataByGrip.rows : cumulativeData} margin={{ top: 6, right: 14, bottom: 28, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis dataKey="date" tick={{ fill: C.muted, fontSize: 9 }} angle={-30} textAnchor="end" interval="preserveStartEnd"
                  label={{ value: "Date", position: "insideBottom", offset: -18, fill: C.muted, fontSize: 11 }} />
                <YAxis tick={{ fill: C.blue, fontSize: 11 }} width={46}
                  label={{ value: `CF (${unit})`, angle: -90, position: "insideLeft", fill: C.blue, fontSize: 11 }} />
                <Tooltip
                  contentStyle={{ background: C.card, border: `1px solid ${C.border}`, fontSize: 12 }}
                  formatter={(val, name) => [fmt1(val), name]}
                />
                {splitMode
                  ? cumulativeDataByGrip.grips.map(g => (
                      <Line key={g} dataKey={`${g}_cf`} stroke={GRIP_COLORS[g] || C.blue}
                        strokeWidth={2} dot={false} name={`${g} CF (${unit})`} connectNulls />
                    ))
                  : <Line dataKey="cf" stroke={C.blue} strokeWidth={2} dot={false} name={`CF (${unit})`} />}
                {/* Three-exp predicted-at-120s overlay — single-grip only.
                    Shows what three-exp says about your long-duration
                    capacity at each historical date. When this line
                    diverges meaningfully from Monod CF, three-exp's
                    extra flexibility is doing real work. */}
                {!splitMode && selGrip && cumulativeData.some(d => d.teePot120 != null) && (
                  <Line dataKey="teePot120" stroke={C.yellow} strokeWidth={1.5}
                        strokeDasharray="5 4" dot={false}
                        name={`3e at 120s (${unit})`} connectNulls />
                )}
              </LineChart>
            </ResponsiveContainer>
            {!splitMode && selGrip && cumulativeData.some(d => d.teePot120 != null) && (
              <div style={{ fontSize: 10, color: C.muted, marginTop: 4, textAlign: "center" }}>
                <span style={{ color: C.blue }}>━ Monod CF</span> · <span style={{ color: C.yellow }}>╌ 3-exp at 120s</span> · divergence indicates Monod's hyperbolic shape is missing the steeper drop-off three-exp captures
              </div>
            )}
          </Card>
        );
      })()}

      {/* ── Gap to Potential, over time ──
          The "am I closing the gap toward my modeled potential" tracker.
          Per-zone line shows how the gap (potential − empirical, as %) has
          evolved over training history. Narrowing trends = adaptation
          delivering. Widening = the model thinks you have more headroom
          than your training is unlocking; widen the focus on that zone.

          Only renders when a grip filter is set (cross-grip gap doesn't
          mean anything physiologically). */}
      {gapHistory && gapHistory.length >= 2 && (
        <Card style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Gap to Potential — {selGrip}{selHand ? ` · ${selHand === "L" ? "Left" : "Right"}` : ""}</div>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>
            % headroom between what you're training at and what the curve says you could hit. Narrowing lines mean adaptation is delivering. Widening lines mean the model sees more potential than you're unlocking — focus there.
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={gapHistory} margin={{ top: 6, right: 14, bottom: 28, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
              <XAxis dataKey="date" tick={{ fill: C.muted, fontSize: 9 }} angle={-30} textAnchor="end" interval="preserveStartEnd"
                label={{ value: "Date", position: "insideBottom", offset: -18, fill: C.muted, fontSize: 11 }} />
              <YAxis tick={{ fill: C.muted, fontSize: 11 }} width={42} unit="%"
                label={{ value: "Gap %", angle: -90, position: "insideLeft", fill: C.muted, fontSize: 11 }} />
              <Tooltip
                contentStyle={{ background: C.card, border: `1px solid ${C.border}`, fontSize: 12 }}
                formatter={(val, name) => [val == null ? "—" : `${val >= 0 ? "+" : ""}${val}%`, name]}
              />
              <Line dataKey="power_gap"     stroke={GOAL_CONFIG.power.color}     strokeWidth={2} dot={{ r: 3 }} connectNulls name="⚡ Power" />
              <Line dataKey="strength_gap"  stroke={GOAL_CONFIG.strength.color}  strokeWidth={2} dot={{ r: 3 }} connectNulls name="💪 Strength" />
              <Line dataKey="endurance_gap" stroke={GOAL_CONFIG.endurance.color} strokeWidth={2} dot={{ r: 3 }} connectNulls name="🏔️ Capacity" />
            </LineChart>
          </ResponsiveContainer>
          <div style={{ display: "flex", justifyContent: "space-around", marginTop: 4, fontSize: 10, color: C.muted }}>
            <span style={{ color: GOAL_CONFIG.power.color }}>⚡ Power</span>
            <span style={{ color: GOAL_CONFIG.strength.color }}>💪 Strength</span>
            <span style={{ color: GOAL_CONFIG.endurance.color }}>🏔️ Capacity</span>
          </div>
        </Card>
      )}

      {/* Per-Hand Critical Force card removed — duplicated info from
          the Critical Force Estimate cards below. */}

      {reps.length === 0 ? (
        <Card>
          <div style={{ textAlign: "center", padding: "32px 0", color: C.muted }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📊</div>
            <div>No session data yet for this selection.</div>
            <div style={{ fontSize: 12, marginTop: 8 }}>Complete some sessions to see your force-duration curve.</div>
          </div>
        </Card>
      ) : (<>


        {/* ── Critical Force card ──
            When no grip filter is active AND ≥2 grips have fits, render
            one card per grip (Micro, Crusher) so each muscle's CF / W′
            and curve shape are read independently. Otherwise fall back
            to the pooled / selGrip-scoped single card. */}
        {(() => {
          // Shared renderer for the CF/W′/curve-shape body of the card.
          const renderCFBody = (fit) => {
            const ratio = fit.CF > 0 ? fit.W / fit.CF : 0;
            const pct   = Math.min(100, Math.max(0, (ratio / 120) * 100));
            const { shape, color: sc, caption } =
              ratio < 30  ? { shape: "CF-dominant (Flat)",    color: C.blue,   caption: "Your curve is flat — CF is high relative to W′. Your sustainable force is well developed; your finite anaerobic reserve is small." } :
              ratio < 80  ? { shape: "Balanced",              color: C.green,  caption: "CF and W′ are roughly proportional — neither the aerobic asymptote nor the anaerobic reserve dominates the curve." } :
                            { shape: "W′-dominant (Steep)",   color: C.orange, caption: "Your curve is steep — W′ is large relative to CF. Your short-burst capacity is well developed; your sustainable asymptote is lower." };
            return (
              <>
                <div style={{ display: "flex", gap: 0, marginBottom: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>Critical Force (CF)</div>
                    <div style={{ fontSize: 32, fontWeight: 800, color: C.purple, lineHeight: 1 }}>
                      {fmtW(fit.CF, unit)}
                    </div>
                    <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>{unit} · max sustainable</div>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>Anaerobic Capacity (W′)</div>
                    <div style={{ fontSize: 32, fontWeight: 800, color: C.orange, lineHeight: 1 }}>
                      {fmtW(fit.W, unit)}·s
                    </div>
                    <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>{unit}·s · finite reserve above CF</div>
                  </div>
                </div>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.muted, marginBottom: 5 }}>
                    <span>Curve Shape</span>
                    <span style={{ color: sc, fontWeight: 700 }}>{shape}</span>
                  </div>
                  <div style={{ position: "relative", height: 8, borderRadius: 4, overflow: "hidden",
                    background: "linear-gradient(to right, #3b82f6, #22c55e, #e07a30)" }}>
                    <div style={{
                      position: "absolute", top: "50%", left: `${pct}%`,
                      transform: "translate(-50%, -50%)",
                      width: 14, height: 14, borderRadius: 7,
                      background: "#fff", border: `2px solid ${sc}`,
                      boxShadow: "0 0 4px rgba(0,0,0,0.4)",
                    }} />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: C.muted, marginTop: 3 }}>
                    <span>Flat (CF dominant)</span><span>Steep (W′ dominant)</span>
                  </div>
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 6, lineHeight: 1.5 }}>
                    {caption} See <b>Next Session Focus</b> above for what to train next.
                  </div>
                </div>
                <div style={{ fontSize: 12, color: C.muted, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
                  Estimated from {fit.n} failure point{fit.n !== 1 ? "s" : ""}. Accuracy improves as failures span multiple time domains — try power hangs (5–10s) and capacity hangs (2+ min) to sharpen the curve.
                </div>
              </>
            );
          };

          const perGripMode = !selGrip && Object.keys(gripEstimates).length >= 2;
          if (perGripMode) {
            return (
              <>
                {Object.entries(gripEstimates).map(([grip, fit]) => (
                  <Card key={grip} style={{ marginBottom: 16 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
                      <div style={{ fontSize: 14, fontWeight: 700 }}>Critical Force Estimate</div>
                      <div style={{ fontSize: 11, color: C.muted, fontWeight: 600 }}>{grip}</div>
                    </div>
                    {renderCFBody(fit)}
                  </Card>
                ))}
              </>
            );
          }

          if (cfEstimate) {
            return (
              <Card style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>Critical Force Estimate</div>
                  {selGrip && (
                    <div style={{ fontSize: 11, color: C.muted, fontWeight: 600 }}>{selGrip}</div>
                  )}
                </div>
                {renderCFBody(cfEstimate)}
              </Card>
            );
          }

          return (
            <Card style={{ marginBottom: 16, border: `1px solid ${C.yellow}30` }}>
              <div style={{ fontSize: 13, color: C.yellow, marginBottom: 6 }}>
                {failures.length === 0 ? "⚠ Critical Force requires failure data" : "⚠ Need 2+ failures at different durations to fit the curve"}
              </div>
              <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
                {failures.length === 0
                  ? "The shape of your force-duration curve is defined by reps that end in auto-failure. Completed reps set the floor; failed reps define the curve."
                  : "You have failure data in one time domain. Add failures at a shorter or longer duration to fit the Monod-Scherrer curve and estimate Critical Force."}
              </div>
            </Card>
          );
        })()}

        {/* The Climbing Capacity chart card lived here. Removed because
            the Capacity Improvement card below already shows each grip's
            Total % (= AUC % gain) and CF & W' Over Time already shows
            the trajectory of the underlying fit parameters. */}

        {/* ── Per-compartment AUC (dose delivered per energy system, per session) ── */}
        {(() => {
          // Group selected reps by session_id; fall back to date
          const bySession = new Map();
          for (const r of reps) {
            const key = r.session_id || r.date;
            if (!bySession.has(key)) bySession.set(key, { key, date: r.date, reps: [] });
            bySession.get(key).reps.push(r);
          }
          const sessions = [...bySession.values()]
            .sort((a, b) => a.date.localeCompare(b.date))
            .slice(-10)
            .map(s => {
              const auc = sessionCompartmentAUC(s.reps);
              const dom = dominantZone5(s.reps);
              return {
                label: s.date.slice(5), // "MM-DD"
                Fast: Math.round(auc.fast),
                Medium: Math.round(auc.medium),
                Slow: Math.round(auc.slow),
                total: Math.round(auc.total),
                n: s.reps.length,
                reps: s.reps,
                dom,
              };
            });
          if (sessions.length === 0) return null;
          const last = sessions[sessions.length - 1];
          const pct = (v) => last.total > 0 ? Math.round((v / last.total) * 100) : 0;
          // Build the last-session zone distribution (count of reps per ZONE5 bucket)
          const lastZoneCounts = ZONE5.map(z => ({
            ...z,
            count: last.reps.filter(r => classifyZone5(r.actual_time_s)?.key === z.key).length,
          }));
          const lastTotalReps = lastZoneCounts.reduce((s, z) => s + z.count, 0);
          return (
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Per-Compartment Dose (AUC)</div>
              <div style={{ fontSize: 11, color: C.muted, marginBottom: 12, lineHeight: 1.5 }}>
                Training dose delivered to each energy system per session. Dose = load × A<sub>i</sub> × τ<sub>Di</sub> · (1 − e<sup>−t/τ<sub>Di</sub></sup>).
                Units: kg·s.
              </div>
              <div style={{ height: 180 }}>
                <ResponsiveContainer>
                  <BarChart data={sessions} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke={C.border} strokeDasharray="3 3" />
                    <XAxis dataKey="label" stroke={C.muted} tick={{ fontSize: 10 }} />
                    <YAxis stroke={C.muted} tick={{ fontSize: 10 }} />
                    <Tooltip
                      contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12 }}
                      labelStyle={{ color: C.muted }}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="Fast"   stackId="a" fill="#e05560" />
                    <Bar dataKey="Medium" stackId="a" fill="#e07a30" />
                    <Bar dataKey="Slow"   stackId="a" fill="#3b82f6" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              {/* Last-session breakdown */}
              <div style={{
                display: "grid", gridTemplateColumns: "1fr 1fr 1fr",
                gap: 8, marginTop: 12, paddingTop: 10, borderTop: `1px solid ${C.border}`,
              }}>
                <div>
                  <div style={{ fontSize: 10, color: C.muted, letterSpacing: 0.5 }}>FAST · PCR</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: "#e05560" }}>{last.Fast}</div>
                  <div style={{ fontSize: 10, color: C.muted }}>{pct(last.Fast)}% · τ 15s</div>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: C.muted, letterSpacing: 0.5 }}>MEDIUM · GLYCO</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: "#e07a30" }}>{last.Medium}</div>
                  <div style={{ fontSize: 10, color: C.muted }}>{pct(last.Medium)}% · τ 90s</div>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: C.muted, letterSpacing: 0.5 }}>SLOW · OXID</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: "#3b82f6" }}>{last.Slow}</div>
                  <div style={{ fontSize: 10, color: C.muted }}>{pct(last.Slow)}% · τ 600s</div>
                </div>
              </div>
              <div style={{ fontSize: 11, color: C.muted, marginTop: 8, fontStyle: "italic" }}>
                Last session: {last.n} rep{last.n !== 1 ? "s" : ""}, {last.total} kg·s total dose.
                {last.dom && <> · landed in <span style={{ color: last.dom.color, fontWeight: 700, fontStyle: "normal" }}>{last.dom.label}</span></>}
              </div>

              {/* ── Last-session zone distribution (5-zone classifier) ── */}
              {lastTotalReps > 0 && (
                <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${C.border}` }}>
                  <div style={{ fontSize: 10, color: C.muted, letterSpacing: 0.5, marginBottom: 6, textTransform: "uppercase" }}>
                    Landed Zones · last session
                  </div>
                  <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", marginBottom: 6 }}>
                    {lastZoneCounts.map(z => z.count > 0 && (
                      <div
                        key={z.key}
                        title={`${z.label}: ${z.count} rep${z.count !== 1 ? "s" : ""}`}
                        style={{
                          flex: z.count,
                          background: z.color,
                        }}
                      />
                    ))}
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, fontSize: 10, color: C.muted }}>
                    {lastZoneCounts.filter(z => z.count > 0).map(z => (
                      <span key={z.key} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 2, background: z.color, display: "inline-block" }} />
                        {z.short} · {z.count}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </Card>
          );
        })()}

        {/* ── Energy system breakdown ── */}
        <Card style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>Energy System Breakdown</div>
          {Object.entries(zones).map(([, z]) => (
            <div key={z.label} style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 5 }}>
                <span>
                  <span style={{ color: z.color, fontWeight: 700 }}>{z.label}</span>
                  <span style={{ color: C.muted }}> · {z.system} · {z.tau}</span>
                </span>
                <span style={{ color: C.muted }}>
                  {z.total === 0 ? "No data" : `${z.failures} fail / ${z.total} total`}
                </span>
              </div>
              <div style={{ height: 10, background: C.border, borderRadius: 5, overflow: "hidden" }}>
                {z.failRate !== null && (
                  <div style={{ height: "100%", width: `${z.failRate * 100}%`, background: z.color, borderRadius: 5, transition: "width 0.4s" }} />
                )}
              </div>
              {z.total === 0 && (
                <div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>
                  Add {z.desc} hangs to characterise this system.
                </div>
              )}
            </div>
          ))}
        </Card>

        {/* ── Unified training recommendation ──
            When no grip filter is active AND ≥2 grips have fits, render
            a separate card per grip so Micro (FDP) and Crusher (FDS)
            each get their own verdict — they are independent muscles
            with independent force-duration curves, so pooling hides
            the real story. Otherwise fall back to the single pooled /
            selGrip-scoped card with the limiter/coverage diagnostics. */}
        {(() => {
          // Helper — render per-zone gap bars. Replaces the old projected-ΔAUC
          // bars to match the gap-driven coaching engine: the recommended zone
          // is the one with the largest gap × intensity × recency × external,
          // and the bars show each zone's gap so the user sees the full
          // landscape of training opportunities, not just the winner.
          const renderGainsBars = (rec) => rec.zoneGaps && (
            <div style={{
              background: C.bg, borderRadius: 8, padding: "8px 10px",
              marginBottom: 10, fontSize: 11,
            }}>
              <div style={{ color: C.muted, letterSpacing: 0.4, textTransform: "uppercase", fontSize: 10, marginBottom: 6 }}>
                Gap to potential · per zone
              </div>
              {(() => {
                // Find max absolute gap for bar scaling
                const maxAbs = Math.max(0.05, ...Object.values(rec.zoneGaps).filter(v => v != null).map(v => Math.abs(v)));
                return [
                  { k: "power",     lbl: "Power",    col: C.red },
                  { k: "strength",  lbl: "Strength", col: C.orange },
                  { k: "endurance", lbl: "Capacity", col: C.blue },
                ].map(r => {
                  const v = rec.zoneGaps[r.k];
                  const pct = v == null ? 0 : Math.min(100, Math.max(0, (v / maxAbs) * 100));
                  const isBest = r.k === rec.key;
                  return (
                    <div key={r.k} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <span style={{ width: 62, color: r.col, fontWeight: isBest ? 700 : 400 }}>
                        {r.lbl}
                      </span>
                      <div style={{ flex: 1, height: 6, background: C.border, borderRadius: 3, overflow: "hidden" }}>
                        <div style={{ height: "100%", width: `${pct}%`, background: v == null ? C.muted : r.col, borderRadius: 3, transition: "width 0.3s", opacity: v == null ? 0.4 : 1 }} />
                      </div>
                      <span style={{ width: 56, textAlign: "right", color: isBest ? r.col : C.muted, fontWeight: isBest ? 700 : 400 }}>
                        {v == null ? "—" : `${v >= 0 ? "+" : ""}${Math.round(v * 100)}%`}
                      </span>
                    </div>
                  );
                });
              })()}
              {rec.responseSource && (() => {
                const calibrated = Object.entries(rec.responseSource).filter(([, s]) => s.source === "blended");
                if (calibrated.length === 0) {
                  return (
                    <div style={{ fontSize: 10, color: C.muted, marginTop: 6, fontStyle: "italic" }}>
                      Using population prior. Response rates will calibrate to your own data after {PERSONAL_RESPONSE_MIN_SESSIONS}+ sessions per zone.
                    </div>
                  );
                }
                const labels = { power: "Power", strength: "Strength", endurance: "Capacity" };
                const parts = calibrated.map(([k, s]) => `${labels[k]} (${Math.round(s.n)})`).join(", ");
                return (
                  <div style={{ fontSize: 10, color: C.muted, marginTop: 6 }}>
                    <span style={{ color: C.green }}>●</span> Calibrated from your history: {parts}.
                    {calibrated.length < 3 && " Others still on prior."}
                  </div>
                );
              })()}
            </div>
          );

          // Per-grip split mode: one card per grip with its own verdict.
          // perGripMode triggers as soon as any grip has coaching data —
          // even a single grip gets its own coaching card rather than
          // falling through to the legacy ΔAUC engine in `recommendation`.
          // Eliminates the inconsistency where a user with only one grip
          // worth of data saw a Monod-driven recommendation while
          // multi-grip users saw the gap-driven coaching engine.
          const perGripMode = !selGrip && Object.keys(gripRecs).length >= 1;
          if (perGripMode) {
            return (
              <>
                {Object.values(gripRecs).map(rec => (
                  <Card key={rec.grip} style={{ marginBottom: 16, border: `1px solid ${rec.color}40` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                      <div style={{ fontSize: 11, color: rec.color, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                        Next Session Focus
                      </div>
                      <div style={{ fontSize: 11, color: C.muted, fontWeight: 600 }}>
                        {rec.grip}
                      </div>
                    </div>
                    <div style={{ fontSize: 22, fontWeight: 800, color: rec.color, marginBottom: 10 }}>
                      {rec.title}
                    </div>
                    <div style={{ fontSize: 13, color: C.text, marginBottom: 14, lineHeight: 1.6 }}>
                      {rec.rationale || `Largest gap to potential at ${GOAL_CONFIG[rec.key]?.label || rec.key} for ${rec.grip}.`}
                    </div>
                    {renderGainsBars(rec)}
                    <div style={{ fontSize: 10, color: C.muted, marginTop: 4 }}>
                      CF {fmtW(rec.CF, unit)} {unit} · W′ {fmtW(rec.W, unit)} {unit}·s · {rec.n} failure{rec.n !== 1 ? "s" : ""}
                    </div>
                  </Card>
                ))}
              </>
            );
          }

          // Single-card mode — pooled fit, or user has picked a specific
          // grip. Shows the full limiter/coverage diagnostics panel.
          if (!recommendation) {
            return (
              <Card style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.5 }}>
                  🔬 Train close to your limit in at least one time domain so the auto-failure system can record a failure point. That unlocks personalized training recommendations.
                </div>
              </Card>
            );
          }
          return (
            <Card style={{ marginBottom: 16, border: `1px solid ${recommendation.color}40` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                <div style={{ fontSize: 11, color: recommendation.color, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                  Next Session Focus
                </div>
                {selGrip && (
                  <div style={{ fontSize: 11, color: C.muted, fontWeight: 600 }}>{selGrip}</div>
                )}
              </div>
              <div style={{ fontSize: 22, fontWeight: 800, color: recommendation.color, marginBottom: 10 }}>
                {recommendation.title}
              </div>
              <div style={{ fontSize: 13, color: C.text, marginBottom: 14, lineHeight: 1.6 }}>
                {recommendation.rationale || recommendation.insight}
              </div>
              {renderGainsBars(recommendation)}
              {/* Secondary diagnostics */}
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {recommendation.limiterKey && recommendation.agree && (
                  <div style={{ fontSize: 11, color: C.muted, display: "flex", gap: 6, alignItems: "flex-start" }}>
                    <span style={{ color: C.green, fontWeight: 700, flexShrink: 0 }}>✓ Shape:</span>
                    <span>
                      Curve-shape diagnostic agrees — this zone also falls farthest below its own Monod curve
                      {recommendation.limiterGrip ? <> on <b>{recommendation.limiterGrip}</b></> : null}.
                    </span>
                  </div>
                )}
                {recommendation.limiterKey && !recommendation.agree && (
                  <div style={{ fontSize: 11, color: C.muted, display: "flex", gap: 6, alignItems: "flex-start" }}>
                    <span style={{ color: C.yellow, fontWeight: 700, flexShrink: 0 }}>⚡ Shape:</span>
                    <span>
                      Curve-shape diagnostic points elsewhere
                      {recommendation.limiterGrip ? <> (<b>{recommendation.limiterGrip}</b>)</> : null},
                      but AUC ranks this protocol as the biggest capacity win. Growing area dominates balancing shape.
                    </span>
                  </div>
                )}
                {recommendation.coverageKey && recommendation.coverageKey === recommendation.key && (
                  <div style={{ fontSize: 11, color: C.muted, display: "flex", gap: 6, alignItems: "flex-start" }}>
                    <span style={{ color: C.green, fontWeight: 700, flexShrink: 0 }}>✓ Coverage:</span>
                    <span>Session count agrees — this is also your least-trained zone in the last 30 days.</span>
                  </div>
                )}
              </div>
            </Card>
          );
        })()}

        {/* Unexplored zones notice */}
        {unexplored.length > 0 && (
          <Card style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, color: C.yellow, marginBottom: 6 }}>
              📍 Unexplored: <b>{unexplored.join(", ")}</b>
            </div>
            <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
              Data from {unexplored.join(" and ").toLowerCase()} hangs would complete your profile and reveal hidden limiters. A single session to failure in each zone is enough to start.
            </div>
          </Card>
        )}

      </>)}
    </div>
  );
}

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

  // Displayed readiness: subjective if rated today, otherwise computed estimate
  const readiness = todaySubj != null ? subjToScore(todaySubj) : computedReadiness;

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

      {tab === 1 && <AnalysisView history={history} unit={unit} bodyWeight={bodyWeight} baseline={baseline} activities={activities} liveEstimate={liveEstimate} gripEstimates={gripEstimates} freshMap={freshMap} readiness={readiness} />}
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
