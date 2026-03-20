// src/App.js  — Finger Training v3
// Rep-based sessions · Three-Compartment Fatigue Model · Tindeq Progressor BLE · Gamification
import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import { supabase } from "./lib/supabase";
import {
  ResponsiveContainer, LineChart, Line,
  XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from "recharts";

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────
const LS_KEY = "ft_v3";

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

const LEVEL_STEP = 1.05; // 5% improvement per level

const LEVEL_TITLES = [
  "Rock Toucher","Gym Rat","Projector","Crusher","Boulderer",
  "Route Climber","Crimper","Pocket Puller","Flash Artist","Legend",
];

// ─────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────
const uid    = () => Math.random().toString(36).slice(2, 10);
const today  = () => new Date().toISOString().slice(0, 10);
const clamp  = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmt1   = (n) => (typeof n === "number" && isFinite(n)) ? n.toFixed(1) : "—";
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
    r.weight_kg > 0
  );
  if (matches.length === 0) return null;
  const sorted = [...matches].sort((a, b) => a.date < b.date ? -1 : 1).slice(-10);
  let wSum = 0, wKg = 0;
  sorted.forEach((r, i) => { const w = i + 1; wSum += w; wKg += r.weight_kg * w; });
  return wKg / wSum;
}

function suggestWeight(refWeight, fatigue) {
  if (refWeight == null) return null;
  return Math.round(refWeight * availFrac(fatigue) * 10) / 10;
}

// ─────────────────────────────────────────────────────────────
// GAMIFICATION
// ─────────────────────────────────────────────────────────────
function getBestLoad(history, hand, grip, targetDuration) {
  const matches = history.filter(r =>
    r.hand === hand &&
    (!grip || r.grip === grip) &&
    r.target_duration === targetDuration &&
    r.weight_kg > 0
  );
  if (matches.length === 0) return null;
  return Math.max(...matches.map(r => r.weight_kg));
}

function calcLevel(history, hand, grip, targetDuration) {
  const matches = history.filter(r =>
    r.hand === hand &&
    (!grip || r.grip === grip) &&
    r.target_duration === targetDuration &&
    r.weight_kg > 0
  ).sort((a, b) => a.date < b.date ? -1 : 1);
  if (matches.length < 2) return 1;
  const baseline = matches[0].weight_kg;
  const best = Math.max(...matches.map(r => r.weight_kg));
  if (best <= baseline) return 1;
  return Math.max(1, 1 + Math.floor(Math.log(best / baseline) / Math.log(LEVEL_STEP)));
}

function levelTitle(level) {
  return LEVEL_TITLES[Math.min(level - 1, LEVEL_TITLES.length - 1)];
}

function nextLevelPct(history, hand, grip, targetDuration) {
  const best = getBestLoad(history, hand, grip, targetDuration);
  if (!best) return null;
  return Math.round(best * LEVEL_STEP * 10) / 10;
}

// ─────────────────────────────────────────────────────────────
// TINDEQ PROGRESSOR BLUETOOTH HOOK
// ─────────────────────────────────────────────────────────────
// BLE packet format (Progressor firmware):
//   Byte 0     : response code (0x01 = weight data)
//   Bytes 1..N : samples, each 8 bytes:
//                  [0..3] float32 LE — weight in kg
//                  [4..7] uint32  LE — timestamp in µs from session start
//
// If your device uses a different format, update parseTindeqPacket().
function parseTindeqPacket(dataView, onSample) {
  if (dataView.byteLength < 1) return;
  if (dataView.getUint8(0) !== RESPONSE_WEIGHT) return;
  let offset = 1;
  while (offset + 8 <= dataView.byteLength) {
    const kg = dataView.getFloat32(offset, /* littleEndian= */ true);
    const ts = dataView.getUint32(offset + 4, true); // µs
    onSample({ kg: Math.max(0, kg), ts });
    offset += 8;
  }
}

