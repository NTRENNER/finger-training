// src/App.js  — Finger Training v3
// Rep-based sessions · Three-Compartment Fatigue Model · Tindeq Progressor BLE · Gamification
import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import { supabase } from "./lib/supabase";
import {
  ResponsiveContainer, LineChart, Line, ComposedChart, Scatter,
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
  { label: "Power",     seconds: 20  },
  { label: "Strength",  seconds: 45  },
  { label: "Endurance", seconds: 240 },
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
const LS_READINESS_KEY = "ft_readiness"; // { [date]: 1-5 } subjective daily rating
const LS_BASELINE_KEY  = "ft_baseline";  // { date, CF, W } — permanent first-calibration snapshot

const LEVEL_STEP = 1.05; // 5% improvement per level

const LEVEL_TITLES = [
  "Wimpy","Popeye","Fresh Fighter","Ten Sleep Tough Guy","Black Hills Buff","Southern Gun",
  "Ten Pound Trout","Chalk Norris","Nail Bender","Captain of Crush","Realization",
];
const LEVEL_EMOJIS = ["🍔","💪","🥊","🏔️","⛰️","🤠","🐟","👊","🔨","💎","🏆"];

// ─────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────
const uid    = () => Math.random().toString(36).slice(2, 10);
const today  = () => new Date().toISOString().slice(0, 10);
const clamp  = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmt1   = (n) => (typeof n === "number" && isFinite(n)) ? n.toFixed(1) : "—";

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
  return LEVEL_TITLES[Math.min(level - 1, LEVEL_TITLES.length - 1)];
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
  const [connected,  setConnected]  = useState(false);
  const [force,      setForce]      = useState(0);
  const [peak,       setPeak]       = useState(0);
  const [avgForce,   setAvgForce]   = useState(0);
  const [bleError,   setBleError]   = useState(null);

  const ctrlRef             = useRef(null);
  const peakRef             = useRef(0);
  const sumRef              = useRef(0);   // running sum for average
  const countRef            = useRef(0);   // sample count for average
  const belowSinceRef       = useRef(null);
  const measuringRef        = useRef(false);
  const autoFailCallbackRef = useRef(null); // set by ActiveSessionView / CalibrationView
  const targetKgRef         = useRef(null); // set by ActiveSessionView each rep

  // Stable setter — lets views register/clear the callback without prop drilling
  const setAutoFailCallback = useCallback((fn) => {
    autoFailCallbackRef.current = fn ?? null;
  }, []);

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
      const server = await device.gatt.connect();
      const svc    = await server.getPrimaryService(TINDEQ_SERVICE);
      const dataC  = await svc.getCharacteristic(TINDEQ_NOTIFY);
      ctrlRef.current = await svc.getCharacteristic(TINDEQ_WRITE);

      dataC.addEventListener("characteristicvaluechanged", (evt) => {
        parseTindeqPacket(evt.target.value, ({ kg, ts }) => {
          setForce(kg);
          if (kg > peakRef.current) { peakRef.current = kg; setPeak(kg); }

          // Running average — only accumulate while measuring
          if (measuringRef.current && kg > 0) {
            sumRef.current   += kg;
            countRef.current += 1;
            setAvgForce(sumRef.current / countRef.current);
          }

          // Auto-failure: if force drops below 95% of target for >1.5 s, end the rep.
          // Uses target weight (not peak) so the bar is fixed and honest.
          // 1.5 s filters brief dips from grip shifts without letting a failed rep drag on.
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
        });
      });

      await dataC.startNotifications();
      device.addEventListener("gattserverdisconnected", () => setConnected(false));
      setConnected(true);
      return true;
    } catch (err) {
      setBleError(err.message || "Connection failed");
      return false;
    }
  }, []);

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

  return { connected, force, peak, avgForce, bleError, connect, startMeasuring, stopMeasuring, resetPeak, tare, targetKgRef, setAutoFailCallback };
}

