// src/App.js
import React, { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
  Scatter,
} from "recharts";

/* =========================
   LocalStorage keys
   ========================= */
const LS = {
  tab: "ft_tab_v4",
  paramsL: "ft_params_left_v4",
  paramsR: "ft_params_right_v4",
  histL: "ft_history_left_v4",
  histR: "ft_history_right_v4",
  ui: "ft_ui_v4",
};

/* =========================
   Helpers
   ========================= */
const uid = () => Math.random().toString(36).slice(2, 10);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const isNum = (x) => Number.isFinite(+x);
const N = (x, d = 0) => (isNum(x) ? +x : d);
const round1 = (x) => Math.round(x * 10) / 10;

function loadLS(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function saveLS(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {}
}

/* =========================
   Defaults (per hand)
   ========================= */
const defaultParams = {
  // Fatigue (3-exponential)
  tau1: 7,
  tau2: 45,
  tau3: 180,
  w1: 0.5,
  w2: 0.3,
  w3: 0.2,
  // Recovery (3-exponential)
  rTau1: 30,
  rTau2: 300,
  rTau3: 1800,
  // Learning (EMA anchors @ 20/60/180s)
  ema20: null,
  ema60: null,
  ema180: null,
  emaAlpha: 0.35,
};

const defaultUI = {
  tMax: 300,
  nextTUTL: 60,
  nextTUTR: 60,
  planReps: 5,
  planRest: 180,
};

/* =========================
   Core model
   ========================= */
// remaining fraction after T seconds
function fatigueAt(t, p) {
  const W = Math.max(1e-9, p.w1 + p.w2 + p.w3);
  const a = p.w1 / W, b = p.w2 / W, c = p.w3 / W;
  const e1 = Math.exp(-t / Math.max(1e-9, p.tau1));
  const e2 = Math.exp(-t / Math.max(1e-9, p.tau2));
  const e3 = Math.exp(-t / Math.max(1e-9, p.tau3));
  return a * e1 + b * e2 + c * e3;
}

function buildCurve(p, tMax = 300, step = 10) {
  const out = [];
  for (let t = 0; t <= tMax; t += step) out.push({ t, f: fatigueAt(t, p) });
  return out;
}

// fraction (0..1) recovered during rest seconds
function recoveryFrac(rest, p) {
  const r1 = p.rTau1 ?? 30;
  const r2 = p.rTau2 ?? 300;
  const r3 = p.rTau3 ?? 1800;
  const W = Math.max(1e-9, p.w1 + p.w2 + p.w3);
  const a = p.w1 / W, b = p.w2 / W, c = p.w3 / W;
  const R1 = 1 - Math.exp(-rest / Math.max(1e-9, r1));
  const R2 = 1 - Math.exp(-rest / Math.max(1e-9, r2));
  const R3 = 1 - Math.exp(-rest / Math.max(1e-9, r3));
  return a * R1 + b * R2 + c * R3;
}

// nearest-by-time record
function nearestByTime(history, targetT) {
  if (!history.length) return null;
  return history.reduce((best, r) => {
    const d = Math.abs(r.duration - targetT);
    if (!best) return r;
    return d < Math.abs(best.duration - targetT) ? r : best;
  }, null);
}

// fit beta: log(L) = c − beta * log(t)
function estimateBeta(history) {
  const H = history.slice(-6);
  if (H.length < 2) return 0.35;
  const xs = H.map((r) => Math.log(Math.max(1, r.duration)));
  const ys = H.map((r) => Math.log(Math.max(0.1, r.load)));
  const xbar = xs.reduce((a, b) => a + b, 0) / xs.length;
  const ybar = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - xbar) * (ys[i] - ybar);
    den += (xs[i] - xbar) ** 2;
  }
  const slope = den ? num / den : 0;
  return clamp(-slope, 0.15, 0.8);
}

