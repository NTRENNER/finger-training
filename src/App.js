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

// Three-compartment fatigue decay parameters (defaults; fitted from history over time)
const DEF_FAT = {
  A1: 0.50, tau1: 15,   // fast   — phosphocreatine (s)
  A2: 0.30, tau2: 90,   // medium — glycolytic       (s)
  A3: 0.20, tau3: 600,  // slow   — metabolic byproducts (s)
};

const LS_NOTES_KEY     = "ft_notes";     // { [session_id]: string }
const LS_BW_KEY        = "ft_bw";        // body weight in kg (number)
const LS_BW_LOG_KEY    = "ft_bw_log";    // [{ date, kg }] body weight history
const LS_READINESS_KEY = "ft_readiness"; // { [date]: 1-5 } subjective daily rating
const LS_BASELINE_KEY  = "ft_baseline";  // { date, CF, W } — permanent first-calibration snapshot
const LS_ACTIVITY_KEY  = "ft_activity";  // [{ date, type, duration_min, intensity }] climbing / other sessions
const LS_GENESIS_KEY   = "ft_genesis";   // { date, CF, W, auc } — snapshot when first all-zone coverage earned

const LEVEL_STEP = 1.05; // 5% improvement per level

// Level display — numeric only, no old badge names
const LEVEL_EMOJIS = ["🌱","🏛️","📈","⚡","⚙️","🔥","🏔️","⭐","💎","🏆","🌟"];

// ─────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────
const uid     = () => Math.random().toString(36).slice(2, 10);
const today   = () => new Date().toISOString().slice(0, 10);
const nowISO      = () => new Date().toISOString();
const fmtClock    = (iso) => { try { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch { return ""; } };
// Return the most recent BW log entry on or before `date` (YYYY-MM-DD), or null.
const bwOnDate = (bwLog, date) => {
  const candidates = (bwLog || []).filter(e => e.date <= date);
  return candidates.length ? candidates[candidates.length - 1] : null;
};
const clamp  = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmt1   = (n) => (typeof n === "number" && isFinite(n)) ? n.toFixed(1) : "—";
const fmt0   = (n) => (typeof n === "number" && isFinite(n)) ? String(Math.round(n)) : "—";

const KG_TO_LBS = 2.20462;
// Convert stored kg → display unit
const toDisp   = (kg, unit) => (unit === "lbs" && typeof kg === "number") ? kg * KG_TO_LBS : kg;
// Convert display unit → kg for storage
const fromDisp = (val, unit) => (unit === "lbs" && typeof val === "number") ? val / KG_TO_LBS : val;
// Format a kg value for display in the current unit
const fmtW = (kg, unit) => fmt1(toDisp(kg, unit));
const fmtTime = (s) => {
  if (!isFinite(s) || s < 0) return "—";
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return m > 0 ? `${m}:${String(sec).padStart(2, "0")}` : `${Math.floor(s)}s`;
};

const loadLS = (key) => {
  try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : null; }
  catch { return null; }
};
const saveLS = (key, v) => {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch {}
};

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

// ─────────────────────────────────────────────────────────────
// MONOD-SCHERRER CURVE FIT  (standalone — used by CalibrationView & AnalysisView)
// ─────────────────────────────────────────────────────────────
// pts: array of { x: 1/duration_s, y: avg_force_kg }
// Returns { CF, W, n } or null if not enough data / degenerate.
function fitCF(pts) {
  if (!pts || pts.length < 2) return null;
  const n   = pts.length;
  const sx  = pts.reduce((a, p) => a + p.x, 0);
  const sy  = pts.reduce((a, p) => a + p.y, 0);
  const sxx = pts.reduce((a, p) => a + p.x * p.x, 0);
  const sxy = pts.reduce((a, p) => a + p.x * p.y, 0);
  const den = n * sxx - sx * sx;
  if (Math.abs(den) < 1e-12) return null;
  const W  = (n * sxy - sx * sy) / den;   // slope  = W′  (kg·s)
  const CF = (sy - W * sx) / n;           // intercept = CF (kg)
  if (CF < 0 || W < 0) return null;
  return { CF, W, n };
}

// Predicted force at a given duration (s) from a CF/W fit.
function predForce(fit, t) { return fit.CF + fit.W / t; }

// Area under F = CF + W/t from tMin to tMax (analytical integral).
// = CF*(tMax-tMin) + W*ln(tMax/tMin)
// Units: kg·s — captures total capacity across the full power→capacity range.
function computeAUC(CF, W, tMin = 10, tMax = 120) {
  return CF * (tMax - tMin) + W * Math.log(tMax / tMin);
}

// ─────────────────────────────────────────────────────────────
// SESSION PLANNER — per-rep fatigue curve prediction
// ─────────────────────────────────────────────────────────────
// Uses a three-compartment depletion/recovery model (same time constants as DEF_FAT).
// Each compartment depletes during a hang and recovers during rest.
// Returns an array of predicted hold times (seconds) for each rep.
function predictRepTimes({ numReps, firstRepTime, restSeconds }) {
  // Compartments: [amplitude, depletion_tau, recovery_tau]
  const comps = [
    { A: 0.50, tauD: 10,  tauR: 15  },  // PCr  — fast
    { A: 0.30, tauD: 30,  tauR: 90  },  // Glycolytic — medium
    { A: 0.20, tauD: 180, tauR: 600 },  // Oxidative  — slow
  ];

  // State: available fraction (0–1) for each compartment, starting fresh
  const state = comps.map(c => ({ ...c, avail: 1.0 }));

  const times = [];
  for (let i = 0; i < numReps; i++) {
    // Capacity this rep = weighted sum of available fractions
    const capacity = state.reduce((s, c) => s + c.A * c.avail, 0); // sum(Ai) = 1
    const t = Math.max(0, Math.round(firstRepTime * capacity * 10) / 10);
    times.push(t);

    // Deplete each compartment over this rep's duration
    for (const c of state) {
      const dep = 1 - Math.exp(-t / c.tauD);
      c.avail = Math.max(0, c.avail * (1 - dep));
    }

    // Recover during rest (if not the last rep)
    if (i < numReps - 1) {
      for (const c of state) {
        const rec = 1 - Math.exp(-restSeconds / c.tauR);
        c.avail = Math.min(1, c.avail + (1 - c.avail) * rec);
      }
    }
  }
  return times;
}

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
// FATIGUE MODEL — THREE-COMPARTMENT IV-KINETICS ANALOGY
// ─────────────────────────────────────────────────────────────
// F(t) = F₀ · Σᵢ Aᵢ · exp(−t / τᵢ)
// F is the fraction of max strength currently *unavailable* due to fatigue.
// Three compartments model fast (PCr), medium (glycolytic), and slow (metabolic) recovery.
//
// Dose from one rep adds fatigue proportional to relative load × duration.

function fatigueAfterRest(F, restSeconds, p = DEF_FAT) {
  const { A1, tau1, A2, tau2, A3, tau3 } = p;
  return F * (
    A1 * Math.exp(-restSeconds / tau1) +
    A2 * Math.exp(-restSeconds / tau2) +
    A3 * Math.exp(-restSeconds / tau3)
  );
}

function fatigueDose(weightKg, durationS, sMaxKg) {
  if (!sMaxKg || sMaxKg <= 0) return 0;
  const k = 0.010; // empirical; could be fitted from history
  return clamp((weightKg / sMaxKg) * durationS * k, 0, 0.90);
}

const availFrac = (F) => clamp(1 - F, 0.05, 1.0);

// ─────────────────────────────────────────────────────────────
// HISTORICAL ESTIMATION
// ─────────────────────────────────────────────────────────────
// Effective load for a rep — prefer Tindeq avg_force_kg, fall back to weight_kg
function effectiveLoad(r) {
  const f = Number(r.avg_force_kg);
  const w = Number(r.weight_kg);
  if (f > 0 && f < 500) return f;
  if (w > 0) return w;
  return 0;
}

// Returns the weighted-recent-average weight at which the user
// achieved close to targetDuration seconds to failure.
function estimateRefWeight(history, hand, grip, targetDuration) {
  if (!history || history.length === 0) return null;
  const tol = targetDuration * 0.40;
  const matches = history.filter(r =>
    r.hand === hand &&
    (!grip || r.grip === grip) &&
    r.actual_time_s > 0 &&
    Math.abs(r.actual_time_s - targetDuration) <= tol &&
    effectiveLoad(r) > 0
  );
  if (matches.length === 0) return null;
  const sorted = [...matches].sort((a, b) => a.date < b.date ? -1 : 1).slice(-10);
  let wSum = 0, wKg = 0;
  sorted.forEach((r, i) => { const w = i + 1; wSum += w; wKg += effectiveLoad(r) * w; });
  return wKg / wSum;
}

function suggestWeight(refWeight, fatigue) {
  if (refWeight == null) return null;
  return Math.round(refWeight * availFrac(fatigue) * 10) / 10;
}

// ─────────────────────────────────────────────────────────────
// LOAD AUTO-PRESCRIPTION from fitted CF/W' (Monod-Scherrer)
// ─────────────────────────────────────────────────────────────
// Returns prescribed load (kg) for a target time-to-exhaustion on a given grip/hand.
// Uses the hyperbolic form: F = CF + W'/T. Falls back to null if not enough failure data.
// Typical targets: Power T=7, Strength T=45, Capacity T=120.
// eslint-disable-next-line no-unused-vars
function prescribedLoad(history, hand, grip, targetDuration) {
  if (!history || !targetDuration) return null;
  const failures = history.filter(r =>
    r.failed &&
    r.hand === hand &&
    (!grip || r.grip === grip) &&
    r.actual_time_s > 0 &&
    effectiveLoad(r) > 0
  );
  if (failures.length < 2) return null;
  const pts = failures.map(r => ({ x: 1 / r.actual_time_s, y: effectiveLoad(r) }));
  const fit = fitCF(pts);
  if (!fit) return null;
  return Math.round((fit.CF + fit.W / targetDuration) * 10) / 10;
}

// ─────────────────────────────────────────────────────────────
// PER-COMPARTMENT AUC (training dose delivered to each energy system)
// ─────────────────────────────────────────────────────────────
// Textbook PK-style integral: dose_i = load × A_i × τ_Di × (1 − e^(−t/τ_Di))
// Short reps saturate compartment 1; long reps (>> τ_Di) saturate that compartment.
// Rest between reps is ignored (rest delivers no dose; only clears for subsequent reps).
//
// Returns { fast, medium, slow, total } in kg·s units (force-time integrated dose).
// Compartment 1 (fast/PCr), 2 (medium/glycolytic), 3 (slow/oxidative).
function sessionCompartmentAUC(reps) {
  const comps = [
    { key: "fast",   A: 0.50, tauD: 10  },
    { key: "medium", A: 0.30, tauD: 30  },
    { key: "slow",   A: 0.20, tauD: 180 },
  ];
  const out = { fast: 0, medium: 0, slow: 0 };
  for (const r of reps || []) {
    const t = r.actual_time_s;
    const L = effectiveLoad(r);
    if (!t || !L || t <= 0 || L <= 0) continue;
    for (const c of comps) {
      out[c.key] += L * c.A * c.tauD * (1 - Math.exp(-t / c.tauD));
    }
  }
  out.total = out.fast + out.medium + out.slow;
  return out;
}

// ─────────────────────────────────────────────────────────────
// Grip Gains 5-zone classifier: categorises a single hang by its
// time-under-tension. The 45s boundaries come from 15 × 3s pulses
// in Grip Gains' original framing; we treat them as TUT thresholds.
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
  const autoFailCallbackRef = useRef(null); // set by ActiveSessionView / CalibrationView
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
            adOnStartRef.current?.();
          }
        } else {
          adSumRef.current  += kg;
          adCountRef.current += 1;
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

// ─────────────────────────────────────────────────────────────
// DESIGN TOKENS
// ─────────────────────────────────────────────────────────────
const C = {
  bg:      "#0d1117",
  card:    "#161b22",
  border:  "#30363d",
  text:    "#e6edf3",
  muted:   "#8b949e",
  blue:    "#58a6ff",
  green:   "#3fb950",
  red:     "#f85149",
  orange:  "#f0883e",
  purple:  "#bc8cff",
  yellow:  "#e3b341",
};

const base = {
  fontFamily: "'Segoe UI', system-ui, sans-serif",
  color: C.text,
  background: C.bg,
  minHeight: "100vh",
  padding: "0",
  margin: "0",
};

// ─────────────────────────────────────────────────────────────
// SHARED UI COMPONENTS
// ─────────────────────────────────────────────────────────────
function Card({ children, style }) {
  return (
    <div style={{
      background: C.card, border: `1px solid ${C.border}`,
      borderRadius: 12, padding: "20px 24px", marginBottom: 16,
      ...style,
    }}>
      {children}
    </div>
  );
}

function Btn({ children, onClick, color = C.blue, disabled, style, small }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: disabled ? C.border : color,
        color: "#fff", border: "none", borderRadius: 8,
        padding: small ? "6px 14px" : "10px 22px",
        fontSize: small ? 13 : 15, fontWeight: 600,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "opacity 0.15s",
        ...style,
      }}
    >
      {children}
    </button>
  );
}

function Label({ children }) {
  return <div style={{ fontSize: 12, color: C.muted, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>{children}</div>;
}

function Sect({ title, children }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10, paddingBottom: 6, borderBottom: `1px solid ${C.border}` }}>
        {title}
      </div>
      {children}
    </div>
  );
}

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
        {unit}{targetKg != null ? ` · target ${fmtW(targetKg, unit)} ${unit}` : ""}
      </div>
      {/* Stats row */}
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.muted, marginBottom: 6 }}>
        <span>Avg: <b style={{ color: C.green }}>{fmtW(avg, unit)} {unit}</b></span>
        <span>Peak: <b style={{ color: C.orange }}>{fmtW(peak, unit)} {unit}</b></span>
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
// CALIBRATION VIEW
// ─────────────────────────────────────────────────────────────
const CAL_STEPS = [
  {
    id: "power", label: "Power", emoji: "⚡",
    duration: 10, color: C.red,
    desc: "10-second max-effort hang. Go all out from the start.",
    tip:  "Use your strongest grip. This anchors your W′ (anaerobic work capacity).",
  },
  {
    id: "strength", label: "Strength", emoji: "💪",
    duration: 45, color: C.orange,
    desc: "45-second hard hang. Challenging but sustained.",
    tip:  "Aim for ~85% effort. Pace yourself to last the full 45 s.",
  },
  {
    id: "endurance", label: "Capacity", emoji: "🏔️",
    duration: null, color: C.blue,
    desc: "Hang to complete failure. Hold as long as possible.",
    tip:  "Target ~50% of your Power test force. The hang ends when you can't hold.",
  },
];
const CAL_REST = 300; // 5 min between steps

