import React, { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ScatterChart,
  Scatter,
} from "recharts";

/** =============================== Utilities & Storage =============================== */

const N = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const round1 = (x) => Math.round(x * 10) / 10;
const uid = () => Math.round(Date.now() + Math.random() * 1e6);
const dayKey = (iso) => new Date(iso).toISOString().slice(0, 10);
const within = (x, target, tol) => Math.abs(x - target) <= tol;

const LS = {
  get(name, def) {
    try {
      const s = localStorage.getItem(name);
      return s ? JSON.parse(s) : def;
    } catch {
      return def;
    }
  },
  set(name, v) {
    localStorage.setItem(name, JSON.stringify(v));
  },
};

/** =============================== Modeling helpers =============================== */
/**
 * Two estimators per hand:
 * 1) Model-Based: learn representative anchor loads near 20/60/180s and interpolate in log-log.
 * 2) Ratio-Based: fit L ∝ t^{-β} from history and scale the nearest set.
 */

function pickAnchorLoad(history, T, window = 4) {
  const near = history
    .filter((r) => within(r.duration, T, window))
    .map((r) => r.load)
    .sort((a, b) => a - b);
  if (!near.length) return null;
  const mid = Math.floor(near.length / 2);
  return near.length % 2 === 1 ? near[mid] : (near[mid - 1] + near[mid]) / 2;
}

function fitAnchors(history) {
  return {
    a20: pickAnchorLoad(history, 20, 4),
    a60: pickAnchorLoad(history, 60, 6),
    a180: pickAnchorLoad(history, 180, 10),
  };
}

function interpLogLog(x1, y1, x2, y2, x) {
  const lx1 = Math.log(x1),
    ly1 = Math.log(y1),
    lx2 = Math.log(x2),
    ly2 = Math.log(y2);
  const m = (ly2 - ly1) / (lx2 - lx1);
  const b = ly1 - m * lx1;
  return Math.exp(m * Math.log(x) + b);
}

function modelLoadForT(anchors, T) {
  const { a20, a60, a180 } = anchors;
  if (a20 && a60 && T >= 20 && T <= 60) return interpLogLog(20, a20, 60, a60, T);
  if (a60 && a180 && T >= 60 && T <= 180) return interpLogLog(60, a60, 180, a180, T);
  if (a20 && a60 && T < 20) return interpLogLog(20, a20, 60, a60, Math.max(5, T));
  if (a60 && a180 && T > 180) return interpLogLog(60, a60, 180, a180, Math.min(400, T));
  // Single-anchor fallback (reasonable default β=0.3)
  const beta = 0.3;
  if (a20) return a20 * Math.pow(T / 20, -beta);
  if (a60) return a60 * Math.pow(T / 60, -beta);
  if (a180) return a180 * Math.pow(T / 180, -beta);
  return null;
}

function fitBeta(history) {
  const pts = history
    .filter((r) => r.load > 0 && r.duration > 0)
    .map((r) => ({ x: Math.log(r.duration), y: Math.log(r.load) }));
  if (pts.length < 2) return 0.3;
  const n = pts.length;
  const sx = pts.reduce((a, p) => a + p.x, 0);
  const sy = pts.reduce((a, p) => a + p.y, 0);
  const sxx = pts.reduce((a, p) => a + p.x * p.x, 0);
  const sxy = pts.reduce((a, p) => a + p.x * p.y, 0);
  const denom = n * sxx - sx * sx;
  if (denom === 0) return 0.3;
  const slope = (n * sxy - sx * sy) / denom;
  const beta = -slope;
  return Math.max(0.05, Math.min(1.0, beta));
}

function nearestByTime(history, targetT) {
  if (!history.length) return null;
  let best = null,
    bestD = Infinity;
  for (const r of history) {
    const d = Math.abs(r.duration - targetT);
    if (d < bestD) {
      bestD = d;
      best = r;
    }
  }
  return best;
}

function ratioSuggestLoad(nearest, beta, targetT) {
  if (!nearest) return null;
  const tObs = Math.max(1, nearest.duration);
  return nearest.load * Math.pow(targetT / tObs, -beta);
}