function scaleLoadByBeta(targetT, neighbor, beta) {
  const t1 = Math.max(1, neighbor.duration);
  const L1 = Math.max(0.1, neighbor.load);
  const t2 = Math.max(1, targetT);
  return L1 * Math.pow(t1 / t2, beta);
}

// learn EMA anchors from nearest-to-20/60/180s (stabilized by beta)
function learnAnchors(history, params) {
  if (!history.length) return params;
  const beta = estimateBeta(history);
  const alpha = params.emaAlpha ?? 0.35;
  const next = { ...params };
  [
    { t: 20, key: "ema20" },
    { t: 60, key: "ema60" },
    { t: 180, key: "ema180" },
  ].forEach(({ t, key }) => {
    const n = nearestByTime(history, t);
    if (!n) return;
    const est = scaleLoadByBeta(t, n, beta);
    const prev = next[key];
    next[key] = prev == null ? est : prev * (1 - alpha) + est * alpha;
  });
  return next;
}

// log–log interpolation across available anchors
function modelLoadForT(params, T) {
  const refs = [
    { t: 20, L: params.ema20 },
    { t: 60, L: params.ema60 },
    { t: 180, L: params.ema180 },
  ].filter((r) => r.L != null);
  if (!refs.length) return null;
  if (refs.length === 1) {
    const only = refs[0];
    const beta = 0.35;
    return scaleLoadByBeta(T, { duration: only.t, load: only.L }, beta);
    }
  const pts = refs
    .map((r) => ({ x: Math.log(r.t), y: Math.log(Math.max(0.1, r.L)) }))
    .sort((a, b) => a.x - b.x);
  const x = Math.log(Math.max(1, T));
  let i = 0;
  while (i < pts.length - 1 && x > pts[i + 1].x) i++;
  i = clamp(i, 0, pts.length - 2);
  const p = pts[i], q = pts[i + 1];
  const t = (x - p.x) / Math.max(1e-9, q.x - p.x);
  const y = p.y * (1 - t) + q.y * t;
  return Math.exp(y);
}

// multi-set plan (account for fatigue within set & recovery between sets)
function planLoads(baseSingleSetLoad, TUT, reps, rest, params) {
  if (!baseSingleSetLoad || reps <= 0) return [];
  const loads = [];
  let A = 1.0;
  const fT = fatigueAt(TUT, params);
  const R = recoveryFrac(rest, params);
  for (let i = 0; i < reps; i++) {
    const L_i = Math.max(0, baseSingleSetLoad * A);
    loads.push(round1(L_i));
    const afterSet = A * fT;
    A = afterSet + (1 - afterSet) * R;
  }
  return loads;
}

/* =========================
   App
   ========================= */