function CalibrationView({ tindeq, unit = "lbs", onComplete, onCancel }) {
  const [calPhase,      setCalPhase]      = useState("intro");
  const [stepIdx,       setStepIdx]       = useState(0);
  const [countdown,     setCountdown]     = useState(3);
  const [elapsed,       setElapsed]       = useState(0);
  const [restRemaining, setRestRemaining] = useState(CAL_REST);
  const [results,       setResults]       = useState([]); // { actualTime, avgForce, peakForce, failed }

  const startTimeRef  = useRef(null);
  const timerRef      = useRef(null);
  const restTimerRef  = useRef(null);
  const autoFailedRef = useRef(false);
  const endHangRef    = useRef(null);

  const step = CAL_STEPS[stepIdx];

  // For capacity step: suggest ~50% of power step avg force
  const capacitySuggestKg = results[0]?.avgForce > 0 ? results[0].avgForce * 0.5 : null;
  const targetKg = step.id === "endurance" ? capacitySuggestKg : null;

  // Keep Tindeq auto-failure target in sync (capacity step only)
  useEffect(() => {
    tindeq.targetKgRef.current = (calPhase === "active" && step.id === "endurance")
      ? targetKg
      : null;
  }, [calPhase, step, targetKg, tindeq]);

  // Wire auto-failure → endHang for the capacity step only.
  useEffect(() => {
    if (calPhase !== "active" || step.id !== "endurance") {
      tindeq.setAutoFailCallback(null);
      return;
    }
    tindeq.setAutoFailCallback(() => {
      autoFailedRef.current = true;
      endHangRef.current?.();
    });
    return () => tindeq.setAutoFailCallback(null);
  }, [calPhase, step, tindeq]);

  const endHang = useCallback(async () => {
    if (!startTimeRef.current) return;
    autoFailedRef.current = false;
    clearInterval(timerRef.current);
    const actualTime = (Date.now() - startTimeRef.current) / 1000;
    startTimeRef.current = null;
    // Capacity step is always a failure rep by design; others are not
    const failed = step.id === "endurance";
    if (tindeq.connected) await tindeq.stopMeasuring();
    const result = {
      actualTime,
      avgForce:  tindeq.avgForce,
      peakForce: tindeq.peak,
      failed,
    };
    setResults(prev => [...prev, result]);
    setCalPhase("result");
  }, [tindeq, step]);

  // Keep endHang ref current so setInterval closure is always fresh
  endHangRef.current = endHang;

  const startHang = useCallback(async () => {
    setElapsed(0);
    startTimeRef.current = Date.now();
    setCalPhase("active");
    if (tindeq.connected) {
      await tindeq.tare();
      await tindeq.startMeasuring();
    }
    timerRef.current = setInterval(() => {
      if (!startTimeRef.current) return;
      const t = (Date.now() - startTimeRef.current) / 1000;
      setElapsed(Math.floor(t));
      // Auto-complete timed steps when duration is reached
      if (step.duration && t >= step.duration) {
        clearInterval(timerRef.current);
        endHangRef.current?.();
      }
    }, 100);
  }, [tindeq, step]);

  // 3-2-1 countdown
  useEffect(() => {
    if (calPhase !== "countdown") return;
    if (countdown <= 0) { startHang(); return; }
    const t = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [calPhase, countdown, startHang]);

  // Rest timer
  useEffect(() => {
    if (calPhase !== "resting") return;
    setRestRemaining(CAL_REST);
    restTimerRef.current = setInterval(() => {
      setRestRemaining(r => {
        if (r <= 1) { clearInterval(restTimerRef.current); advanceStep(); return 0; }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(restTimerRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calPhase]);

  // Cleanup on unmount
  useEffect(() => () => {
    clearInterval(timerRef.current);
    clearInterval(restTimerRef.current);
  }, []);

  const advanceStep = () => {
    const next = stepIdx + 1;
    if (next >= CAL_STEPS.length) {
      setCalPhase("complete");
    } else {
      setStepIdx(next);
      setCountdown(3);
      setCalPhase("countdown");
    }
  };

  const handleResultNext = () => {
    if (stepIdx >= CAL_STEPS.length - 1) setCalPhase("complete");
    else setCalPhase("resting");
  };

  const handleComplete = () => {
    const sessionId = uid();
    const reps = results.map((r, i) => {
      const s = CAL_STEPS[i];
      return {
        id:              uid(),
        date:            today(),
        grip:            "Calibration",
        hand:            "Both",
        target_duration: s.duration ?? Math.round(r.actualTime),
        weight_kg:       0,
        actual_time_s:   Math.round(r.actualTime * 10) / 10,
        avg_force_kg:    (isFinite(r.avgForce) && r.avgForce > 0 && r.avgForce < 500)
                           ? Math.round(r.avgForce * 10) / 10
                           : 0,
        peak_force_kg:   (isFinite(r.peakForce) && r.peakForce > 0)
                           ? Math.round(r.peakForce * 10) / 10
                           : 0,
        set_num:         1,
        rep_num:         i + 1,
        rest_s:          CAL_REST,
        session_id:      sessionId,
        failed:          r.failed,
      };
    });
    onComplete(reps);
  };

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 13, color: C.muted }}>Calibration</div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>Force-Duration Profile</div>
        </div>
        {calPhase === "intro" && (
          <Btn small color={C.muted} onClick={onCancel}>Cancel</Btn>
        )}
      </div>

      {/* Step progress dots */}
      {calPhase !== "intro" && (
        <div style={{ display: "flex", gap: 6, marginBottom: 20 }}>
          {CAL_STEPS.map((s, i) => (
            <div key={s.id} style={{
              flex: 1, height: 6, borderRadius: 3,
              background: i < results.length ? s.color : C.border,
              opacity: i > stepIdx && calPhase !== "complete" ? 0.3 : 1,
              transition: "background 0.4s",
            }} />
          ))}
        </div>
      )}

      {/* ── INTRO ── */}
      {calPhase === "intro" && (
        <>
          <Card>
            <div style={{ textAlign: "center", padding: "8px 0 16px" }}>
              <div style={{ fontSize: 48, marginBottom: 8 }}>📊</div>
              <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 10 }}>
                Calibrate Your Strength
              </div>
              <div style={{ fontSize: 14, color: C.muted, lineHeight: 1.65 }}>
                3 quick tests across different time domains. Seeds your force-duration
                curve and powers accurate training recommendations from day one.
              </div>
            </div>
          </Card>

          {CAL_STEPS.map((s, i) => (
            <Card key={s.id} style={{ marginTop: 10 }}>
              <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
                <div style={{
                  fontSize: 24, width: 44, height: 44, borderRadius: 22, flexShrink: 0,
                  background: s.color + "22",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  {s.emoji}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: s.color }}>
                    Step {i + 1}: {s.label}
                    <span style={{ fontWeight: 400, color: C.muted, marginLeft: 6, fontSize: 13 }}>
                      {s.duration ? `${s.duration}s` : "to failure"}
                    </span>
                  </div>
                  <div style={{ fontSize: 13, color: C.text, marginTop: 3 }}>{s.desc}</div>
                  <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>{s.tip}</div>
                </div>
              </div>
            </Card>
          ))}

          <div style={{
            marginTop: 12, padding: "12px 16px",
            background: "#1a1f2e", borderRadius: 10,
            fontSize: 12, color: C.muted,
          }}>
            ⏱ Plan ~20 min total — 5-minute rest between each test.
          </div>

          <Btn
            onClick={() => { setStepIdx(0); setCountdown(3); setCalPhase("countdown"); }}
            style={{ width: "100%", padding: "16px 0", fontSize: 17, borderRadius: 12, marginTop: 14 }}
            color={C.blue}
          >
            Begin Calibration →
          </Btn>
        </>
      )}

      {/* ── COUNTDOWN ── */}
      {calPhase === "countdown" && (
        <Card style={{ textAlign: "center", padding: "40px 24px" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: step.color, marginBottom: 6 }}>
            {step.emoji} Step {stepIdx + 1} of {CAL_STEPS.length}: {step.label}
          </div>
          <div style={{ fontSize: 14, color: C.muted, marginBottom: 28 }}>{step.desc}</div>
          <div style={{ fontSize: 96, fontWeight: 900, color: C.yellow, lineHeight: 1 }}>
            {countdown === 0 ? "GO" : countdown}
          </div>
          {step.id === "endurance" && capacitySuggestKg != null && (
            <div style={{ fontSize: 14, color: C.muted, marginTop: 20 }}>
              Target force: <b style={{ color: C.blue }}>{fmtW(capacitySuggestKg, unit)} {unit}</b>
            </div>
          )}
        </Card>
      )}

      {/* ── ACTIVE ── */}
      {calPhase === "active" && (
        <>
          <Card>
            <div style={{ textAlign: "center", marginBottom: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: step.color }}>
                {step.emoji} {step.label}
              </span>
              {step.duration && (
                <span style={{ fontSize: 12, color: C.muted, marginLeft: 8 }}>
                  — target {step.duration}s
                </span>
              )}
              {step.id === "endurance" && capacitySuggestKg != null && (
                <span style={{ fontSize: 12, color: C.muted, marginLeft: 8 }}>
                  — target {fmtW(capacitySuggestKg, unit)} {unit}
                </span>
              )}
            </div>
            <BigTimer
              seconds={elapsed}
              targetSeconds={step.duration ?? null}
              running={true}
            />
            {tindeq.connected ? (
              <ForceGauge
                force={tindeq.force}
                avg={tindeq.avgForce}
                peak={tindeq.peak}
                targetKg={targetKg}
                unit={unit}
              />
            ) : (
              <div style={{ fontSize: 12, color: C.muted, textAlign: "center", marginTop: 8 }}>
                No Tindeq — tap the button below when you let go.
              </div>
            )}
          </Card>
          <Btn
            onClick={endHang}
            style={{ width: "100%", padding: "18px 0", fontSize: 18, borderRadius: 12, marginTop: 8 }}
            color={step.id === "endurance" ? C.red : C.muted}
          >
            {step.id === "endurance" ? "✕ I Failed" : "✓ Done"}
          </Btn>
        </>
      )}

      {/* ── RESULT ── */}
      {calPhase === "result" && (() => {
        const r = results[results.length - 1];
        const isLast = stepIdx >= CAL_STEPS.length - 1;
        return (
          <>
            <Card style={{ borderColor: step.color }}>
              <div style={{ textAlign: "center", padding: "8px 0 12px" }}>
                <div style={{ fontSize: 36 }}>{step.emoji}</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: step.color, marginTop: 6 }}>
                  {step.label} Complete
                </div>
              </div>
              <div style={{ display: "flex", gap: 16, justifyContent: "center", flexWrap: "wrap", marginTop: 8 }}>
                <div style={{ textAlign: "center" }}>
                  <Label>Time</Label>
                  <div style={{ fontSize: 28, fontWeight: 800, color: C.text }}>
                    {fmtTime(r.actualTime)}
                  </div>
                </div>
                {r.avgForce > 0 && (
                  <div style={{ textAlign: "center" }}>
                    <Label>Avg Force</Label>
                    <div style={{ fontSize: 28, fontWeight: 800, color: step.color }}>
                      {fmtW(r.avgForce, unit)} {unit}
                    </div>
                  </div>
                )}
                {r.peakForce > 0 && (
                  <div style={{ textAlign: "center" }}>
                    <Label>Peak</Label>
                    <div style={{ fontSize: 28, fontWeight: 800, color: C.purple }}>
                      {fmtW(r.peakForce, unit)} {unit}
                    </div>
                  </div>
                )}
              </div>
              {step.id === "power" && r.avgForce > 0 && (
                <div style={{
                  marginTop: 14, padding: "10px 14px",
                  background: C.bg, borderRadius: 8,
                  fontSize: 12, color: C.muted,
                }}>
                  💡 Capacity target will be{" "}
                  <b style={{ color: C.blue }}>
                    {fmtW(r.avgForce * 0.5, unit)} {unit}
                  </b>{" "}
                  (~50% of your Power test)
                </div>
              )}
            </Card>
            <Btn
              onClick={handleResultNext}
              style={{ width: "100%", padding: "16px 0", fontSize: 16, borderRadius: 12, marginTop: 12 }}
              color={isLast ? C.green : C.blue}
            >
              {isLast ? "✓ View My Results" : `Rest 5 min → Step ${stepIdx + 2}: ${CAL_STEPS[stepIdx + 1].label}`}
            </Btn>
          </>
        );
      })()}

      {/* ── RESTING ── */}
      {calPhase === "resting" && (
        <>
          <Card>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 13, color: C.muted, marginBottom: 8 }}>
                Rest before Step {stepIdx + 2}: {CAL_STEPS[stepIdx + 1]?.label}
              </div>
              <div style={{
                fontSize: 72, fontWeight: 900, lineHeight: 1,
                color: restRemaining > 60 ? C.green : C.orange,
              }}>
                {fmtTime(restRemaining)}
              </div>
              <div style={{ marginTop: 14, height: 6, background: C.border, borderRadius: 3, overflow: "hidden" }}>
                <div style={{
                  height: "100%",
                  width: `${(restRemaining / CAL_REST) * 100}%`,
                  background: restRemaining > 60 ? C.green : C.orange,
                  borderRadius: 3, transition: "width 1s linear",
                }} />
              </div>
            </div>
          </Card>
          <div style={{
            marginTop: 12, padding: "12px 16px",
            background: "#1a1f2e", borderRadius: 10,
            fontSize: 13, color: C.muted,
          }}>
            🧘 <b style={{ color: C.text }}>Up next:</b> {CAL_STEPS[stepIdx + 1]?.desc}
          </div>
          <Btn
            onClick={() => { clearInterval(restTimerRef.current); advanceStep(); }}
            style={{ width: "100%", padding: "14px 0", fontSize: 15, borderRadius: 12, marginTop: 12 }}
            color={C.muted}
          >
            Skip rest — I'm ready →
          </Btn>
        </>
      )}

      {/* ── COMPLETE ── */}
      {calPhase === "complete" && (
        <>
          <Card style={{ borderColor: C.green }}>
            <div style={{ textAlign: "center", padding: "8px 0 16px" }}>
              <div style={{ fontSize: 48 }}>🎯</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: C.green, marginTop: 8 }}>
                Calibration Complete!
              </div>
              <div style={{ fontSize: 13, color: C.muted, marginTop: 8, lineHeight: 1.6 }}>
                Your force-duration curve is seeded. Head to the Analysis tab
                for your Critical Force estimate and training recommendations.
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>
              {results.map((r, i) => (
                <div key={i} style={{
                  display: "flex", alignItems: "center", gap: 12,
                  padding: "10px 14px", background: C.bg, borderRadius: 8,
                }}>
                  <span style={{ fontSize: 22 }}>{CAL_STEPS[i].emoji}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: CAL_STEPS[i].color }}>
                      {CAL_STEPS[i].label}
                    </div>
                    <div style={{ fontSize: 12, color: C.muted }}>
                      {fmtTime(r.actualTime)}
                      {r.avgForce > 0 && ` · ${fmtW(r.avgForce, unit)} ${unit} avg`}
                    </div>
                  </div>
                  <span style={{ color: C.green, fontSize: 16 }}>✓</span>
                </div>
              ))}
            </div>
          </Card>
          <Btn
            onClick={handleComplete}
            style={{ width: "100%", padding: "16px 0", fontSize: 17, borderRadius: 12, marginTop: 16 }}
            color={C.green}
          >
            View My Analysis →
          </Btn>
        </>
      )}

    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// SETUP VIEW
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// SESSION PLANNER CARD
// ─────────────────────────────────────────────────────────────
// Shows a goal picker + predicted per-rep fatigue curve + "Use this plan" button.
// Requires a live CF/W′ estimate fitted from training history.
// Grip Gains uniform protocol: 20s rest between every hang, 4–6 hangs per
// session depending on zone. The set count is chosen so per-hang hold-time
// converges to its asymptote (you've drained to compartment-3 steady state).
// Power drains only the fast pool which refills ~75% in 20s, so it takes ~6
// hangs to hit the tail. Capacity drains all three pools per hang, so the tail
// is reached in ~4 hangs. Strength sits between.
const GOAL_CONFIG = {
  power: {
    label: "Power", emoji: "⚡", color: "#e05560",
    refTime: 7, restDefault: 20, repsDefault: 6, setsDefault: 1, setRestDefault: 0,
    intensity: "6 × 5–7s max · 20s rest",
    setsRationale: "Grip Gains power protocol: 6 hangs of 5–7s at near-max load with 20s rest. 20s refills ~75% of PCr (τ₁≈15s) between hangs — enough to keep output high but not enough to fully recover. Six hangs reaches the asymptote where subsequent hangs would produce similar output; beyond that you're spinning your wheels. Use as a pre-climbing warm-up; primes neural drive without shredding you. Load auto-prescribed from CF + W'/7.",
  },
  strength: {
    label: "Strength", emoji: "💪", color: "#e07a30",
    refTime: 45, restDefault: 20, repsDefault: 5, setsDefault: 1, setRestDefault: 0,
    intensity: "45s + 4 to failure · 20s rest",
    setsRationale: "Grip Gains strength protocol: hang 1 targets 45s, hangs 2–5 go to failure, 20s rest between. 20s refills PCr but barely touches the glycolytic pool (τ₂≈90s → ~20% recovery), so fatigue compounds and each subsequent hang falls short of the last. Stop at 5 hangs: you've reached the compartment-2 + 3 steady state. The rep-time decay curve is a personal τ₂ probe — watch it flatten over weeks as glycolytic recovery improves. Load auto-prescribed from CF + W'/45.",
  },
  endurance: {
    label: "Capacity", emoji: "🏔️", color: "#3b82f6",
    refTime: 120, restDefault: 20, repsDefault: 4, setsDefault: 1, setRestDefault: 0,
    intensity: "120s + 3 to failure · 20s rest · just above CF",
    setsRationale: "Grip Gains capacity protocol at load ≈ CF + W'/120 (a hair above Critical Force). Hang 1 targets 120s continuous; hangs 2–4 go to failure with 20s rest. Each hang drains all three pools; 20s rest refills the fast pool but leaves medium and slow heavily depleted, so hold-time drops fast toward the CF asymptote. Stop at 4 hangs — subsequent hangs would be nearly flat on the tail. Trains CF / capillarity / mitochondrial density. Load auto-prescribed from CF + W'/120.",
  },
};

// ─────────────────────────────────────────────────────────────
// BADGE CONFIG — seven milestones from Genesis to Realization
// Thresholds are % AUC improvement above the Genesis snapshot.
// Badge 1 (Genesis) is earned by completing one session in each zone.
// ─────────────────────────────────────────────────────────────
const BADGE_CONFIG = [
  { id: "genesis",     label: "Genesis",     emoji: "🌱", threshold: 0,   desc: "One session in every zone — the curve awakens" },
  { id: "foundation",  label: "Foundation",  emoji: "🏛️", threshold: 10,  desc: "10% above Genesis — the base is taking shape" },
  { id: "progression", label: "Progression", emoji: "📈", threshold: 22,  desc: "22% above Genesis — the model sees real upward movement" },
  { id: "momentum",    label: "Momentum",    emoji: "⚡", threshold: 37,  desc: "37% above Genesis — adaptation is compounding" },
  { id: "grind",       label: "The Grind",   emoji: "⚙️", threshold: 55,  desc: "55% above Genesis — past the easy gains" },
  { id: "threshold",   label: "Threshold",   emoji: "🔥", threshold: 75,  desc: "75% above Genesis — crossing into rare territory" },
  { id: "realization", label: "Realization", emoji: "🏔️", threshold: 100, desc: "2× your Genesis capacity — the potential fulfilled" },
];

function SessionPlannerCard({ liveEstimate, onApplyPlan, recommendedZone = null }) {
  // Default goal to the undertrained zone when we know it; fall back to strength
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
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>🗓 Session Planner</div>

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
                  undertrained
                </div>
              )}
              <div style={{ fontSize: 16 }}>{g.emoji}</div>
              <div style={{ marginTop: 2 }}>{g.label}</div>
            </button>
          );
        })}
      </div>

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
// CLIMBING LOG WIDGET
// Quick-log a climbing session so zone coverage accounts for it.
// ─────────────────────────────────────────────────────────────
const CLIMB_INTENSITIES = [
  { key: "easy",       label: "Easy",       emoji: "🟢", desc: "Cruisy / warm-up",   zone: "Capacity"  },
  { key: "moderate",   label: "Moderate",   emoji: "🟡", desc: "Pumpy / sustained",   zone: "Capacity"  },
  { key: "hard",       label: "Hard",       emoji: "🔴", desc: "Limit / crux-heavy",  zone: "Strength"  },
  { key: "bouldering", label: "Bouldering", emoji: "⚡", desc: "Power / explosive",   zone: "Power"     },
];