function useTindeq({ onAutoFailure }) {
  const [connected,  setConnected]  = useState(false);
  const [force,      setForce]      = useState(0);
  const [peak,       setPeak]       = useState(0);
  const [bleError,   setBleError]   = useState(null);

  const ctrlRef          = useRef(null);
  const peakRef          = useRef(0);
  const belowSinceRef    = useRef(null);
  const measuringRef     = useRef(false);
  const onAutoFailureRef = useRef(onAutoFailure);
  useEffect(() => { onAutoFailureRef.current = onAutoFailure; }, [onAutoFailure]);

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
        parseTindeqPacket(evt.target.value, ({ kg }) => {
          setForce(kg);
          if (kg > peakRef.current) { peakRef.current = kg; setPeak(kg); }

          // Auto failure detection: force < 50% of peak for >500 ms
          if (measuringRef.current && peakRef.current > 1.0) {
            if (kg < peakRef.current * 0.50) {
              if (!belowSinceRef.current) belowSinceRef.current = Date.now();
              else if (Date.now() - belowSinceRef.current > 500) {
                measuringRef.current  = false;
                belowSinceRef.current = null;
                onAutoFailureRef.current?.();
              }
            } else {
              belowSinceRef.current = null;
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
    peakRef.current = 0; setPeak(0); setForce(0);
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

  return { connected, force, peak, bleError, connect, startMeasuring, stopMeasuring, resetPeak, tare };
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
//     peak_force_kg real, set_num integer, rep_num integer,
//     rest_s integer, session_id text
//   );
//   ALTER TABLE reps ENABLE ROW LEVEL SECURITY;
//   CREATE POLICY "auth_all" ON reps FOR ALL USING (auth.uid() IS NOT NULL);
async function pushRep(rep) {
  const { error } = await supabase.from("reps").insert([{
    date: rep.date, grip: rep.grip, hand: rep.hand,
    target_duration: rep.target_duration, weight_kg: rep.weight_kg,
    actual_time_s: rep.actual_time_s, peak_force_kg: rep.peak_force_kg,
    set_num: rep.set_num, rep_num: rep.rep_num,
    rest_s: rep.rest_s, session_id: rep.session_id,
  }]);
  if (error) console.warn("Supabase push:", error.message);
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
    peak_force_kg: Number(r.peak_force_kg) || 0,
    set_num: Number(r.set_num) || 1,
    rep_num: Number(r.rep_num) || 1,
    rest_s: Number(r.rest_s) || 20,
    session_id: r.session_id ?? "",
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
      <div style={{ fontSize: 72, fontWeight: 800, fontVariantNumeric: "tabular-nums", color, lineHeight: 1 }}>
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

function ForceGauge({ force, peak, maxDisplay = 50 }) {
  const fPct   = clamp(force / maxDisplay, 0, 1);
  const pkPct  = clamp(peak  / maxDisplay, 0, 1);
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.muted, marginBottom: 4 }}>
        <span>Force</span>
        <span>Peak: <b style={{ color: C.orange }}>{fmt1(peak)} kg</b></span>
      </div>
      <div style={{ position: "relative", height: 28, background: C.border, borderRadius: 6, overflow: "hidden" }}>
        <div style={{ position: "absolute", height: "100%", width: `${fPct * 100}%`, background: C.blue, borderRadius: 6, transition: "width 0.05s" }} />
        <div style={{ position: "absolute", top: 0, bottom: 0, left: `${pkPct * 100}%`, width: 2, background: C.orange }} />
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, display: "flex", alignItems: "center", paddingLeft: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "#fff", mixBlendMode: "difference" }}>
            {fmt1(force)} kg
          </span>
        </div>
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
// SETUP VIEW
// ─────────────────────────────────────────────────────────────
function SetupView({ config, setConfig, onStart, history }) {
  const [customGrip, setCustomGrip] = useState("");

  const handleGrip = (g) => setConfig(c => ({ ...c, grip: g }));
  const refWeightL = estimateRefWeight(history, "L", config.grip, config.targetTime);
  const refWeightR = estimateRefWeight(history, "R", config.grip, config.targetTime);

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
      <h2 style={{ margin: "0 0 20px", fontSize: 22, fontWeight: 700 }}>Session Setup</h2>

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
                  {refWeightL != null ? `${fmt1(refWeightL)} kg` : "—"}
                </span>
              </div>
            )}
            {config.hand !== "L" && (
              <div>
                <Label>Right</Label>
                <span style={{ fontSize: 24, fontWeight: 700, color: C.blue }}>
                  {refWeightR != null ? `${fmt1(refWeightR)} kg` : "—"}
                </span>
              </div>
            )}
          </div>
        </Card>
      )}

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
function ActiveSessionView({ session, onRepDone, onAbort, tindeq }) {
  const { config, currentSet, currentRep, fatigue } = session;
  const [elapsed,       setElapsed]       = useState(0);
  const [repRunning,    setRepRunning]    = useState(false);
  const [manualWeight,  setManualWeight]  = useState(null);
  const startTimeRef = useRef(null);
  const timerRef     = useRef(null);

  // Compute suggested weight for each hand
  const suggestions = useMemo(() => {
    const handList = config.hand === "Both" ? ["L", "R"] : [config.hand];
    return Object.fromEntries(
      handList.map(h => [h, {
        ref: session.refWeights?.[h] ?? null,
        suggested: suggestWeight(session.refWeights?.[h] ?? null, fatigue),
      }])
    );
  }, [config.hand, session.refWeights, fatigue]);

  // Start timer
  const startRep = useCallback(async () => {
    setElapsed(0);
    startTimeRef.current = Date.now();
    setRepRunning(true);
    if (tindeq.connected) await tindeq.tare(); // auto-tare at rep start
    if (tindeq.connected) await tindeq.startMeasuring();
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 100);
  }, [tindeq]);

  // Stop / record — works for manual tap OR Tindeq auto-detect
  const endRep = useCallback(async (autoFail = false) => {
    if (!startTimeRef.current) return; // no rep in progress
    clearInterval(timerRef.current);
    const actualTime = (Date.now() - startTimeRef.current) / 1000;
    startTimeRef.current = null; // prevent double-fire
    setRepRunning(false);
    if (tindeq.connected) await tindeq.stopMeasuring();
    onRepDone({
      actualTime: actualTime,
      peakForce:  tindeq.peak,
    });
  }, [tindeq, onRepDone]);

  // Auto-fail callback from Tindeq
  useEffect(() => {
    if (tindeq.connected) {
      // The hook calls onAutoFailure — we wire it via ref in parent
    }
  }, [tindeq.connected]);

  // Wire auto-fail
  useEffect(() => {
    tindeq._autoFailRef && (tindeq._autoFailRef.current = () => endRep(true));
  });

  useEffect(() => () => clearInterval(timerRef.current), []);

  const handList = config.hand === "Both" ? ["L", "R"] : [config.hand];
  const sug = handList.length === 1 ? suggestions[handList[0]] : null;

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 13, color: C.muted }}>Set {currentSet + 1} of {config.numSets}</div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>
            {config.grip} · {config.hand === "Both" ? "Both Hands" : config.hand === "L" ? "Left" : "Right"}
          </div>
        </div>
        <Btn small color={C.red} onClick={onAbort}>End Session</Btn>
      </div>

      <RepDots total={config.repsPerSet} done={currentRep} current={currentRep} />

      {/* Timer */}
      <Card>
        <BigTimer seconds={elapsed} targetSeconds={config.targetTime} running={repRunning} />

        {/* Force gauge (Tindeq) */}
        {tindeq.connected && (
          <ForceGauge force={tindeq.force} peak={tindeq.peak} />
        )}

        {!tindeq.connected && (
          <div style={{ fontSize: 12, color: C.muted, textAlign: "center", marginTop: 8 }}>
            No Tindeq connected — tap "Failure" when you can't hold on.
          </div>
        )}
      </Card>

      {/* Weight suggestion */}
      <Card>
        <div style={{ fontSize: 13, color: C.muted, marginBottom: 8 }}>
          Rep {currentRep + 1} suggested weight
          {fatigue > 0.05 && (
            <span style={{ marginLeft: 8, color: C.orange }}>
              (fatigue {Math.round(fatigue * 100)}%)
            </span>
          )}
        </div>
        {config.hand === "Both" ? (
          <div style={{ display: "flex", gap: 32 }}>
            {handList.map(h => (
              <div key={h}>
                <Label>{h === "L" ? "Left" : "Right"}</Label>
                <span style={{ fontSize: 28, fontWeight: 700, color: C.blue }}>
                  {suggestions[h].suggested != null ? `${fmt1(suggestions[h].suggested)} kg` : "—"}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 36, fontWeight: 800, color: C.blue }}>
            {sug?.suggested != null ? `${fmt1(sug.suggested)} kg` : "Enter manually ↓"}
          </div>
        )}

        {/* Manual override */}
        <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="number" min={0} step={0.5}
            value={manualWeight ?? ""}
            onChange={e => setManualWeight(e.target.value === "" ? null : Number(e.target.value))}
            placeholder="Override kg…"
            style={{ width: 120, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px", color: C.text, fontSize: 15 }}
          />
          <span style={{ fontSize: 12, color: C.muted }}>kg (override)</span>
        </div>
      </Card>

      {/* Controls */}
      <div style={{ display: "flex", gap: 12 }}>
        {!repRunning ? (
          <Btn
            onClick={startRep}
            style={{ flex: 1, padding: "18px 0", fontSize: 18, borderRadius: 12 }}
            color={C.green}
          >
            ▶ Start Rep
          </Btn>
        ) : (
          <Btn
            onClick={() => endRep(false)}
            style={{ flex: 1, padding: "18px 0", fontSize: 18, borderRadius: 12 }}
            color={C.red}
          >
            ✕ Failure
          </Btn>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// REST VIEW
// ─────────────────────────────────────────────────────────────
function RestView({ lastRep, nextWeight, restSeconds, onRestDone, setNum, numSets, repNum, repsPerSet }) {
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
                  {fmt1(lastRep.peakForce)} kg
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
            {fmt1(nextWeight)} kg
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
function BetweenSetsView({ completedSet, totalSets, onNextSet }) {
  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "40px 16px", textAlign: "center" }}>
      <div style={{ fontSize: 48 }}>🏔️</div>
      <h2 style={{ margin: "12px 0 8px" }}>Set {completedSet} of {totalSets} done!</h2>
      <p style={{ color: C.muted, marginBottom: 32 }}>
        Rest as long as you need before the next set.
      </p>
      {completedSet < totalSets && (
        <Btn
          onClick={onNextSet}
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
function SessionSummaryView({ reps, config, leveledUp, newLevel, onDone }) {
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
  const maxPeak    = Math.max(...reps.map(r => r.peak_force_kg), 0);
  const maxWeight  = Math.max(...reps.map(r => r.weight_kg), 0);

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
      {leveledUp && (
        <Card style={{ background: "#1c1f0a", borderColor: C.yellow, marginBottom: 20 }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 48 }}>⭐</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: C.yellow }}>Level Up!</div>
            <div style={{ fontSize: 16, color: C.text, marginTop: 4 }}>
              You are now Level {newLevel} — {levelTitle(newLevel)}!
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
            <div style={{ fontSize: 28, fontWeight: 700 }}>{fmt1(maxWeight)} kg</div>
          </div>
          {maxPeak > 0 && (
            <div style={{ gridColumn: "1 / -1" }}>
              <Label>Peak Force (Tindeq)</Label>
              <div style={{ fontSize: 22, fontWeight: 700, color: C.orange }}>{fmt1(maxPeak)} kg</div>
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
                {maxPeak > 0 && <th style={{ textAlign: "right", paddingBottom: 6 }}>Peak F</th>}
              </tr>
            </thead>
            <tbody>
              {sReps.map(r => (
                <tr key={r.rep_num} style={{ borderTop: `1px solid ${C.border}` }}>
                  <td style={{ padding: "6px 0" }}>{r.rep_num}</td>
                  <td style={{ textAlign: "right" }}>{fmt1(r.weight_kg)} kg</td>
                  <td style={{ textAlign: "right", color: r.actual_time_s >= config.targetTime ? C.green : C.red }}>
                    {fmtTime(r.actual_time_s)}
                  </td>
                  {maxPeak > 0 && (
                    <td style={{ textAlign: "right", color: C.orange }}>
                      {r.peak_force_kg > 0 ? `${fmt1(r.peak_force_kg)} kg` : "—"}
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
function CharacterView({ history }) {
  const [selHand, setSelHand]   = useState("L");
  const [selTarget, setSelTarget] = useState(45);
  const [selGrip,  setSelGrip]  = useState("");

  const grips = useMemo(() => {
    return [...new Set(history.map(r => r.grip).filter(Boolean))].sort();
  }, [history]);

  const level     = calcLevel(history, selHand, selGrip, selTarget);
  const best      = getBestLoad(history, selHand, selGrip, selTarget);
  const nextPct   = nextLevelPct(history, selHand, selGrip, selTarget);
  const title     = levelTitle(level);

  // Sparkline: best load per month
  const sparkData = useMemo(() => {
    const byMonth = {};
    history
      .filter(r => r.hand === selHand && (!selGrip || r.grip === selGrip) && r.target_duration === selTarget && r.weight_kg > 0)
      .forEach(r => {
        const m = (r.date || "").slice(0, 7);
        if (!m) return;
        byMonth[m] = Math.max(byMonth[m] || 0, r.weight_kg);
      });
    return Object.entries(byMonth).sort().map(([m, v]) => ({ month: m, kg: v }));
  }, [history, selHand, selGrip, selTarget]);

  const emoji = ["🧗","🧗‍♂️","🏔️","⛰️","🌟","⭐","🔥","💎","👑","🏆"][Math.min(level - 1, 9)];

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
      <h2 style={{ margin: "0 0 16px", fontSize: 22 }}>Your Character</h2>

      {/* Filters */}
      <Card>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
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

      {/* Character card */}
      <Card style={{ textAlign: "center", background: "linear-gradient(135deg, #161b22, #0d1117)" }}>
        <div style={{ fontSize: 72, lineHeight: 1, marginBottom: 8 }}>{emoji}</div>
        <div style={{ fontSize: 36, fontWeight: 800, color: C.yellow }}>Level {level}</div>
        <div style={{ fontSize: 18, color: C.muted, marginTop: 4 }}>{title}</div>
        {best != null && (
          <div style={{ marginTop: 16, fontSize: 14, color: C.text }}>
            Best: <b style={{ color: C.blue }}>{fmt1(best)} kg</b> at {fmtTime(selTarget)}
          </div>
        )}
        {nextPct != null && (
          <div style={{ marginTop: 8, fontSize: 13, color: C.muted }}>
            Next level at <b style={{ color: C.green }}>{fmt1(nextPct)} kg</b>
            {best != null && ` (+${fmt1(nextPct - best)} kg)`}
          </div>
        )}
        {sparkData.length === 0 && (
          <div style={{ marginTop: 16, fontSize: 13, color: C.muted }}>
            Log some sessions to see your progress!
          </div>
        )}
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
              <YAxis tick={{ fill: C.muted, fontSize: 11 }} unit=" kg" />
              <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, color: C.text }} />
              <Line type="monotone" dataKey="kg" stroke={C.blue} strokeWidth={2} dot={{ fill: C.blue }} name="Best (kg)" />
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
function HistoryView({ history, onDownload }) {
  const [grip,   setGrip]   = useState("");
  const [hand,   setHand]   = useState("");
  const [target, setTarget] = useState(0);

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

      {grouped.slice(0, 30).map((sess, i) => (
        <Card key={i} style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
            <div>
              <b>{sess.grip}</b>
              <span style={{ marginLeft: 8, fontSize: 12, color: C.muted }}>
                {sess.hand === "L" ? "Left" : sess.hand === "R" ? "Right" : "Both"}
                {" · "}{TARGET_OPTIONS.find(o => o.seconds === sess.target_duration)?.label ?? sess.target_duration + "s"}
              </span>
            </div>
            <span style={{ fontSize: 12, color: C.muted }}>{sess.date}</span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {sess.reps.sort((a, b) => a.set_num - b.set_num || a.rep_num - b.rep_num).map((r, j) => (
              <div key={j} style={{
                padding: "4px 10px", borderRadius: 8, fontSize: 12,
                background: r.actual_time_s >= sess.target_duration ? "#1a2f1a" : "#2f1a1a",
                border: `1px solid ${r.actual_time_s >= sess.target_duration ? C.green : C.red}`,
              }}>
                <b>{fmt1(r.weight_kg)}kg</b> · {fmtTime(r.actual_time_s)}
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// TRENDS VIEW
// ─────────────────────────────────────────────────────────────
function TrendsView({ history }) {
  const [sel, setSel] = useState(45);

  const data = useMemo(() => {
    const byDate = {};
    for (const r of history.filter(r => r.target_duration === sel && r.weight_kg > 0)) {
      const d = r.date || "";
      if (!byDate[d]) byDate[d] = { date: d, L: 0, R: 0 };
      if (r.hand === "L") byDate[d].L = Math.max(byDate[d].L, r.weight_kg);
      if (r.hand === "R") byDate[d].R = Math.max(byDate[d].R, r.weight_kg);
    }
    return Object.values(byDate).sort((a, b) => a.date < b.date ? -1 : 1);
  }, [history, sel]);

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
      <h2 style={{ margin: "0 0 16px", fontSize: 22 }}>Trends</h2>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {TARGET_OPTIONS.map(o => (
          <button key={o.seconds} onClick={() => setSel(o.seconds)} style={{
            flex: 1, padding: "8px 0", borderRadius: 8, cursor: "pointer", fontWeight: 600,
            background: sel === o.seconds ? C.blue : C.border,
            color: sel === o.seconds ? "#fff" : C.muted, border: "none",
          }}>{o.label}</button>
        ))}
      </div>
      {data.length === 0 ? (
        <div style={{ textAlign: "center", color: C.muted, marginTop: 60 }}>
          No data for this target yet.
        </div>
      ) : (
        <Card>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 8 }}>
            Best daily load · {TARGET_OPTIONS.find(o => o.seconds === sel)?.label} ({sel}s)
          </div>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
              <XAxis dataKey="date" tick={{ fill: C.muted, fontSize: 10 }} />
              <YAxis tick={{ fill: C.muted, fontSize: 11 }} unit=" kg" />
              <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, color: C.text }} />
              <Legend />
              <Line type="monotone" dataKey="L" stroke={C.blue}   strokeWidth={2} dot={false} name="Left"  connectNulls />
              <Line type="monotone" dataKey="R" stroke={C.orange} strokeWidth={2} dot={false} name="Right" connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </Card>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// SETTINGS VIEW
// ─────────────────────────────────────────────────────────────
function SettingsView({ user, loginEmail, setLoginEmail, onMagicLink, onSignOut }) {
  const [showSQL, setShowSQL] = useState(false);
  const sql = `-- Run this once in your Supabase SQL editor:
CREATE TABLE reps (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  date text, grip text, hand text,
  target_duration integer,
  weight_kg real, actual_time_s real,
  peak_force_kg real,
  set_num integer, rep_num integer,
  rest_s integer, session_id text
);
ALTER TABLE reps ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_all" ON reps
  FOR ALL USING (auth.uid() IS NOT NULL);`;

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
      <h2 style={{ margin: "0 0 16px", fontSize: 22 }}>Settings</h2>

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
        <Sect title="Supabase Setup">
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 10 }}>
            If this is a fresh install, run this SQL in your Supabase project to create the new <code>reps</code> table.
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
const TABS = ["Train", "Character", "History", "Trends", "Settings"];

export default function App() {
  // ── Auth ──────────────────────────────────────────────────
  const [user,       setUser]       = useState(null);
  const [loginEmail, setLoginEmail] = useState("");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setUser(data.session?.user ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setUser(s?.user ?? null));
    return () => sub.subscription.unsubscribe();
  }, []);

  // ── History (all reps) ───────────────────────────────────
  const [history, setHistory] = useState(() => loadLS(LS_KEY) || []);
  useEffect(() => saveLS(LS_KEY, history), [history]);

  // Load from Supabase when signed in
  useEffect(() => {
    if (!user) return;
    fetchReps().then(reps => { if (reps) setHistory(reps); });
  }, [user]);

  const addReps = useCallback((newReps) => {
    setHistory(h => {
      const existing = new Set(h.map(r => r.id));
      const fresh    = newReps.filter(r => !existing.has(r.id));
      return [...fresh, ...h];
    });
    if (user) newReps.forEach(pushRep);
  }, [user]);

  // ── Tab ───────────────────────────────────────────────────
  const [tab, setTab] = useState(0);

  // ── Session Config ────────────────────────────────────────
  const [config, setConfig] = useState(() => ({
    hand:       "L",
    grip:       "",
    repsPerSet: 5,
    numSets:    3,
    targetTime: 45,
    restTime:   20,
  }));

  // ── Session State Machine ─────────────────────────────────
  // phase: 'idle' | 'rep_ready' | 'rep_active' | 'resting' | 'between_sets' | 'done'
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

  // Max strength estimate (for fatigue dose calculation)
  const sMaxL = useMemo(() => {
    const best = getBestLoad(history, "L", config.grip, config.targetTime);
    return best ? best * 1.2 : 20; // estimate ceiling 20% above best
  }, [history, config.grip, config.targetTime]);
  const sMaxR = useMemo(() => {
    const best = getBestLoad(history, "R", config.grip, config.targetTime);
    return best ? best * 1.2 : 20;
  }, [history, config.grip, config.targetTime]);

  // ── Tindeq ────────────────────────────────────────────────
  const autoFailRef = useRef(null);
  const tindeq = useTindeq({ onAutoFailure: () => autoFailRef.current?.() });
  // Also expose an _autoFailRef for ActiveSessionView to wire
  tindeq._autoFailRef = autoFailRef;

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
    setPhase("rep_ready");
    setTab(0); // stay on Train tab
  }, [history, config]);

  // ── Handle rep completion ─────────────────────────────────
  const handleRepDone = useCallback(({ actualTime, peakForce }) => {
    const weight = (() => {
      const hands = config.hand === "Both" ? ["L", "R"] : [config.hand];
      // Use suggested weight (already shown to user); average for Both
      const ws = hands.map(h => suggestWeight(refWeights[h], fatigue)).filter(Boolean);
      return ws.length > 0 ? ws.reduce((a, b) => a + b, 0) / ws.length : 0;
    })();

    const repRecord = {
      id:              uid(),
      date:            today(),
      grip:            config.grip,
      hand:            config.hand === "Both" ? "B" : config.hand,
      target_duration: config.targetTime,
      weight_kg:       Math.round(weight * 10) / 10,
      actual_time_s:   Math.round(actualTime * 10) / 10,
      peak_force_kg:   Math.round((peakForce || 0) * 10) / 10,
      set_num:         currentSet + 1,
      rep_num:         currentRep + 1,
      rest_s:          config.restTime,
      session_id:      sessionId,
    };

    setLastRepResult({ actualTime, peakForce, targetTime: config.targetTime });
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
        // Session done — check for level up
        finishSession([...sessionReps, repRecord]);
      } else {
        setCurrentSet(nextSet);
        setCurrentRep(0);
        setFatigue(0); // reset fatigue between sets
        setPhase("between_sets");
      }
    } else {
      setCurrentRep(nextRep);
      setPhase("resting");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, currentRep, currentSet, fatigue, refWeights, sessionId, sessionReps, addReps, sMaxL, sMaxR]);

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
    // After rest, apply fatigue decay then start next rep
    setFatigue(f => fatigueAfterRest(f, config.restTime));
    setPhase("rep_ready");
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
    const hand = config.hand === "Both" ? "L" : config.hand;
    return suggestWeight(refWeights[hand], restFatigue);
  }, [phase, fatigue, config.restTime, config.hand, refWeights]);

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

      {/* Train tab */}
      {tab === 0 && (() => {
        if (phase === "idle") {
          return (
            <>
              <SetupView config={config} setConfig={setConfig} onStart={startSession} history={history} />
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
                      Live force: <b style={{ color: C.blue }}>{tindeq.force.toFixed(1)} kg</b>
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
              session={{ config, currentSet, currentRep, fatigue, sessionId, refWeights }}
              onRepDone={handleRepDone}
              onAbort={handleAbort}
              tindeq={tindeq}
            />
          );
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
            />
          );
        }

        if (phase === "between_sets") {
          return (
            <BetweenSetsView
              completedSet={currentSet}
              totalSets={config.numSets}
              onNextSet={handleNextSet}
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
            />
          );
        }

        return null;
      })()}

      {tab === 1 && <CharacterView history={history} />}
      {tab === 2 && <HistoryView history={history} onDownload={() => downloadCSV(history)} />}
      {tab === 3 && <TrendsView history={history} />}
      {tab === 4 && (
        <SettingsView
          user={user}
          loginEmail={loginEmail}
          setLoginEmail={setLoginEmail}
          onMagicLink={sendMagicLink}
          onSignOut={signOut}
        />
      )}
    </div>
  );
}