function multiSetPlan({ targetT, base, beta, reps = 5, rest = 120 }) {
  // Light taper to keep TUT stable. k depends weakly on targetT vs rest.
  const k = Math.min(0.08, Math.max(0.015, (targetT / (rest + targetT)) * 0.12)); // 1.5–8%
  const plan = [];
  for (let i = 0; i < reps; i++) {
    const li = base * Math.pow(1 - k, i);
    plan.push(Math.max(0, round1(li)));
  }
  return plan;
}

function buildFatigueCurve(anchors) {
  const xs = [];
  for (let t = 10; t <= 400; t += 10) {
    const L = modelLoadForT(anchors, t);
    xs.push({ t, pct: L ? (L / (anchors.a20 || L)) * 100 : null });
  }
  return xs.filter((d) => d.pct != null);
}

/** =============================== History helpers =============================== */

function buildCombinedRows(hL, hR) {
  // group by (date(YYYY-MM-DD) | grip) so L/R appear together
  const keyOf = (r) => `${dayKey(r.date)}|${(r.grip || "").trim()}`;
  const map = new Map();

  for (const r of hL) {
    const k = keyOf(r);
    const row = map.get(k) || { date: r.date, grip: (r.grip || "").trim() };
    row.L = r;
    map.set(k, row);
  }
  for (const r of hR) {
    const k = keyOf(r);
    const row = map.get(k) || { date: r.date, grip: (r.grip || "").trim() };
    row.R = r;
    map.set(k, row);
  }

  return Array.from(map.values()).sort((a, b) => new Date(b.date) - new Date(a.date));
}

function dailyTrends(hL, hR, aL, aR) {
  const byDay = new Map(); // date -> {loads:[], durs:[]}
  const add = (r) => {
    const k = dayKey(r.date);
    const v = byDay.get(k) || { loads: [], durs: [] };
    v.loads.push(r.load);
    v.durs.push(r.duration);
    byDay.set(k, v);
  };
  hL.forEach(add);
  hR.forEach(add);

  const days = Array.from(byDay.entries()).sort(
    (a, b) => new Date(a[0]) - new Date(b[0])
  );

  return days.map(([d, v]) => {
    const avgLoad = v.loads.reduce((a, b) => a + b, 0) / v.loads.length;
    const avgDur = v.durs.reduce((a, b) => a + b, 0) / v.durs.length;
    // approximate modeled %: average of each hand's curve at avgDur, normalized to its ~20s anchor
    const mL = modelLoadForT(aL, avgDur);
    const mR = modelLoadForT(aR, avgDur);
    let pct = null;
    if (mL && aL.a20) pct = (mL / aL.a20) * 50;
    if (mR && aR.a20) pct = (pct == null ? 0 : pct) + (mR / aR.a20) * 50;
    pct = pct == null ? null : +pct.toFixed(2);
    return {
      date: d,
      avgLoad: +avgLoad.toFixed(2),
      avgDur: +avgDur.toFixed(2),
      modeledPct: pct ?? 0,
    };
  });
}

/** =============================== Small UI atoms =============================== */

function MetricCard({ label, value, help }) {
  return (
    <div style={{ border: "1px solid #eee", borderRadius: 8, padding: 10, minHeight: 70 }}>
      <div style={{ fontSize: 12, color: "#666" }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700 }}>{value}</div>
      {help && <div style={{ fontSize: 12, color: "#666", marginTop: 4 }}>{help}</div>}
    </div>
  );
}

/** =============================== App =============================== */