function ClimbingLogWidget({ activities = [], onLog = () => {} }) {
  const [open,      setOpen]      = useState(false);
  const [intensity, setIntensity] = useState("moderate");
  const [duration,  setDuration]  = useState(90);
  const [logged,    setLogged]    = useState(false);

  const todayActivities = activities.filter(a => a.date === today() && a.type === "climbing");
  const hasToday        = todayActivities.length > 0;

  const handleLog = () => {
    onLog({ date: today(), type: "climbing", duration_min: duration, intensity });
    setLogged(true);
    setOpen(false);
    setTimeout(() => setLogged(false), 3000);
  };

  return (
    <div style={{ marginBottom: 16 }}>
      {/* Collapsed row */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          style={{
            width: "100%", padding: "10px 16px", borderRadius: 10, cursor: "pointer",
            background: C.card, border: `1px solid ${C.border}`,
            display: "flex", alignItems: "center", justifyContent: "space-between",
            color: C.text, fontSize: 13,
          }}
        >
          <span>
            🧗 {hasToday
              ? `Climbing logged today (${todayActivities.length}×)`
              : logged ? "✓ Climbing session logged!" : "Log a climbing session"}
          </span>
          <span style={{ fontSize: 11, color: C.muted }}>counts toward zone coverage +</span>
        </button>
      )}

      {/* Expanded form */}
      {open && (
        <Card style={{ border: `1px solid ${C.blue}40` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>🧗 Log Climbing Session</div>
            <button onClick={() => setOpen(false)} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 18, lineHeight: 1 }}>×</button>
          </div>

          {/* Intensity picker */}
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>Climbing style</div>
          <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
            {CLIMB_INTENSITIES.map(({ key, label, emoji, desc, zone }) => (
              <button key={key} onClick={() => setIntensity(key)} style={{
                flex: "1 1 40%", padding: "8px 6px", borderRadius: 8, cursor: "pointer",
                border: intensity === key ? `2px solid ${C.blue}` : `1px solid ${C.border}`,
                background: intensity === key ? C.blue + "22" : C.bg,
                color: C.text, textAlign: "left",
              }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{emoji} {label}</div>
                <div style={{ fontSize: 10, color: C.muted }}>{desc} · {zone}</div>
              </button>
            ))}
          </div>

          {/* Duration */}
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>Duration</div>
          <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
            {[60, 90, 120, 180].map(d => (
              <button key={d} onClick={() => setDuration(d)} style={{
                flex: 1, padding: "7px 0", borderRadius: 8, border: "none", cursor: "pointer",
                background: duration === d ? C.blue : C.border,
                color: duration === d ? "#fff" : C.muted,
                fontSize: 12, fontWeight: 600,
              }}>{d >= 60 ? `${d / 60}h` : `${d}m`}</button>
            ))}
          </div>

          <Btn onClick={handleLog} color={C.blue} style={{ width: "100%", padding: "10px 0", borderRadius: 8 }}>
            Log Climbing Session
          </Btn>
        </Card>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 1RM legacy — the OneRMWidget has been removed from the UI now that
// the Grip Gains power protocol (6 × 5–7s max hangs at 20s rest) is
// used as the pre-climb warm-up and replaces a standalone 1RM test.
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
  const cutoffStr = cutoff.toISOString().slice(0, 10);

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
    if (median <= POWER_MAX)         power++;
    else if (median <= STRENGTH_MAX) strength++;
    else                             endurance++;
  }

  // Legacy 1RM activities still credit Power — they are finger-specific max
  // efforts from before the Grip Gains power protocol was introduced.
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

function ZoneCoverageCard({ history, activities = [] }) {
  const coverage = useMemo(() => computeZoneCoverage(history, activities),
    [history, activities]); // eslint-disable-line react-hooks/exhaustive-deps

  if (coverage.total === 0) return null;

  const zones = [
    { key: "power",     label: "⚡ Power",     val: coverage.power,     color: "#e05560" },
    { key: "strength",  label: "💪 Strength",  val: coverage.strength,  color: "#e07a30" },
    { key: "endurance", label: "🏔️ Capacity",  val: coverage.endurance, color: "#3b82f6" },
  ];
  const recZone = zones.find(z => z.key === coverage.recommended);
  const maxVal  = Math.max(coverage.power, coverage.strength, coverage.endurance, 1);
  const advice  = {
    power:     "Power is least-trained. Short max-effort hangs build your phosphocreatine system — quality over volume.",
    strength:  "Strength is least-trained. Progressive hangs with partial recovery drive glycolytic adaptation.",
    endurance: "Capacity is least-trained. Sub-max repeaters raise Critical Force and lift every other zone by default.",
  };

  return (
    <Card style={{ marginBottom: 16, border: `1px solid ${recZone?.color ?? C.border}30` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>Zone Coverage</div>
        <div style={{ fontSize: 11, color: C.muted }}>last 30 days · {coverage.total} sessions</div>
      </div>
      {zones.map(({ key, label, val, color }) => {
        const isRec = key === coverage.recommended;
        return (
          <div key={key} style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <div style={{ fontSize: 12, fontWeight: isRec ? 700 : 400, color: isRec ? color : C.muted, display: "flex", alignItems: "center", gap: 6 }}>
                {label}
                {isRec && (
                  <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 8, background: color + "22", color }}>
                    train next
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.muted }}>{val}</div>
            </div>
            <div style={{ height: 6, background: C.border, borderRadius: 3, overflow: "hidden" }}>
              <div style={{
                height: "100%", borderRadius: 3,
                width: `${(val / maxVal) * 100}%`,
                background: color,
                opacity: isRec ? 1 : 0.4,
              }} />
            </div>
          </div>
        );
      })}
      <div style={{ fontSize: 11, color: C.muted, marginTop: 6, lineHeight: 1.5 }}>
        {advice[coverage.recommended]}
      </div>
    </Card>
  );
}

function SetupView({ config, setConfig, onStart, onCalibrate, history, unit = "lbs", onBwSave = () => {}, readiness = null, todaySubj = null, onSubjReadiness = () => {}, isEstimated = false, liveEstimate = null, activities = [], onLogActivity = () => {}, connectSlot = null }) {
  const [customGrip, setCustomGrip] = useState("");

  const handleGrip = (g) => setConfig(c => ({ ...c, grip: g }));
  const refWeightL = estimateRefWeight(history, "L", config.grip, config.targetTime);
  const refWeightR = estimateRefWeight(history, "R", config.grip, config.targetTime);

  // Level progress for current config — always both hands now
  const levelL      = calcLevel(history, "L", config.grip, config.targetTime);
  const levelR      = calcLevel(history, "R", config.grip, config.targetTime);
  const bestLoadL   = getBestLoad(history, "L", config.grip, config.targetTime);
  const bestLoadR   = getBestLoad(history, "R", config.grip, config.targetTime);
  const nextTargetL = nextLevelTarget(history, "L", config.grip, config.targetTime);
  const nextTargetR = nextLevelTarget(history, "R", config.grip, config.targetTime);
  const hasLevelData = (bestLoadL != null || bestLoadR != null) && config.grip;

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

      {(refWeightL != null || refWeightR != null) && (
        <Card style={{ borderColor: C.blue }}>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 8 }}>
            Suggested first-rep weight (from history, {config.targetTime}s target)
          </div>
          <div style={{ display: "flex", gap: 24 }}>
            <div>
              <Label>Left</Label>
              <span style={{ fontSize: 24, fontWeight: 700, color: C.blue }}>
                {refWeightL != null ? `${fmtW(refWeightL, unit)} ${unit}` : "—"}
              </span>
            </div>
            <div>
              <Label>Right</Label>
              <span style={{ fontSize: 24, fontWeight: 700, color: C.blue }}>
                {refWeightR != null ? `${fmtW(refWeightR, unit)} ${unit}` : "—"}
              </span>
            </div>
          </div>
        </Card>
      )}

      {/* Zone Coverage — rolling 30-day zone balance */}
      {/* Level progress for selected config */}
      {hasLevelData && (
        <Card style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 8 }}>
            {config.grip} · {config.targetTime}s
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            {[
              { key: "L", label: "Left",  level: levelL, best: bestLoadL, next: nextTargetL },
              { key: "R", label: "Right", level: levelR, best: bestLoadR, next: nextTargetR },
            ].map(row => (
              <div key={row.key} style={{ flex: 1, padding: 10, background: C.bg, borderRadius: 8 }}>
                <div style={{ fontSize: 11, color: C.muted, marginBottom: 2 }}>{row.label}</div>
                <div style={{ fontSize: 16, fontWeight: 800, color: C.text }}>
                  {row.best != null
                    ? <>{LEVEL_EMOJIS[Math.min(row.level - 1, LEVEL_EMOJIS.length - 1)]} L{row.level}</>
                    : <span style={{ color: C.muted, fontWeight: 500 }}>—</span>}
                </div>
                {row.best != null && (
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
                    {fmtW(row.best, unit)} {unit}
                    {row.next != null && <> · next {fmtW(row.next, unit)}</>}
                  </div>
                )}
                {row.next != null && row.best != null && (
                  <div style={{ width: "100%", height: 4, background: C.border, borderRadius: 2, marginTop: 6 }}>
                    <div style={{
                      height: "100%", borderRadius: 2, background: C.green,
                      width: `${Math.min(100, (row.best / row.next) * 100)}%`,
                    }} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {(history.length > 0 || activities.length > 0) && <ZoneCoverageCard history={history} activities={activities} />}

      {/* Activity Logs */}
      <ClimbingLogWidget activities={activities} onLog={onLogActivity} />

      {/* Session Planner — always shown; defaults to undertrained zone */}
      <SessionPlannerCard
        liveEstimate={liveEstimate}
        recommendedZone={(() => {
          const cov = computeZoneCoverage(history, activities);
          if (cov.total === 0) return null;
          return cov.recommended;
        })()}
        onApplyPlan={({ targetTime, repsPerSet, restTime, numSets, setRestTime }) =>
          setConfig(c => ({ ...c, targetTime, repsPerSet, restTime, numSets, setRestTime }))
        }
      />

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

      {/* Alternating hands mode — only when Both + rest ≥ rep duration */}
      {config.hand === "Both" && config.restTime >= config.targetTime && (
        <div style={{
          marginBottom: 16, padding: "12px 16px",
          background: C.card,
          border: `1px solid ${config.altMode ? C.green + "66" : C.border}`,
          borderRadius: 12,
          display: "flex", alignItems: "center", justifyContent: "space-between",
        }}>
          <div style={{ flex: 1, paddingRight: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>Alternating Hands Mode</div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
              Left rep → switch → Right rep → rest · each hand fully recovers while the other works
            </div>
          </div>
          <button
            onClick={() => setConfig(c => ({ ...c, altMode: !c.altMode }))}
            style={{
              flexShrink: 0, width: 48, height: 26, borderRadius: 13,
              border: "none", cursor: "pointer",
              background: config.altMode ? C.green : C.border,
              position: "relative", transition: "background 0.2s",
            }}
          >
            <div style={{
              position: "absolute", top: 3,
              left: config.altMode ? 25 : 3,
              width: 20, height: 20, borderRadius: 10,
              background: "#fff", transition: "left 0.2s",
            }} />
          </button>
        </div>
      )}

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
  const { config, currentSet, currentRep, fatigue, activeHand } = session;

  // repPhase: 'ready' (show Start button, first rep only)
  //           'countdown' (3-2-1)
  //           'active' (rep in progress)
  const [repPhase,     setRepPhase]    = useState(autoStart ? "active" : "ready");
  const [countdown,    setCountdown]   = useState(3);
  const [elapsed,      setElapsed]     = useState(0);
  const [manualWeight, setManualWeight] = useState(null);
  const startTimeRef = useRef(null);
  const timerRef     = useRef(null);

  // Suggested weight per hand
  const suggestions = useMemo(() => {
    const handList = config.hand === "Both" ? ["L", "R"] : [config.hand];
    return Object.fromEntries(
      handList.map(h => [h, {
        suggested: suggestWeight(session.refWeights?.[h] ?? null, fatigue),
      }])
    );
  }, [config.hand, session.refWeights, fatigue]);

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
            {fatigue > 0.05 && <span style={{ marginLeft: 8, color: C.orange }}>(fatigue {Math.round(fatigue * 100)}%)</span>}
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
// ─────────────────────────────────────────────────────────────
// ── Workout session history sub-view ──────────────────────────
function WorkoutHistoryView({ unit = "lbs", bodyWeight = null }) {
  // Always read fresh from localStorage — no useState wrapper so newly
  // completed sessions appear immediately without needing a remount.
  const [tick,           setTick]           = useState(0); // increment to force re-read
  const [editIdx,        setEditIdx]        = useState(null);
  const [editWorkout,    setEditWorkout]    = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [filterEx,   setFilterEx]   = useState("");  // "" = all, or exercise id
  const [filterDays, setFilterDays] = useState(0);   // 0 = all time, else last N days
  const [relMode,    setRelMode]    = useState(false);

  const log      = useMemo(() => loadLS(LS_WORKOUT_LOG_KEY)  || [], [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const bwLog    = useMemo(() => loadLS(LS_BW_LOG_KEY)       || [], [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const syncedIds = useMemo(() => new Set(loadLS(LS_WORKOUT_SYNCED_KEY) || []), [tick]); // eslint-disable-line react-hooks/exhaustive-deps

  // Flat name lookup across all workout definitions
  const exNames = useMemo(() => {
    const map = {};
    for (const wk of Object.values(DEFAULT_WORKOUTS)) {
      for (const ex of (wk.exercises || [])) {
        if (!map[ex.id]) map[ex.id] = ex.name || ex.id.replace(/_/g, " ");
      }
    }
    return map;
  }, []);

  // Exercises that appear in the log with actual sets (reps + weight) — the measurable ones
  const measurableExIds = useMemo(() => {
    const seen = new Set();
    for (const s of log) {
      for (const [id, data] of Object.entries(s.exercises || {})) {
        if (data.sets && data.sets.length > 0) seen.add(id);
      }
    }
    return [...seen].sort((a, b) => (exNames[a] || a).localeCompare(exNames[b] || b));
  }, [log, exNames]);

  // Apply filters — a session matches if it contains the selected exercise with sets
  const filtered = useMemo(() => {
    const cutoff = filterDays > 0
      ? new Date(Date.now() - filterDays * 864e5).toISOString().slice(0, 10)
      : null;
    return log.filter(s => {
      if (cutoff && s.date < cutoff) return false;
      if (filterEx) {
        const exData = s.exercises?.[filterEx];
        if (!exData?.sets?.length) return false;
      }
      return true;
    });
  }, [log, filterEx, filterDays]);

  // Sorted newest-first for display; track original index for saves
  const sorted = useMemo(() =>
    filtered.map((s) => ({ ...s, origIdx: log.indexOf(s) }))
            .sort((a, b) => a.date < b.date ? 1 : -1),
    [filtered, log]
  );

  const saveEdit = (origIdx) => {
    const updated = log.map((s, i) => i === origIdx ? { ...s, workout: editWorkout } : s);
    saveLS(LS_WORKOUT_LOG_KEY, updated);
    setTick(t => t + 1);
    setEditIdx(null);
    setEditWorkout(null);
  };

  const deleteSession = (sessionId) => {
    // Remove from localStorage
    saveLS(LS_WORKOUT_LOG_KEY, log.filter(s => s.id !== sessionId));
    // Remove from synced set
    const synced = new Set(loadLS(LS_WORKOUT_SYNCED_KEY) || []);
    synced.delete(sessionId);
    saveLS(LS_WORKOUT_SYNCED_KEY, [...synced]);
    // Add to tombstone set so the merge never re-adds it from Supabase
    const deleted = new Set(loadLS(LS_WORKOUT_DELETED_KEY) || []);
    deleted.add(sessionId);
    saveLS(LS_WORKOUT_DELETED_KEY, [...deleted]);
    // Best-effort delete from Supabase
    deleteWorkoutSession(sessionId);
    setConfirmDeleteId(null);
    setTick(t => t + 1);
  };

  if (!log.length) return (
    <div style={{ textAlign: "center", color: C.muted, marginTop: 60, fontSize: 15 }}>
      No workout sessions yet — start a workout!
    </div>
  );

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginBottom: 8 }}>
        {bodyWeight != null && (
          <button onClick={() => setRelMode(r => !r)} style={{
            padding: "5px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer", border: "none",
            background: relMode ? C.purple : C.border,
            color: relMode ? "#fff" : C.muted, fontWeight: relMode ? 700 : 400,
          }}>% BW</button>
        )}
        <Btn small onClick={() => downloadWorkoutCSV(log)} color={C.muted}>↓ CSV</Btn>
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        {measurableExIds.map(id => (
          <button key={id} onClick={() => setFilterEx(filterEx === id ? "" : id)} style={{
            padding: "4px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer",
            background: filterEx === id ? C.orange : C.border,
            color: filterEx === id ? "#fff" : C.muted, border: "none",
          }}>{exNames[id] || id}</button>
        ))}
        {[30, 60, 90].map(days => (
          <button key={days} onClick={() => setFilterDays(filterDays === days ? 0 : days)} style={{
            padding: "4px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer",
            background: filterDays === days ? C.blue : C.border,
            color: filterDays === days ? "#fff" : C.muted, border: "none",
          }}>{days}d</button>
        ))}
      </div>

      {sorted.length === 0 && (
        <div style={{ textAlign: "center", color: C.muted, marginTop: 40, fontSize: 15 }}>
          No sessions match these filters.
        </div>
      )}

      {sorted.map((session) => {
        const { origIdx } = session;
        const isEditing = editIdx === origIdx;
        const wkDef = DEFAULT_WORKOUTS[session.workout] || {};

        return (
          <Card key={origIdx} style={{ marginBottom: 10 }}>
            {/* Session header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div>
                <span style={{ fontWeight: 700, fontSize: 15 }}>Workout {session.workout}</span>
                {wkDef.name && !isEditing && (
                  <span style={{ marginLeft: 8, fontSize: 12, color: C.muted }}>{wkDef.name}</span>
                )}
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {session.sessionNumber && !isEditing && (
                  <span style={{ fontSize: 11, color: C.muted }}>#{session.sessionNumber}</span>
                )}
                <span style={{ fontSize: 12, color: C.muted }}>
                  {session.date}{session.completedAt ? " · " + fmtClock(session.completedAt) : ""}
                  {(() => { const e = bwOnDate(bwLog, session.date); return e ? " · " + fmt1(toDisp(e.kg, unit)) + " " + unit : ""; })()}
                </span>
                <span
                  title={session.id && syncedIds.has(session.id) ? "Synced to cloud" : "Local only — not yet synced"}
                  style={{ fontSize: 13, opacity: 0.7 }}
                >
                  {session.id && syncedIds.has(session.id) ? "☁️" : "📱"}
                </span>
                {!isEditing && confirmDeleteId !== session.id && (
                  <button
                    onClick={() => { setEditIdx(origIdx); setEditWorkout(session.workout); }}
                    style={{ background: "none", border: "none", color: C.muted, fontSize: 13, cursor: "pointer", padding: "0 2px", lineHeight: 1 }}
                    title="Edit workout type"
                  >✏️</button>
                )}
                {!isEditing && confirmDeleteId !== session.id && (
                  <button
                    onClick={() => setConfirmDeleteId(session.id)}
                    style={{ background: "none", border: "none", color: C.muted, fontSize: 13, cursor: "pointer", padding: "0 2px", lineHeight: 1 }}
                    title="Delete session"
                  >🗑</button>
                )}
                {confirmDeleteId === session.id && (
                  <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span style={{ fontSize: 12, color: C.red }}>Delete?</span>
                    <button onClick={() => deleteSession(session.id)} style={{
                      background: C.red, border: "none", borderRadius: 6, color: "#fff",
                      fontSize: 12, fontWeight: 700, padding: "3px 10px", cursor: "pointer",
                    }}>Yes</button>
                    <button onClick={() => setConfirmDeleteId(null)} style={{
                      background: C.border, border: "none", borderRadius: 6, color: C.muted,
                      fontSize: 12, padding: "3px 8px", cursor: "pointer",
                    }}>No</button>
                  </span>
                )}
              </div>
            </div>

            {/* Edit: reclassify workout type */}
            {isEditing && (
              <div style={{ marginBottom: 12, padding: 10, background: C.bg, borderRadius: 8 }}>
                <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>Change workout type:</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                  {Object.keys(DEFAULT_WORKOUTS).map(key => (
                    <button key={key} onClick={() => setEditWorkout(key)} style={{
                      padding: "6px 12px", borderRadius: 8, border: "none", cursor: "pointer",
                      fontWeight: 700, fontSize: 13, textAlign: "center",
                      background: editWorkout === key ? C.blue : C.border,
                      color: editWorkout === key ? "#fff" : C.muted,
                    }}>
                      <div>{key}</div>
                      <div style={{ fontSize: 9, fontWeight: 400, marginTop: 1, opacity: 0.8 }}>
                        {DEFAULT_WORKOUTS[key]?.name || ""}
                      </div>
                    </button>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => saveEdit(origIdx)} style={{
                    background: C.green, border: "none", borderRadius: 6, color: "#000",
                    fontSize: 12, fontWeight: 700, padding: "5px 14px", cursor: "pointer",
                  }}>Save</button>
                  <button onClick={() => { setEditIdx(null); setEditWorkout(null); }} style={{
                    background: C.border, border: "none", borderRadius: 6, color: C.muted,
                    fontSize: 12, padding: "5px 10px", cursor: "pointer",
                  }}>Cancel</button>
                </div>
              </div>
            )}

            {/* Exercises — render all that have actual data, regardless of workout definition */}
            {Object.entries(session.exercises || {}).map(([id, data]) => {
              const exName = exNames[id] || id.replace(/_/g, " ");

              if (data.sets && data.sets.length) {
                const anyDone = data.sets.some(s => s.done);
                if (!anyDone) return null;
                return (
                  <div key={id} style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 12, color: C.muted, marginBottom: 4 }}>{exName}</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {data.sets.map((s, si) => (
                        <span key={si} style={{
                          padding: "3px 10px", borderRadius: 7, fontSize: 12,
                          background: s.done ? "#1a2f1a" : C.border,
                          border: `1px solid ${s.done ? C.green : C.border}`,
                          color: s.done ? C.text : C.muted,
                        }}>
                          {(() => {
                            if (!s.weight) return "—";
                            const w = parseFloat(s.weight);
                            if (relMode && bodyWeight != null && bodyWeight > 0) {
                              const bwDisp = toDisp(bodyWeight, unit);
                              const pct = Math.round((w / bwDisp) * 100);
                              return `${w >= bwDisp ? "+" : ""}${pct}% BW`;
                            }
                            return `${s.weight} ${unit}`;
                          })()}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              }

              if (data.done) {
                return (
                  <div key={id} style={{ fontSize: 12, color: C.muted, marginBottom: 3 }}>
                    <span style={{ color: C.green, marginRight: 5 }}>✓</span>{exName}
                  </div>
                );
              }
              return null;
            })}
          </Card>
        );
      })}
    </div>
  );
}

function HistoryView({ history, onDownload, unit = "lbs", bodyWeight = null, onDeleteSession, onUpdateSession, onDeleteRep, onUpdateRep, onAddRep, notes = {}, onNoteChange }) {
  const [domain,      setDomain]      = useState(() => loadLS(LS_HISTORY_DOMAIN_KEY) || "fingers");
  const switchDomain = (d) => { setDomain(d); saveLS(LS_HISTORY_DOMAIN_KEY, d); };
  const [grip,        setGrip]        = useState("");
  const [hand,        setHand]        = useState("");
  const [target,      setTarget]      = useState(0);
  const [confirmKey,  setConfirmKey]  = useState(null);
  const [editKey,     setEditKey]     = useState(null);
  const [editHand,    setEditHand]    = useState("L");
  const [editGrip,    setEditGrip]    = useState("");
  const [editTarget,  setEditTarget]  = useState(null); // target_duration seconds
  const [noteKey,     setNoteKey]     = useState(null); // session currently showing note editor
  // Per-rep editing
  const [repEditMode, setRepEditMode] = useState(null);        // sessKey with reps in edit mode
  const [editingRep,  setEditingRep]  = useState(null);        // { sessKey, repIdx, rep }
  const [addingRep,   setAddingRep]   = useState(null);        // sessKey being added to
  const [editRepLoad, setEditRepLoad] = useState("");          // display-unit load (edit or add)
  const [editRepTime, setEditRepTime] = useState("");          // seconds (edit or add)
  // Manual session entry
  const [addingSession,    setAddingSession]    = useState(false);
  const [newSessDate,      setNewSessDate]      = useState(() => new Date().toISOString().slice(0, 10));
  const [newSessGrip,      setNewSessGrip]      = useState("");
  const [newSessTarget,    setNewSessTarget]    = useState(TARGET_OPTIONS[0].seconds);
  const [newSessReps,      setNewSessReps]      = useState([]);  // [{ load, time, hand }]
  const [newRepLoad,       setNewRepLoad]       = useState("");
  const [newRepTime,       setNewRepTime]       = useState("");

  const openRepEdit = (sessKey, repIdx, rep) => {
    setAddingRep(null);
    setEditingRep({ sessKey, repIdx, rep });
    setEditRepLoad(String(fmt1(toDisp(effectiveLoad(rep), unit))));
    setEditRepTime(String(rep.actual_time_s));
  };
  const closeRepEdit = () => { setEditingRep(null); setAddingRep(null); };

  const saveRepEdit = () => {
    if (!editingRep) return;
    const loadKg = fromDisp(parseFloat(editRepLoad), unit);
    const updates = { actual_time_s: parseFloat(editRepTime) };
    if (editingRep.rep.avg_force_kg > 0) updates.avg_force_kg = loadKg;
    else updates.weight_kg = loadKg;
    onUpdateRep(editingRep.rep, updates);
    closeRepEdit();
  };

  const openRepAdd = (sessKey) => {
    setEditingRep(null);
    setAddingRep(sessKey);
    setEditRepLoad("");
    setEditRepTime("");
  };

  const saveRepAdd = (sess) => {
    const loadKg = fromDisp(parseFloat(editRepLoad), unit);
    const time   = parseFloat(editRepTime);
    if (!loadKg || !time) return;
    const existingReps = sess.reps;
    const maxRepNum = existingReps.length
      ? Math.max(...existingReps.map(r => r.rep_num || 0))
      : 0;
    const maxSetNum = existingReps.length
      ? Math.max(...existingReps.map(r => r.set_num || 1))
      : 1;
    const sessionId = existingReps[0]?.session_id || null;
    // Derive hand for the new rep:
    //  - Single-hand session: use sess.hand
    //  - Mixed/Both session: alternate from last rep's hand (fallback L)
    let newHand = sess.hand;
    if (sess.hand === "B") {
      const lastHand = existingReps.length ? existingReps[existingReps.length - 1].hand : null;
      newHand = lastHand === "L" ? "R" : "L";
    }
    const newRep = {
      date:            sess.date,
      grip:            sess.grip,
      hand:            newHand,
      target_duration: sess.target_duration,
      actual_time_s:   time,
      avg_force_kg:    loadKg,
      weight_kg:       loadKg,
      peak_force_kg:   0,
      set_num:         maxSetNum,
      rep_num:         maxRepNum + 1,
      rest_s:          0,
      session_id:      sessionId,
      failed:          time < sess.target_duration,
    };
    onAddRep(newRep);
    closeRepEdit();
  };

  const saveNewSession = () => {
    if (!newSessGrip || newSessReps.length === 0) return;
    const genId = () => { try { return crypto.randomUUID(); } catch { return `mr_${Date.now()}_${Math.random().toString(36).slice(2,9)}_${Math.random().toString(36).slice(2,5)}`; } };
    const sessionId = genId();
    const reps = newSessReps.map((r, i) => {
      const loadKg = fromDisp(parseFloat(r.load), unit);
      return {
        id:              genId(),   // unique id so addReps dedup doesn't drop reps 2+
        date:            newSessDate,
        grip:            newSessGrip,
        hand:            r.hand || (i % 2 === 0 ? "L" : "R"),
        target_duration: newSessTarget,
        actual_time_s:   parseFloat(r.time),
        avg_force_kg:    loadKg,
        weight_kg:       loadKg,
        peak_force_kg:   0,
        set_num:         1,
        rep_num:         i + 1,
        rest_s:          0,
        session_id:      sessionId,
        failed:          parseFloat(r.time) < newSessTarget,
      };
    });
    // Pass all reps at once so addReps dedupes against the original state, not incremental updates
    onAddRep(reps);
    setAddingSession(false);
    setNewSessReps([]);
    setNewSessGrip("");
    setNewRepLoad(""); setNewRepTime("");
  };

  const bwLog = useMemo(() => loadLS(LS_BW_LOG_KEY) || [], []); // eslint-disable-line react-hooks/exhaustive-deps

  const grips = useMemo(() => [...new Set(history.map(r => r.grip).filter(Boolean))].sort(), [history]);

  const filtered = useMemo(() => history.filter(r =>
    (!grip   || r.grip === grip) &&
    (!hand   || r.hand === hand || r.hand === "B") &&  // "Both" sessions visible under any hand filter
    (!target || r.target_duration === target)
  ), [history, grip, hand, target]);

  // Group by session_id then date. Derive `hand` from the union of rep hands,
  // so a Both-mode session with L and R reps shows "Both" (not just the first rep's hand).
  const grouped = useMemo(() => {
    const map = {};
    for (const r of filtered) {
      const key = r.session_id || r.date;
      if (!map[key]) map[key] = { date: r.date, grip: r.grip, hand: r.hand, target_duration: r.target_duration, reps: [] };
      map[key].reps.push(r);
    }
    for (const sess of Object.values(map)) {
      const hands = new Set(sess.reps.map(r => r.hand).filter(Boolean));
      if (hands.has("L") && hands.has("R")) sess.hand = "B";
      else if (hands.has("L")) sess.hand = "L";
      else if (hands.has("R")) sess.hand = "R";
      // else leave the original (covers legacy "B" and empty)
    }
    return Object.values(map).sort((a, b) => a.date < b.date ? 1 : -1);
  }, [filtered]);

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>History</h2>
        <div style={{ display: "flex", gap: 8 }}>
          {domain === "fingers" && <Btn small onClick={() => { setAddingSession(s => !s); setNewSessDate(new Date().toISOString().slice(0, 10)); setNewSessGrip(""); setNewSessTarget(TARGET_OPTIONS[0].seconds); setNewSessReps([]); setNewRepLoad(""); setNewRepTime(""); }} color={addingSession ? C.red : C.green}>＋ Session</Btn>}
          {domain === "fingers" && <Btn small onClick={onDownload} color={C.muted}>↓ CSV</Btn>}
        </div>
      </div>

      {/* ── Add Session form ── */}
      {domain === "fingers" && addingSession && (
        <Card style={{ marginBottom: 16, background: "#0d1f0d" }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10, color: C.green }}>New session</div>
          {/* Date */}
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
            <span style={{ fontSize: 12, color: C.muted, width: 40 }}>Date</span>
            <input type="date" value={newSessDate} onChange={e => setNewSessDate(e.target.value)}
              style={{ flex: 1, background: C.border, border: "none", borderRadius: 6, padding: "4px 8px", color: C.text, fontSize: 13 }} />
          </div>
          {/* Grip */}
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
            <span style={{ fontSize: 12, color: C.muted, width: 40 }}>Grip</span>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", flex: 1 }}>
              {GRIP_PRESETS.map(g => (
                <button key={g} onClick={() => setNewSessGrip(g)} style={{
                  padding: "4px 10px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 12,
                  background: newSessGrip === g ? C.orange : C.border,
                  color: newSessGrip === g ? "#fff" : C.muted,
                }}>{g}</button>
              ))}
              <input value={newSessGrip} onChange={e => setNewSessGrip(e.target.value)}
                placeholder="or type…"
                style={{ flex: 1, minWidth: 70, background: C.border, border: "none", borderRadius: 6, padding: "4px 8px", color: C.text, fontSize: 12 }} />
            </div>
          </div>
          {/* Zone */}
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
            <span style={{ fontSize: 12, color: C.muted, width: 40 }}>Zone</span>
            <div style={{ display: "flex", gap: 4 }}>
              {TARGET_OPTIONS.map(o => (
                <button key={o.seconds} onClick={() => setNewSessTarget(o.seconds)} style={{
                  padding: "4px 10px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600,
                  background: newSessTarget === o.seconds ? C.blue : C.border,
                  color: newSessTarget === o.seconds ? "#fff" : C.muted,
                }}>{o.label}</button>
              ))}
            </div>
          </div>
          {/* Reps list */}
          {newSessReps.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>Reps added — tap L/R to flip</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {newSessReps.map((r, i) => (
                  <span key={i} style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 8px", borderRadius: 7, fontSize: 12, background: "#1a2f1a", border: `1px solid ${C.green}`, color: C.text }}>
                    <button onClick={() => setNewSessReps(rs => rs.map((x, j) => j === i ? { ...x, hand: x.hand === "L" ? "R" : "L" } : x))}
                      style={{
                        background: r.hand === "L" ? C.purple : C.orange,
                        border: "none", borderRadius: 4,
                        color: "#fff", fontWeight: 700, fontSize: 10,
                        padding: "1px 5px", cursor: "pointer", lineHeight: 1.2,
                      }}>{r.hand}</button>
                    {r.load}{unit} · {r.time}s
                    <button onClick={() => setNewSessReps(rs => rs.filter((_, j) => j !== i))}
                      style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 11, padding: 0, lineHeight: 1 }}>✕</button>
                  </span>
                ))}
              </div>
            </div>
          )}
          {/* Add rep row */}
          <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 12 }}>
            <input type="number" value={newRepLoad} onChange={e => setNewRepLoad(e.target.value)}
              placeholder={`Load (${unit})`}
              style={{ flex: 1, background: C.border, border: "none", borderRadius: 6, padding: "5px 8px", color: C.text, fontSize: 13 }} />
            <input type="number" value={newRepTime} onChange={e => setNewRepTime(e.target.value)}
              placeholder="Time (s)"
              style={{ flex: 1, background: C.border, border: "none", borderRadius: 6, padding: "5px 8px", color: C.text, fontSize: 13 }} />
            <button onClick={() => {
              if (!newRepLoad || !newRepTime) return;
              // Alternate L/R default: first rep L, then flip from last rep's hand
              const lastHand = newSessReps.length ? newSessReps[newSessReps.length - 1].hand : null;
              const nextHand = lastHand === "L" ? "R" : "L";
              setNewSessReps(rs => [...rs, { load: newRepLoad, time: newRepTime, hand: nextHand }]);
              setNewRepLoad(""); setNewRepTime("");
            }} style={{
              background: C.green, border: "none", borderRadius: 6, color: "#000",
              fontWeight: 700, fontSize: 13, padding: "5px 12px", cursor: "pointer",
            }}>＋ Rep</button>
          </div>
          {/* Save / Cancel */}
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={saveNewSession} disabled={!newSessGrip || newSessReps.length === 0} style={{
              background: (!newSessGrip || newSessReps.length === 0) ? C.border : C.green,
              border: "none", borderRadius: 6, color: (!newSessGrip || newSessReps.length === 0) ? C.muted : "#000",
              fontSize: 13, fontWeight: 700, padding: "6px 16px", cursor: "pointer",
            }}>Save session</button>
            <button onClick={() => { setAddingSession(false); setNewSessReps([]); }} style={{
              background: C.border, border: "none", borderRadius: 6, color: C.muted,
              fontSize: 13, padding: "6px 12px", cursor: "pointer",
            }}>Cancel</button>
          </div>
        </Card>
      )}

      {/* Domain toggle */}
      <div style={{ display: "flex", background: C.border, borderRadius: 24, padding: 3, marginBottom: 20, gap: 2 }}>
        {[["fingers", "🖐 Fingers"], ["workout", "🏋️ Workout"]].map(([key, label]) => (
          <button key={key} onClick={() => switchDomain(key)} style={{
            flex: 1, padding: "8px 0", borderRadius: 20, border: "none", cursor: "pointer",
            fontWeight: 700, fontSize: 13,
            background: domain === key ? C.blue : "transparent",
            color: domain === key ? "#fff" : C.muted,
            transition: "background 0.15s",
          }}>{label}</button>
        ))}
      </div>

      {domain === "workout" && <WorkoutHistoryView unit={unit} bodyWeight={bodyWeight} />}
      {domain === "fingers" && <>

      {/* Filters */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        {grips.map(g => (
          <button key={g} onClick={() => setGrip(grip === g ? "" : g)} style={{
            padding: "4px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer",
            background: grip === g ? C.orange : C.border,
            color: grip === g ? "#fff" : C.muted, border: "none",
          }}>{g}</button>
        ))}
        {["L","R"].map(h => (
          <button key={h} onClick={() => setHand(hand === h ? "" : h)} style={{
            padding: "4px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer",
            background: hand === h ? C.purple : C.border,
            color: hand === h ? "#fff" : C.muted, border: "none",
          }}>{h === "L" ? "Left" : "Right"}</button>
        ))}
        {TARGET_OPTIONS.map(o => (
          <button key={o.seconds} onClick={() => setTarget(target === o.seconds ? 0 : o.seconds)} style={{
            padding: "4px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer",
            background: target === o.seconds ? C.blue : C.border,
            color: target === o.seconds ? "#fff" : C.muted, border: "none",
          }}>{o.label}</button>
        ))}
      </div>

      {grouped.length === 0 && (
        <div style={{ textAlign: "center", color: C.muted, marginTop: 60, fontSize: 15 }}>
          No sessions yet — start training!
        </div>
      )}

      {grouped.slice(0, 30).map((sess, i) => {
        const sessKey = sess.reps[0]?.session_id || sess.date;
        const isConfirming = confirmKey === sessKey;
        const isEditing    = editKey    === sessKey;
        return (
          <Card key={i} style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
              <div>
                <b>{sess.grip}</b>
                <span style={{ marginLeft: 8, fontSize: 12, color: C.muted }}>
                  {sess.hand === "L" ? "Left" : sess.hand === "R" ? "Right" : "L + R"}
                  {" · "}{TARGET_OPTIONS.find(o => o.seconds === sess.target_duration)?.label ?? sess.target_duration + "s"}
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12, color: C.muted }}>
                  {sess.date}{sess.reps[0]?.session_started_at ? " · " + fmtClock(sess.reps[0].session_started_at) : ""}
                  {(() => { const e = bwOnDate(bwLog, sess.date); return e ? " · " + fmt1(toDisp(e.kg, unit)) + " " + unit : ""; })()}
                </span>
                {!isConfirming && !isEditing && (
                  <>
                    <button
                      onClick={() => setNoteKey(noteKey === sessKey ? null : sessKey)}
                      style={{
                        background: "none", border: "none",
                        color: notes[sessKey] ? C.yellow : C.muted,
                        fontSize: 13, cursor: "pointer", padding: "0 2px", lineHeight: 1,
                      }}
                      title={notes[sessKey] ? "View/edit note" : "Add note"}
                    >📝</button>
                    <button onClick={() => { setEditKey(sessKey); setEditHand(sess.hand); setEditGrip(sess.grip); setEditTarget(sess.target_duration); setConfirmKey(null); setNoteKey(null); }} style={{
                      background: "none", border: "none", color: C.muted,
                      fontSize: 13, cursor: "pointer", padding: "0 2px", lineHeight: 1,
                    }} title="Edit session">✏️</button>
                    <button onClick={() => { setConfirmKey(sessKey); setEditKey(null); setNoteKey(null); }} style={{
                      background: "none", border: "none", color: C.muted,
                      fontSize: 14, cursor: "pointer", padding: "0 2px", lineHeight: 1,
                    }} title="Delete session">🗑</button>
                  </>
                )}
                {isConfirming && (
                  <>
                    <button onClick={() => { onDeleteSession(sessKey); setConfirmKey(null); }} style={{
                      background: C.red, border: "none", borderRadius: 6, color: "#fff",
                      fontSize: 11, fontWeight: 700, padding: "3px 8px", cursor: "pointer",
                    }}>Delete</button>
                    <button onClick={() => setConfirmKey(null)} style={{
                      background: C.border, border: "none", borderRadius: 6, color: C.muted,
                      fontSize: 11, padding: "3px 8px", cursor: "pointer",
                    }}>Cancel</button>
                  </>
                )}
              </div>
            </div>

            {/* Edit UI */}
            {isEditing && (
              <div style={{ marginBottom: 10, padding: 10, background: C.bg, borderRadius: 8 }}>
                {/* Row 1: hand + grip */}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
                  <div style={{ display: "flex", gap: 4 }}>
                    {["L","R","B"].map(h => (
                      <button key={h} onClick={() => setEditHand(h)} style={{
                        padding: "4px 10px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600,
                        background: editHand === h ? C.purple : C.border,
                        color: editHand === h ? "#fff" : C.muted,
                      }}>{h === "L" ? "Left" : h === "R" ? "Right" : "Both"}</button>
                    ))}
                  </div>
                  <input
                    value={editGrip}
                    onChange={e => setEditGrip(e.target.value)}
                    placeholder="Grip type"
                    style={{ flex: 1, minWidth: 80, background: C.border, border: "none", borderRadius: 6, padding: "4px 8px", color: C.text, fontSize: 12 }}
                  />
                </div>
                {/* Row 2: zone / target duration */}
                <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
                  {TARGET_OPTIONS.map(o => (
                    <button key={o.seconds} onClick={() => setEditTarget(o.seconds)} style={{
                      padding: "4px 12px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600,
                      background: editTarget === o.seconds ? C.blue : C.border,
                      color: editTarget === o.seconds ? "#fff" : C.muted,
                    }}>{o.label}</button>
                  ))}
                </div>
                {/* Row 3: save / cancel */}
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => { onUpdateSession(sessKey, { hand: editHand, grip: editGrip, target_duration: editTarget }); setEditKey(null); }} style={{
                    background: C.green, border: "none", borderRadius: 6, color: "#000",
                    fontSize: 11, fontWeight: 700, padding: "4px 10px", cursor: "pointer",
                  }}>Save</button>
                  <button onClick={() => setEditKey(null)} style={{
                    background: C.border, border: "none", borderRadius: 6, color: C.muted,
                    fontSize: 11, padding: "4px 8px", cursor: "pointer",
                  }}>Cancel</button>
                </div>
              </div>
            )}

            {/* Edit-reps toggle */}
            {!isEditing && !isConfirming && (
              <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
                <button
                  onClick={() => { setRepEditMode(repEditMode === sessKey ? null : sessKey); closeRepEdit(); }}
                  style={{
                    background: "none", border: `1px solid ${repEditMode === sessKey ? C.red : C.border}`,
                    color: repEditMode === sessKey ? C.red : C.muted,
                    borderRadius: 12, padding: "2px 10px", fontSize: 11, cursor: "pointer",
                  }}
                >{repEditMode === sessKey ? "Done" : "Edit reps"}</button>
              </div>
            )}

            {/* Rep chips */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {sess.reps.sort((a, b) => a.set_num - b.set_num || a.rep_num - b.rep_num).map((r, j) => {
                const isRepEditing = editingRep?.sessKey === sessKey && editingRep?.repIdx === j;
                const passed = r.actual_time_s >= sess.target_duration;
                // Show hand badge only on mixed (Both) sessions — single-hand sessions already say "Left"/"Right" in the header
                const showHandBadge = sess.hand === "B" && (r.hand === "L" || r.hand === "R");
                return (
                  <div key={j} style={{ position: "relative", display: "inline-flex", alignItems: "center", gap: 0 }}>
                    <div
                      onClick={() => repEditMode === sessKey && !isRepEditing && openRepEdit(sessKey, j, r)}
                      style={{
                        padding: "4px 10px", borderRadius: 8, fontSize: 12,
                        background: isRepEditing ? C.blue + "33" : passed ? "#1a2f1a" : "#2f1a1a",
                        border: `1px solid ${isRepEditing ? C.blue : passed ? C.green : C.red}`,
                        cursor: repEditMode === sessKey ? "pointer" : "default",
                        paddingRight: repEditMode === sessKey ? 22 : 10,
                      }}
                    >
                      {showHandBadge && (
                        <span style={{
                          display: "inline-block", marginRight: 6,
                          padding: "1px 5px", borderRadius: 4,
                          fontSize: 10, fontWeight: 700,
                          background: r.hand === "R" ? C.orange + "33" : C.blue + "33",
                          color:      r.hand === "R" ? C.orange : C.blue,
                        }}>{r.hand}</span>
                      )}
                      <b>{fmtW(effectiveLoad(r), unit)}{unit}</b> · {fmtTime(r.actual_time_s)}
                    </div>
                    {repEditMode === sessKey && (
                      <button
                        onClick={() => onDeleteRep(r)}
                        title="Delete this rep"
                        style={{
                          position: "absolute", right: 3, top: "50%", transform: "translateY(-50%)",
                          background: C.red, color: "#fff", border: "none", borderRadius: "50%",
                          width: 16, height: 16, fontSize: 10, lineHeight: "16px", textAlign: "center",
                          cursor: "pointer", padding: 0, fontWeight: 700,
                        }}
                      >×</button>
                    )}
                  </div>
                );
              })}
            </div>

            {/* + Add rep button */}
            {repEditMode === sessKey && !editingRep && addingRep !== sessKey && (
              <button
                onClick={() => openRepAdd(sessKey)}
                style={{
                  marginTop: 8, width: "100%", padding: "6px 0",
                  background: "none", border: `1px dashed ${C.border}`,
                  color: C.muted, borderRadius: 8, fontSize: 12, cursor: "pointer",
                }}
              >+ Add rep</button>
            )}

            {/* Inline rep editor / adder */}
            {(editingRep?.sessKey === sessKey || addingRep === sessKey) && (
              <div style={{ marginTop: 10, padding: 10, background: C.bg, borderRadius: 8 }}>
                <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>
                  {addingRep === sessKey ? "Add rep" : "Edit rep"}
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 8 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <label style={{ fontSize: 10, color: C.muted }}>Load ({unit})</label>
                    <input
                      autoFocus
                      type="number"
                      value={editRepLoad}
                      onChange={e => setEditRepLoad(e.target.value)}
                      style={{ width: 80, background: C.border, border: "none", borderRadius: 6, padding: "4px 8px", color: C.text, fontSize: 13 }}
                    />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <label style={{ fontSize: 10, color: C.muted }}>Time (s)</label>
                    <input
                      type="number"
                      value={editRepTime}
                      onChange={e => setEditRepTime(e.target.value)}
                      style={{ width: 60, background: C.border, border: "none", borderRadius: 6, padding: "4px 8px", color: C.text, fontSize: 13 }}
                    />
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={() => addingRep === sessKey ? saveRepAdd(sess) : saveRepEdit()}
                    style={{
                      background: C.green, border: "none", borderRadius: 6, color: "#000",
                      fontSize: 11, fontWeight: 700, padding: "4px 10px", cursor: "pointer",
                    }}
                  >Save</button>
                  <button onClick={closeRepEdit} style={{
                    background: C.border, border: "none", borderRadius: 6, color: C.muted,
                    fontSize: 11, padding: "4px 8px", cursor: "pointer",
                  }}>Cancel</button>
                </div>
              </div>
            )}

            {/* Note preview (when note exists and editor is closed) */}
            {notes[sessKey] && noteKey !== sessKey && (
              <div style={{
                marginTop: 10, padding: "7px 10px",
                background: "#1f1a00", borderRadius: 7,
                fontSize: 12, color: C.yellow, lineHeight: 1.5,
                borderLeft: `3px solid ${C.yellow}`,
              }}>
                📝 {notes[sessKey]}
              </div>
            )}

            {/* Note editor */}
            {noteKey === sessKey && (
              <div style={{ marginTop: 10 }}>
                <textarea
                  autoFocus
                  value={notes[sessKey] || ""}
                  onChange={e => onNoteChange(sessKey, e.target.value)}
                  placeholder="Add a note — how did it feel? Any context?"
                  rows={3}
                  style={{
                    width: "100%", boxSizing: "border-box",
                    background: "#1f1a00", border: `1px solid ${C.yellow}55`,
                    borderRadius: 7, padding: "8px 10px",
                    color: C.text, fontSize: 12, lineHeight: 1.5,
                    resize: "vertical",
                  }}
                />
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 6 }}>
                  {notes[sessKey] && (
                    <button onClick={() => { onNoteChange(sessKey, ""); setNoteKey(null); }} style={{
                      background: "none", border: `1px solid ${C.border}`,
                      color: C.muted, borderRadius: 6, padding: "3px 10px", fontSize: 11, cursor: "pointer",
                    }}>Clear</button>
                  )}
                  <button onClick={() => setNoteKey(null)} style={{
                    background: C.yellow, border: "none",
                    color: "#000", borderRadius: 6, padding: "3px 12px", fontSize: 11,
                    fontWeight: 700, cursor: "pointer",
                  }}>Done</button>
                </div>
              </div>
            )}
          </Card>
        );
      })}
      </>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// TRENDS VIEW
// ─────────────────────────────────────────────────────────────
// ── Workout strength-trend sub-view ──────────────────────────
function WorkoutTrendsView({ unit = "lbs" }) {
  // Always read fresh from localStorage
  const wLog = useMemo(() => loadLS(LS_WORKOUT_LOG_KEY) || [], []); // eslint-disable-line react-hooks/exhaustive-deps
  // All exercises that have logged weight data
  const exerciseOptions = useMemo(() => {
    const seen = new Map(); // id → name
    for (const session of wLog) {
      for (const [id, data] of Object.entries(session.exercises || {})) {
        if (data.sets && data.sets.some(s => s.weight && s.done)) {
          if (!seen.has(id)) {
            let name = id.replace(/_/g, " ");
            for (const wk of Object.values(DEFAULT_WORKOUTS)) {
              const ex = (wk.exercises || []).find(e => e.id === id);
              if (ex && ex.name) { name = ex.name; break; }
            }
            seen.set(id, name);
          }
        }
      }
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }, [wLog]);

  const [selEx, setSelEx] = useState(null);
  // Auto-select first available exercise
  const activeEx = selEx && exerciseOptions.find(e => e.id === selEx) ? selEx : (exerciseOptions[0]?.id || null);

  const chartData = useMemo(() => {
    if (!activeEx) return [];
    const points = [];
    for (const session of wLog) {
      const exData = session.exercises?.[activeEx];
      if (!exData?.sets) continue;
      const weights = exData.sets
        .filter(s => s.done && s.weight)
        .map(s => parseFloat(s.weight))
        .filter(w => !isNaN(w) && w > 0);
      if (!weights.length) continue;
      const maxW = Math.max(...weights);
      const dispW = unit === "kg" ? Math.round(maxW / 2.205 * 10) / 10 : maxW;
      points.push({ date: session.date, max: dispW, workout: session.workout });
    }
    points.sort((a, b) => a.date < b.date ? -1 : 1);
    let pr = -Infinity;
    return points.map(p => {
      const isPR = p.max > pr;
      if (isPR) pr = p.max;
      return { ...p, isPR };
    });
  }, [wLog, activeEx, unit]);

  const currentPR = useMemo(() => [...chartData].filter(d => d.isPR).slice(-1)[0], [chartData]);

  if (!exerciseOptions.length) return (
    <div style={{ textAlign: "center", color: C.muted, marginTop: 60, fontSize: 14 }}>
      Complete a workout session to see strength trends.
    </div>
  );

  return (
    <div>
      {/* Exercise selector */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        {exerciseOptions.map(ex => (
          <button key={ex.id} onClick={() => setSelEx(ex.id)} style={{
            padding: "6px 14px", borderRadius: 20, cursor: "pointer", fontWeight: 600, border: "none", fontSize: 12,
            background: activeEx === ex.id ? C.blue : C.border,
            color: activeEx === ex.id ? "#fff" : C.muted,
          }}>{ex.name}</button>
        ))}
      </div>

      {currentPR && (
        <Card style={{ marginBottom: 12, borderColor: C.yellow + "55" }}>
          <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
            <span style={{ fontSize: 18 }}>🏆</span>
            <div>
              <Label>Personal Record</Label>
              <span style={{ fontSize: 22, fontWeight: 800, color: C.yellow }}>
                {currentPR.max} {unit}
              </span>
              <div style={{ fontSize: 11, color: C.muted }}>{currentPR.date}</div>
            </div>
          </div>
        </Card>
      )}

      {chartData.length < 2 ? (
        <Card>
          <div style={{ color: C.muted, fontSize: 13, textAlign: "center", padding: "16px 0" }}>
            Log 2+ sessions with this exercise to see a trend line.
          </div>
        </Card>
      ) : (
        <Card>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 4 }}>
            Max weight per session · {exerciseOptions.find(e => e.id === activeEx)?.name}
          </div>
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 10 }}>
            <span style={{ color: C.yellow }}>★</span> = personal record
          </div>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
              <XAxis dataKey="date" tick={{ fill: C.muted, fontSize: 10 }} />
              <YAxis tick={{ fill: C.muted, fontSize: 11 }} unit={` ${unit}`} />
              <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, color: C.text }} />
              <Line
                type="monotone"
                dataKey="max"
                stroke={C.blue}
                strokeWidth={2}
                name="Max weight"
                connectNulls
                dot={(props) => {
                  const { cx, cy, payload } = props;
                  if (!payload.isPR) return (
                    <circle key={`dot-${cx}-${cy}`} cx={cx} cy={cy} r={2.5} fill={C.blue} opacity={0.6} />
                  );
                  return (
                    <g key={`pr-${cx}-${cy}`}>
                      <circle cx={cx} cy={cy} r={7} fill={C.yellow} opacity={0.2} />
                      <circle cx={cx} cy={cy} r={4} fill={C.yellow} />
                      <text x={cx} y={cy - 12} textAnchor="middle" fill={C.yellow} fontSize={9} fontWeight="bold">PR</text>
                    </g>
                  );
                }}
              />
            </LineChart>
          </ResponsiveContainer>
        </Card>
      )}
    </div>
  );
}

function BodyWeightTrendsView({ unit = "lbs" }) {
  const bwLog = useMemo(() => loadLS(LS_BW_LOG_KEY) || [], []); // eslint-disable-line react-hooks/exhaustive-deps
  const chartData = useMemo(() =>
    bwLog.map(e => ({ date: e.date, weight: Math.round(toDisp(e.kg, unit) * 10) / 10 })),
    [bwLog, unit]
  );
  const latest = chartData[chartData.length - 1];
  const first  = chartData[0];
  const delta  = latest && first && chartData.length > 1
    ? Math.round((latest.weight - first.weight) * 10) / 10
    : null;

  if (!chartData.length) return (
    <div style={{ textAlign: "center", color: C.muted, marginTop: 60, fontSize: 14 }}>
      Update your body weight in Settings to start tracking it here.
    </div>
  );

  return (
    <div>
      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        <Card style={{ flex: 1 }}>
          <Label>Current</Label>
          <div style={{ fontSize: 22, fontWeight: 800, color: C.text }}>
            {latest?.weight} <span style={{ fontSize: 13, fontWeight: 400, color: C.muted }}>{unit}</span>
          </div>
          <div style={{ fontSize: 11, color: C.muted }}>{latest?.date}</div>
        </Card>
        {delta != null && (
          <Card style={{ flex: 1 }}>
            <Label>Change</Label>
            <div style={{ fontSize: 22, fontWeight: 800, color: delta < 0 ? C.green : delta > 0 ? C.orange : C.muted }}>
              {delta > 0 ? "+" : ""}{delta} <span style={{ fontSize: 13, fontWeight: 400, color: C.muted }}>{unit}</span>
            </div>
            <div style={{ fontSize: 11, color: C.muted }}>since {first?.date}</div>
          </Card>
        )}
      </div>

      {chartData.length < 2 ? (
        <Card>
          <div style={{ color: C.muted, fontSize: 13, textAlign: "center", padding: "16px 0" }}>
            Log your weight again after updating it in Settings to see a trend line.
          </div>
        </Card>
      ) : (
        <Card>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 10 }}>Body weight over time</div>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
              <XAxis dataKey="date" tick={{ fill: C.muted, fontSize: 10 }} />
              <YAxis
                tick={{ fill: C.muted, fontSize: 11 }}
                unit={` ${unit}`}
                domain={["auto", "auto"]}
              />
              <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, color: C.text }} />
              <Line
                type="monotone"
                dataKey="weight"
                stroke={C.purple}
                strokeWidth={2}
                name={`Weight (${unit})`}
                dot={{ r: 4, fill: C.purple }}
                activeDot={{ r: 6 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </Card>
      )}
    </div>
  );
}

function TrendsView({ history, unit = "lbs" }) {
  const [domain, setDomain] = useState("fingers"); // "fingers" | "workout"
  const [sel,     setSel]     = useState(45);
  const [selHand, setSelHand] = useState("");   // "" = both
  const [selGrip, setSelGrip] = useState("");   // "" = all grips

  const grips = useMemo(() => [...new Set(history.map(r => r.grip).filter(Boolean))].sort(), [history]);

  const data = useMemo(() => {
    const byDate = {};
    for (const r of history.filter(r =>
      r.target_duration === sel &&
      effectiveLoad(r) > 0 &&
      (!selGrip || r.grip === selGrip)
    )) {
      const d = r.date || "";
      if (!byDate[d]) byDate[d] = { date: d, L: null, R: null };
      const load = toDisp(effectiveLoad(r), unit);
      if (r.hand === "L") byDate[d].L = Math.max(byDate[d].L ?? 0, load);
      if (r.hand === "R") byDate[d].R = Math.max(byDate[d].R ?? 0, load);
    }
    // Sort chronologically, then flag PR points
    const sorted = Object.values(byDate).sort((a, b) => a.date < b.date ? -1 : 1);
    let maxL = -Infinity, maxR = -Infinity;
    return sorted.map(d => {
      const isPR_L = d.L != null && d.L > maxL;
      const isPR_R = d.R != null && d.R > maxR;
      if (isPR_L) maxL = d.L;
      if (isPR_R) maxR = d.R;
      return { ...d, isPR_L, isPR_R };
    });
  }, [history, sel, selGrip, unit]);

  // Latest PR values for summary display
  const latestPR = useMemo(() => {
    const prsL = data.filter(d => d.isPR_L);
    const prsR = data.filter(d => d.isPR_R);
    return {
      L: prsL.length ? prsL[prsL.length - 1] : null,
      R: prsR.length ? prsR[prsR.length - 1] : null,
    };
  }, [data]);

  const lines = selHand === "L" ? [{ key: "L", color: C.blue,   name: "Left"  }]
              : selHand === "R" ? [{ key: "R", color: C.orange, name: "Right" }]
              : [{ key: "L", color: C.blue, name: "Left" }, { key: "R", color: C.orange, name: "Right" }];

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
      <h2 style={{ margin: "0 0 16px", fontSize: 22 }}>Trends</h2>

      {/* Domain toggle: Fingers / Workout / Body */}
      <div style={{ display: "flex", background: C.border, borderRadius: 24, padding: 3, marginBottom: 20, gap: 2 }}>
        {[["fingers", "🖐 Fingers"], ["workout", "🏋️ Workout"], ["body", "⚖️ Body"]].map(([key, label]) => (
          <button key={key} onClick={() => setDomain(key)} style={{
            flex: 1, padding: "8px 0", borderRadius: 20, border: "none", cursor: "pointer",
            fontWeight: 700, fontSize: 12,
            background: domain === key ? C.blue : "transparent",
            color: domain === key ? "#fff" : C.muted,
            transition: "background 0.15s",
          }}>{label}</button>
        ))}
      </div>

      {domain === "workout" && <WorkoutTrendsView unit={unit} />}
      {domain === "body"    && <BodyWeightTrendsView unit={unit} />}
      {domain === "fingers" && <>

      {/* Filters */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        {["L","R"].map(h => (
          <button key={h} onClick={() => setSelHand(selHand === h ? "" : h)} style={{
            padding: "6px 18px", borderRadius: 20, cursor: "pointer", fontWeight: 600, border: "none",
            background: selHand === h ? C.purple : C.border,
            color: selHand === h ? "#fff" : C.muted,
          }}>{h === "L" ? "Left" : "Right"}</button>
        ))}
        {TARGET_OPTIONS.map(o => (
          <button key={o.seconds} onClick={() => setSel(o.seconds)} style={{
            padding: "6px 18px", borderRadius: 20, cursor: "pointer", fontWeight: 600, border: "none",
            background: sel === o.seconds ? C.blue : C.border,
            color: sel === o.seconds ? "#fff" : C.muted,
          }}>{o.label}</button>
        ))}
      </div>
      {grips.length > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
          <button onClick={() => setSelGrip("")} style={{
            padding: "4px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer", border: "none",
            background: !selGrip ? C.orange : C.border,
            color: !selGrip ? "#fff" : C.muted,
          }}>All Grips</button>
          {grips.map(g => (
            <button key={g} onClick={() => setSelGrip(selGrip === g ? "" : g)} style={{
              padding: "4px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer", border: "none",
              background: selGrip === g ? C.orange : C.border,
              color: selGrip === g ? "#fff" : C.muted,
            }}>{g}</button>
          ))}
        </div>
      )}

      {data.length === 0 ? (
        <div style={{ textAlign: "center", color: C.muted, marginTop: 60 }}>
          No data for this filter yet.
        </div>
      ) : (
        <>
          {/* PR summary */}
          {(latestPR.L || latestPR.R) && (
            <Card style={{ marginBottom: 12, borderColor: C.yellow + "55" }}>
              <div style={{ display: "flex", gap: 24, alignItems: "center" }}>
                <span style={{ fontSize: 18 }}>🏆</span>
                {latestPR.L && (selHand === "" || selHand === "L") && (
                  <div>
                    <Label>Left PR</Label>
                    <span style={{ fontSize: 22, fontWeight: 800, color: C.yellow }}>
                      {fmt1(latestPR.L.L)} {unit}
                    </span>
                    <div style={{ fontSize: 11, color: C.muted }}>{latestPR.L.date}</div>
                  </div>
                )}
                {latestPR.R && (selHand === "" || selHand === "R") && (
                  <div>
                    <Label>Right PR</Label>
                    <span style={{ fontSize: 22, fontWeight: 800, color: C.yellow }}>
                      {fmt1(latestPR.R.R)} {unit}
                    </span>
                    <div style={{ fontSize: 11, color: C.muted }}>{latestPR.R.date}</div>
                  </div>
                )}
              </div>
            </Card>
          )}

          <Card>
            <div style={{ fontSize: 13, color: C.muted, marginBottom: 4 }}>
              Best daily load · {TARGET_OPTIONS.find(o => o.seconds === sel)?.label}
              {selGrip ? ` · ${selGrip}` : ""}
            </div>
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 10 }}>
              <span style={{ color: C.yellow }}>★</span> = personal record
            </div>
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={data}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis dataKey="date" tick={{ fill: C.muted, fontSize: 10 }} />
                <YAxis tick={{ fill: C.muted, fontSize: 11 }} unit={` ${unit}`} />
                <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, color: C.text }} />
                <Legend />
                {lines.map(l => (
                  <Line
                    key={l.key}
                    type="monotone"
                    dataKey={l.key}
                    stroke={l.color}
                    strokeWidth={2}
                    name={l.name}
                    connectNulls
                    dot={(props) => {
                      const { cx, cy, payload } = props;
                      const isPR = l.key === "L" ? payload.isPR_L : payload.isPR_R;
                      const val  = payload[l.key];
                      if (val == null) return null;
                      if (!isPR) return (
                        <circle key={`dot-${cx}-${cy}`} cx={cx} cy={cy} r={2.5} fill={l.color} opacity={0.6} />
                      );
                      return (
                        <g key={`pr-${cx}-${cy}`}>
                          <circle cx={cx} cy={cy} r={7} fill={C.yellow} opacity={0.2} />
                          <circle cx={cx} cy={cy} r={4} fill={C.yellow} />
                          <text x={cx} y={cy - 12} textAnchor="middle" fill={C.yellow} fontSize={9} fontWeight="bold">PR</text>
                        </g>
                      );
                    }}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </Card>
        </>
      )}
      </>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// ANALYSIS VIEW  — Force-Duration Curve + Training Recommendations
// ─────────────────────────────────────────────────────────────
// Zone boundaries (seconds)
const POWER_MAX    = 20;
const STRENGTH_MAX = 120;

function AnalysisView({ history, unit = "lbs", bodyWeight = null, onCalibrate = null, baseline = null, activities = [] }) {
  const [selHand,   setSelHand]   = useState("L");
  const [selGrip,   setSelGrip]   = useState("");
  const [relMode,   setRelMode]   = useState(false); // relative strength toggle

  const grips = useMemo(() =>
    [...new Set(history.map(r => r.grip).filter(Boolean))].sort(),
    [history]
  );

  // All reps with usable force + time data for the selected filters
  const reps = useMemo(() => history.filter(r =>
    r.hand === selHand &&
    (!selGrip || r.grip === selGrip) &&
    r.avg_force_kg > 0 && r.avg_force_kg < 500 &&
    r.actual_time_s > 0
  ), [history, selHand, selGrip]);

  const failures  = reps.filter(r => r.failed);
  const successes = reps.filter(r => !r.failed);

  const maxDur = Math.max(...reps.map(r => r.actual_time_s), STRENGTH_MAX + 60);

  // ── Critical Force estimation via Monod-Scherrer linearization ──
  // Delegates to the standalone fitCF() helper so CalibrationView & App can share the logic.
  const cfEstimate = useMemo(() => {
    if (failures.length < 2) return null;
    const pts = failures.map(r => ({ x: 1 / r.actual_time_s, y: r.avg_force_kg }));
    return fitCF(pts);
  }, [failures]);

  // ── Capacity improvement % vs baseline ──
  // Reference durations for each domain (seconds)
  const REF = { power: 10, strength: 45, endurance: 180 };

  const improvement = useMemo(() => {
    if (!baseline || !cfEstimate) return null;
    const pct = (t) => {
      const cur  = predForce(cfEstimate, t);
      const base = predForce(baseline,   t);
      if (base <= 0) return null;
      return Math.round((cur / base - 1) * 100);
    };
    const p = pct(REF.power);
    const s = pct(REF.strength);
    const e = pct(REF.endurance);
    if (p == null || s == null || e == null) return null;
    return {
      power:     p,
      strength:  s,
      endurance: e,
      total:     Math.round((p + s + e) / 3),
    };
  }, [baseline, cfEstimate]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Per-hand / per-grip improvement breakdown ──
  // Groups ALL failure reps (including calibration) by grip × hand,
  // splits each group into first-2 (baseline) vs all (current), fits CF/W′ for each.
  const perHandImprovement = useMemo(() => {
    if (!baseline) return null;
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
      const sorted = [...reps].sort((a, b) => a.date.localeCompare(b.date));
      // Use calibration snapshot as baseline; current = fitCF over all failures for this key
      const curPts = sorted.map(r => ({ x: 1 / r.actual_time_s, y: r.avg_force_kg }));
      const cur    = fitCF(curPts);
      if (!cur) continue;
      const [grip, hand] = key.split("|");
      const pct = (t) => Math.round((predForce(cur, t) / predForce(baseline, t) - 1) * 100);
      result[key] = {
        grip, hand, n: reps.length,
        power:     pct(REF.power),
        strength:  pct(REF.strength),
        endurance: pct(REF.endurance),
        total:     Math.round((pct(REF.power) + pct(REF.strength) + pct(REF.endurance)) / 3),
      };
    }
    return Object.keys(result).length > 0 ? result : null;
  }, [history, baseline]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Cumulative improvement time-series ──
  // For each unique date with failure data, compute CF/W′ from all failures up to that date
  // and compute % improvement vs baseline.
  const cumulativeData = useMemo(() => {
    if (!baseline || failures.length < 2) return [];
    const sorted = [...failures].sort((a, b) => a.date.localeCompare(b.date));
    const dates  = [...new Set(sorted.map(r => r.date))];
    return dates.map(date => {
      const upTo = sorted.filter(r => r.date <= date);
      if (upTo.length < 2) return null;
      const fit = fitCF(upTo.map(r => ({ x: 1 / r.actual_time_s, y: r.avg_force_kg })));
      if (!fit) return null;
      return {
        date,
        power:     Math.round((predForce(fit, REF.power)     / predForce(baseline, REF.power)     - 1) * 100),
        strength:  Math.round((predForce(fit, REF.strength)   / predForce(baseline, REF.strength)   - 1) * 100),
        endurance: Math.round((predForce(fit, REF.endurance)  / predForce(baseline, REF.endurance)  - 1) * 100),
      };
    }).filter(Boolean);
  }, [baseline, failures]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fitted force-duration curve points for overlay
  const curveData = useMemo(() => {
    if (!cfEstimate) return [];
    const { CF, W } = cfEstimate;
    return Array.from({ length: 80 }, (_, i) => {
      const t = 2 + ((maxDur - 2) / 79) * i;
      return { x: t, y: toDisp(Math.max(CF + W / t, CF), unit) };
    });
  }, [cfEstimate, maxDur, unit]);

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
  const maxForceRel = Math.max(
    ...(useRel
      ? reps.map(r => r.avg_force_kg / bodyWeight)
      : reps.map(r => toDisp(r.avg_force_kg, unit))),
    useRel ? 0.5 : 40
  );

  // ── Zone breakdown (power / strength / capacity) ──
  const zones = useMemo(() => {
    const zoneStats = (lo, hi) => {
      const z = reps.filter(r => r.actual_time_s >= lo && r.actual_time_s < hi);
      const f = z.filter(r => r.failed).length;
      return { total: z.length, failures: f, successes: z.length - f,
               failRate: z.length > 0 ? f / z.length : null };
    };
    return {
      power:     { ...zoneStats(0, POWER_MAX),                label: "Power",     color: C.red,    desc: "0–20s",    system: "Phosphocreatine",  tau: "τ₁ ≈ 15s"  },
      strength:  { ...zoneStats(POWER_MAX, STRENGTH_MAX),     label: "Strength",  color: C.orange, desc: "20–120s",  system: "Glycolytic",       tau: "τ₂ ≈ 90s"  },
      endurance: { ...zoneStats(STRENGTH_MAX, Infinity),      label: "Capacity",  color: C.blue,   desc: "120s+",    system: "Oxidative",        tau: "τ₃ ≈ 600s" },
    };
  }, [reps]);

  // ── Unified training recommendation ──
  // Combines two signals: physiological limiter (fail rate) and zone coverage gap.
  // Limiter is primary — what your body is struggling with RIGHT NOW.
  // Coverage gap is secondary — what you've been neglecting recently.
  const recommendation = useMemo(() => {
    const ZONE_DETAILS = {
      power: {
        title: "Train Power", color: C.red,
        insight: "Your phosphocreatine system is the rate-limiter. Heavy, short maximal efforts with full recovery are the prescription — quality over volume.",
        protocol: "5–10s hang · 90–100% max load · 3–5 min rest · 4–6 reps",
      },
      strength: {
        title: "Train Strength", color: C.orange,
        insight: "Your glycolytic system is the rate-limiter. Progressive overload in the medium time domain, or 7s-on/3s-off repeaters, drives the most adaptation.",
        protocol: "45s hang · 75–85% max · 3 min rest · 3–5 sets",
      },
      endurance: {
        title: "Train Capacity", color: C.blue,
        insight: "Your oxidative system is the rate-limiter. Raising Critical Force is the highest-leverage move — it lifts the aerobic ceiling and improves every other zone.",
        protocol: "2–5 min hang · 40–60% max · 2 min rest · 3–4 sets",
      },
    };

    // Signal 1: physiological limiter (highest fail rate among zones with data)
    const ranked = Object.entries(zones)
      .filter(([, z]) => z.failRate !== null)
      .sort(([, a], [, b]) => b.failRate - a.failRate);
    const limiterKey = ranked.length > 0 ? ranked[0][0] : null;

    // Signal 2: zone coverage gap (least-trained in last 30 days)
    const coverage = computeZoneCoverage(history, activities);
    const coverageKey = coverage.total > 0 ? coverage.recommended : null;

    if (!limiterKey && !coverageKey) return null;

    // Primary: limiter. Fall back to coverage if no failure data.
    const primaryKey = limiterKey ?? coverageKey;
    const details    = ZONE_DETAILS[primaryKey];

    // Are the two signals aligned?
    const agree = !limiterKey || !coverageKey || limiterKey === coverageKey;

    return {
      key: primaryKey,
      ...details,
      limiterKey,
      coverageKey,
      agree,
      coverageZoneLabel: coverageKey ? ZONE_DETAILS[coverageKey].title.replace("Train ", "") : null,
    };
  }, [zones, failures, history, activities]); // eslint-disable-line react-hooks/exhaustive-deps

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
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 4, gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Force-Duration Analysis</h2>
        {onCalibrate && (
          <Btn small onClick={onCalibrate} color={C.blue} style={{ flexShrink: 0, marginTop: 4 }}>
            📊 Calibrate
          </Btn>
        )}
      </div>
      <p style={{ margin: "0 0 16px", fontSize: 13, color: C.muted, lineHeight: 1.5 }}>
        Where failures fall on the fatigue curve reveals which energy system is your limiter — and what to train next.
      </p>

      {/* Calibration nudge for new users — only when no baseline set yet */}
      {!baseline && onCalibrate && (
        <div style={{
          marginBottom: 16, padding: "14px 16px",
          background: "#0d1f3c", border: `1px solid ${C.blue}40`, borderRadius: 12,
        }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.blue, marginBottom: 6 }}>
            📊 No baseline yet
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 12, lineHeight: 1.6 }}>
            A quick 3-step calibration seeds your force-duration curve and unlocks improvement tracking.
            Takes about 15 minutes — do it fresh, before any hard training.
          </div>
          <Btn onClick={onCalibrate} color={C.blue} style={{ padding: "10px 0", width: "100%", borderRadius: 8 }}>
            Run Calibration →
          </Btn>
        </div>
      )}

      {/* Filters */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: grips.length ? 10 : 0 }}>
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

      {/* ── Capacity Improvement summary (shown whenever baseline + any data exist) ── */}
      {baseline && improvement && (
        <Card style={{ marginBottom: 16, border: `1px solid ${C.purple}40` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Capacity Improvement</div>
            <div style={{ fontSize: 11, color: C.muted }}>since {baseline.date}</div>
          </div>
          {/* Total headline */}
          <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 14 }}>
            <div style={{ fontSize: 40, fontWeight: 900, color: improvement.total >= 0 ? C.green : C.red, lineHeight: 1 }}>
              {improvement.total >= 0 ? "+" : ""}{improvement.total}%
            </div>
            <div style={{ fontSize: 13, color: C.muted }}>Total Capacity</div>
          </div>
          {/* Three domains */}
          <div style={{ display: "flex", gap: 8 }}>
            {[
              { label: "⚡ Power",     val: improvement.power,     color: C.red    },
              { label: "💪 Strength",  val: improvement.strength,  color: C.orange },
              { label: "🏔️ Capacity",  val: improvement.endurance, color: C.blue   },
            ].map(({ label, val, color }) => (
              <div key={label} style={{
                flex: 1, background: C.bg, borderRadius: 10, padding: "10px 8px", textAlign: "center",
                border: `1px solid ${color}30`,
              }}>
                <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>{label}</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: val >= 0 ? color : C.red }}>
                  {val >= 0 ? "+" : ""}{val}%
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ── Cumulative improvement time-series ── */}
      {cumulativeData.length >= 2 && (
        <Card style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Improvement Over Time</div>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>
            % change vs. baseline as more failure data accumulates.
          </div>
          <div style={{ display: "flex", gap: 14, fontSize: 11, color: C.muted, marginBottom: 8, flexWrap: "wrap" }}>
            <span><span style={{ color: C.red }}>―</span> ⚡ Power</span>
            <span><span style={{ color: C.orange }}>―</span> 💪 Strength</span>
            <span><span style={{ color: C.blue }}>―</span> 🏔️ Capacity</span>
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={cumulativeData} margin={{ top: 6, right: 16, bottom: 28, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
              <XAxis dataKey="date" tick={{ fill: C.muted, fontSize: 9 }} angle={-30} textAnchor="end" interval="preserveStartEnd"
                label={{ value: "Date", position: "insideBottom", offset: -18, fill: C.muted, fontSize: 11 }} />
              <YAxis tick={{ fill: C.muted, fontSize: 11 }} unit="%" width={40} />
              <ReferenceLine y={0} stroke={C.border} strokeDasharray="3 3" />
              <Tooltip
                contentStyle={{ background: C.card, border: `1px solid ${C.border}`, fontSize: 12 }}
                formatter={(val, name) => [`${val >= 0 ? "+" : ""}${val}%`, name]}
              />
              <Line dataKey="power"     stroke={C.red}    strokeWidth={2} dot={false} name="Power"     />
              <Line dataKey="strength"  stroke={C.orange} strokeWidth={2} dot={false} name="Strength"  />
              <Line dataKey="endurance" stroke={C.blue}   strokeWidth={2} dot={false} name="Capacity"  />
            </LineChart>
          </ResponsiveContainer>
        </Card>
      )}

      {/* ── Per-hand / per-grip breakdown ── */}
      {perHandImprovement && (() => {
        // Group rows by grip
        const byGrip = {};
        for (const row of Object.values(perHandImprovement)) {
          if (!byGrip[row.grip]) byGrip[row.grip] = {};
          byGrip[row.grip][row.hand] = row;
        }
        return (
          <Card style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>Per-Hand Improvement</div>
            {Object.entries(byGrip).map(([grip, hands]) => (
              <div key={grip} style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>{grip}</div>
                {["L", "R"].filter(h => hands[h]).map(h => {
                  const row = hands[h];
                  return (
                    <div key={h} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                      <div style={{ width: 28, fontSize: 12, fontWeight: 700, color: C.muted, flexShrink: 0 }}>
                        {h === "L" ? "←L" : "R→"}
                      </div>
                      {[
                        { label: "⚡", val: row.power,     color: C.red    },
                        { label: "💪", val: row.strength,  color: C.orange },
                        { label: "🏔️", val: row.endurance, color: C.blue   },
                      ].map(({ label, val, color }) => (
                        <div key={label} style={{
                          flex: 1, background: C.bg, borderRadius: 8, padding: "5px 6px", textAlign: "center",
                          border: `1px solid ${color}25`,
                        }}>
                          <div style={{ fontSize: 9, color: C.muted }}>{label}</div>
                          <div style={{ fontSize: 14, fontWeight: 700, color: val >= 0 ? color : C.red }}>
                            {val >= 0 ? "+" : ""}{val}%
                          </div>
                        </div>
                      ))}
                      <div style={{
                        width: 50, background: C.bg, borderRadius: 8, padding: "5px 6px", textAlign: "center",
                        border: `1px solid ${C.purple}25`, flexShrink: 0,
                      }}>
                        <div style={{ fontSize: 9, color: C.muted }}>Total</div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: row.total >= 0 ? C.purple : C.red }}>
                          {row.total >= 0 ? "+" : ""}{row.total}%
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
            <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>
              Compared to your initial calibration baseline · {baseline?.date}
            </div>
          </Card>
        );
      })()}

      {reps.length === 0 ? (
        <Card>
          <div style={{ textAlign: "center", padding: "32px 0", color: C.muted }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📊</div>
            <div>No session data yet for this selection.</div>
            <div style={{ fontSize: 12, marginTop: 8 }}>Complete some sessions to see your force-duration curve.</div>
          </div>
        </Card>
      ) : (<>

        {/* ── Force-Duration scatter ── */}
        <Card style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Force vs. Duration</div>
            {bodyWeight != null && (
              <div style={{ display: "flex", gap: 4 }}>
                {["Absolute", "Relative"].map(mode => (
                  <button key={mode} onClick={() => setRelMode(mode === "Relative")} style={{
                    padding: "3px 10px", borderRadius: 12, fontSize: 11, cursor: "pointer", border: "none", fontWeight: 600,
                    background: (mode === "Relative") === relMode ? C.purple : C.border,
                    color: (mode === "Relative") === relMode ? "#fff" : C.muted,
                  }}>{mode}</button>
                ))}
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 16, fontSize: 11, color: C.muted, marginBottom: 10, flexWrap: "wrap" }}>
            <span><span style={{ color: C.green }}>●</span> Completed</span>
            <span><span style={{ color: C.red }}>●</span> Auto-failed</span>
            {cfEstimate && <span><span style={{ color: C.purple }}>―</span> F-D curve</span>}
            {cfEstimate && <span><span style={{ color: C.purple }}>╌</span> Critical Force</span>}
            {useRel && <span style={{ color: C.purple }}>× bodyweight ({fmtW(bodyWeight, unit)} {unit})</span>}
          </div>
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
              {/* Zone backgrounds */}
              <ReferenceArea x1={0}            x2={POWER_MAX}    fill={C.red}    fillOpacity={0.07} />
              <ReferenceArea x1={POWER_MAX}    x2={STRENGTH_MAX} fill={C.orange} fillOpacity={0.07} />
              <ReferenceArea x1={STRENGTH_MAX} x2={maxDur + 10}  fill={C.blue}   fillOpacity={0.07} />
              {/* Critical Force horizontal line */}
              {cfEstimate && (
                <ReferenceLine
                  y={useRel ? cfEstimate.CF / bodyWeight : toDisp(cfEstimate.CF, unit)}
                  stroke={C.purple} strokeDasharray="6 3" strokeWidth={1.5}
                  label={{ value: `CF ${fmtForce(cfEstimate.CF)} ${forceUnit}`, position: "insideTopRight", fill: C.purple, fontSize: 10 }}
                />
              )}
              {/* Fitted force-duration curve */}
              {curveDataRel.length > 0 && (
                <Line data={curveDataRel} dataKey="y" stroke={C.purple} strokeWidth={2} dot={false} legendType="none" />
              )}
              {/* Completed reps */}
              <Scatter data={successDotsRel} fill={C.green} opacity={0.85} name="Completed" />
              {/* Failed reps */}
              <Scatter data={failureDotsRel} fill={C.red} opacity={0.95} name="Auto-failed" />
            </ComposedChart>
          </ResponsiveContainer>
          {/* Zone labels */}
          <div style={{ display: "flex", justifyContent: "space-around", marginTop: 4, fontSize: 10, color: C.muted }}>
            <span style={{ color: C.red }}>⚡ Power &lt;20s</span>
            <span style={{ color: C.orange }}>💪 Strength 20–120s</span>
            <span style={{ color: C.blue }}>🔄 Capacity 120s+</span>
          </div>
        </Card>

        {/* ── Critical Force card ── */}
        {cfEstimate ? (
          <Card style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>Critical Force Estimate</div>
            <div style={{ display: "flex", gap: 0, marginBottom: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>Critical Force (CF)</div>
                <div style={{ fontSize: 32, fontWeight: 800, color: C.purple, lineHeight: 1 }}>
                  {fmtW(cfEstimate.CF, unit)}
                </div>
                <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>{unit} · max sustainable</div>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>Anaerobic Capacity (W′)</div>
                <div style={{ fontSize: 32, fontWeight: 800, color: C.orange, lineHeight: 1 }}>
                  {fmtW(cfEstimate.W, unit)}·s
                </div>
                <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>{unit}·s · finite reserve above CF</div>
              </div>
            </div>
            {/* ── Curve Shape Indicator ── */}
            {(() => {
              // W′/CF in seconds = how many seconds of W′ reserve per unit of CF.
              // Low  (<30s)  → flat curve  = CF-dominant (strong aerobic base)
              // Med  (30-80s)→ balanced
              // High (>80s)  → steep curve = W′-dominant (strong short-term, lower base)
              const ratio = cfEstimate.CF > 0 ? cfEstimate.W / cfEstimate.CF : 0;
              const pct   = Math.min(100, Math.max(0, (ratio / 120) * 100));
              const { shape, color: sc, advice } =
                ratio < 30  ? { shape: "CF-dominant (Flat)",    color: C.blue,   advice: "Strong aerobic base. Power training will give you the biggest gains — short maximal hangs build W′." } :
                ratio < 80  ? { shape: "Balanced",              color: C.green,  advice: "Good balance of CF and W′. Cycle power and capacity sessions to keep both systems growing." } :
                              { shape: "W′-dominant (Steep)",   color: C.orange, advice: "Strong short burst capacity. Capacity training (sub-max hangs, long efforts) will raise your CF ceiling and benefit all zones." };
              return (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.muted, marginBottom: 5 }}>
                    <span>Curve Shape</span>
                    <span style={{ color: sc, fontWeight: 700 }}>{shape}</span>
                  </div>
                  {/* Gradient bar: flat (blue) → balanced (green) → steep (orange) */}
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
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 6, lineHeight: 1.5, fontStyle: "italic" }}>
                    {advice}
                  </div>
                </div>
              );
            })()}
            <div style={{ fontSize: 12, color: C.muted, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
              Estimated from {cfEstimate.n} failure point{cfEstimate.n !== 1 ? "s" : ""}. Accuracy improves as failures span multiple time domains — try power hangs (5–10s) and capacity hangs (2+ min) to sharpen the curve.
            </div>
          </Card>
        ) : (
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
        )}

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

              {/* ── Last-session zone distribution (Grip Gains 5-zone classifier) ── */}
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

        {/* ── Unified training recommendation ── */}
        {recommendation ? (
          <Card style={{ marginBottom: 16, border: `1px solid ${recommendation.color}40` }}>
            <div style={{ fontSize: 11, color: recommendation.color, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
              Next Session Focus
            </div>
            <div style={{ fontSize: 22, fontWeight: 800, color: recommendation.color, marginBottom: 10 }}>
              {recommendation.title}
            </div>
            <div style={{ fontSize: 13, color: C.text, marginBottom: 14, lineHeight: 1.6 }}>
              {recommendation.insight}
            </div>
            <div style={{ background: C.bg, borderRadius: 8, padding: "10px 14px", fontSize: 12, color: C.muted, fontFamily: "monospace", letterSpacing: "0.02em", marginBottom: 12 }}>
              {recommendation.protocol}
            </div>
            {/* Signal explanation */}
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {recommendation.limiterKey && (
                <div style={{ fontSize: 11, color: C.muted, display: "flex", gap: 6, alignItems: "flex-start" }}>
                  <span style={{ color: recommendation.color, fontWeight: 700, flexShrink: 0 }}>↑ Limiter:</span>
                  <span>Highest fail rate in this zone — your body is telling you this is the weak link.</span>
                </div>
              )}
              {recommendation.coverageKey && recommendation.agree && (
                <div style={{ fontSize: 11, color: C.muted, display: "flex", gap: 6, alignItems: "flex-start" }}>
                  <span style={{ color: C.green, fontWeight: 700, flexShrink: 0 }}>✓ Coverage:</span>
                  <span>Also least-trained in the last 30 days — both signals agree.</span>
                </div>
              )}
              {recommendation.coverageKey && !recommendation.agree && (
                <div style={{ fontSize: 11, color: C.muted, display: "flex", gap: 6, alignItems: "flex-start" }}>
                  <span style={{ color: C.yellow, fontWeight: 700, flexShrink: 0 }}>⚡ Note:</span>
                  <span>
                    Zone coverage suggests {recommendation.coverageZoneLabel} (least-trained recently),
                    but your fail rate points here as the physiological bottleneck. Limiter takes priority.
                  </span>
                </div>
              )}
            </div>
          </Card>
        ) : (
          <Card style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.5 }}>
              🔬 Train close to your limit in at least one time domain so the auto-failure system can record a failure point. That unlocks personalized training recommendations.
            </div>
          </Card>
        )}

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
function SettingsView({ user, loginEmail, setLoginEmail, onMagicLink, onSignOut, unit = "lbs", onUnitChange = () => {}, bodyWeight = null, onBWChange = () => {}, trip = DEFAULT_TRIP, onTripChange = () => {} }) {
  const [showSQL, setShowSQL] = useState(false);
  const sql = `-- Run this once in your Supabase SQL editor (fresh install):
CREATE TABLE reps (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  date text, grip text, hand text,
  target_duration integer,
  weight_kg real, actual_time_s real,
  avg_force_kg real, peak_force_kg real,
  set_num integer, rep_num integer,
  rest_s integer, session_id text,
  failed boolean DEFAULT false
);
ALTER TABLE reps ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_all" ON reps
  FOR ALL USING (auth.uid() IS NOT NULL);

-- If upgrading an existing table, run this instead:
-- ALTER TABLE reps ADD COLUMN IF NOT EXISTS failed boolean DEFAULT false;`;

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
      <h2 style={{ margin: "0 0 16px", fontSize: 22 }}>Settings</h2>

      <Card>
        <Sect title="Units">
          <div style={{ display: "flex", gap: 8 }}>
            {["lbs", "kg"].map(u => (
              <button key={u} onClick={() => onUnitChange(u)} style={{
                flex: 1, padding: "10px 0", borderRadius: 8, cursor: "pointer", fontWeight: 700, fontSize: 16,
                background: unit === u ? C.blue : C.border,
                color: unit === u ? "#fff" : C.muted, border: "none",
              }}>{u}</button>
            ))}
          </div>
        </Sect>
      </Card>

      <Card>
        <Sect title="Body Weight">
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>
            Used to show <b>relative strength</b> (force ÷ bodyweight) in the Analysis tab.
            Helps compare progress through weight changes.
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <input
              type="number" inputMode="numeric" min={30} max={500} step={1}
              value={bodyWeight != null ? fmt0(toDisp(bodyWeight, unit)) : ""}
              onChange={e => {
                const v = e.target.value === "" ? null : fromDisp(Math.round(Number(e.target.value)), unit);
                onBWChange(v);
              }}
              placeholder={`Weight in ${unit}`}
              style={{
                width: 110, background: C.bg,
                border: `1px solid ${C.border}`, borderRadius: 8,
                padding: "8px 12px", color: C.text, fontSize: 15,
              }}
            />
            <span style={{ fontSize: 14, color: C.muted }}>{unit}</span>
            {bodyWeight != null && (
              <span style={{ fontSize: 12, color: C.muted, marginLeft: 4 }}>
                ({unit === "lbs" ? `${fmt0(bodyWeight)} kg` : `${fmt0(bodyWeight * KG_TO_LBS)} lbs`})
              </span>
            )}
          </div>
        </Sect>
      </Card>

      <Card>
        <Sect title="Training Goal">
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>
            Target trip or event. Drives the countdown + taper reminder on the Workout tab.
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input
              type="text"
              value={trip.name || ""}
              onChange={e => onTripChange({ name: e.target.value })}
              placeholder="Name (e.g. Tensleep)"
              style={{
                flex: "1 1 160px", minWidth: 140, background: C.bg,
                border: `1px solid ${C.border}`, borderRadius: 8,
                padding: "8px 12px", color: C.text, fontSize: 15,
              }}
            />
            <input
              type="date"
              value={trip.date || ""}
              onChange={e => onTripChange({ date: e.target.value })}
              style={{
                background: C.bg,
                border: `1px solid ${C.border}`, borderRadius: 8,
                padding: "8px 12px", color: C.text, fontSize: 15,
              }}
            />
          </div>
          {(() => {
            const cd = tripCountdown(trip.date);
            if (!cd) {
              return (
                <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>
                  Pick a date to enable the countdown.
                </div>
              );
            }
            if (cd.past) {
              return (
                <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>
                  Trip date is in the past — update it to a future date.
                </div>
              );
            }
            return (
              <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>
                {cd.weeks}wk · {cd.days}d until {trip.name || "trip"} ({cd.tripLabel}). Taper starts {cd.taperLabel}.
              </div>
            );
          })()}
        </Sect>
      </Card>

      <Card>
        <Sect title="Cloud Sync (Supabase)">
          {user ? (
            <div>
              <div style={{ fontSize: 14, marginBottom: 12 }}>
                Signed in as <b>{user.email}</b>
              </div>
              <Btn small color={C.red} onClick={onSignOut}>Sign Out</Btn>
            </div>
          ) : (
            <div>
              <div style={{ fontSize: 13, color: C.muted, marginBottom: 10 }}>
                Sign in to sync data across devices.
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  type="email" value={loginEmail}
                  onChange={e => setLoginEmail(e.target.value)}
                  placeholder="your@email.com"
                  style={{ flex: 1, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px", color: C.text, fontSize: 14 }}
                />
                <Btn small onClick={onMagicLink}>Send Link</Btn>
              </div>
            </div>
          )}
        </Sect>
      </Card>

      <Card>
        <Sect title="Tindeq Progressor">
          <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6 }}>
            <p style={{ marginTop: 0 }}>
              The Tindeq Progressor connects via Web Bluetooth. Use <b>Chrome</b> on desktop or Android.
            </p>
            <p>
              Connect from the training screen. The app auto-detects failure when force drops below 50% of peak for &gt;500 ms.
            </p>
            <p style={{ marginBottom: 0 }}>
              If readings seem off, your firmware may use a slightly different BLE packet format — contact support.
            </p>
          </div>
        </Sect>
      </Card>

      <Card>
        <details>
          <summary style={{ fontSize: 12, color: C.muted, cursor: "pointer", userSelect: "none" }}>
            Developer options
          </summary>
          <div style={{ marginTop: 12 }}>
            <Sect title="Supabase Setup">
              <div style={{ fontSize: 13, color: C.muted, marginBottom: 10 }}>
                If this is a fresh install, run this SQL in your Supabase project to create the <code>reps</code> table.
              </div>
              <Btn small onClick={() => setShowSQL(s => !s)} color={C.muted}>
                {showSQL ? "Hide SQL" : "Show Setup SQL"}
              </Btn>
              {showSQL && (
                <pre style={{
                  marginTop: 12, background: C.bg, border: `1px solid ${C.border}`,
                  borderRadius: 8, padding: 12, fontSize: 11, color: C.green,
                  whiteSpace: "pre-wrap", overflowX: "auto",
                }}>{sql}</pre>
              )}
            </Sect>
          </div>
        </details>
      </Card>

      <Card>
        <Sect title="About">
          <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6 }}>
            <b>Fatigue Model:</b> Three-compartment IV-kinetics analogy. Fast (15 s), medium (90 s),
            and slow (600 s) exponential decay model phosphocreatine replenishment, glycolytic clearance,
            and metabolic byproduct removal respectively.
            <br /><br />
            <b>Level System:</b> Each 5% improvement in your best load at a target duration = +1 level.
            <br /><br />
            <b>Version:</b> Finger Training v3
          </div>
        </Sect>
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// BADGES VIEW
// ─────────────────────────────────────────────────────────────
function BadgesView({ history, liveEstimate, genesisSnap }) {
  // Zone coverage for Genesis unlock
  const hasPower    = history.some(r => r.target_duration === 10);
  const hasStrength = history.some(r => r.target_duration === 45);
  const hasCapacity = history.some(r => r.target_duration === 120);
  const genesisEarned = hasPower && hasStrength && hasCapacity;

  // AUC progress
  const genesisAUC  = genesisSnap ? computeAUC(genesisSnap.CF, genesisSnap.W) : null;
  const currentAUC  = liveEstimate ? computeAUC(liveEstimate.CF, liveEstimate.W) : null;
  const pctImprove  = (genesisAUC && currentAUC && currentAUC > genesisAUC)
    ? (currentAUC - genesisAUC) / genesisAUC * 100
    : 0;

  // Which badges are earned
  const earnedIds = new Set(
    BADGE_CONFIG
      .filter((b, i) => i === 0 ? genesisEarned : genesisEarned && pctImprove >= b.threshold)
      .map(b => b.id)
  );
  const earnedList  = BADGE_CONFIG.filter(b => earnedIds.has(b.id));
  const currentBadge= earnedList[earnedList.length - 1] ?? null;
  const nextBadge   = BADGE_CONFIG.find(b => !earnedIds.has(b.id)) ?? null;

  // Progress bar toward next badge
  const prevThr = currentBadge?.threshold ?? 0;
  const nextThr = nextBadge?.threshold ?? 100;
  const toNext  = nextBadge
    ? Math.min(100, Math.max(0, (pctImprove - prevThr) / (nextThr - prevThr) * 100))
    : 100;

  const zonesHave = [hasPower, hasStrength, hasCapacity].filter(Boolean).length;

  return (
    <div style={{ padding: "20px 16px", maxWidth: 480, margin: "0 auto" }}>

      {/* Hero: current badge */}
      <div style={{ textAlign: "center", marginBottom: 28 }}>
        <div style={{ fontSize: 56, lineHeight: 1 }}>{currentBadge?.emoji ?? "⬜"}</div>
        <div style={{ fontSize: 22, fontWeight: 800, color: C.text, marginTop: 10 }}>
          {currentBadge?.label ?? "Begin your journey"}
        </div>
        {genesisEarned && currentAUC && (
          <div style={{ fontSize: 13, color: C.muted, marginTop: 4 }}>
            {pctImprove.toFixed(1)}% above your Genesis capacity
          </div>
        )}
      </div>

      {/* Genesis checklist — shown until earned */}
      {!genesisEarned && (
        <div style={{
          background: C.card, border: `1px solid ${C.border}`,
          borderRadius: 12, padding: 16, marginBottom: 20,
        }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 4 }}>
            Earn Genesis 🌱
          </div>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 12 }}>
            Log one session in each training zone to unlock your curve.
          </div>
          {[
            { label: "Power — 10s hang",     done: hasPower },
            { label: "Strength — 45s hang",   done: hasStrength },
            { label: "Capacity — 120s hang",  done: hasCapacity },
          ].map(z => (
            <div key={z.label} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <span style={{ fontSize: 17 }}>{z.done ? "✅" : "⬜"}</span>
              <span style={{ fontSize: 13, color: z.done ? C.green : C.muted, fontWeight: z.done ? 600 : 400 }}>
                {z.label}
              </span>
            </div>
          ))}
          <div style={{ height: 5, background: C.border, borderRadius: 3, marginTop: 12 }}>
            <div style={{
              height: "100%", borderRadius: 3, background: C.green,
              width: `${(zonesHave / 3) * 100}%`, transition: "width 0.4s",
            }} />
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 6 }}>{zonesHave} of 3 zones covered</div>
        </div>
      )}

      {/* Progress toward next badge */}
      {genesisEarned && nextBadge && (
        <div style={{
          background: C.card, border: `1px solid ${C.border}`,
          borderRadius: 12, padding: 16, marginBottom: 20,
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ fontSize: 13, color: C.muted }}>Progress to {nextBadge.emoji} {nextBadge.label}</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: C.blue }}>{toNext.toFixed(0)}%</span>
          </div>
          <div style={{ height: 6, background: C.border, borderRadius: 3 }}>
            <div style={{
              height: "100%", borderRadius: 3, background: C.blue,
              width: `${toNext}%`, transition: "width 0.4s",
            }} />
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>
            Need +{nextBadge.threshold}% · you're at +{pctImprove.toFixed(1)}%
          </div>
        </div>
      )}

      {/* All-earned celebration */}
      {genesisEarned && !nextBadge && (
        <div style={{
          background: "#1a2a1a", border: `1px solid ${C.green}`,
          borderRadius: 12, padding: 16, marginBottom: 20, textAlign: "center",
        }}>
          <div style={{ fontSize: 13, color: C.green, fontWeight: 700 }}>
            🏔️ Realization achieved — you've fulfilled the potential
          </div>
        </div>
      )}

      {/* Badge pyramid — Genesis at top (origin), Realization at bottom (destination) */}
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 10, textAlign: "center", letterSpacing: "0.05em" }}>
        THE JOURNEY
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {BADGE_CONFIG.map((badge) => {
          const earned  = earnedIds.has(badge.id);
          const current = currentBadge?.id === badge.id;
          return (
            <div key={badge.id} style={{
              background: earned ? C.card : "transparent",
              border: `1px solid ${current ? C.blue : earned ? C.border : C.border + "50"}`,
              borderRadius: 12, padding: "12px 16px",
              display: "flex", alignItems: "center", gap: 14,
              opacity: earned ? 1 : 0.38,
              boxShadow: current ? `0 0 0 2px ${C.blue}30` : "none",
            }}>
              <span style={{ fontSize: 28, filter: earned ? "none" : "grayscale(1)" }}>
                {badge.emoji}
              </span>
              <div style={{ flex: 1 }}>
                <div style={{
                  fontSize: 15, fontWeight: 700,
                  color: current ? C.blue : earned ? C.text : C.muted,
                  display: "flex", alignItems: "center", gap: 8,
                }}>
                  {badge.label}
                  {current && (
                    <span style={{
                      fontSize: 10, fontWeight: 700, color: C.blue,
                      background: C.blue + "20", borderRadius: 4,
                      padding: "1px 6px", letterSpacing: "0.06em",
                    }}>NOW</span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{badge.desc}</div>
              </div>
              <div style={{ fontSize: 12, color: C.muted, textAlign: "right", minWidth: 40 }}>
                {badge.threshold === 0 ? "start" : `+${badge.threshold}%`}
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer note */}
      <div style={{ fontSize: 12, color: C.muted, textAlign: "center", marginTop: 20, lineHeight: 1.5 }}>
        % is AUC growth above your Genesis snapshot —<br />
        total force capacity across the 10–120s range.
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// AUTO REP SESSION VIEW
// ─────────────────────────────────────────────────────────────
// Touchless session mode for spring-strap / pre-calibrated setups.
// Tindeq detects pull start and release automatically — no button taps needed.
// Each detected rep calls onRepDone with {actualTime, avgForce, failed:false}.
function AutoRepSessionView({ session, onRepDone, onAbort, tindeq, unit = "lbs" }) {
  const { config, currentSet, currentRep, activeHand, fatigue, refWeights } = session;
  const handLabel = config.hand === "Both"
    ? (activeHand === "L" ? "Left Hand" : "Right Hand")
    : config.hand === "L" ? "Left Hand" : "Right Hand";

  // Program-recommended target weight for the active hand (adjusted for fatigue)
  const suggestedKg = useMemo(
    () => suggestWeight(refWeights?.[activeHand] ?? null, fatigue ?? 0),
    [refWeights, activeHand, fatigue]
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
              {(fatigue ?? 0) > 0.05 && (
                <span style={{ marginLeft: 6, color: C.orange, letterSpacing: 0 }}>
                  (fatigue {Math.round((fatigue ?? 0) * 100)}%)
                </span>
              )}
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
            avg={0}
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
const LS_WORKOUT_LOG_KEY     = "ft_workout_log";
const LS_WORKOUT_SYNCED_KEY  = "ft_workout_synced";  // Set<id> of sessions confirmed in Supabase
const LS_WORKOUT_DELETED_KEY = "ft_workout_deleted"; // Set<id> tombstones — never re-add from remote
const LS_HISTORY_DOMAIN_KEY  = "ft_history_domain";
const LS_TRIP_KEY            = "ft_trip";            // { date: "YYYY-MM-DD", name: "Tensleep" }

const DEFAULT_TRIP         = { date: "2026-08-22", name: "Tensleep" };
const WK_ROTATION          = ["A", "B", "C"];

// Parse a "YYYY-MM-DD" trip date string. Returns null for empty/invalid input.
function parseTripDate(tripDateStr) {
  if (!tripDateStr) return null;
  const d = new Date(tripDateStr + "T00:00:00");
  return isNaN(d) ? null : d;
}

function weeksToTrip(tripDateStr) {
  const trip = parseTripDate(tripDateStr);
  if (!trip) return 0;
  return Math.max(0, Math.ceil((trip - new Date()) / (7 * 24 * 60 * 60 * 1000)));
}

// Trip countdown info — model-agnostic (conjugate-friendly).
// Does NOT impose linear Build/Push/Peak/Taper blocks. Reports weeks remaining
// and a taper window starting 7 days out (universal across training models).
function tripCountdown(tripDateStr) {
  const trip = parseTripDate(tripDateStr);
  if (!trip) return null;
  const now = new Date();
  const msPerDay = 24 * 60 * 60 * 1000;
  const days = Math.ceil((trip - now) / msPerDay);
  const weeks = Math.max(0, Math.ceil(days / 7));
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const fmt = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const taperStart = addDays(trip, -7);
  return {
    trip,
    days,
    weeks,
    tripLabel: fmt(trip),
    taperLabel: fmt(taperStart),
    inTaper: days <= 7 && days >= 0,
    past: days < 0,
  };
}

const WTYPE_META = {
  F: { label: "F", bg: "#1a2d4a", color: "#58a6ff" },
  S: { label: "S", bg: "#2d1f00", color: "#e3b341" },
  H: { label: "H", bg: "#2d0000", color: "#f85149" },
  P: { label: "P", bg: "#2d1200", color: "#f0883e" },
  C: { label: "C", bg: "#002d10", color: "#3fb950" },
  X: { label: "↔", bg: "#1e1e2e", color: "#8b949e" },
  D: { label: "D", bg: "#1e1535", color: "#bc8cff" },
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
  D: {
    name: "Outdoor / Gym Climbing",
    exercises: [
      { id: "micro_1rm",   name: "Micro 1RM",   type: "F", sets: 1,    reps: "Max",  logWeight: false, note: "" },
      { id: "crusher_1rm", name: "Crusher 1RM", type: "F", sets: 1,    reps: "Max",  logWeight: false, note: "" },
      { id: "climb",       name: "Climb",        type: "D", sets: null, reps: null,   logWeight: false, note: "Project focus" },
      { id: "stretch",     name: "Stretching",   type: "X", sets: null, reps: null,   logWeight: false, note: "Couch · Splits machine · Hamstring lockout · Forearms · Lat" },
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
  const [editingKey, setEditingKey] = useState(null);          // "A"|"B"|"C"|"D"|null

  const savePlan  = (p) => { setPlan(p);  saveLS(LS_WORKOUT_PLAN_KEY,  p); };
  const saveState = (s) => { setWState(s); saveLS(LS_WORKOUT_STATE_KEY, s); };
  const saveLog   = (l) => { setWLog(l);  saveLS(LS_WORKOUT_LOG_KEY,   l); };

  const rotKey    = WK_ROTATION[wState.rotationIndex % WK_ROTATION.length];
  const workout   = plan[rotKey];
  const sessionN  = wState.sessionCount + 1;
  const wtr       = weeksToTrip(trip.date);

  // Previous best set weights for an exercise in this workout slot
  const prevBestSets = (exId) => {
    for (let i = wLog.length - 1; i >= 0; i--) {
      const e = wLog[i];
      if (e.workout === rotKey && e.exercises?.[exId]?.sets) {
        return e.exercises[exId].sets.map(s => s.weight).filter(Boolean);
      }
    }
    return [];
  };

  const startSession = () => {
    // Pre-populate weights and reps from last session for this workout
    const prevLog = [...wLog].reverse().find(e => e.workout === rotKey);
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
    const session = { id: genId(), date: today(), completedAt: nowISO(), workout: rotKey, sessionNumber: sessionN, exercises: sessionData };
    // Read fresh from localStorage rather than the React state snapshot, which may
    // be stale if the migration effect rewrote the log after this component mounted.
    const freshLog = loadLS(LS_WORKOUT_LOG_KEY) || [];
    saveLog([...freshLog, session]);
    if (onSessionSaved) onSessionSaved(session);
    saveState({
      rotationIndex: (wState.rotationIndex + 1) % WK_ROTATION.length,
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
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 14 }}>
              {/* Letter badge */}
              <div style={{
                width: 40, height: 40, borderRadius: 10, flexShrink: 0,
                background: WTYPE_META.S.bg, border: `1px solid ${C.border}`,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 18, fontWeight: 800, color: C.blue,
              }}>{rotKey}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: C.muted, marginBottom: 2 }}>WORKOUT {rotKey}  ·  NEXT UP</div>
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

            {/* Exercise list */}
            <div>
              {workout.exercises.map((ex, i) => (
                <ExerciseRow key={ex.id} ex={ex} last={i === workout.exercises.length - 1} />
              ))}
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
              {["A", "B", "C", "D"].map(key => {
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

const TABS = ["Fingers", "Analysis", "Journey", "Workout", "History", "Trends", "Settings"];

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

  // Track how many reps are waiting to be synced to Supabase.
  const [pendingCount, setPendingCount] = useState(() => (loadLS(LS_QUEUE_KEY) || []).length);
  const refreshPending = () => setPendingCount((loadLS(LS_QUEUE_KEY) || []).length);

  // Load from Supabase when signed in; also flush any queued reps.
  // Only replace local history if Supabase actually returned rows — an empty
  // response (expired JWT silently blocked by RLS, network hiccup, etc.) must
  // never wipe out a good local cache.
  useEffect(() => {
    if (!user) return;
    // Flush queued reps first, then reload full history.
    flushQueue().then(flushed => {
      if (flushed > 0) refreshPending();
      fetchReps().then(reps => {
        if (reps && reps.length > 0) setHistory(reps);
        refreshPending();
      });
    });
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
  const liveEstimate = useMemo(() => {
    const failures = history.filter(r => r.failed && r.avg_force_kg > 0 && r.actual_time_s > 0);
    if (failures.length < 2) return null;
    return fitCF(failures.map(r => ({ x: 1 / r.actual_time_s, y: r.avg_force_kg })));
  }, [history]);

  // ── Calibration mode ──────────────────────────────────────
  const [calMode, setCalMode] = useState(false);

  // Permanent baseline snapshot — set once from first calibration, never overwritten.
  const [baseline, setBaseline] = useState(() => loadLS(LS_BASELINE_KEY));
  const [activities, setActivities] = useState(() => loadLS(LS_ACTIVITY_KEY) || []);

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

  const handleCalibrationComplete = useCallback((calReps) => {
    addReps(calReps);

    // Snapshot CF/W′ baseline from the 3 calibration reps if we don't have one yet.
    if (!loadLS(LS_BASELINE_KEY)) {
      const pts = calReps
        .filter(r => r.avg_force_kg > 0 && r.actual_time_s > 0)
        .map(r => ({ x: 1 / r.actual_time_s, y: r.avg_force_kg }));
      const fit = fitCF(pts);
      if (fit) {
        const snap = { date: today(), CF: fit.CF, W: fit.W };
        saveLS(LS_BASELINE_KEY, snap);
        setBaseline(snap);
      }
    }

    setCalMode(false);
    setTab(1); // navigate to Analysis tab
  }, [addReps]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Session Config ────────────────────────────────────────
  // hand is hard-coded to "Both": the user always trains both hands, either
  // alternating per rep or doing all-L-then-all-R. There's no UI toggle for
  // this anymore; it lives in config only so existing downstream code keeps
  // working.
  const [config, setConfig] = useState(() => ({
    hand:       "Both",
    grip:       "",
    repsPerSet: 5,
    numSets:    3,
    targetTime: 45,
    restTime:   20,
    setRestTime: 180,
    altMode:    false, // interleave both hands when rest >= rep duration
  }));

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
  const startSession = useCallback(() => {
    const sid = uid();
    const rw = {};
    ["L", "R"].forEach(h => {
      rw[h] = estimateRefWeight(history, h, config.grip, config.targetTime);
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
  }, [history, config]);

  // ── Handle rep completion ─────────────────────────────────
  const handleRepDone = useCallback(({ actualTime, avgForce, failed = false }) => {
    const effectiveHand = config.hand === "Both" ? activeHand : config.hand;
    const weight = (() => {
      const ws = [suggestWeight(refWeights[effectiveHand], fatigue)].filter(Boolean);
      return ws.length > 0 ? ws[0] : 0;
    })();

    const repRecord = {
      id:              uid(),
      date:            today(),
      grip:            config.grip,
      hand:            effectiveHand,
      target_duration: config.targetTime,
      weight_kg:       Math.round(weight * 10) / 10,
      actual_time_s:   Math.round(actualTime * 10) / 10,
      avg_force_kg:    (isFinite(avgForce) && avgForce > 0 && avgForce < 500)
                         ? Math.round(avgForce * 10) / 10
                         : null,
      set_num:         currentSet + 1,
      rep_num:         currentRep + 1,
      rest_s:             config.restTime,
      session_id:         sessionId,
      failed:             failed,
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

  // Compute next rep suggestion for rest screen
  const nextWeight = useMemo(() => {
    if (phase !== "resting") return null;
    const restFatigue = fatigueAfterRest(fatigue, config.restTime);
    const hand = config.hand === "Both" ? activeHand : config.hand;
    return suggestWeight(refWeights[hand], restFatigue);
  }, [phase, fatigue, config.restTime, config.hand, refWeights, activeHand]);

  // ── Auth helpers ──────────────────────────────────────────
  const sendMagicLink = async () => {
    if (!loginEmail) return;
    const { error } = await supabase.auth.signInWithOtp({
      email: loginEmail,
      options: { emailRedirectTo: window.location.origin },
    });
    alert(error ? error.message : "Check your email for the sign-in link!");
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
        if (phase === "idle" && calMode) {
          return (
            <CalibrationView
              tindeq={tindeq}
              unit={unit}
              onComplete={handleCalibrationComplete}
              onCancel={() => setCalMode(false)}
            />
          );
        }

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
              onCalibrate={() => setCalMode(true)}
              history={history}
              unit={unit}
              onBwSave={saveBW}
              readiness={readiness}
              todaySubj={todaySubj}
              onSubjReadiness={handleSubjReadiness}
              isEstimated={todaySubj == null}
              liveEstimate={liveEstimate}
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

      {tab === 1 && <AnalysisView history={history} unit={unit} bodyWeight={bodyWeight} baseline={baseline} activities={activities} onCalibrate={() => { setCalMode(true); setTab(0); }} />}
      {tab === 2 && <BadgesView history={history} liveEstimate={liveEstimate} genesisSnap={genesisSnap} />}
      {tab === 3 && <WorkoutTab unit={unit} onSessionSaved={handleWorkoutSessionSaved} onBwSave={saveBW} trip={trip} />}
      {tab === 4 && <HistoryView history={history} onDownload={() => downloadCSV(history)} unit={unit} bodyWeight={bodyWeight} onDeleteSession={deleteSession} onUpdateSession={updateSession} onDeleteRep={deleteRep} onUpdateRep={updateRep} onAddRep={(rep) => addReps(Array.isArray(rep) ? rep : [rep])} notes={notes} onNoteChange={handleNoteChange} />}
      {tab === 5 && <TrendsView history={history} unit={unit} />}
      {tab === 6 && (
        <SettingsView
          user={user}
          loginEmail={loginEmail}
          setLoginEmail={setLoginEmail}
          onMagicLink={sendMagicLink}
          onSignOut={signOut}
          unit={unit}
          onUnitChange={saveUnit}
          bodyWeight={bodyWeight}
          onBWChange={saveBW}
          trip={trip}
          onTripChange={saveTrip}
        />
      )}
    </div>
  );
}
