// src/App.js
import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "./lib/supabase";
import {
  ResponsiveContainer,
  ComposedChart,
  LineChart,
  Line,
  Scatter,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
  ReferenceLine,
} from "recharts";

/* ====================== Utilities ====================== */

const LS_KEY = "ft_state_v2";
const uid = () => Math.random().toString(36).slice(2);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const eps = 1e-9;

const loadLS = () => {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};
const saveLS = (s) => {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s));
  } catch {}
};

// CSV
function csvEscape(v = "") {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCSV(rows) {
  const headers = [
    "id",
    "date",
    "grip",
    "leftLoad",
    "leftDur",
    "rightLoad",
    "rightDur",
    "rest",
    "notes",
  ];
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.id,
        r.date,
        r.grip,
        r.leftLoad,
        r.leftDur,
        r.rightLoad,
        r.rightDur,
        r.rest,
        r.notes,
      ]
        .map(csvEscape)
        .join(",")
    );
  }
  return "\uFEFF" + lines.join("\n");
}
function downloadCSV(rows, name = "finger-training-history.csv") {
  if (!rows?.length) return;
  const blob = new Blob([toCSV(rows)], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ====================== Model ====================== */

// 3-exponential curve f(t) in [0..1] (remaining capacity fraction)
function normalizeWeights(w1, w2, w3) {
  const s = Math.max(1e-9, Number(w1) + Number(w2) + Number(w3));
  return { w1n: w1 / s, w2n: w2 / s, w3n: w3 / s };
}
function fAt(t, w, tau) {
  const { w1n, w2n, w3n } = normalizeWeights(w.w1, w.w2, w.w3);
  const e1 = Math.exp(-t / Math.max(1e-9, tau.t1));
  const e2 = Math.exp(-t / Math.max(1e-9, tau.t2));
  const e3 = Math.exp(-t / Math.max(1e-9, tau.t3));
  return w1n * e1 + w2n * e2 + w3n * e3; // remaining capacity after t
}
function recoveryFrac(t, tau) {
  // simple complementary recovery proxy using same taus
  const e1 = 1 - Math.exp(-t / Math.max(1e-9, tau.t1));
  const e2 = 1 - Math.exp(-t / Math.max(1e-9, tau.t2));
  const e3 = 1 - Math.exp(-t / Math.max(1e-9, tau.t3));
  return (e1 + e2 + e3) / 3;
}

// History → (t, L) points per hand
function historyPoints(history, hand) {
  return history
    .map((r) =>
      hand === "L"
        ? { t: Number(r.leftDur) || 0, L: Number(r.leftLoad) || 0 }
        : { t: Number(r.rightDur) || 0, L: Number(r.rightLoad) || 0 }
    )
    .filter((p) => p.t > 0 && p.L > 0)
    .sort((a, b) => a.t - b.t);
}

// Robust ratio interpolation (monotone, log-space)
function ratioLoadForT(targetT, pts) {
  if (!pts?.length) return 0;

  // 1) Aggregate duplicates (same TUT) by averaging load
  const byT = new Map();
  for (const p of pts) {
    const t = Number(p.t) || 0;
    const L = Number(p.L) || 0;
    if (t <= 0 || L <= 0) continue;
    const cur = byT.get(t);
    if (cur) byT.set(t, { sum: cur.sum + L, n: cur.n + 1 });
    else byT.set(t, { sum: L, n: 1 });
  }
  let arr = Array.from(byT.entries())
    .map(([t, v]) => ({ t: Number(t), L: v.sum / v.n }))
    .sort((a, b) => a.t - b.t);
  if (!arr.length) return 0;

  // 2) Enforce monotone decreasing L(t) via a simple PAVA (Pool Adjacent Violators)
  // We want L[i] >= L[i+1].
  const stack = [];
  for (const p of arr) {
    // each block holds {tSum, wSum, L} where L is block mean
    stack.push({ tSum: p.t, wSum: 1, L: p.L });
    // merge while monotonicity is violated
    while (stack.length >= 2) {
      const a = stack[stack.length - 2];
      const b = stack[stack.length - 1];
      if (a.L < b.L) {
        // merge a and b
        const tSum = a.tSum + b.tSum;
        const wSum = a.wSum + b.wSum;
        const L = (a.L * a.wSum + b.L * b.wSum) / wSum;
        stack.splice(stack.length - 2, 2, { tSum, wSum, L });
      } else {
        break;
      }
    }
  }
  // expand blocks back to points (use block-average t)
  arr = stack.map((blk) => ({ t: blk.tSum / blk.wSum, L: blk.L }))
             .sort((a, b) => a.t - b.t);

  // 3) Edge clamps
  if (targetT <= arr[0].t) return arr[0].L;
  if (targetT >= arr[arr.length - 1].t) return arr[arr.length - 1].L;

  // 4) Find bracket and interpolate in log-space
  for (let i = 0; i < arr.length - 1; i++) {
    const a = arr[i], b = arr[i + 1];
    if (a.t <= targetT && targetT <= b.t) {
      const r = (targetT - a.t) / Math.max(eps, b.t - a.t);
      const La = Math.max(eps, a.L);
      const Lb = Math.max(eps, b.L);
      const logL = (1 - r) * Math.log(La) + r * Math.log(Lb);
      return Math.exp(logL);
    }
  }
  return arr[arr.length - 1].L; // fallback (shouldn’t hit)
}

// === Learned scale from history ===
// === Learned scale from history ===
// Model: L_i ≈ scale * f(t_i)  ⇒ scale ≈ avg(L_i / f(t_i))
function scaleFromHistory(pts, w, tau, manualScale) {
  if (manualScale > 0) return manualScale;
  let sum = 0,
    n = 0;
  for (const p of pts) {
    const denom = fAt(p.t, w, tau);
    if (denom > eps) {
      sum += p.L / denom;
      n++;
    }
  }
  return n ? sum / n : 0;
}

// Model-based recommended load for target TUT (first-set estimate)
function modelLoadForT(T, pts, w, tau, manualScale) {
  const scale = scaleFromHistory(pts, w, tau, manualScale);
  return scale * fAt(T, w, tau); // decreases as T increases
}

// Multi-set planner (now supports anchor: 'min' | 'model' | 'ratio')
function planSets({
  TUT,
  sets,
  restSec,
  pts,
  w,
  tau,
  manualScale,
  capDrop = 0.15,
  precise = false,
  anchor = "min",
}) {
  const scale0 = scaleFromHistory(pts, w, tau, manualScale);
  if (scale0 <= 0) return Array.from({ length: sets }, () => 0);

  // First-set base according to anchor
  const modelBase = scale0 * fAt(TUT, w, tau);
  const ratioBase = ratioLoadForT(TUT, pts) || 0;
  let base;
  if (anchor === "ratio") base = ratioBase || modelBase;
  else if (anchor === "model") base = modelBase;
  else base = Math.min(modelBase, ratioBase || Infinity); // conservative

  let currentCapacity = 1.0; // capacity before each set (0..1)
  const out = [];

  for (let s = 1; s <= sets; s++) {
    // Effective curve is currentCapacity * f(t)
    // Load that ends near TUT: scale0 * currentCapacity * f(TUT)
    const closedForm = scale0 * currentCapacity * fAt(TUT, w, tau);
    const load = precise ? closedForm : base * currentCapacity;
    out.push(Math.max(0, load));

    // Fatigue during the set
    currentCapacity *= fAt(TUT, w, tau);

    // Recovery
    const rec = recoveryFrac(restSec, tau); // 0..1
    currentCapacity = clamp(
      currentCapacity + (1 - currentCapacity) * rec,
      0.1,
      1.0
    );
  }

  // Cap: later sets shouldn’t wildly exceed the first
  if (out.length > 1) {
    const first = out[0];
    for (let i = 1; i < out.length; i++) {
      out[i] = Math.min(out[i], first * (1 + capDrop));
    }
  }
  return out;
}

/* ====================== App ====================== */

export default function App() {
  /* ---------- auth + core state ---------- */
  const [tab, setTab] = useState("sessions"); // sessions | history | model | recs
  const [user, setUser] = useState(null);
  const [loginEmail, setLoginEmail] = useState("");

  const [S, setS] = useState(
    () =>
      loadLS() || {
        history: [],
        tau: { t1: 10, t2: 60, t3: 240 },
        wLeft: { w1: 1, w2: 1, w3: 1 },
        wRight: { w1: 1, w2: 1, w3: 1 },
        targets: { power: 20, strength: 60, endurance: 180 },
        model: {
          manualScaleL: 0,
          manualScaleR: 0,
          maxChartTime: 300,
        },
      }
  );
  useEffect(() => saveLS(S), [S]);

  // Supabase auth
  useEffect(() => {
    supabase
      .auth
      .getSession()
      .then(({ data }) => setUser(data.session?.user ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) =>
      setUser(s?.user ?? null)
    );
    return () => sub.subscription.unsubscribe();
  }, []);
  async function sendMagicLink(e) {
    e?.preventDefault();
    if (!loginEmail) return;
    const { error } = await supabase.auth.signInWithOtp({
      email: loginEmail,
      options: { emailRedirectTo: window.location.origin },
    });
    if (error) alert(error.message);
    else alert("Check your email to finish signing in.");
  }
  async function signOut() {
    await supabase.auth.signOut();
  }

  // Load cloud history on login
  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data, error } = await supabase
        .from("sessions")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) {
        console.warn(error);
        return;
      }
      const mapped = (data || []).map((r) => ({
        id: r.id,
        date: r.date ?? new Date().toISOString().slice(0, 10),
        grip: r.grip ?? "",
        leftLoad: Number(r.left_load) || 0,
        leftDur: Number(r.left_dur) || 0,
        rightLoad: Number(r.right_load) || 0,
        rightDur: Number(r.right_dur) || 0,
        rest: Number(r.rest) || 0,
        notes: r.notes ?? "",
      }));
      setS((s) => ({ ...s, history: mapped }));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  /* ---------- Sessions (entry) ---------- */
  const [form, setForm] = useState(() => ({
    date: new Date().toISOString().slice(0, 10),
    grip: "",
    leftLoad: "",
    leftDur: "",
    rightLoad: "",
    rightDur: "",
    rest: "",
    notes: "",
  }));
  const canAdd =
    (Number(form.leftLoad) > 0 || Number(form.rightLoad) > 0) &&
    (Number(form.leftDur) > 0 || Number(form.rightDur) > 0);

  async function onAddSession() {
    if (!canAdd) return;
    const row = {
      id: uid(),
      date: form.date || new Date().toISOString().slice(0, 10),
      grip: form.grip || "",
      leftLoad: Number(form.leftLoad) || 0,
      leftDur: Number(form.leftDur) || 0,
      rightLoad: Number(form.rightLoad) || 0,
      rightDur: Number(form.rightDur) || 0,
      rest: Number(form.rest) || 0,
      notes: form.notes || "",
    };
    setS((s) => ({ ...s, history: [row, ...s.history] }));
    setForm((f) => ({
      ...f,
      leftLoad: "",
      leftDur: "",
      rightLoad: "",
      rightDur: "",
      notes: "",
    }));

    if (user) {
      const payload = {
        user_id: user.id,
        date: row.date,
        grip: row.grip,
        left_load: row.leftLoad || null,
        left_dur: row.leftDur || null,
        right_load: row.rightLoad || null,
        right_dur: row.rightDur || null,
        rest: row.rest || null,
        notes: row.notes || null,
      };
      const { data, error } = await supabase
        .from("sessions")
        .insert(payload)
        .select()
        .single();
      if (!error && data) {
        setS((s) => ({
          ...s,
          history: s.history.map((h) =>
            h.id === row.id ? { ...h, id: data.id } : h
          ),
        }));
      }
    }
  }

  /* ---------- History edit/delete ---------- */
  function onEditCell(id, patch) {
    setS((s) => ({
      ...s,
      history: s.history.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    }));
    if (user) {
      const dbPatch = {};
      if (patch.date !== undefined) dbPatch.date = patch.date;
      if (patch.grip !== undefined) dbPatch.grip = patch.grip;
      if (patch.leftLoad !== undefined) dbPatch.left_load = patch.leftLoad;
      if (patch.leftDur !== undefined) dbPatch.left_dur = patch.leftDur;
      if (patch.rightLoad !== undefined) dbPatch.right_load = patch.rightLoad;
      if (patch.rightDur !== undefined) dbPatch.right_dur = patch.rightDur;
      if (patch.rest !== undefined) dbPatch.rest = patch.rest;
      if (patch.notes !== undefined) dbPatch.notes = patch.notes;
      supabase.from("sessions").update(dbPatch).eq("id", id);
    }
  }
  function onDeleteRow(id) {
    if (!window.confirm("Delete this record?")) return;
    const row = S.history.find((r) => r.id === id);
    setS((s) => ({ ...s, history: s.history.filter((r) => r.id !== id) }));
    if (user && row && String(row.id).length > 10) {
      supabase.from("sessions").delete().eq("id", id);
    }
  }
  function onClearAll() {
    if (!window.confirm("Clear ALL history?")) return;
    setS((s) => ({ ...s, history: [] }));
  }

  /* ---------- Model helpers & series ---------- */
  const setTau = (k, v) =>
    setS((s) => ({
      ...s,
      tau: { ...s.tau, [k]: clamp(Number(v) || 1, 1, 900) },
    }));
  const setW = (hand, k, v) =>
    setS((s) =>
      hand === "L"
        ? { ...s, wLeft: { ...s.wLeft, [k]: clamp(Number(v) || 0.1, 0.1, 10) } }
        : {
            ...s,
            wRight: { ...s.wRight, [k]: clamp(Number(v) || 0.1, 0.1, 10) },
          }
    );
  const setModelCfg = (k, v) =>
    setS((s) => ({ ...s, model: { ...s.model, [k]: Number(v) || 0 } }));

  const ptsL = useMemo(() => historyPoints(S.history, "L"), [S.history]);
  const ptsR = useMemo(() => historyPoints(S.history, "R"), [S.history]);

  // learned scales for overlay + recommendations
  const scaleL = useMemo(
    () => scaleFromHistory(ptsL, S.wLeft, S.tau, S.model.manualScaleL),
    [ptsL, S.wLeft, S.tau, S.model.manualScaleL]
  );
  const scaleR = useMemo(
    () => scaleFromHistory(ptsR, S.wRight, S.tau, S.model.manualScaleR),
    [ptsR, S.wRight, S.tau, S.model.manualScaleR]
  );

  const chartTmax = S.model.maxChartTime || 300;

  // Recovery curve for the Recovery panel
  const recSeries = useMemo(() => {
    const arr = [];
    for (let t = 0; t <= chartTmax; t += 5) {
      arr.push({ t, recovery: recoveryFrac(t, S.tau) });
    }
    return arr;
  }, [S.tau, chartTmax]);

  // History dots for fatigue overlay (y = observed fatigue fraction = L / learned-scale)
  // Add tiny x-offset so L/R dots don't overlap visually
const L_OFF = -0.8;
const R_OFF = +0.8;

const histDotsL = useMemo(
  () =>
    ptsL.map((p) => ({
      t: Math.max(0, Math.min(chartTmax, (p.t || 0) + L_OFF)),
      y: clamp(scaleL > 0 ? p.L / scaleL : 0, 0, 1),
    })),
  [ptsL, scaleL, chartTmax]
);

const histDotsR = useMemo(
  () =>
    ptsR.map((p) => ({
      t: Math.max(0, Math.min(chartTmax, (p.t || 0) + R_OFF)),
      y: clamp(scaleR > 0 ? p.L / scaleR : 0, 0, 1),
    })),
  [ptsR, scaleR, chartTmax]
);

  /* ---------- Recommendations ---------- */
  const targets = S.targets;
  function recs(hand) {
    const pts = hand === "L" ? ptsL : ptsR;
    const w = hand === "L" ? S.wLeft : S.wRight;
    const manualScale = hand === "L" ? S.model.manualScaleL : S.model.manualScaleR;
    return {
      model20: modelLoadForT(targets.power, pts, w, S.tau, manualScale),
      model60: modelLoadForT(targets.strength, pts, w, S.tau, manualScale),
      model180: modelLoadForT(targets.endurance, pts, w, S.tau, manualScale),
      ratio20: ratioLoadForT(targets.power, pts),
      ratio60: ratioLoadForT(targets.strength, pts),
      ratio180: ratioLoadForT(targets.endurance, pts),
    };
  }
  const recL = recs("L");
  const recR = recs("R");

  // Planner state (now includes anchor)
  const [planL, setPlanL] = useState({
    sets: 1,
    TUT: 0,
    rest: 0,
    cap: 0.15,
    precise: true,
    anchor: "min",
  });
  const [planR, setPlanR] = useState({
    sets: 1,
    TUT: 0,
    rest: 120,
    cap: 0.15,
    precise: true,
    anchor: "min",
  });

  const loadsPlanL = useMemo(
    () =>
      planSets({
        TUT: planL.TUT,
        sets: planL.sets,
        restSec: planL.rest,
        capDrop: planL.cap,
        pts: ptsL,
        w: S.wLeft,
        tau: S.tau,
        manualScale: S.model.manualScaleL,
        precise: planL.precise,
        anchor: planL.anchor,
      }),
    [planL, ptsL, S.wLeft, S.tau, S.model.manualScaleL]
  );
  const loadsPlanR = useMemo(
    () =>
      planSets({
        TUT: planR.TUT,
        sets: planR.sets,
        restSec: planR.rest,
        capDrop: planR.cap,
        pts: ptsR,
        w: S.wRight,
        tau: S.tau,
        manualScale: S.model.manualScaleR,
        precise: planR.precise,
        anchor: planR.anchor,
      }),
    [planR, ptsR, S.wRight, S.tau, S.model.manualScaleR]
  );

  /* ====================== UI ====================== */

  return (
    <div style={{ fontFamily: "ui-sans-serif, system-ui, -apple-system", padding: 16 }}>
      {/* Auth bar */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <div style={{ fontSize: 12, opacity: 0.75 }}>
          {user ? `Signed in as ${user.email}` : "Not signed in (local only)"}
        </div>
        <div>
          {!user ? (
            <form onSubmit={sendMagicLink} style={{ display: "inline-flex", gap: 8 }}>
              <input
                type="email"
                required
                placeholder="you@example.com"
                value={loginEmail}
                onChange={(e) => setLoginEmail(e.target.value)}
                style={{ padding: "6px 8px" }}
              />
              <button type="submit">Send Magic Link</button>
            </form>
          ) : (
            <button onClick={signOut}>Sign out</button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        {[
          ["sessions", "Sessions"],
          ["history", "History"],
          ["model", "Model"],
          ["recs", "Recommendations"],
        ].map(([k, lbl]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            style={{
              padding: "8px 12px",
              borderRadius: 8,
              border: "1px solid #ddd",
              background: tab === k ? "#111" : "#fff",
              color: tab === k ? "#fff" : "#111",
            }}
          >
            {lbl}
          </button>
        ))}
      </div>

      {/* Sessions — vertical layout */}
      {tab === "sessions" && (
        <div
          style={{
            border: "1px solid #eee",
            borderRadius: 12,
            padding: 16,
            maxWidth: 680,
          }}
        >
          <h3 style={{ marginTop: 0 }}>Log a Session</h3>

          <div style={{ marginBottom: 10 }}>
            <label>Date</label>
            <input
              type="date"
              value={form.date}
              onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
              style={{ width: "100%", padding: 10 }}
            />
          </div>

          <div style={{ marginBottom: 10 }}>
            <label>Grip / Exercise</label>
            <input
              type="text"
              placeholder="e.g., Half crimp"
              value={form.grip}
              onChange={(e) => setForm((f) => ({ ...f, grip: e.target.value }))}
              style={{ width: "100%", padding: 10 }}
            />
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 12,
              marginBottom: 10,
            }}
          >
            <div>
              <label>Left Load (lb)</label>
              <input
                type="number"
                min="0"
                step="0.5"
                value={form.leftLoad}
                onChange={(e) => setForm((f) => ({ ...f, leftLoad: e.target.value }))}
                style={{ width: "100%", padding: 10 }}
              />
            </div>
            <div>
              <label>Right Load (lb)</label>
              <input
                type="number"
                min="0"
                step="0.5"
                value={form.rightLoad}
                onChange={(e) => setForm((f) => ({ ...f, rightLoad: e.target.value }))}
                style={{ width: "100%", padding: 10 }}
              />
            </div>

            <div>
              <label>Left Duration (s)</label>
              <input
                type="number"
                min="0"
                step="1"
                value={form.leftDur}
                onChange={(e) => setForm((f) => ({ ...f, leftDur: e.target.value }))}
                style={{ width: "100%", padding: 10 }}
              />
            </div>
            <div>
              <label>Right Duration (s)</label>
              <input
                type="number"
                min="0"
                step="1"
                value={form.rightDur}
                onChange={(e) => setForm((f) => ({ ...f, rightDur: e.target.value }))}
                style={{ width: "100%", padding: 10 }}
              />
            </div>
          </div>

          <div style={{ marginBottom: 10 }}>
            <label>Rest (s)</label>
            <input
              type="number"
              min="0"
              step="1"
              value={form.rest}
              onChange={(e) => setForm((f) => ({ ...f, rest: e.target.value }))}
              style={{ width: "100%", padding: 10 }}
            />
          </div>

          <div style={{ marginBottom: 12 }}>
            <label>Notes</label>
            <textarea
              rows={3}
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              style={{ width: "100%", padding: 10, resize: "vertical" }}
            />
          </div>

          <button disabled={!canAdd} onClick={onAddSession} style={{ padding: "10px 14px" }}>
            Add Session
          </button>
        </div>
      )}

      {/* History */}
      {tab === "history" && (
        <div>
          <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
            <button
              onClick={onClearAll}
              style={{ background: "#fff3f3", borderColor: "#f2bcbc", color: "#b00000" }}
            >
              Clear All
            </button>
            <button onClick={() => downloadCSV(S.history)} disabled={!S.history.length}>
              Download CSV
            </button>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "#f7f7f7" }}>
                  {["Date", "Grip", "L Load", "L Dur", "R Load", "R Dur", "Rest", "Notes", ""].map(
                    (h) => (
                      <th
                        key={h}
                        style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #eee" }}
                      >
                        {h}
                      </th>
                    )
                  )}
                </tr>
              </thead>
              <tbody>
                {S.history.map((r) => (
                  <tr key={r.id}>
                    <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0" }}>
                      <input
                        type="date"
                        value={r.date}
                        onChange={(e) => onEditCell(r.id, { date: e.target.value })}
                      />
                    </td>
                    <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0" }}>
                      <input
                        type="text"
                        value={r.grip}
                        onChange={(e) => onEditCell(r.id, { grip: e.target.value })}
                      />
                    </td>
                    <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0" }}>
                      <input
                        type="number"
                        value={r.leftLoad}
                        onChange={(e) =>
                          onEditCell(r.id, { leftLoad: Number(e.target.value) || 0 })
                        }
                        style={{ width: 90 }}
                      />
                    </td>
                    <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0" }}>
                      <input
                        type="number"
                        value={r.leftDur}
                        onChange={(e) =>
                          onEditCell(r.id, { leftDur: Number(e.target.value) || 0 })
                        }
                        style={{ width: 90 }}
                      />
                    </td>
                    <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0" }}>
                      <input
                        type="number"
                        value={r.rightLoad}
                        onChange={(e) =>
                          onEditCell(r.id, { rightLoad: Number(e.target.value) || 0 })
                        }
                        style={{ width: 90 }}
                      />
                    </td>
                    <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0" }}>
                      <input
                        type="number"
                        value={r.rightDur}
                        onChange={(e) =>
                          onEditCell(r.id, { rightDur: Number(e.target.value) || 0 })
                        }
                        style={{ width: 90 }}
                      />
                    </td>
                    <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0" }}>
                      <input
                        type="number"
                        value={r.rest}
                        onChange={(e) => onEditCell(r.id, { rest: Number(e.target.value) || 0 })}
                        style={{ width: 90 }}
                      />
                    </td>
                    <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0" }}>
                      <input
                        type="text"
                        value={r.notes}
                        onChange={(e) => onEditCell(r.id, { notes: e.target.value })}
                        style={{ width: "100%" }}
                      />
                    </td>
                    <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0" }}>
                      <button onClick={() => onDeleteRow(r.id)}>Delete</button>
                    </td>
                  </tr>
                ))}
                {!S.history.length && (
                  <tr>
                    <td colSpan={9} style={{ padding: 12, opacity: 0.6 }}>
                      No history yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Trends */}
          <Trends history={S.history} />
        </div>
      )}

      {/* Model */}
      {tab === "model" && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))",
            gap: 16,
          }}
        >
          <Panel title="Taus (s)">
            {["t1", "t2", "t3"].map((k) => (
              <SliderRow
                key={k}
                label={k}
                value={S.tau[k]}
                min={5}
                max={900}
                step={1}
                onChange={(v) => setTau(k, v)}
                unit="s"
              />
            ))}
            <SliderRow
              label="Chart X-max"
              value={S.model.maxChartTime}
              min={120}
              max={600}
              step={10}
              onChange={(v) => setModelCfg("maxChartTime", v)}
              unit="s"
            />
          </Panel>

          <Panel title="Left Weights & Scale">
            {["w1", "w2", "w3"].map((k) => (
              <SliderRow
                key={k}
                label={k}
                value={S.wLeft[k]}
                min={0.1}
                max={10}
                step={0.1}
                onChange={(v) => setW("L", k, v)}
              />
            ))}
            <SliderRow
              label="Manual Scale (0=auto)"
              value={S.model.manualScaleL}
              min={0}
              max={1000}
              step={1}
              onChange={(v) => setModelCfg("manualScaleL", v)}
            />
          </Panel>

          <Panel title="Right Weights & Scale">
            {["w1", "w2", "w3"].map((k) => (
              <SliderRow
                key={k}
                label={k}
                value={S.wRight[k]}
                min={0.1}
                max={10}
                step={0.1}
                onChange={(v) => setW("R", k, v)}
              />
            ))}
            <SliderRow
              label="Manual Scale (0=auto)"
              value={S.model.manualScaleR}
              min={0}
              max={1000}
              step={1}
              onChange={(v) => setModelCfg("manualScaleR", v)}
            />
          </Panel>

          {/* Fatigue (Left vs Right) with history overlay */}
          <Panel title="Fatigue Curve f(t) + History">
            <div style={{ height: 300 }}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={Array.from({ length: Math.floor(chartTmax / 5) + 1 }, (_, i) => ({ t: i * 5 }))}
                >
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis
                    type="number"
                    dataKey="t"
                    domain={[0, chartTmax]}
                    label={{ value: "Time (s)", position: "insideBottomRight", offset: -5 }}
                  />

                  {/* Two Y axes: one for curves, one (hidden) for dots */}
                  <YAxis yAxisId="curve" domain={[0, 1]} />
                  <YAxis yAxisId="dots" type="number" domain={[0, 1]} hide />

                  <Tooltip />
                  <Legend />

                  {/* Curves on 'curve' axis */}
                  <Line
                    yAxisId="curve"
                    dataKey={(d) => fAt(d.t, S.wLeft, S.tau)}
                    name="Left f(t)"
                    dot={false}
                    type="monotone"
                  />
                  <Line
                    yAxisId="curve"
                    dataKey={(d) => fAt(d.t, S.wRight, S.tau)}
                    name="Right f(t)"
                    dot={false}
                    type="monotone"
                  />

                  {/* Dots on 'dots' axis (reads {t,y}) */}
                  <Scatter
                    yAxisId="dots"
                    data={histDotsL}
                    dataKey="y"
                    name="Left sets"
                    fill="#1f77b4"
                    stroke="#1f77b4"
                    strokeWidth={1.5}
                    fillOpacity={0.8}
                    shape="circle"
                    r={4}
                    isAnimationActive={false}
                  />
                  <Scatter
                    yAxisId="dots"
                    data={histDotsR}
                    dataKey="y"
                    name="Right sets"
                    fill="#ff7f0e"
                    stroke="#ff7f0e"
                    strokeWidth={1.5}
                    fillOpacity={0.8}
                    shape="circle"
                    r={4}
                    isAnimationActive={false}
                  />

                  <ReferenceLine y={0.5} yAxisId="curve" stroke="#aaa" strokeDasharray="4 4" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <small style={{ opacity: 0.7 }}>
              Dots are your sets mapped to fatigue fraction = Load / learned-scale. As you add data,
              dots should hover around the curves.
            </small>
          </Panel>

          {/* Recovery */}
          <Panel title="Recovery Fraction">
            <div style={{ height: 260 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={recSeries}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis
                    dataKey="t"
                    type="number"
                    domain={[0, chartTmax]}
                    label={{ value: "Rest (s)", position: "insideBottomRight", offset: -5 }}
                  />
                  <YAxis domain={[0, 1]} />
                  <Tooltip />
                  <Legend />
                  <Line dataKey="recovery" name="Recovery" dot={false} type="monotone" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Panel>
        </div>
      )}

      {/* Recommendations */}
      {tab === "recs" && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit,minmax(320px,1fr))",
            gap: 16,
          }}
        >
          <Panel title="Left — Model vs Ratio">
            <DenseRecs label="Power (20s)" m={recL.model20} r={recL.ratio20} />
            <DenseRecs label="Strength (60s)" m={recL.model60} r={recL.ratio60} />
            <DenseRecs label="Endurance (180s)" m={recL.model180} r={recL.ratio180} />
            <small style={{ opacity: 0.75 }}>
              Model: L(T) = scale · f(T) (learned from your sets). As T↑, f(T)↓ so load decreases.
              Ratio interpolates nearby points. Pick the lower if unsure.
            </small>
          </Panel>

          <Panel title="Right — Model vs Ratio">
            <DenseRecs label="Power (20s)" m={recR.model20} r={recR.ratio20} />
            <DenseRecs label="Strength (60s)" m={recR.model60} r={recR.ratio60} />
            <DenseRecs label="Endurance (180s)" m={recR.model180} r={recR.ratio180} />
          </Panel>

          <Panel title="Planner — Left">
            <PlannerControls plan={planL} setPlan={setPlanL} />
            <PlannedList loads={loadsPlanL} />
          </Panel>

          <Panel title="Planner — Right">
            <PlannerControls plan={planR} setPlan={setPlanR} />
            <PlannedList loads={loadsPlanR} />
          </Panel>
        </div>
      )}
    </div>
  );
}