export default function App() {
  // Tabs
  const [tab, setTab] = useState(() => loadLS(LS.tab, "recommend"));
  useEffect(() => saveLS(LS.tab, tab), [tab]);

  // UI
  const [ui, setUI] = useState(() => loadLS(LS.ui, defaultUI));
  useEffect(() => saveLS(LS.ui, ui), [ui]);

  // Params per hand
  const [pL, setPL] = useState(() => loadLS(LS.paramsL, { ...defaultParams }));
  const [pR, setPR] = useState(() => loadLS(LS.paramsR, { ...defaultParams }));
  useEffect(() => saveLS(LS.paramsL, pL), [pL]);
  useEffect(() => saveLS(LS.paramsR, pR), [pR]);

  // History per hand
  const [hL, setHL] = useState(() => loadLS(LS.histL, []));
  const [hR, setHR] = useState(() => loadLS(LS.histR, []));
  useEffect(() => saveLS(LS.histL, hL), [hL]);
  useEffect(() => saveLS(LS.histR, hR), [hR]);

  // Curves
  const curveL = useMemo(() => buildCurve(pL, ui.tMax, 10), [pL, ui.tMax]);
  const curveR = useMemo(() => buildCurve(pR, ui.tMax, 10), [pR, ui.tMax]);

  // Reco (base single-set)
  const betaL = useMemo(() => estimateBeta(hL), [hL]);
  const betaR = useMemo(() => estimateBeta(hR), [hR]);
  const nearL = useMemo(() => nearestByTime(hL, ui.nextTUTL), [hL, ui.nextTUTL]);
  const nearR = useMemo(() => nearestByTime(hR, ui.nextTUTR), [hR, ui.nextTUTR]);
  const modelL = useMemo(() => modelLoadForT(pL, ui.nextTUTL), [pL, ui.nextTUTL]);
  const modelR = useMemo(() => modelLoadForT(pR, ui.nextTUTR), [pR, ui.nextTUTR]);
  const ratioL = useMemo(() => (nearL ? scaleLoadByBeta(ui.nextTUTL, nearL, betaL) : null), [nearL, ui.nextTUTL, betaL]);
  const ratioR = useMemo(() => (nearR ? scaleLoadByBeta(ui.nextTUTR, nearR, betaR) : null), [nearR, ui.nextTUTR, betaR]);

  const baseLeft = useMemo(() => {
    if (modelL != null && ratioL != null) return round1((modelL + ratioL) / 2);
    return round1(modelL ?? ratioL ?? 0);
  }, [modelL, ratioL]);
  const baseRight = useMemo(() => {
    if (modelR != null && ratioR != null) return round1((modelR + ratioR) / 2);
    return round1(modelR ?? ratioR ?? 0);
  }, [modelR, ratioR]);

  // Plans
  const planLeft = useMemo(
    () => planLoads(baseLeft, ui.nextTUTL, ui.planReps, ui.planRest, pL),
    [baseLeft, ui.nextTUTL, ui.planReps, ui.planRest, pL]
  );
  const planRight = useMemo(
    () => planLoads(baseRight, ui.nextTUTR, ui.planReps, ui.planRest, pR),
    [baseRight, ui.nextTUTR, ui.planReps, ui.planRest, pR]
  );

  // Sessions CRUD
  const [form, setForm] = useState({ hand: "L", load: "", duration: "", rest: "180", notes: "" });

  const onAdd = () => {
    const rec = {
      id: uid(),
      date: new Date().toISOString(),
      hand: form.hand,
      load: N(form.load, 0),
      duration: N(form.duration, 0),
      rest: N(form.rest, 0),
      notes: form.notes || "",
    };
    if (!rec.load || !rec.duration) return;
    if (rec.hand === "L") setHL((a) => [...a, rec]);
    else setHR((a) => [...a, rec]);
    setForm((f) => ({ ...f, load: "", duration: "", notes: "" }));
  };

  const onEdit = (hand, id) => {
    const list = hand === "L" ? hL : hR;
    const rec = list.find((r) => r.id === id);
    if (!rec) return;
    const load = prompt("Load (lb):", String(rec.load));
    if (load == null) return;
    const dur = prompt("Duration (s):", String(rec.duration));
    if (dur == null) return;
    const rest = prompt("Rest (s):", String(rec.rest));
    if (rest == null) return;
    const notes = prompt("Notes:", rec.notes || "");
    const upd = { ...rec, load: N(load, rec.load), duration: N(dur, rec.duration), rest: N(rest, rec.rest), notes: notes ?? rec.notes };
    if (hand === "L") setHL((arr) => arr.map((r) => (r.id === id ? upd : r)));
    else setHR((arr) => arr.map((r) => (r.id === id ? upd : r)));
  };

  const onDelete = (hand, id) => {
    if (!window.confirm("Delete this record permanently?")) return;
    if (hand === "L") setHL((arr) => arr.filter((r) => r.id !== id));
    else setHR((arr) => arr.filter((r) => r.id !== id));
  };

  const clearAll = () => {
    if (!window.confirm("⚠️ Clear ALL history (Left & Right)? This cannot be undone.")) return;
    setHL([]);
    setHR([]);
  };

  // Learn buttons
  const learnLeft = () => setPL((p) => learnAnchors(hL, p));
  const learnRight = () => setPR((p) => learnAnchors(hR, p));

  // Backup
  const exportJSON = () => {
    const blob = new Blob(
      [JSON.stringify({ paramsL: pL, paramsR: pR, historyL: hL, historyR: hR, ui }, null, 2)],
      { type: "application/json" }
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `finger-training-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const importJSON = (file) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (data.paramsL) setPL(data.paramsL);
        if (data.paramsR) setPR(data.paramsR);
        if (Array.isArray(data.historyL)) setHL(data.historyL);
        if (Array.isArray(data.historyR)) setHR(data.historyR);
        if (data.ui) setUI((u) => ({ ...u, ...data.ui }));
      } catch {
        alert("Invalid JSON file.");
      }
    };
    reader.readAsText(file);
  };

  /* =========================
     UI
     ========================= */
  return (
    <div style={{ maxWidth: 1200, margin: "18px auto", padding: "0 14px" }}>
      <h1 style={{ margin: 0 }}>Finger Training — Precision Dosing (Per Hand)</h1>
      <p style={{ margin: "6px 0 16px", color: "#555" }}>
        Side-by-side recommendations (Model vs Ratio), learn from history, and plan loads across multiple sets using your fatigue & recovery model.
      </p>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        {["model", "recommend", "sessions", "history"].map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: "8px 12px",
              borderRadius: 8,
              border: "1px solid #ccc",
              background: tab === t ? "#0b74ff" : "white",
              color: tab === t ? "white" : "#222",
              fontWeight: 600,
              cursor: "pointer",
              textTransform: "capitalize",
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {/* ===== MODEL ===== */}
      {tab === "model" && (
        <div style={{ display: "grid", gridTemplateColumns: "310px 1fr", gap: 12 }}>
          {/* Controls */}
          <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
            <h3 style={{ marginTop: 0 }}>Parameters (affect both hands unless noted)</h3>
            <Section title="Fatigue τ (s)">
              <ParamSlider label="τ1 fast" value={pL.tau1} min={3} max={30} step={1}
                onChange={(v) => { setPL((p)=>({...p, tau1:v})); setPR((p)=>({...p, tau1:v})); }} />
              <ParamSlider label="τ2 medium" value={pL.tau2} min={20} max={120} step={1}
                onChange={(v) => { setPL((p)=>({...p, tau2:v})); setPR((p)=>({...p, tau2:v})); }} />
              <ParamSlider label="τ3 slow" value={pL.tau3} min={120} max={600} step={10}
                onChange={(v) => { setPL((p)=>({...p, tau3:v})); setPR((p)=>({...p, tau3:v})); }} />
            </Section>

            <Section title="Weights (w1/w2/w3)">
              <ParamSlider label="w1 fast" value={pL.w1} min={0.05} max={0.9} step={0.05}
                onChange={(v) => { setPL((p)=>({...p, w1:v})); setPR((p)=>({...p, w1:v})); }} />
              <ParamSlider label="w2 medium" value={pL.w2} min={0.05} max={0.9} step={0.05}
                onChange={(v) => { setPL((p)=>({...p, w2:v})); setPR((p)=>({...p, w2:v})); }} />
              <ParamSlider label="w3 slow" value={pL.w3} min={0.05} max={0.9} step={0.05}
                onChange={(v) => { setPL((p)=>({...p, w3:v})); setPR((p)=>({...p, w3:v})); }} />
              <div style={{ fontSize: 12, color: "#666", marginTop: 4 }}>
                Weights are normalized automatically inside the model, so they don’t need to sum to 1.
              </div>
            </Section>

            <Section title="Recovery τ (s)">
              <ParamSlider label="rτ1 fast" value={pL.rTau1} min={5} max={120} step={5}
                onChange={(v) => { setPL((p)=>({...p, rTau1:v})); setPR((p)=>({...p, rTau1:v})); }} />
              <ParamSlider label="rτ2 medium" value={pL.rTau2} min={60} max={900} step={15}
                onChange={(v) => { setPL((p)=>({...p, rTau2:v})); setPR((p)=>({...p, rTau2:v})); }} />
              <ParamSlider label="rτ3 slow" value={pL.rTau3} min={600} max={3600} step={60}
                onChange={(v) => { setPL((p)=>({...p, rTau3:v})); setPR((p)=>({...p, rTau3:v})); }} />
            </Section>

            <Section title="Learning">
              <ParamSlider label="EMA α (anchor smoothing)" value={pL.emaAlpha} min={0.05} max={0.8} step={0.05}
                onChange={(v) => { setPL((p)=>({...p, emaAlpha:v})); setPR((p)=>({...p, emaAlpha:v})); }} />
            </Section>

            <div style={{ marginTop: 12 }}>
              <label>Chart max time (s): </label>
              <input
                type="number"
                value={ui.tMax}
                onChange={(e) => setUI((u) => ({ ...u, tMax: clamp(N(e.target.value, 300), 60, 600) }))}
                style={{ width: 110, padding: 6 }}
              />
              <div style={{ color: "#666", marginTop: 4 }}>
                Try 300–400 s if you never work past 180 s.
              </div>
            </div>
          </div>

          {/* Curves + points */}
          <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
            <h3 style={{ marginTop: 0 }}>Fatigue Curve f(t) with Your Sets</h3>
            <ResponsiveContainer width="100%" height={380}>
              <LineChart data={curveL} margin={{ top: 10, right: 20, bottom: 16, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  type="number"
                  dataKey="t"
                  domain={[0, ui.tMax]}
                  label={{ value: "Time (s)", position: "insideBottomRight", offset: -5 }}
                />
                <YAxis
                  type="number"
                  domain={[0, 1]}
                  tickFormatter={(v) => (v * 100).toFixed(0) + "%"}
                  label={{ value: "Fatigue (norm.)", angle: -90, offset: 10, position: "insideLeft" }}
                />
                <Tooltip formatter={(v) => (typeof v === "number" ? (v * 100).toFixed(1) + "%" : v)} />
                <Legend />
                <Line type="monotone" dataKey="f" name="Model (Left params)" dot={false} strokeWidth={2} />
                <Line
                  type="monotone"
                  dataKey="fR"
                  name="Model (Right params)"
                  dot={false}
                  strokeDasharray="4 4"
                  stroke="#8884d8"
                  data={curveR.map((d) => ({ ...d, fR: d.f }))}
                />
                <Scatter
                  name="Left sets"
                  data={hL.map((r) => ({ t: r.duration, y: fatigueAt(r.duration, pL) }))}
                  fill="#333"
                />
                <Scatter
                  name="Right sets"
                  data={hR.map((r) => ({ t: r.duration, y: fatigueAt(r.duration, pR) }))}
                  fill="#666"
                />
              </LineChart>
            </ResponsiveContainer>
            <div style={{ fontSize: 12, color: "#666", marginTop: 6 }}>
              If it looks too linear, try decreasing τ3 and/or increasing w1/w2 a bit, or extend the window.
            </div>
          </div>
        </div>
      )}

      {/* ===== RECOMMEND ===== */}
      {tab === "recommend" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <RecPanel
            title="Left Hand"
            nextTUT={ui.nextTUTL}
            onSetTUT={(v) => setUI((u) => ({ ...u, nextTUTL: v }))}
            modelLoad={modelL}
            ratioLoad={ratioL}
            combined={baseLeft}
            near={nearL}
            onLearn={learnLeft}
            planLoads={planLeft}
            planReps={ui.planReps}
            planRest={ui.planRest}
          />
          <RecPanel
            title="Right Hand"
            nextTUT={ui.nextTUTR}
            onSetTUT={(v) => setUI((u) => ({ ...u, nextTUTR: v }))}
            modelLoad={modelR}
            ratioLoad={ratioR}
            combined={baseRight}
            near={nearR}
            onLearn={learnRight}
            planLoads={planRight}
            planReps={ui.planReps}
            planRest={ui.planRest}
          />

          {/* Shared plan settings */}
          <div style={{ gridColumn: "1 / span 2", border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
            <h3 style={{ marginTop: 0 }}>Multi-Set Plan Settings</h3>
            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <label>Reps</label>
              <input
                type="number"
                value={ui.planReps}
                onChange={(e) => setUI((u) => ({ ...u, planReps: clamp(N(e.target.value, u.planReps), 1, 30) }))}
                style={{ width: 90, padding: 6 }}
              />
              <label>Rest (s)</label>
              <input
                type="number"
                value={ui.planRest}
                onChange={(e) => setUI((u) => ({ ...u, planRest: clamp(N(e.target.value, u.planRest), 0, 3600) }))}
                style={{ width: 110, padding: 6 }}
              />
              <span style={{ color: "#666" }}>
                Loads taper across sets to keep each set near your target TUT.
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ===== SESSIONS (earlier layout restored) ===== */}
      {tab === "sessions" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12 }}>
          <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
            <h3 style={{ marginTop: 0 }}>Log a Session</h3>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "90px 120px 120px 120px 1fr 120px",
                gap: 8,
                alignItems: "center",
              }}
            >
              <div>
                <label>Hand</label>
                <select
                  value={form.hand}
                  onChange={(e) => setForm((f) => ({ ...f, hand: e.target.value }))}
                  style={{ width: "100%", padding: 6 }}
                >
                  <option value="L">Left</option>
                  <option value="R">Right</option>
                </select>
              </div>
              <div>
                <label>Load (lb)</label>
                <input
                  type="number"
                  value={form.load}
                  onChange={(e) => setForm((f) => ({ ...f, load: e.target.value }))}
                  style={{ width: "100%", padding: 6 }}
                />
              </div>
              <div>
                <label>Duration (s)</label>
                <input
                  type="number"
                  value={form.duration}
                  onChange={(e) => setForm((f) => ({ ...f, duration: e.target.value }))}
                  style={{ width: "100%", padding: 6 }}
                />
              </div>
              <div>
                <label>Rest (s)</label>
                <input
                  type="number"
                  value={form.rest}
                  onChange={(e) => setForm((f) => ({ ...f, rest: e.target.value }))}
                  style={{ width: "100%", padding: 6 }}
                />
              </div>
              <div>
                <label>Notes</label>
                <input
                  type="text"
                  value={form.notes}
                  onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                  style={{ width: "100%", padding: 6 }}
                  placeholder="optional"
                />
              </div>
              <div>
                <button onClick={onAdd} style={{ width: "100%", padding: 10 }}>
                  + Add
                </button>
              </div>
            </div>
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={learnLeft}>Learn Left</button>
            <button onClick={learnRight}>Learn Right</button>
          </div>
        </div>
      )}

      {/* ===== HISTORY (earlier layout restored) ===== */}
      {tab === "history" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <HistoryTable title="Left History" rows={hL} onEdit={(id) => onEdit("L", id)} onDelete={(id) => onDelete("L", id)} />
          <HistoryTable title="Right History" rows={hR} onEdit={(id) => onEdit("R", id)} onDelete={(id) => onDelete("R", id)} />
          <div style={{ gridColumn: "1 / span 2", display: "flex", gap: 8 }}>
            <button onClick={exportJSON}>Export JSON</button>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span>Import JSON</span>
              <input type="file" accept="application/json" onChange={(e) => e.target.files?.[0] && importJSON(e.target.files[0])} />
            </label>
            <button onClick={clearAll} style={{ marginLeft: "auto", color: "#b00020" }}>
              Clear ALL history…
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* =========================
   Small UI pieces
   ========================= */
function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  );
}

function ParamSlider({ label, value, min, max, step, onChange }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <label>{label}</label>
        <div style={{ fontVariantNumeric: "tabular-nums" }}>{round1(value)}</div>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(N(e.target.value, value))}
        style={{ width: "100%" }}
      />
    </div>
  );
}

function RecPanel({
  title,
  nextTUT,
  onSetTUT,
  modelLoad,
  ratioLoad,
  combined,
  near,
  onLearn,
  planLoads,
  planReps,
  planRest,
}) {
  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
        <label>Target TUT (s)</label>
        <input type="number" value={nextTUT} onChange={(e) => onSetTUT(N(e.target.value, nextTUT))} style={{ width: 100, padding: 6 }} />
        <button onClick={onLearn}>Learn</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
        <MetricCard label="Model-Based" value={modelLoad != null ? `${round1(modelLoad)} lb` : "—"} help="Interpolates learned 20/60/180 anchors." />
        <MetricCard label="Ratio-Based" value={ratioLoad != null ? `${round1(ratioLoad)} lb` : "—"} help="Nearest set scaled by L ∝ t^{-β}." />
      </div>

      <div style={{ fontWeight: 600, marginBottom: 8 }}>
        Single-Set Suggestion: {combined ? `${combined} lb @ ${nextTUT}s` : "Add history and click Learn"}
      </div>

      {planLoads && planLoads.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            Multi-Set Plan ({planReps} sets, rest {planRest}s):
          </div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {planLoads.map((L, i) => (
              <li key={i}>Set {i + 1}: {L} lb</li>
            ))}
          </ul>
          <div style={{ fontSize: 12, color: "#666", marginTop: 6 }}>
            Loads taper across sets using your fatigue/recovery model to keep each set near {nextTUT}s.
          </div>
        </div>
      )}

      <div style={{ fontSize: 13, color: "#666", marginTop: 8 }}>
        {near ? <>Nearest set: {near.load} lb @ {near.duration}s {near.notes ? `— ${near.notes}` : ""}</> : "No nearby set yet."}
      </div>
    </div>
  );
}

function MetricCard({ label, value, help }) {
  return (
    <div style={{ border: "1px solid #eee", borderRadius: 8, padding: 10, background: "#fafafa" }}>
      <div style={{ fontSize: 12, color: "#666" }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700 }}>{value}</div>
      <div style={{ fontSize: 12, color: "#777", marginTop: 4 }}>{help}</div>
    </div>
  );
}

function HistoryTable({ title, rows, onEdit, onDelete }) {
  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      {rows.length === 0 ? (
        <div style={{ color: "#666" }}>No sessions yet.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#fafafa" }}>
                <Th>Date</Th>
                <Th>Load (lb)</Th>
                <Th>Duration (s)</Th>
                <Th>Rest (s)</Th>
                <Th>Notes</Th>
                <Th>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {rows.slice().reverse().map((r) => (
                <tr key={r.id}>
                  <Td>{new Date(r.date).toLocaleString()}</Td>
                  <Td>{r.load}</Td>
                  <Td>{r.duration}</Td>
                  <Td>{r.rest}</Td>
                  <Td>{r.notes || "—"}</Td>
                  <Td>
                    <button onClick={() => onEdit(r.id)} style={{ marginRight: 6 }}>Edit</button>
                    <button onClick={() => onDelete(r.id)} style={{ color: "#b00020" }}>Delete</button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const Th = ({ children }) => (
  <th style={{ textAlign: "left", padding: "8px 6px", borderBottom: "1px solid #eee", fontWeight: 600, fontSize: 13, color: "#333" }}>
    {children}
  </th>
);
const Td = ({ children }) => (
  <td style={{ padding: "8px 6px", borderBottom: "1px solid #f0f0f0" }}>{children}</td>
);