export default function App() {
  // Histories
  const [hL, setHL] = useState(() => LS.get("histL", []));
  const [hR, setHR] = useState(() => LS.get("histR", []));
  useEffect(() => LS.set("histL", hL), [hL]);
  useEffect(() => LS.set("histR", hR), [hR]);

  // One-time migration: if grip was stored in notes in old data, move it.
  useEffect(() => {
    const moveGripFromNotes = (setter) => {
      setter((arr) =>
        arr.map((r) => {
          if (!r.grip && r.notes && r.notes.trim()) {
            return { ...r, grip: r.notes.trim(), notes: "" };
          }
          return r;
        })
      );
    };
    moveGripFromNotes(setHL);
    moveGripFromNotes(setHR);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tabs
  const [tab, setTab] = useState("recommend"); // recommend | sessions | history | model

  /** ------- Sessions form ------- */
  const todayISO = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({
    date: todayISO,
    grip: "",
    leftLoad: "",
    rightLoad: "",
    leftDur: "",
    rightDur: "",
    rest: "",
    notes: "",
  });

  const onAdd = () => {
    const date = form.date || todayISO;
    const grip = (form.grip || "").trim();
    const rest = N(form.rest, 0);
    const notes = form.notes || "";

    const next = [];
    if (form.leftLoad || form.leftDur) {
      next.push({
        id: uid(),
        hand: "L",
        date,
        grip,
        load: N(form.leftLoad, 0),
        duration: N(form.leftDur, 0),
        rest,
        notes,
      });
    }
    if (form.rightLoad || form.rightDur) {
      next.push({
        id: uid(),
        hand: "R",
        date,
        grip,
        load: N(form.rightLoad, 0),
        duration: N(form.rightDur, 0),
        rest,
        notes,
      });
    }
    if (!next.length) return;

    setHL((arr) => arr.concat(next.filter((r) => r.hand === "L")));
    setHR((arr) => arr.concat(next.filter((r) => r.hand === "R")));

    setForm({
      date,
      grip,
      leftLoad: "",
      rightLoad: "",
      leftDur: "",
      rightDur: "",
      rest: "",
      notes: "",
    });
  };

  const onDelete = (hand, id) => {
    const ok = window.confirm("Delete this record?");
    if (!ok) return;
    if (hand === "L") setHL((arr) => arr.filter((r) => r.id !== id));
    else setHR((arr) => arr.filter((r) => r.id !== id));
  };

  const clearAll = () => {
    const ok1 = window.confirm("This will delete ALL Left & Right history. Continue?");
    if (!ok1) return;
    const ok2 = window.confirm("Really delete EVERYTHING? This cannot be undone.");
    if (!ok2) return;
    setHL([]);
    setHR([]);
  };

  const exportJSON = () => {
    const blob = new Blob([JSON.stringify({ left: hL, right: hR }, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `finger-training-history-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const importJSON = (file) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (data.left && Array.isArray(data.left)) setHL(data.left);
        if (data.right && Array.isArray(data.right)) setHR(data.right);
        alert("Import complete.");
      } catch (e) {
        alert("Import failed: " + e.message);
      }
    };
    reader.readAsText(file);
  };

  /** ------- Learning & recommendations ------- */
  const anchorsL = useMemo(() => fitAnchors(hL), [hL]);
  const anchorsR = useMemo(() => fitAnchors(hR), [hR]);
  const betaL = useMemo(() => fitBeta(hL), [hL]);
  const betaR = useMemo(() => fitBeta(hR), [hR]);

  const [tutL, setTutL] = useState(20);
  const [tutR, setTutR] = useState(20);

  const modelLoadL = useMemo(() => modelLoadForT(anchorsL, tutL), [anchorsL, tutL]);
  const modelLoadR = useMemo(() => modelLoadForT(anchorsR, tutR), [anchorsR, tutR]);

  const nearL = useMemo(() => nearestByTime(hL, tutL), [hL, tutL]);
  const nearR = useMemo(() => nearestByTime(hR, tutR), [hR, tutR]);

  const ratioLoadL = useMemo(() => ratioSuggestLoad(nearL, betaL, tutL), [nearL, betaL, tutL]);
  const ratioLoadR = useMemo(() => ratioSuggestLoad(nearR, betaR, tutR), [nearR, betaR, tutR]);

  const combinedL = useMemo(() => {
    const xs = [modelLoadL, ratioLoadL].filter((v) => v != null);
    if (!xs.length) return null;
    return round1(xs.reduce((a, b) => a + b, 0) / xs.length);
  }, [modelLoadL, ratioLoadL]);

  const combinedR = useMemo(() => {
    const xs = [modelLoadR, ratioLoadR].filter((v) => v != null);
    if (!xs.length) return null;
    return round1(xs.reduce((a, b) => a + b, 0) / xs.length);
  }, [modelLoadR, ratioLoadR]);

  // Planner controls (shared)
  const [planReps, setPlanReps] = useState(5);
  const [planRest, setPlanRest] = useState(120);
  const planL = useMemo(
    () =>
      combinedL != null
        ? multiSetPlan({ targetT: tutL, base: combinedL, beta: betaL, reps: planReps, rest: planRest })
        : [],
    [combinedL, betaL, tutL, planReps, planRest]
  );
  const planR = useMemo(
    () =>
      combinedR != null
        ? multiSetPlan({ targetT: tutR, base: combinedR, beta: betaR, reps: planReps, rest: planRest })
        : [],
    [combinedR, betaR, tutR, planReps, planRest]
  );

  // Curves & trends
  const curveL = useMemo(() => buildFatigueCurve(anchorsL), [anchorsL]);
  const curveR = useMemo(() => buildFatigueCurve(anchorsR), [anchorsR]);
  const rows = useMemo(() => buildCombinedRows(hL, hR), [hL, hR]);
  const trends = useMemo(() => dailyTrends(hL, hR, anchorsL, anchorsR), [hL, hR, anchorsL, anchorsR]);

  /** =============================== UI =============================== */

  return (
    <div style={{ maxWidth: 1200, margin: "20px auto", padding: "0 12px", fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial" }}>
      <h2 style={{ marginTop: 0 }}>Finger Training Planner</h2>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        {["recommend", "sessions", "history", "model"].map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: "8px 12px",
              borderRadius: 8,
              border: "1px solid #ddd",
              background: tab === t ? "#f0f6ff" : "white",
              fontWeight: tab === t ? 700 : 500,
            }}
          >
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* RECOMMENDATIONS */}
      {tab === "recommend" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <RecPanel
            title="Left Hand"
            nextTUT={tutL}
            onSetTUT={setTutL}
            modelLoad={modelLoadL}
            ratioLoad={ratioLoadL}
            combined={combinedL}
            near={nearL}
            planLoads={planL}
            planReps={planReps}
            planRest={planRest}
          />
          <RecPanel
            title="Right Hand"
            nextTUT={tutR}
            onSetTUT={setTutR}
            modelLoad={modelLoadR}
            ratioLoad={ratioLoadR}
            combined={combinedR}
            near={nearR}
            planLoads={planR}
            planReps={planReps}
            planRest={planRest}
          />
          <div style={{ gridColumn: "1 / span 2", border: "1px solid #eee", borderRadius: 8, padding: 12 }}>
            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <label><b>Planner:</b></label>
              <label>Reps</label>
              <input
                type="number"
                value={planReps}
                onChange={(e) => setPlanReps(Math.max(1, Math.floor(N(e.target.value, planReps))))}
                style={{ width: 80, padding: 6 }}
              />
              <label>Rest (s)</label>
              <input
                type="number"
                value={planRest}
                onChange={(e) => setPlanRest(Math.max(0, Math.floor(N(e.target.value, planRest))))}
                style={{ width: 100, padding: 6 }}
              />
              <span style={{ fontSize: 13, color: "#666" }}>Loads taper slightly to keep TUT stable across sets.</span>
            </div>
          </div>
        </div>
      )}

      {/* SESSIONS */}
      {tab === "sessions" && (
        <div style={{ display: "grid", gridTemplateColumns: "420px 1fr", gap: 16 }}>
          {/* LEFT: Vertical form container */}
          <div style={{ border: "1px solid #ddd", borderRadius: 10, padding: 14 }}>
            <h3 style={{ marginTop: 0 }}>Log a Session</h3>

            {/* Date */}
            <div style={{ marginBottom: 10 }}>
              <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Date</label>
              <input
                type="date"
                value={form.date}
                onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
                style={{ width: "100%", padding: 8 }}
              />
            </div>

            {/* Grip / Exercise */}
            <div style={{ marginBottom: 10 }}>
              <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Grip / Exercise</label>
              <input
                type="text"
                placeholder="e.g., 20mm Half Crimp or Rolling Thunder"
                value={form.grip}
                onChange={(e) => setForm((f) => ({ ...f, grip: e.target.value }))}
                style={{ width: "100%", padding: 8 }}
              />
            </div>

            {/* Left/Right Load */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
              <div>
                <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Left Load (lb)</label>
                <input
                  type="number"
                  value={form.leftLoad}
                  onChange={(e) => setForm((f) => ({ ...f, leftLoad: e.target.value }))}
                  style={{ width: "100%", padding: 8 }}
                />
              </div>
              <div>
                <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Right Load (lb)</label>
                <input
                  type="number"
                  value={form.rightLoad}
                  onChange={(e) => setForm((f) => ({ ...f, rightLoad: e.target.value }))}
                  style={{ width: "100%", padding: 8 }}
                />
              </div>
            </div>

            {/* Left/Right Duration */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
              <div>
                <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Left Duration (s)</label>
                <input
                  type="number"
                  value={form.leftDur}
                  onChange={(e) => setForm((f) => ({ ...f, leftDur: e.target.value }))}
                  style={{ width: "100%", padding: 8 }}
                />
              </div>
              <div>
                <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Right Duration (s)</label>
                <input
                  type="number"
                  value={form.rightDur}
                  onChange={(e) => setForm((f) => ({ ...f, rightDur: e.target.value }))}
                  style={{ width: "100%", padding: 8 }}
                />
              </div>
            </div>

            {/* Rest */}
            <div style={{ marginBottom: 10 }}>
              <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Rest (s)</label>
              <input
                type="number"
                value={form.rest}
                onChange={(e) => setForm((f) => ({ ...f, rest: e.target.value }))}
                style={{ width: "100%", padding: 8 }}
              />
            </div>

            {/* Notes */}
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Notes</label>
              <input
                type="text"
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                style={{ width: "100%", padding: 8 }}
                placeholder="optional"
              />
            </div>

            <button onClick={onAdd} style={{ width: "100%", padding: 12, fontWeight: 700 }}>
              + Add Session
            </button>
          </div>

          {/* RIGHT: Quick actions / tips */}
          <div style={{ border: "1px solid "#eee", borderRadius: 10, padding: 14 }}>
            <h3 style={{ marginTop: 0 }}>Quick Actions</h3>
            <div style={{ fontSize: 13, color: "#555" }}>
              Aim to fail within ±2–3 s. If a set runs long, log the <b>actual</b> duration — the model and controller
              will adjust the next loads automatically.
            </div>
            <div style={{ marginTop: 12 }}>
              <button onClick={() => alert("Learning is automatic from history (20/60/180s anchors + ratio controller).")}>
                What does “Learn” mean?
              </button>
            </div>
          </div>
        </div>
      )}

      {/* HISTORY */}
      {tab === "history" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12 }}>
          <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
            <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button onClick={exportJSON}>Export JSON</button>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span>Import JSON</span>
                <input type="file" accept="application/json" onChange={(e) => e.target.files?.[0] && importJSON(e.target.files[0])} />
              </label>
              <button onClick={clearAll} style={{ marginLeft: "auto", color: "#b00020" }}>
                Clear ALL history…
              </button>
            </div>

            <h3 style={{ marginTop: 0 }}>Session History (most recent first)</h3>

            {rows.length === 0 ? (
              <div style={{ color: "#666" }}>No sessions yet.</div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ background: "#fafafa" }}>
                      <th style={thS}>Date</th>
                      <th style={thS}>Grip</th>
                      <th style={thS}>Left Load</th>
                      <th style={thS}>Right Load</th>
                      <th style={thS}>Left Dur (s)</th>
                      <th style={thS}>Right Dur (s)</th>
                      <th style={thS}>Notes</th>
                      <th style={thS}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => {
                      const L = row.L, R = row.R;
                      return (
                        <tr key={i}>
                          <td style={tdS}>{new Date(row.date).toLocaleDateString()}</td>

                          {/* Grip (edits both L/R) */}
                          <td style={tdS}>
                            <input
                              style={{ width: 180, padding: 4 }}
                              type="text"
                              value={row.grip || ""}
                              onChange={(e) => {
                                const v = e.target.value;
                                if (L) setHL((arr) => arr.map((r) => (r.id === L.id ? { ...r, grip: v } : r)));
                                if (R) setHR((arr) => arr.map((r) => (r.id === R.id ? { ...r, grip: v } : r)));
                              }}
                            />
                          </td>

                          {/* Left / Right Loads */}
                          <td style={tdS}>
                            {L ? (
                              <input
                                style={{ width: 80, padding: 4 }}
                                type="number"
                                value={L.load}
                                onChange={(e) =>
                                  setHL((arr) =>
                                    arr.map((r) => (r.id === L.id ? { ...r, load: N(e.target.value, L.load) } : r))
                                  )
                                }
                              />
                            ) : "—"}
                          </td>
                          <td style={tdS}>
                            {R ? (
                              <input
                                style={{ width: 80, padding: 4 }}
                                type="number"
                                value={R.load}
                                onChange={(e) =>
                                  setHR((arr) =>
                                    arr.map((r) => (r.id === R.id ? { ...r, load: N(e.target.value, R.load) } : r))
                                  )
                                }
                              />
                            ) : "—"}
                          </td>

                          {/* Left / Right Durations */}
                          <td style={tdS}>
                            {L ? (
                              <input
                                style={{ width: 80, padding: 4 }}
                                type="number"
                                value={L.duration}
                                onChange={(e) =>
                                  setHL((arr) =>
                                    arr.map((r) =>
                                      r.id === L.id ? { ...r, duration: N(e.target.value, L.duration) } : r
                                    )
                                  )
                                }
                              />
                            ) : "—"}
                          </td>
                          <td style={tdS}>
                            {R ? (
                              <input
                                style={{ width: 80, padding: 4 }}
                                type="number"
                                value={R.duration}
                                onChange={(e) =>
                                  setHR((arr) =>
                                    arr.map((r) =>
                                      r.id === R.id ? { ...r, duration: N(e.target.value, R.duration) } : r
                                    )
                                  )
                                }
                              />
                            ) : "—"}
                          </td>

                          {/* Notes (independent of grip) */}
                          <td style={tdS}>
                            <input
                              style={{ width: 220, padding: 4 }}
                              type="text"
                              value={L?.notes ?? R?.notes ?? ""}
                              onChange={(e) => {
                                const v = e.target.value;
                                if (L) setHL((arr) => arr.map((r) => (r.id === L.id ? { ...r, notes: v } : r)));
                                if (R) setHR((arr) => arr.map((r) => (r.id === R.id ? { ...r, notes: v } : r)));
                              }}
                            />
                          </td>

                          <td style={tdS}>
                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                              <button
                                disabled={!L}
                                onClick={() => L && onDelete("L", L.id)}
                                style={{ color: "#b00020", opacity: L ? 1 : 0.5 }}
                              >
                                Delete L
                              </button>
                              <button
                                disabled={!R}
                                onClick={() => R && onDelete("R", R.id)}
                                style={{ color: "#b00020", opacity: R ? 1 : 0.5 }}
                              >
                                Delete R
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <div style={{ marginTop: 10, fontSize: 12, color: "#666" }}>
              Tip: Edit values inline; changes are saved immediately to your browser.
            </div>
          </div>

          {/* Trends */}
          <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
            <h3 style={{ marginTop: 0 }}>Trends (Averages)</h3>
            {trends.length === 0 ? (
              <div style={{ color: "#666" }}>No data yet.</div>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={trends} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis yAxisId="left" domain={[0, "auto"]} />
                  <YAxis yAxisId="right" orientation="right" domain={[0, 100]} />
                  <Tooltip />
                  <Legend />
                  <Line yAxisId="left" type="monotone" dataKey="avgDur" name="Avg Duration (s)" dot={false} strokeWidth={2} />
                  <Line yAxisId="left" type="monotone" dataKey="avgLoad" name="Avg Load (L/R)" dot={false} strokeWidth={2} />
                  <Line yAxisId="right" type="monotone" dataKey="modeledPct" name="Modeled %MVC (avg)" dot={false} strokeWidth={2} strokeDasharray="4 4" />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      )}

      {/* MODEL */}
      {tab === "model" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          {/* Left fatigue */}
          <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
            <h3 style={{ marginTop: 0 }}>Left: Fatigue Curve</h3>
            {curveL.length === 0 ? (
              <div style={{ color: "#666" }}>Add sets near 20/60/180s to learn anchors.</div>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={curveL}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis type="number" dataKey="t" domain={[0, 400]} label={{ value: "Time (s)", position: "insideBottomRight", offset: -5 }} />
                  <YAxis domain={[0, "auto"]} />
                  <Tooltip />
                  <Legend />
                  <Line type="monotone" dataKey="pct" name="% relative to ~20s" dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            )}
            {hL.length > 0 && (
              <div style={{ height: 220 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <ScatterChart>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis type="number" dataKey="duration" name="Time (s)" domain={[0, 400]} />
                    <YAxis type="number" dataKey="load" name="Load (lb)" />
                    <Tooltip cursor={{ strokeDasharray: "3 3" }} />
                    <Legend />
                    <Scatter name="Left Sets" data={hL} />
                  </ScatterChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          {/* Right fatigue */}
          <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
            <h3 style={{ marginTop: 0 }}>Right: Fatigue Curve</h3>
            {curveR.length === 0 ? (
              <div style={{ color: "#666" }}>Add sets near 20/60/180s to learn anchors.</div>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={curveR}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis type="number" dataKey="t" domain={[0, 400]} label={{ value: "Time (s)", position: "insideBottomRight", offset: -5 }} />
                  <YAxis domain={[0, "auto"]} />
                  <Tooltip />
                  <Legend />
                  <Line type="monotone" dataKey="pct" name="% relative to ~20s" dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            )}
            {hR.length > 0 && (
              <div style={{ height: 220 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <ScatterChart>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis type="number" dataKey="duration" name="Time (s)" domain={[0, 400]} />
                    <YAxis type="number" dataKey="load" name="Load (lb)" />
                    <Tooltip cursor={{ strokeDasharray: "3 3" }} />
                    <Legend />
                    <Scatter name="Right Sets" data={hR} />
                  </ScatterChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** =============================== Subcomponents =============================== */

function RecPanel({
  title,
  nextTUT,
  onSetTUT,
  modelLoad,
  ratioLoad,
  combined,
  near,
  planLoads,
  planReps,
  planRest,
}) {
  const singleSetText =
    "Single-Set Suggestion: " +
    (combined != null ? combined + " lb @ " + nextTUT + "s" : "Add history and click Learn");

  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
      <h3 style={{ marginTop: 0 }}>{title}</h3>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
        <label>Target TUT (s)</label>
        <input
          type="number"
          value={nextTUT}
          onChange={(e) => onSetTUT(Number(e.target.value) || nextTUT)}
          style={{ width: 100, padding: 6 }}
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
        <MetricCard
          label="Model-Based"
          value={modelLoad != null ? round1(modelLoad) + " lb" : "—"}
          help="Interpolates learned 20/60/180 anchors."
        />
        <MetricCard
          label="Ratio-Based"
          value={ratioLoad != null ? round1(ratioLoad) + " lb" : "—"}
          help="Nearest set scaled by L ∝ t^{-β}."
        />
      </div>

      <div style={{ fontWeight: 600, marginBottom: 8 }}>{singleSetText}</div>

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
            Loads taper slightly using your model so each set finishes near {nextTUT}s.
          </div>
        </div>
      )}

      <div style={{ fontSize: 13, color: "#666", marginTop: 8 }}>
        {near ? (
          <span>
            Nearest set: {near.load} lb @ {near.duration}s {near.notes ? "— " + near.notes : ""}
          </span>
        ) : (
          "No nearby set yet."
        )}
      </div>
    </div>
  );
}

/** =============================== Styles for table headers/cells =============================== */

const thS = {
  textAlign: "left",
  padding: "8px 6px",
  borderBottom: "1px solid #eee",
  fontWeight: 600,
  fontSize: 13,
  color: "#333",
  whiteSpace: "nowrap",
};

const tdS = {
  padding: "8px 6px",
  borderBottom: "1px solid #f0f0f0",
  verticalAlign: "top",
};