/* ====================== Subcomponents ====================== */

function Panel({ title, children }) {
  return (
    <div style={{ border: "1px solid #eee", borderRadius: 8, padding: 12 }}>
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      {children}
    </div>
  );
}
function SliderRow({ label, value, onChange, min, max, step = 1, unit = "" }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <label style={{ fontSize: 12, opacity: 0.7 }}>{label}</label>
        <div style={{ fontFeatureSettings: "tnum" }}>
          {Number(value).toFixed(step < 1 ? 1 : 0)}
          {unit}
        </div>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: "100%" }}
      />
    </div>
  );
}
function DenseRecs({ label, m, r }) {
  const mm = Number(m || 0).toFixed(1);
  const rr = Number(r || 0).toFixed(1);
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1.2fr 1fr 1fr",
        gap: 8,
        marginBottom: 6,
        alignItems: "center",
      }}
    >
      <div style={{ fontWeight: 600 }}>{label}</div>
      <div>Model: <b>{mm}</b></div>
      <div>Ratio: <b>{rr}</b></div>
    </div>
  );
}
function PlannerControls({ plan, setPlan }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(3,1fr)",
        gap: 8,
        marginBottom: 8,
      }}
    >
      <Num label="Sets" v={plan.sets}
        set={(v) => setPlan((p) => ({ ...p, sets: clamp(Number(v) || 1, 1, 20) }))} />
      <Num label="TUT (s)" v={plan.TUT}
        set={(v) => setPlan((p) => ({ ...p, TUT: clamp(Number(v) || 0, 0, 300) }))} />
      <Num label="Rest (s)" v={plan.rest}
        set={(v) => setPlan((p) => ({ ...p, rest: clamp(Number(v) || 0, 0, 900) }))} />

      {/* Anchor select */}
      <div>
        <label style={{ fontSize: 12, opacity: 0.7 }}>Anchor</label>
        <select
          value={plan.anchor || "min"}
          onChange={(e) => setPlan((p) => ({ ...p, anchor: e.target.value }))}
          style={{ width: "100%", padding: 8 }}
        >
          <option value="min">min(Model, Ratio)</option>
          <option value="model">Model</option>
          <option value="ratio">Ratio</option>
        </select>
      </div>

      <div style={{ gridColumn: "1/-1" }}>
        <label style={{ fontSize: 12, opacity: 0.7 }}>Cap later-set increase (fraction)</label>
        <input
          type="number" step="0.01" min="0" max="1" value={plan.cap}
          onChange={(e) => setPlan((p) => ({ ...p, cap: clamp(Number(e.target.value) || 0, 0, 1) }))}
          style={{ width: "100%", padding: 8 }}
        />
      </div>

      <div style={{ gridColumn: "1/-1", display: "flex", alignItems: "center", gap: 8 }}>
        <input id="precise" type="checkbox" checked={!!plan.precise}
          onChange={(e) => setPlan((p) => ({ ...p, precise: e.target.checked }))} />
        <label htmlFor="precise"><b>Precise TUT mode</b> (each set ends near target TUT)</label>
      </div>
    </div>
  );
}
function PlannedList({ loads }) {
  if (!loads?.length)
    return <div style={{ opacity: 0.6 }}>No plan yet — add some history first.</div>;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))", gap: 8 }}>
      {loads.map((L, i) => (
        <div key={i} style={{ border: "1px solid #eee", borderRadius: 8, padding: 8 }}>
          <div style={{ fontSize: 12, opacity: 0.7 }}>Set {i + 1}</div>
          <div style={{ fontWeight: 700 }}>{L.toFixed(1)} lb</div>
        </div>
      ))}
    </div>
  );
}
function Num({ label, v, set }) {
  return (
    <div>
      <label style={{ fontSize: 12, opacity: 0.7 }}>{label}</label>
      <input type="number" value={v} onChange={(e) => set(e.target.value)} style={{ width: "100%", padding: 8 }} />
    </div>
  );
}
function Trends({ history }) {
  const series = useMemo(() => {
    const byDate = new Map();
    for (const r of history) {
      const d = r.date || "";
      const v = byDate.get(d) || { n: 0, lsum: 0, rsum: 0 };
      if (Number(r.leftLoad) > 0) v.lsum += Number(r.leftLoad);
      if (Number(r.rightLoad) > 0) v.rsum += Number(r.rightLoad);
      v.n++;
      byDate.set(d, v);
    }
    const out = [];
    for (const [d, v] of byDate.entries())
      out.push({ date: d, left: v.n ? v.lsum / v.n : 0, right: v.n ? v.rsum / v.n : 0 });
    out.sort((a, b) => (a.date > b.date ? 1 : -1));
    return out;
  }, [history]);

  return (
    <div style={{ height: 280, marginTop: 16 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={series}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="date" />
          <YAxis />
          <Tooltip />
          <Legend />
          <Line type="monotone" dataKey="left" name="Left Avg Load" dot={false} />
          <Line type="monotone" dataKey="right" name="Right Avg Load" dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}