// ─────────────────────────────────────────────────────────────
// SUPABASE HELPERS
// ─────────────────────────────────────────────────────────────
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
    id: "endurance", label: "Endurance", emoji: "🏔️",
    duration: null, color: C.blue,
    desc: "Hang to complete failure. Endure as long as possible.",
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

  // For endurance step: suggest ~50% of power step avg force
  const enduranceSuggestKg = results[0]?.avgForce > 0 ? results[0].avgForce * 0.5 : null;
  const targetKg = step.id === "endurance" ? enduranceSuggestKg : null;

  // Keep Tindeq auto-failure target in sync (endurance step only)
  useEffect(() => {
    tindeq.targetKgRef.current = (calPhase === "active" && step.id === "endurance")
      ? targetKg
      : null;
  }, [calPhase, step, targetKg, tindeq]);

  // Wire auto-failure → endHang for the endurance step only.
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
    // Endurance is always a failure rep by design; others are not
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
          {step.id === "endurance" && enduranceSuggestKg != null && (
            <div style={{ fontSize: 14, color: C.muted, marginTop: 20 }}>
              Target force: <b style={{ color: C.blue }}>{fmtW(enduranceSuggestKg, unit)} {unit}</b>
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
              {step.id === "endurance" && enduranceSuggestKg != null && (
                <span style={{ fontSize: 12, color: C.muted, marginLeft: 8 }}>
                  — target {fmtW(enduranceSuggestKg, unit)} {unit}
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
                  💡 Endurance target will be{" "}
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
function SetupView({ config, setConfig, onStart, onCalibrate, history, unit = "lbs", readiness = null, todaySubj = null, onSubjReadiness = () => {}, isEstimated = false }) {
  const [customGrip, setCustomGrip] = useState("");

  const handleGrip = (g) => setConfig(c => ({ ...c, grip: g }));
  const refWeightL = estimateRefWeight(history, "L", config.grip, config.targetTime);
  const refWeightR = estimateRefWeight(history, "R", config.grip, config.targetTime);

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
      <h2 style={{ margin: "0 0 20px", fontSize: 22, fontWeight: 700 }}>Session Setup</h2>

      {/* Calibration prompt — prominent when no history, subtle otherwise */}
      {history.length === 0 ? (
        <div style={{
          marginBottom: 20, padding: "16px 18px",
          background: "#0d1f3c", border: `1px solid ${C.blue}`,
          borderRadius: 12,
        }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.blue, marginBottom: 6 }}>
            📊 No training history yet
          </div>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 14, lineHeight: 1.6 }}>
            Run a quick 3-step calibration to seed your force-duration curve and get
            personalized weight suggestions from your very first session.
          </div>
          <Btn onClick={onCalibrate} style={{ width: "100%", padding: "12px 0", borderRadius: 10 }} color={C.blue}>
            Start Calibration →
          </Btn>
        </div>
      ) : (
        onCalibrate && (
          <div style={{
            marginBottom: 16, padding: "12px 16px",
            background: C.card, border: `1px solid ${C.border}`,
            borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16,
          }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>📊 Force-Duration Calibration</div>
              <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
                3-step test · seeds your Analysis curve
              </div>
            </div>
            <Btn small onClick={onCalibrate} color={C.blue}>Run →</Btn>
          </div>
        )
      )}

      <Card>
        <Sect title="Target Duration">
          <div style={{ display: "flex", gap: 10 }}>
            {TARGET_OPTIONS.map(opt => (
              <button
                key={opt.seconds}
                onClick={() => setConfig(c => ({ ...c, targetTime: opt.seconds }))}
                style={{
                  flex: 1, padding: "10px 0", borderRadius: 8, fontWeight: 700,
                  fontSize: 14, cursor: "pointer",
                  background: config.targetTime === opt.seconds ? C.blue : C.border,
                  color: config.targetTime === opt.seconds ? "#fff" : C.muted,
                  border: "none",
                }}
              >
                {opt.label}
                <div style={{ fontSize: 11, fontWeight: 400, marginTop: 2 }}>
                  {opt.seconds}s
                </div>
              </button>
            ))}
          </div>
        </Sect>

        <Sect title="Hand">
          <div style={{ display: "flex", gap: 10 }}>
            {["L", "R", "Both"].map(h => (
              <button
                key={h}
                onClick={() => setConfig(c => ({ ...c, hand: h }))}
                style={{
                  flex: 1, padding: "10px 0", borderRadius: 8, fontWeight: 700,
                  fontSize: 14, cursor: "pointer",
                  background: config.hand === h ? C.purple : C.border,
                  color: config.hand === h ? "#fff" : C.muted,
                  border: "none",
                }}
              >
                {h === "L" ? "Left" : h === "R" ? "Right" : "Both"}
              </button>
            ))}
          </div>
        </Sect>

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

      <Card>
        <Sect title="Set Structure">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div>
              <Label>Reps per set</Label>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Btn small onClick={() => setConfig(c => ({ ...c, repsPerSet: Math.max(1, c.repsPerSet - 1) }))}>−</Btn>
                <span style={{ fontSize: 24, fontWeight: 700, minWidth: 28, textAlign: "center" }}>{config.repsPerSet}</span>
                <Btn small onClick={() => setConfig(c => ({ ...c, repsPerSet: Math.min(10, c.repsPerSet + 1) }))}>+</Btn>
              </div>
              <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>1 – 10</div>
            </div>
            <div>
              <Label>Number of sets</Label>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Btn small onClick={() => setConfig(c => ({ ...c, numSets: Math.max(1, c.numSets - 1) }))}>−</Btn>
                <span style={{ fontSize: 24, fontWeight: 700, minWidth: 28, textAlign: "center" }}>{config.numSets}</span>
                <Btn small onClick={() => setConfig(c => ({ ...c, numSets: Math.min(10, c.numSets + 1) }))}>+</Btn>
              </div>
            </div>
          </div>
        </Sect>

        <Sect title="Rest Between Reps">
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <input
              type="range" min={3} max={240} step={1}
              value={config.restTime}
              onChange={e => setConfig(c => ({ ...c, restTime: Number(e.target.value) }))}
              style={{ flex: 1, accentColor: C.blue }}
            />
            <span style={{ fontSize: 20, fontWeight: 700, minWidth: 42, textAlign: "right" }}>
              {fmtTime(config.restTime)}
            </span>
          </div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>3 s – 4 min</div>
        </Sect>

        <Sect title="Rest Between Sets">
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <input
              type="range" min={60} max={600} step={30}
              value={config.setRestTime}
              onChange={e => setConfig(c => ({ ...c, setRestTime: Number(e.target.value) }))}
              style={{ flex: 1, accentColor: C.purple }}
            />
            <span style={{ fontSize: 20, fontWeight: 700, minWidth: 42, textAlign: "right" }}>
              {fmtTime(config.setRestTime)}
            </span>
          </div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>1 min – 10 min</div>
        </Sect>
      </Card>

      {(refWeightL != null || refWeightR != null) && (
        <Card style={{ borderColor: C.blue }}>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 8 }}>
            Suggested first-rep weight (from history, {config.targetTime}s target)
          </div>
          <div style={{ display: "flex", gap: 24 }}>
            {config.hand !== "R" && (
              <div>
                <Label>Left</Label>
                <span style={{ fontSize: 24, fontWeight: 700, color: C.blue }}>
                  {refWeightL != null ? `${fmtW(refWeightL, unit)} ${unit}` : "—"}
                </span>
              </div>
            )}
            {config.hand !== "L" && (
              <div>
                <Label>Right</Label>
                <span style={{ fontSize: 24, fontWeight: 700, color: C.blue }}>
                  {refWeightR != null ? `${fmtW(refWeightR, unit)} ${unit}` : "—"}
                </span>
              </div>
            )}
          </div>
        </Card>
      )}

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

  const handList = config.hand === "Both" ? ["L", "R"] : [config.hand];
  const sug = handList.length === 1 ? suggestions[handList[0]] : null;

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
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 8 }}>
            Rep {currentRep + 1} suggested weight
            {fatigue > 0.05 && <span style={{ marginLeft: 8, color: C.orange }}>(fatigue {Math.round(fatigue * 100)}%)</span>}
          </div>
          {config.hand === "Both" ? (
            <div style={{ display: "flex", gap: 32 }}>
              {handList.map(h => (
                <div key={h}>
                  <Label>{h === "L" ? "Left" : "Right"}</Label>
                  <span style={{ fontSize: 28, fontWeight: 700, color: C.blue }}>
                    {suggestions[h].suggested != null ? `${fmtW(suggestions[h].suggested, unit)} ${unit}` : "—"}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 36, fontWeight: 800, color: C.blue }}>
              {sug?.suggested != null ? `${fmtW(sug.suggested, unit)} ${unit}` : "—"}
            </div>
          )}
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
function RestView({ lastRep, nextWeight, restSeconds, onRestDone, setNum, numSets, repNum, repsPerSet, unit = "lbs" }) {
  const [remaining, setRemaining] = useState(restSeconds);
  const intervalRef = useRef(null);

  useEffect(() => {
    setRemaining(restSeconds);
    intervalRef.current = setInterval(() => {
      setRemaining(r => {
        if (r <= 1) { clearInterval(intervalRef.current); onRestDone(); return 0; }
        return r - 1;
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
                {fmtTime(lastRep.actualTime)}
              </span>
              <div style={{ fontSize: 11, color: C.muted }}>target {fmtTime(lastRep.targetTime)}</div>
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
        {fmtTime(remaining)}
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
        <Card style={{ background: "#1c1f0a", borderColor: C.yellow, marginBottom: 20 }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 48 }}>⭐</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: C.yellow }}>Badge Unlocked!</div>
            <div style={{ fontSize: 16, color: C.text, marginTop: 4 }}>
              {LEVEL_EMOJIS[Math.min(newLevel - 1, LEVEL_EMOJIS.length - 1)]} {levelTitle(newLevel)}
            </div>
            <div style={{ fontSize: 13, color: C.muted, marginTop: 6 }}>
              5% strength improvement achieved 💪
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
// CHARACTER VIEW
// ─────────────────────────────────────────────────────────────
function CharacterView({ history, unit = "lbs" }) {
  const [selHand,   setSelHand]   = useState("L");
  const [selTarget, setSelTarget] = useState(45);
  const [selGrip,   setSelGrip]   = useState("");
  const [charName,  setCharName]  = useState(() => loadLS("char_name") || "");
  const [editing,   setEditing]   = useState(false);
  const [nameInput, setNameInput] = useState("");

  const grips = useMemo(() => {
    return [...new Set(history.map(r => r.grip).filter(Boolean))].sort();
  }, [history]);

  const level    = calcLevel(history, selHand, selGrip, selTarget);
  const best     = getBestLoad(history, selHand, selGrip, selTarget);
  const nextTgt  = nextLevelTarget(history, selHand, selGrip, selTarget);
  const baseline = useMemo(
    () => getBaseline(history, selHand, selGrip, selTarget),
    [history, selHand, selGrip, selTarget]
  );

  // Sparkline: best load per month
  const sparkData = useMemo(() => {
    const byMonth = {};
    history
      .filter(r => r.hand === selHand && (!selGrip || r.grip === selGrip) &&
        r.target_duration === selTarget && effectiveLoad(r) > 0)
      .forEach(r => {
        const m = (r.date || "").slice(0, 7);
        if (!m) return;
        byMonth[m] = Math.max(byMonth[m] || 0, effectiveLoad(r));
      });
    return Object.entries(byMonth).sort().map(([m, v]) => ({ month: m, kg: toDisp(v, unit) }));
  }, [history, selHand, selGrip, selTarget, unit]);

  const saveName = () => {
    const n = nameInput.trim();
    setCharName(n);
    saveLS("char_name", n);
    setEditing(false);
  };

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
      <h2 style={{ margin: "0 0 16px", fontSize: 22 }}>Your Character</h2>

      {/* Character name */}
      <Card style={{ textAlign: "center", background: "linear-gradient(135deg, #161b22, #0d1117)", marginBottom: 16 }}>
        {editing ? (
          <div style={{ display: "flex", gap: 8, justifyContent: "center", alignItems: "center" }}>
            <input
              autoFocus
              value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") saveName(); if (e.key === "Escape") setEditing(false); }}
              placeholder="Enter your name"
              style={{
                background: C.border, border: "none", borderRadius: 8, padding: "8px 12px",
                color: C.text, fontSize: 18, fontWeight: 700, width: 200, textAlign: "center",
              }}
            />
            <button onClick={saveName} style={{
              background: C.green, border: "none", borderRadius: 8, color: "#000",
              padding: "8px 14px", fontWeight: 700, cursor: "pointer",
            }}>Save</button>
          </div>
        ) : (
          <div
            onClick={() => { setNameInput(charName); setEditing(true); }}
            style={{ cursor: "pointer" }}
            title="Click to set your name"
          >
            <div style={{ fontSize: 32, fontWeight: 800, color: C.yellow }}>
              {charName || <span style={{ color: C.muted, fontSize: 20 }}>Tap to set your name</span>}
            </div>
          </div>
        )}
        {best != null && (
          <div style={{ marginTop: 12, fontSize: 14, color: C.text }}>
            Best: <b style={{ color: C.blue }}>{fmtW(best, unit)} {unit}</b> at {fmtTime(selTarget)}
          </div>
        )}
        {nextTgt != null && (
          <div style={{ marginTop: 4, fontSize: 13, color: C.muted }}>
            Next badge at <b style={{ color: C.green }}>{fmtW(nextTgt, unit)} {unit}</b>
            {best != null && nextTgt > best && ` (+${fmtW(nextTgt - best, unit)} ${unit})`}
          </div>
        )}
        {sparkData.length === 0 && (
          <div style={{ marginTop: 12, fontSize: 13, color: C.muted }}>
            Log some sessions to see your progress!
          </div>
        )}
      </Card>

      {/* Filters */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: grips.length > 0 ? 12 : 0 }}>
          {["L","R"].map(h => (
            <button key={h} onClick={() => setSelHand(h)} style={{
              padding: "6px 18px", borderRadius: 20, cursor: "pointer", fontWeight: 600,
              background: selHand === h ? C.purple : C.border,
              color: selHand === h ? "#fff" : C.muted, border: "none",
            }}>{h === "L" ? "Left" : "Right"}</button>
          ))}
          {TARGET_OPTIONS.map(o => (
            <button key={o.seconds} onClick={() => setSelTarget(o.seconds)} style={{
              padding: "6px 18px", borderRadius: 20, cursor: "pointer", fontWeight: 600,
              background: selTarget === o.seconds ? C.blue : C.border,
              color: selTarget === o.seconds ? "#fff" : C.muted, border: "none",
            }}>{o.label}</button>
          ))}
        </div>
        {grips.length > 0 && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={() => setSelGrip("")} style={{
              padding: "4px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer",
              background: !selGrip ? C.orange : C.border,
              color: !selGrip ? "#fff" : C.muted, border: "none",
            }}>All Grips</button>
            {grips.map(g => (
              <button key={g} onClick={() => setSelGrip(g)} style={{
                padding: "4px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer",
                background: selGrip === g ? C.orange : C.border,
                color: selGrip === g ? "#fff" : C.muted, border: "none",
              }}>{g}</button>
            ))}
          </div>
        )}
      </Card>

      {/* Badge grid */}
      <Card>
        <div style={{ fontSize: 13, color: C.muted, marginBottom: 12 }}>Badges</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10 }}>
          {LEVEL_TITLES.map((title, i) => {
            // Badge 0 (Wimpy) = earned on first session; others need improvement over baseline
            const earned = i === 0 ? (baseline != null) : (level > i);
            const isCurrent = level === i + 1;
            // Threshold: badge 0 = baseline itself; badge i = baseline × LEVEL_STEP^i
            const threshold = baseline != null
              ? Math.round(baseline * Math.pow(LEVEL_STEP, i) * 10) / 10
              : null;
            return (
              <div key={title} style={{
                background: earned ? (isCurrent ? "#1c2a1c" : C.border) : C.card,
                border: `1px solid ${earned ? (isCurrent ? C.green : C.border) : C.border}`,
                borderRadius: 10, padding: "10px 12px",
                display: "flex", alignItems: "center", gap: 10,
              }}>
                <div style={{ fontSize: 28, lineHeight: 1, opacity: earned ? 1 : 0.4 }}>{LEVEL_EMOJIS[i]}</div>
                <div>
                  <div style={{
                    fontSize: 13, fontWeight: 700,
                    color: earned ? (isCurrent ? C.green : C.text) : C.muted,
                  }}>{title}</div>
                  {threshold != null && (
                    <div style={{ fontSize: 11, color: C.muted }}>
                      {earned ? "≥ " : ""}{fmtW(threshold, unit)} {unit}
                    </div>
                  )}
                </div>
                {earned && <div style={{ marginLeft: "auto", fontSize: 14, color: C.green }}>✓</div>}
                {!earned && <div style={{ marginLeft: "auto", fontSize: 14, color: C.muted }}>🔒</div>}
              </div>
            );
          })}
        </div>
      </Card>

      {/* Progress chart */}
      {sparkData.length > 1 && (
        <Card>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 8 }}>
            Monthly best load ({selTarget}s target)
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={sparkData}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
              <XAxis dataKey="month" tick={{ fill: C.muted, fontSize: 11 }} />
              <YAxis tick={{ fill: C.muted, fontSize: 11 }} unit={` ${unit}`} />
              <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, color: C.text }} />
              <Line type="monotone" dataKey="kg" stroke={C.blue} strokeWidth={2} dot={{ fill: C.blue }} name={`Best (${unit})`} />
            </LineChart>
          </ResponsiveContainer>
        </Card>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// HISTORY VIEW
// ─────────────────────────────────────────────────────────────
function HistoryView({ history, onDownload, unit = "lbs", onDeleteSession, onUpdateSession, notes = {}, onNoteChange }) {
  const [grip,        setGrip]        = useState("");
  const [hand,        setHand]        = useState("");
  const [target,      setTarget]      = useState(0);
  const [confirmKey,  setConfirmKey]  = useState(null);
  const [editKey,     setEditKey]     = useState(null);
  const [editHand,    setEditHand]    = useState("L");
  const [editGrip,    setEditGrip]    = useState("");
  const [noteKey,     setNoteKey]     = useState(null); // session currently showing note editor

  const grips = useMemo(() => [...new Set(history.map(r => r.grip).filter(Boolean))].sort(), [history]);

  const filtered = useMemo(() => history.filter(r =>
    (!grip   || r.grip === grip) &&
    (!hand   || r.hand === hand) &&
    (!target || r.target_duration === target)
  ), [history, grip, hand, target]);

  // Group by session_id then date
  const grouped = useMemo(() => {
    const map = {};
    for (const r of filtered) {
      const key = r.session_id || r.date;
      if (!map[key]) map[key] = { date: r.date, grip: r.grip, hand: r.hand, target_duration: r.target_duration, reps: [] };
      map[key].reps.push(r);
    }
    return Object.values(map).sort((a, b) => a.date < b.date ? 1 : -1);
  }, [filtered]);

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>History</h2>
        <Btn small onClick={onDownload} color={C.muted}>↓ CSV</Btn>
      </div>

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
                  {sess.hand === "L" ? "Left" : sess.hand === "R" ? "Right" : "Both"}
                  {" · "}{TARGET_OPTIONS.find(o => o.seconds === sess.target_duration)?.label ?? sess.target_duration + "s"}
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12, color: C.muted }}>{sess.date}</span>
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
                    <button onClick={() => { setEditKey(sessKey); setEditHand(sess.hand); setEditGrip(sess.grip); setConfirmKey(null); setNoteKey(null); }} style={{
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
              <div style={{ marginBottom: 10, padding: 10, background: C.bg, borderRadius: 8, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
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
                <button onClick={() => { onUpdateSession(sessKey, { hand: editHand, grip: editGrip }); setEditKey(null); }} style={{
                  background: C.green, border: "none", borderRadius: 6, color: "#000",
                  fontSize: 11, fontWeight: 700, padding: "4px 10px", cursor: "pointer",
                }}>Save</button>
                <button onClick={() => setEditKey(null)} style={{
                  background: C.border, border: "none", borderRadius: 6, color: C.muted,
                  fontSize: 11, padding: "4px 8px", cursor: "pointer",
                }}>Cancel</button>
              </div>
            )}

            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {sess.reps.sort((a, b) => a.set_num - b.set_num || a.rep_num - b.rep_num).map((r, j) => (
                <div key={j} style={{
                  padding: "4px 10px", borderRadius: 8, fontSize: 12,
                  background: r.actual_time_s >= sess.target_duration ? "#1a2f1a" : "#2f1a1a",
                  border: `1px solid ${r.actual_time_s >= sess.target_duration ? C.green : C.red}`,
                }}>
                  <b>{fmtW(effectiveLoad(r), unit)}{unit}</b> · {fmtTime(r.actual_time_s)}
                </div>
              ))}
            </div>

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
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// TRENDS VIEW
// ─────────────────────────────────────────────────────────────
function TrendsView({ history, unit = "lbs" }) {
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
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// ANALYSIS VIEW  — Force-Duration Curve + Training Recommendations
// ─────────────────────────────────────────────────────────────
// Zone boundaries (seconds)
const POWER_MAX    = 20;
const STRENGTH_MAX = 120;

function AnalysisView({ history, unit = "lbs", bodyWeight = null, onCalibrate = null, baseline = null }) {
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

  // ── IV Kinetics recovery model data ──
  // Shows how each energy compartment recovers over a rest period.
  // x = rest duration in seconds (0–1200s = 0–20 min)
  const recoveryData = useMemo(() => {
    const { A1, tau1, A2, tau2, A3, tau3 } = DEF_FAT;
    return Array.from({ length: 121 }, (_, i) => {
      const t   = i * 10; // 0, 10, 20 … 1200 s
      const pcr = Math.round((1 - Math.exp(-t / tau1)) * 100);
      const gly = Math.round((1 - Math.exp(-t / tau2)) * 100);
      const ox  = Math.round((1 - Math.exp(-t / tau3)) * 100);
      const tot = Math.round(
        (A1 * (1 - Math.exp(-t / tau1)) +
         A2 * (1 - Math.exp(-t / tau2)) +
         A3 * (1 - Math.exp(-t / tau3))) * 100
      );
      return { t, pcr, gly, ox, tot };
    });
  }, []);

  // ── Zone breakdown (power / strength / endurance) ──
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
      endurance: { ...zoneStats(STRENGTH_MAX, Infinity),      label: "Endurance", color: C.blue,   desc: "120s+",    system: "Oxidative",        tau: "τ₃ ≈ 600s" },
    };
  }, [reps]);

  // ── Training recommendation ──
  const recommendation = useMemo(() => {
    if (failures.length === 0) return null;
    const ranked = Object.entries(zones)
      .filter(([, z]) => z.failRate !== null)
      .sort(([, a], [, b]) => b.failRate - a.failRate);
    if (!ranked.length) return null;
    const [key, limiter] = ranked[0];
    const details = {
      power: {
        title:    "Train Power",
        insight:  "Your phosphocreatine system is the rate-limiter. Heavy, short maximal efforts with full recovery between sets are the prescription — quality over volume.",
        protocol: "5–10s hang  ·  90–100% max load  ·  3–5 min rest  ·  4–6 reps",
      },
      strength: {
        title:    "Train Strength",
        insight:  "Your glycolytic system is the rate-limiter. Progressive overload in your current time domain, or classic 7s-on / 3s-off repeaters, will drive the most adaptation.",
        protocol: "45s hang  ·  75–85% max  ·  3 min rest  ·  3–5 sets",
      },
      endurance: {
        title:    "Train Endurance",
        insight:  "Your oxidative system is the rate-limiter. Raising Critical Force is the highest-leverage move — it lifts the aerobic ceiling and improves every other zone by default.",
        protocol: "2–5 min hang  ·  40–60% max  ·  2 min rest  ·  3–4 sets",
      },
    };
    return { key, color: limiter.color, ...details[key] };
  }, [zones, failures]);

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
              { label: "🏔️ Endurance", val: improvement.endurance, color: C.blue   },
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
            <span><span style={{ color: C.blue }}>―</span> 🏔️ Endurance</span>
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
              <Line dataKey="endurance" stroke={C.blue}   strokeWidth={2} dot={false} name="Endurance" />
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
            <span style={{ color: C.blue }}>🔄 Endurance 120s+</span>
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
            <div style={{ fontSize: 12, color: C.muted, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
              Estimated from {cfEstimate.n} failure point{cfEstimate.n !== 1 ? "s" : ""}. Accuracy improves as failures span multiple time domains — try power hangs (5–10s) and endurance hangs (2+ min) to sharpen the curve.
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

        {/* ── Training recommendation ── */}
        {recommendation ? (
          <Card style={{ marginBottom: 16, border: `1px solid ${recommendation.color}` }}>
            <div style={{ fontSize: 11, color: recommendation.color, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>
              Recommended Focus
            </div>
            <div style={{ fontSize: 22, fontWeight: 800, color: recommendation.color, marginBottom: 10 }}>
              {recommendation.title}
            </div>
            <div style={{ fontSize: 13, color: C.text, marginBottom: 14, lineHeight: 1.6 }}>
              {recommendation.insight}
            </div>
            <div style={{ background: C.bg, borderRadius: 8, padding: "10px 14px", fontSize: 12, color: C.muted, fontFamily: "monospace", letterSpacing: "0.02em" }}>
              {recommendation.protocol}
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

      {/* ── IV Kinetics Recovery Model ── */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>
          Energy System Recovery
        </div>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 12, lineHeight: 1.6 }}>
          How each energy compartment recovers after a maximal effort.
          This is the three-compartment IV-kinetics model that drives your weight suggestions and rest timers.
        </div>

        {/* Legend */}
        <div style={{ display: "flex", gap: 16, fontSize: 11, color: C.muted, marginBottom: 8, flexWrap: "wrap" }}>
          <span><span style={{ color: C.red }}>―</span> ⚡ Phosphocreatine (PCr) τ=15s</span>
          <span><span style={{ color: C.orange }}>―</span> 💪 Glycolytic τ=90s</span>
          <span><span style={{ color: C.blue }}>―</span> 🏔️ Oxidative τ=600s</span>
          <span><span style={{ color: "#aaa" }}>―</span> Total</span>
        </div>

        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={recoveryData} margin={{ top: 8, right: 16, bottom: 28, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
            <XAxis
              dataKey="t"
              type="number"
              domain={[0, 1200]}
              tickFormatter={v => v < 60 ? `${v}s` : `${v / 60}m`}
              label={{ value: "Rest duration", position: "insideBottom", offset: -16, fill: C.muted, fontSize: 11 }}
              tick={{ fill: C.muted, fontSize: 10 }}
              ticks={[0, 30, 60, 120, 180, 300, 600, 900, 1200]}
            />
            <YAxis
              domain={[0, 100]}
              tick={{ fill: C.muted, fontSize: 11 }}
              unit="%"
              width={38}
            />
            <Tooltip
              contentStyle={{ background: C.card, border: `1px solid ${C.border}`, color: C.text, fontSize: 12 }}
              labelFormatter={v => v < 60 ? `Rest: ${v}s` : `Rest: ${fmt1(v / 60)} min`}
              formatter={(val, name) => [`${val}%`, name]}
            />
            {/* Reference lines for common rest periods */}
            <ReferenceLine x={30}  stroke={C.border} strokeDasharray="3 3"
              label={{ value: "30s", position: "top", fill: C.muted, fontSize: 9 }} />
            <ReferenceLine x={180} stroke={C.border} strokeDasharray="3 3"
              label={{ value: "3m",  position: "top", fill: C.muted, fontSize: 9 }} />
            <ReferenceLine x={300} stroke={C.border} strokeDasharray="3 3"
              label={{ value: "5m",  position: "top", fill: C.muted, fontSize: 9 }} />
            <Line dataKey="pcr" stroke={C.red}    strokeWidth={2} dot={false} name="PCr (⚡ Power)"     />
            <Line dataKey="gly" stroke={C.orange} strokeWidth={2} dot={false} name="Glycolytic (💪 Strength)" />
            <Line dataKey="ox"  stroke={C.blue}   strokeWidth={2} dot={false} name="Oxidative (🏔️ Endurance)" />
            <Line dataKey="tot" stroke="#888"      strokeWidth={1.5} dot={false} name="Total" strokeDasharray="4 2" />
          </LineChart>
        </ResponsiveContainer>

        {/* Interpretation guide */}
        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
          {[
            { color: C.red,    label: "30–45s rest",  text: "PCr ~95% recovered. Enough for next power rep; glycolytic still depleted." },
            { color: C.orange, label: "3–5 min rest", text: "Glycolytic ~85% recovered. Ideal between-set rest for strength training." },
            { color: C.blue,   label: "20–30 min rest", text: "Oxidative approaches full recovery. Required between maximal endurance efforts." },
          ].map(row => (
            <div key={row.label} style={{ display: "flex", gap: 10, fontSize: 12 }}>
              <div style={{ width: 70, flexShrink: 0, color: row.color, fontWeight: 700, fontSize: 11, paddingTop: 1 }}>
                {row.label}
              </div>
              <div style={{ color: C.muted, lineHeight: 1.5 }}>{row.text}</div>
            </div>
          ))}
        </div>
      </Card>

      </>)}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// SETTINGS VIEW
// ─────────────────────────────────────────────────────────────
function SettingsView({ user, loginEmail, setLoginEmail, onMagicLink, onSignOut, unit = "lbs", onUnitChange = () => {}, bodyWeight = null, onBWChange = () => {} }) {
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
              type="number" min={30} max={200} step={0.5}
              value={bodyWeight != null ? fmtW(bodyWeight, unit) : ""}
              onChange={e => {
                const v = e.target.value === "" ? null : fromDisp(Number(e.target.value), unit);
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
                ({unit === "lbs" ? `${fmt1(bodyWeight)} kg` : `${fmt1(bodyWeight * KG_TO_LBS)} lbs`})
              </span>
            )}
          </div>
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
const TABS = ["Train", "Character", "History", "Trends", "Analysis", "Settings"];

export default function App() {
  // ── Auth ──────────────────────────────────────────────────
  const [user,       setUser]       = useState(null);
  const [loginEmail, setLoginEmail] = useState("");

  // ── Unit preference ───────────────────────────────────────
  const [unit, setUnit] = useState(() => loadLS("unit_pref") || "lbs");
  const saveUnit = (u) => { setUnit(u); saveLS("unit_pref", u); };

  // ── Body weight ───────────────────────────────────────────
  const [bodyWeight, setBodyWeight] = useState(() => loadLS(LS_BW_KEY) ?? null);
  const saveBW = (kg) => { setBodyWeight(kg); saveLS(LS_BW_KEY, kg); };

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
    // updates: { hand?, grip? }
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

  // ── Calibration mode ──────────────────────────────────────
  const [calMode, setCalMode] = useState(false);

  // Permanent baseline snapshot — set once from first calibration, never overwritten.
  const [baseline, setBaseline] = useState(() => loadLS(LS_BASELINE_KEY));

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
    setTab(4); // navigate to Analysis tab
  }, [addReps]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Session Config ────────────────────────────────────────
  const [config, setConfig] = useState(() => ({
    hand:       "L",
    grip:       "",
    repsPerSet: 5,
    numSets:    3,
    targetTime: 45,
    restTime:   20,
    setRestTime: 180,
  }));

  // ── Session State Machine ─────────────────────────────────
  // phase: 'idle' | 'rep_ready' | 'rep_active' | 'resting' | 'between_sets' | 'switch_hands' | 'done'
  const [phase,       setPhase]       = useState("idle");
  const [currentSet,  setCurrentSet]  = useState(0);
  const [currentRep,  setCurrentRep]  = useState(0);
  const [fatigue,     setFatigue]     = useState(0);
  const [sessionReps, setSessionReps] = useState([]);
  const [sessionId,   setSessionId]   = useState("");
  const [refWeights,  setRefWeights]  = useState({});
  const [lastRepResult, setLastRepResult] = useState(null);
  const [leveledUp,   setLeveledUp]   = useState(false);
  const [newLevel,    setNewLevel]    = useState(1);
  const [activeHand,  setActiveHand]  = useState("L"); // tracks current hand in Both mode

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
    setSessionId(sid);
    setRefWeights(rw);
    setSessionReps([]);
    setCurrentSet(0);
    setCurrentRep(0);
    setFatigue(0);
    setLeveledUp(false);
    setLastRepResult(null);
    setActiveHand(config.hand === "Both" ? "L" : config.hand);
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
      rest_s:          config.restTime,
      session_id:      sessionId,
      failed:          failed,
    };

    setLastRepResult({ actualTime, avgForce, targetTime: config.targetTime });
    setSessionReps(reps => [...reps, repRecord]);
    addReps([repRecord]);

    // Update fatigue
    const sMax = config.hand === "R" ? sMaxR : sMaxL;
    const dose = fatigueDose(weight, actualTime, sMax);
    setFatigue(f => Math.min(f + dose, 0.95));

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
  }, [config, currentRep, currentSet, fatigue, refWeights, sessionId, sessionReps, addReps, sMaxL, sMaxR, activeHand]);

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
    // Decay fatigue over the rest period, then auto-start the next rep
    setFatigue(f => fatigueAfterRest(f, config.restTime));
    setPhase("rep_active"); // autoStart=true — no button needed
  }, [config.restTime]);

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
            {t === "Train" && phase !== "idle" && (
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
          return (
            <>
              <SetupView
                config={config}
                setConfig={setConfig}
                onStart={startSession}
                onCalibrate={() => setCalMode(true)}
                history={history}
                unit={unit}
                readiness={readiness}
                todaySubj={todaySubj}
                onSubjReadiness={handleSubjReadiness}
                isEstimated={todaySubj == null}
              />
              {/* Tindeq connect button */}
              <div style={{ maxWidth: 480, margin: "0 auto", padding: "0 16px 32px" }}>
                <Card>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 600 }}>Tindeq Progressor</div>
                      <div style={{ fontSize: 12, color: C.muted }}>
                        {tindeq.connected ? "Connected ✓" : tindeq.bleError || "Not connected"}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      {tindeq.connected && (
                        <Btn small onClick={tindeq.tare} color={C.muted}>Tare</Btn>
                      )}
                      <Btn
                        small
                        onClick={tindeq.connect}
                        disabled={tindeq.connected}
                        color={tindeq.connected ? C.green : C.blue}
                      >
                        {tindeq.connected ? "Connected" : "Connect BLE"}
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
            </>
          );
        }

        if (phase === "rep_ready" || phase === "rep_active") {
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

        if (phase === "resting") {
          return (
            <RestView
              lastRep={lastRepResult}
              nextWeight={nextWeight}
              restSeconds={config.restTime}
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

      {tab === 1 && <CharacterView history={history} unit={unit} />}
      {tab === 2 && <HistoryView history={history} onDownload={() => downloadCSV(history)} unit={unit} onDeleteSession={deleteSession} onUpdateSession={updateSession} notes={notes} onNoteChange={handleNoteChange} />}
      {tab === 3 && <TrendsView history={history} unit={unit} />}
      {tab === 4 && <AnalysisView history={history} unit={unit} bodyWeight={bodyWeight} baseline={baseline} onCalibrate={() => { setCalMode(true); setTab(0); }} />}
      {tab === 5 && (
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
        />
      )}
    </div>
  );
}
