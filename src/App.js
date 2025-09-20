import React, { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ComposedChart,
  Bar,
} from "recharts";

/* ===================== Small utilities ===================== */
const LS_L = "finger_training_left_v2";
const LS_R = "finger_training_right_v2";
const todayISO = new Date().toISOString().slice(0, 10);
const N = (v, d = 0) => {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : d;
};
const uid = () => Math.random().toString(36).slice(2, 10);
const dayKey = (iso) => (iso || todayISO);

/* ===================== Simple UI atoms ===================== */
function Card({ title, children, style }) {
  return (
    <div style={{ border: "1px solid #eee", borderRadius: 10, padding: 14, ...style }}>
      {title && <div style={{ fontWeight: 700, marginBottom: 8 }}>{title}</div>}
      {children}
    </div>
  );
}
const Label = ({ children, width = 140 }) => (
  <div style={{ width, fontSize: 12, color: "#444" }}>{children}</div>
);

/* ===================== Data model ===================== */
/** Record:
 * { id, hand: "L"|"R", date: "YYYY-MM-DD", grip, load, duration, rest, notes }
 */

/* ---------- Core helpers ---------- */

/** nearestByTime: pick record whose duration is closest to target T */
function nearestByTime(history, targetT) {
  if (!history || history.length === 0) return null;
  let best = null;
  let bestD = Infinity;
  for (const r of history) {
    const d = Math.abs(N(r.duration, 0) - targetT);
    if (d < bestD) {
      best = r;
      bestD = d;
    }
  }
  return best;
}

/** fitBeta: estimate exponent for L ~ (Tref/T)^beta across history (least squares) */
function fitBeta(history) {
  const Tref = 20;
  const pairs = [];
  for (const r of history) {
    const L = N(r.load, 0);
    const T = N(r.duration, 0);
    if (L > 0 && T > 0 && T !== Tref) {
      pairs.push({ L, T });
    }
  }
  if (pairs.length < 2) return 0.7; // fallback
  // regress y=ln L on x=ln(Tref/T)
  let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
  for (const p of pairs) {
    const x = Math.log(Tref / p.T);
    const y = Math.log(p.L);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      n++; sx += x; sy += y; sxx += x * x; sxy += x * y;
    }
  }
  if (n < 2) return 0.7;
  const beta = (n * sxy - sx * sy) / Math.max(1e-9, (n * sxx - sx * sx));
  return Math.min(2.5, Math.max(0.2, beta));
}

/** modelLoadForT via a single-parameter power model anchored at 20s
 * We set K from nearest-to-20 (or the best available), then L(T) = K*(20/T)^beta
 */
function modelLoadForT(anchors, T) {
  if (!anchors) return null;
  const { a20, beta } = anchors;
  if (!a20 || !beta || T <= 0) return null;
  return a20 * Math.pow(20 / T, beta);
}

/** ---- Optional 3-exponential shape (manual sliders) ----
 * L_adj(T) = L_base(T) * [ triShape(T) / triShape(20) ]
 * triShape(T) = w1*exp(-T/t1) + w2*exp(-T/t2) + w3*exp(-T/t3), weights normalized
 */
function triShape(T, p) {
  const wsum = Math.max(1e-9, (p.w1 || 0) + (p.w2 || 0) + (p.w3 || 0));
  const w1 = (p.w1 || 0) / wsum, w2 = (p.w2 || 0) / wsum, w3 = (p.w3 || 0) / wsum;
  const e1 = Math.exp(-Math.max(0, T) / Math.max(1e-6, p.t1 || 1));
  const e2 = Math.exp(-Math.max(0, T) / Math.max(1e-6, p.t2 || 1));
  const e3 = Math.exp(-Math.max(0, T) / Math.max(1e-6, p.t3 || 1));
  return w1 * e1 + w2 * e2 + w3 * e3;
}
function adjustedModelLoadForT(anchors, T, p) {
  const base = modelLoadForT(anchors, T);
  if (base == null) return null;
  const k = triShape(T, p);
  const k20 = triShape(20, p);
  return k20 > 0 ? base * (k / k20) : base;
}
function buildAdjustedCurve(anchors, p) {
  const xs = [];
  for (let t = 10; t <= 400; t += 10) {
    const Lb = modelLoadForT(anchors, t);
    const La = adjustedModelLoadForT(anchors, t, p);
    const ref = anchors.a20 || Lb || La;
    const pct = ref ? ((La || Lb) / ref) * 100 : null;
    if (pct != null) xs.push({ t, pct: +pct.toFixed(2) });
  }
  return xs;
}

/** fitAnchors: estimate a20 using nearest record to 20s, otherwise regress to 20s */
function fitAnchors(history) {
  if (!history || history.length === 0) return { a20: null, beta: 0.7 };
  const beta = fitBeta(history);
  const near20 = nearestByTime(history, 20);
  let a20 = null;
  if (near20 && Math.abs(near20.duration - 20) <= 5) {
    a20 = N(near20.load, 0);
  } else {
    let sum = 0, n = 0;
    for (const r of history) {
      const L = N(r.load, 0);
      const T = N(r.duration, 0);
      if (L > 0 && T > 0) { sum += L * Math.pow(T / 20, beta); n++; }
    }
    a20 = n > 0 ? sum / n : null;
  }
  const a60 = a20 && beta ? a20 * Math.pow(20 / 60, beta) : null;
  const a180 = a20 && beta ? a20 * Math.pow(20 / 180, beta) : null;
  return { a20, a60, a180, beta };
}

/** ratioSuggestLoad: given the nearest record and beta, suggest L_target */
function ratioSuggestLoad(near, beta, Ttarget) {
  if (!near || !beta || !Ttarget) return null;
  const Lnear = N(near.load, 0);
  const Tnear = N(near.duration, 0);
  if (Lnear <= 0 || Tnear <= 0) return null;
  return Lnear * Math.pow(Tnear / Ttarget, beta);
}

/** build fatigue curve (% of 20s) from anchors (base model) */
function buildFatigueCurve(anchors) {
  const xs = [];
  for (let t = 10; t <= 400; t += 10) {
    const L = modelLoadForT(anchors, t);
    xs.push({ t, pct: L ? (L / (anchors.a20 || L)) * 100 : null });
  }
  return xs.filter((d) => d.pct != null);
}

/** multi-set planner: taper slightly so each set finishes near target TUT */
function multiSetPlan({ targetT, base, beta, reps, rest }) {
  if (!base || !beta || !reps) return [];
  const loads = [];
  // crude fatigue accumulation by rest; lighten ~2–5% per subsequent set depending on rest
  const restFactor = Math.max(0, Math.min(1, rest / 180)); // 0 (no rest) .. 1 (full)
  const step = 0.05 * (1 - restFactor); // more taper if rest is short
  for (let i = 0; i < reps; i++) {
    const factor = Math.max(0.7, 1 - step * i);
    loads.push(Math.round(base * factor * 10) / 10);
  }
  return loads;
}

/* ===================== App ===================== */
export default function App() {
  const [tab, setTab] = useState("sessions"); // sessions | history | model | recommend

  /* ---------- history state (localStorage) ---------- */
  const [hL, setHL] = useState(() => {
    try { return JSON.parse(localStorage.getItem(LS_L) || "[]"); } catch { return []; }
  });
  const [hR, setHR] = useState(() => {
    try { return JSON.parse(localStorage.getItem(LS_R) || "[]"); } catch { return []; }
  });
  useEffect(() => { localStorage.setItem(LS_L, JSON.stringify(hL)); }, [hL]);
  useEffect(() => { localStorage.setItem(LS_R, JSON.stringify(hR)); }, [hR]);

  /* ---------- Sessions form ---------- */
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

    const Lload = N(form.leftLoad, 0);
    const Rload = N(form.rightLoad, 0);
    const Ldur  = N(form.leftDur, 0);
    const Rdur  = N(form.rightDur, 0);

    const leftValid  = Lload > 0 && Ldur > 0;
    const rightValid = Rload > 0 && Rdur > 0;

    if (!leftValid && !rightValid) {
      alert("Please enter BOTH load and duration (> 0) for Left and/or Right.");
      return;
    }

    const toAdd = [];
    if (leftValid) {
      toAdd.push({ id: uid(), hand: "L", date, grip, load: Lload, duration: Ldur, rest, notes });
    }
    if (rightValid) {
      toAdd.push({ id: uid(), hand: "R", date, grip, load: Rload, duration: Rdur, rest, notes });
    }

    if (toAdd.some(r => r.hand === "L")) setHL(a => a.concat(toAdd.filter(r => r.hand === "L")));
    if (toAdd.some(r => r.hand === "R")) setHR(a => a.concat(toAdd.filter(r => r.hand === "R")));

    alert(`Saved ${toAdd.length} record${toAdd.length === 1 ? "" : "s"}.`);

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

  const onClearAll = () => {
    if (!window.confirm("This will delete ALL history for BOTH hands on THIS DEVICE. Continue?")) return;
    if (!window.confirm("Are you absolutely sure? This cannot be undone.")) return;
    setHL([]); setHR([]);
  };

  /* ---------- History editing ---------- */
  const [editingId, setEditingId] = useState(null);
  const [editBuf, setEditBuf] = useState(null);
  const onEdit = (rec) => { setEditingId(rec.id); setEditBuf({ ...rec }); };
  const onCancelEdit = () => { setEditingId(null); setEditBuf(null); };
  const onSaveEdit = () => {
    if (!editBuf) return;
    const up = (arr) => arr.map(r => (r.id === editBuf.id ? { ...editBuf } : r));
    if (editBuf.hand === "L") setHL(up);
    else setHR(up);
    setEditingId(null); setEditBuf(null);
  };
  const onDelete = (rec) => {
    if (!window.confirm("Delete this record?")) return;
    if (rec.hand === "L") setHL(a => a.filter(r => r.id !== rec.id));
    else setHR(a => a.filter(r => r.id !== rec.id));
  };

  /* ---------- Import/Export ---------- */
  const exportJSON = () => {
    const payload = { left: hL, right: hR, exportedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "finger-training-history.json";
    a.click();
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

  /* ---------- Learning & recommendations ---------- */
  const anchorsL = useMemo(() => fitAnchors(hL), [hL]);
  const anchorsR = useMemo(() => fitAnchors(hR), [hR]);
  const betaL = useMemo(() => fitBeta(hL), [hL]);
  const betaR = useMemo(() => fitBeta(hR), [hR]);

  const [tutL, setTutL] = useState(20);
  const [tutR, setTutR] = useState(20);

  // Manual model sliders (optional tri-exponential adjustment)
  const [useAdjusted, setUseAdjusted] = useState(false);
  const [params, setParams] = useState({ w1: 0.6, w2: 0.3, w3: 0.1, t1: 8, t2: 45, t3: 180 });

  // Base model
  const baseModelLoadL = useMemo(() => modelLoadForT(anchorsL, tutL), [anchorsL, tutL]);
  const baseModelLoadR = useMemo(() => modelLoadForT(anchorsR, tutR), [anchorsR, tutR]);

  // Adjusted model
  const adjModelLoadL = useMemo(
    () => adjustedModelLoadForT(anchorsL, tutL, params), [anchorsL, tutL, params]
  );
  const adjModelLoadR = useMemo(
    () => adjustedModelLoadForT(anchorsR, tutR, params), [anchorsR, tutR, params]
  );

  // Final model loads used by recs
  const modelLoadL = useMemo(
    () => (useAdjusted ? adjModelLoadL : baseModelLoadL),
    [useAdjusted, adjModelLoadL, baseModelLoadL]
  );
  const modelLoadR = useMemo(
    () => (useAdjusted ? adjModelLoadR : baseModelLoadR),
    [useAdjusted, adjModelLoadR, baseModelLoadR]
  );

  const nearL = useMemo(() => nearestByTime(hL, tutL), [hL, tutL]);
  const nearR = useMemo(() => nearestByTime(hR, tutR), [hR, tutR]);

  const ratioLoadL = useMemo(() => ratioSuggestLoad(nearL, betaL, tutL), [nearL, betaL, tutL]);
  const ratioLoadR = useMemo(() => ratioSuggestLoad(nearR, betaR, tutR), [nearR, betaR, tutR]);

  const combinedL = useMemo(() => {
    const xs = [modelLoadL, ratioLoadL].filter((v) => v != null);
    if (!xs.length) return null;
    return Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10;
  }, [modelLoadL, ratioLoadL]);
  const combinedR = useMemo(() => {
    const xs = [modelLoadR, ratioLoadR].filter((v) => v != null);
    if (!xs.length) return null;
    return Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10;
  }, [modelLoadR, ratioLoadR]);

  // Multi-set planner
  const [planReps, setPlanReps] = useState(5);
  const [planRest, setPlanRest] = useState(120);
  const planL = useMemo(
    () => (combinedL != null ? multiSetPlan({ targetT: tutL, base: combinedL, beta: betaL, reps: planReps, rest: planRest }) : []),
    [combinedL, betaL, tutL, planReps, planRest]
  );
  const planR = useMemo(
    () => (combinedR != null ? multiSetPlan({ targetT: tutR, base: combinedR, beta: betaR, reps: planReps, rest: planRest }) : []),
    [combinedR, betaR, tutR, planReps, planRest]
  );

  /* ===================== Render ===================== */
  return (
    <div style={{ padding: 16, maxWidth: 1200, margin: "0 auto", fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial" }}>
      {/* Tabs */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        {["sessions", "history", "model", "recommend"].map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: "8px 12px",
              borderRadius: 8,
              border: "1px solid #ddd",
              background: tab === t ? "#0d6efd" : "#fff",
              color: tab === t ? "#fff" : "#333",
              cursor: "pointer",
            }}
          >
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
  <button
    onClick={exportJSON}
    style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #ddd" }}
  >
    Export JSON
  </button>

  <label
    style={{
      padding: "8px 12px",
      borderRadius: 8,
      border: "1px solid #ddd",
      cursor: "pointer",
    }}
  >
    Import JSON
    <input
      type="file"
      accept="application/json"
      style={{ display: "none" }}
      onChange={(e) => {
        const f = e.target.files && e.target.files[0];
        if (f) importJSON(f);
        e.target.value = ""; // reset for same-file re-imports
      }}
    />
  </label>

  <button
    onClick={onClearAll}
    style={{
      padding: "8px 12px",
      borderRadius: 8,
      border: "1px solid #ddd",
      color: "#b00020",
      background: "#fff",
    }}
  >
    Clear All
  </button>
</div>
      </div>

      {/* SESSIONS */}
      {tab === "sessions" && (
        <div style={{ display: "grid", gridTemplateColumns: "380px 1fr", gap: 16 }}>
          {/* Left column: vertical form */}
          <Card title="Add Session">
            {/* Date */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
              <Label>Date</Label>
              <input type="date" value={form.date} onChange={(e) => setForm(f => ({ ...f, date: e.target.value }))}
                     style={{ flex: 1, padding: 6 }} />
            </div>
            {/* Grip/Exercise */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
              <Label>Grip / Exercise</Label>
              <input value={form.grip} onChange={(e) => setForm(f => ({ ...f, grip: e.target.value }))}
                     placeholder="e.g., 3-finger half crimp" style={{ flex: 1, padding: 6 }} />
            </div>
            {/* Loads row */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
              <div>
                <div style={{ fontSize: 12, marginBottom: 4 }}>Left Load (lb, required)</div>
                <input value={form.leftLoad} onChange={(e) => setForm(f => ({ ...f, leftLoad: e.target.value }))}
                       inputMode="decimal" placeholder="e.g., 95" style={{ width: "100%", padding: 6 }} />
              </div>
              <div>
                <div style={{ fontSize: 12, marginBottom: 4 }}>Right Load (lb, required)</div>
                <input value={form.rightLoad} onChange={(e) => setForm(f => ({ ...f, rightLoad: e.target.value }))}
                       inputMode="decimal" placeholder="e.g., 95" style={{ width: "100%", padding: 6 }} />
              </div>
            </div>
            {/* Durations row */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
              <div>
                <div style={{ fontSize: 12, marginBottom: 4 }}>Left Duration (s, required)</div>
                <input value={form.leftDur} onChange={(e) => setForm(f => ({ ...f, leftDur: e.target.value }))}
                       inputMode="numeric" placeholder="e.g., 20" style={{ width: "100%", padding: 6 }} />
              </div>
              <div>
                <div style={{ fontSize: 12, marginBottom: 4 }}>Right Duration (s, required)</div>
                <input value={form.rightDur} onChange={(e) => setForm(f => ({ ...f, rightDur: e.target.value }))}
                       inputMode="numeric" placeholder="e.g., 20" style={{ width: "100%", padding: 6 }} />
              </div>
            </div>
            {/* Rest */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
              <Label>Rest (s)</Label>
              <input value={form.rest} onChange={(e) => setForm(f => ({ ...f, rest: e.target.value }))}
                     inputMode="numeric" placeholder="e.g., 120" style={{ flex: 1, padding: 6 }} />
            </div>
            {/* Notes */}
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 8 }}>
              <Label>Notes</Label>
              <textarea value={form.notes} onChange={(e) => setForm(f => ({ ...f, notes: e.target.value }))}
                        placeholder="Anything useful…" rows={3} style={{ flex: 1, padding: 6 }} />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={onAdd} style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #ddd", background: "#0d6efd", color: "#fff" }}>
                Add Session
              </button>
            </div>
          </Card>

          {/* Right column: quick actions & hints */}
          <Card title="Quick Actions / Hints">
            <div style={{ fontSize: 14, color: "#333" }}>
              • Enter both load and duration for each hand you want to save.<br />
              • Use consistent <b>time-under-tension</b> targets (20s/60s/180s) so the model learns faster.<br />
              • Edit or delete mistakes from the History tab (each record has its own controls).<br />
              • Export/Import JSON to move data between devices.
            </div>
          </Card>
        </div>
      )}

      {/* HISTORY */}
      {tab === "history" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 16 }}>
          {/* Trends */}
          <Card title="Trends (Load over Time)">
            <div style={{ height: 220 }}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={(function () {
                    // build time series of avg load per date
                    const map = new Map(); // date -> {sum, n, Lsum, Rsum}
                    const add = (r) => {
                      const k = dayKey(r.date);
                      if (!map.has(k)) map.set(k, { sum: 0, n: 0, Lsum: 0, Rsum: 0 });
                      const o = map.get(k);
                      o.sum += N(r.load, 0);
                      o.n += 1;
                      if (r.hand === "L") o.Lsum += N(r.load, 0);
                      else o.Rsum += N(r.load, 0);
                    };
                    hL.forEach(add);
                    hR.forEach(add);
                    const rows = [...map.entries()].map(([d, o]) => ({
                      date: d,
                      avg: o.n ? o.sum / o.n : 0,
                      leftLoad: o.Lsum || 0,
                      rightLoad: o.Rsum || 0,
                    })).sort((a, b) => (a.date < b.date ? -1 : 1));
                    return rows;
                  })()}
                >
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="leftLoad" name="Left Load (sum)" />
                  <Bar dataKey="rightLoad" name="Right Load (sum)" />
                  <Line type="monotone" dataKey="avg" name="Avg Load" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </Card>

          {/* Tables */}
          <Card title="Left History">
            <HistoryTable rows={hL} onEdit={onEdit} onDelete={onDelete}
              editingId={editingId} editBuf={editBuf} setEditBuf={setEditBuf}
              onSaveEdit={onSaveEdit} onCancelEdit={onCancelEdit} />
          </Card>
          <Card title="Right History">
            <HistoryTable rows={hR} onEdit={onEdit} onDelete={onDelete}
              editingId={editingId} editBuf={editBuf} setEditBuf={setEditBuf}
              onSaveEdit={onSaveEdit} onCancelEdit={onCancelEdit} />
          </Card>
        </div>
      )}

      {/* MODEL */}
      {tab === "model" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          {/* Sliders panel spanning both columns */}
          <div style={{ gridColumn: "1 / span 2", border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
            <h3 style={{ marginTop: 0 }}>Manual Shape (3-Exponential) — Optional</h3>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <input type="checkbox" checked={useAdjusted} onChange={(e) => setUseAdjusted(e.target.checked)} />
              <span>Use sliders to shape recommendations</span>
            </label>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
              {/* Weights */}
              <div>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>Weights</div>
                {["w1", "w2", "w3"].map((k) => (
                  <div key={k} style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 12, color: "#555" }}>{k.toUpperCase()} = {params[k].toFixed(2)}</div>
                    <input
                      type="range" min="0" max="1" step="0.01"
                      value={params[k]}
                      onChange={(e) => setParams(p => ({ ...p, [k]: Number(e.target.value) }))}
                      style={{ width: "100%" }}
                    />
                  </div>
                ))}
                <div style={{ fontSize: 12, color: "#666" }}>Weights are auto-normalized.</div>
              </div>

              {/* Time constants */}
              <div>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>Time Constants (s)</div>
                {[["t1", 2, 40], ["t2", 20, 120], ["t3", 60, 400]].map(([k, lo, hi]) => (
                  <div key={k} style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 12, color: "#555" }}>{k.toUpperCase()} = {Math.round(params[k])} s</div>
                    <input
                      type="range" min={lo} max={hi} step="1"
                      value={params[k]}
                      onChange={(e) => setParams(p => ({ ...p, [k]: Number(e.target.value) }))}
                      style={{ width: "100%" }}
                    />
                  </div>
                ))}
                <div style={{ fontSize: 12, color: "#666" }}>Rule of thumb: t1 ~ ATP/PCr, t2 ~ glycolytic, t3 ~ oxidative.</div>
              </div>

              {/* Preview */}
              <div>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>Preview (Left)</div>
                <div style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>
                  Blue = learned; Orange = slider-shaped (normalized at 20s).
                </div>
                <div style={{ height: 180 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis type="number" dataKey="t" domain={[0, 200]} />
                      <YAxis domain={[0, "auto"]} />
                      <Tooltip />
                      <Legend />
                      <Line type="monotone" data={buildFatigueCurve(anchorsL)} dataKey="pct" name="Learned (Left)" dot={false} strokeWidth={2} />
                      <Line type="monotone" data={buildAdjustedCurve(anchorsL, params)} dataKey="pct" name="Slider Overlay" dot={false} strokeWidth={2} strokeDasharray="5 3" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          </div>

          {/* Base model curves */}
          <Card title="Fatigue Curve (Left)">
            <div style={{ height: 220 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={buildFatigueCurve(anchorsL)}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis type="number" dataKey="t" domain={[0, 200]} label={{ value: "Time (s)", position: "insideBottomRight", offset: -5 }} />
                  <YAxis domain={[0, "auto"]} />
                  <Tooltip />
                  <Legend />
                  <Line type="monotone" dataKey="pct" name="% of 20s Load" dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Card>
          <Card title="Fatigue Curve (Right)">
            <div style={{ height: 220 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={buildFatigueCurve(anchorsR)}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis type="number" dataKey="t" domain={[0, 200]} label={{ value: "Time (s)", position: "insideBottomRight", offset: -5 }} />
                  <YAxis domain={[0, "auto"]} />
                  <Tooltip />
                  <Legend />
                  <Line type="monotone" dataKey="pct" name="% of 20s Load" dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </div>
      )}

      {/* RECOMMENDATIONS */}
      {tab === "recommend" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <RecPanel
            title="Left Hand"
            nextTUT={tutL}
            onSetTUT={setTutL}
            modelLoad={modelLoadL}
            baseModelLoad={baseModelLoadL}
            adjModelLoad={adjModelLoadL}
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
            baseModelLoad={baseModelLoadR}
            adjModelLoad={adjModelLoadR}
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
    </div>
  );
}

/* ===================== Sub-components ===================== */

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
  baseModelLoad,
  adjModelLoad,
}) {
  return (
    <div style={{ border: "1px solid #eee", borderRadius: 10, padding: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ fontWeight: 700 }}>{title}</div>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <label style={{ fontSize: 12, color: "#555" }}>TUT (s)</label>
          <input
            type="number"
            min={5}
            max={200}
            step={1}
            value={nextTUT}
            onChange={(e) => onSetTUT(Math.max(1, Number(e.target.value) || 1))}
            style={{ width: 72, padding: 6 }}
          />
        </div>
      </div>

      {/* numbers */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div style={{ padding: 10, background: "#fafafa", borderRadius: 8 }}>
          <div style={{ fontSize: 12, color: "#666" }}>Model-Based</div>
          <div style={{ fontSize: 20, fontWeight: 700 }}>
            {modelLoad != null ? (modelLoad.toFixed(1) + " lb") : "—"}
          </div>
        </div>
        <div style={{ padding: 10, background: "#fafafa", borderRadius: 8 }}>
          <div style={{ fontSize: 12, color: "#666" }}>Ratio-Controller</div>
          <div style={{ fontSize: 20, fontWeight: 700 }}>
            {ratioLoad != null ? (ratioLoad.toFixed(1) + " lb") : "—"}
          </div>
        </div>

        <div style={{ gridColumn: "1 / span 2", padding: 10, background: "#f5faff", borderRadius: 8 }}>
          <div style={{ fontSize: 12, color: "#336" }}>Combined Suggestion</div>
          <div style={{ fontSize: 22, fontWeight: 800 }}>
            {combined != null ? (combined.toFixed(1) + " lb @ " + nextTUT + "s") : "—"}
          </div>
        </div>
      </div>

      {/* Base vs Adjusted comparison */}
      <div style={{ marginTop: 12, padding: 10, border: "1px solid #eee", borderRadius: 8 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Model Comparison</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <div style={{ fontSize: 12, color: "#666" }}>Base Model</div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>
              {baseModelLoad != null ? (baseModelLoad.toFixed(1) + " lb @ " + nextTUT + "s") : "—"}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: "#666" }}>Slider-Adjusted</div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>
              {adjModelLoad != null ? (adjModelLoad.toFixed(1) + " lb @ " + nextTUT + "s") : "—"}
            </div>
          </div>
        </div>
      </div>

      {/* Multi-set plan */}
      {planLoads && planLoads.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            Multi-Set Plan ({planReps} sets, rest {planRest}s)
          </div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {planLoads.map((L, i) => (
              <li key={i}>Set {i + 1}: {L} lb</li>
            ))}
          </ul>
          <div style={{ fontSize: 12, color: "#666", marginTop: 6 }}>
            Loads taper slightly so each set finishes near {nextTUT}s.
          </div>
        </div>
      )}

      <div style={{ fontSize: 13, color: "#666", marginTop: 8 }}>
        {near ? (
          <span>Nearest set: {near.load} lb @ {near.duration}s {near.notes ? "— " + near.notes : ""}</span>
        ) : ("No nearby set yet.")}
      </div>
    </div>
  );
}

function HistoryTable({ rows, onEdit, onDelete, editingId, editBuf, setEditBuf, onSaveEdit, onCancelEdit }) {
  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => {
      if (a.date === b.date) return (a.hand < b.hand ? -1 : 1);
      return a.date < b.date ? 1 : -1; // newest first
    });
  }, [rows]);

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ borderBottom: "1px solid #eee" }}>
            <th style={{ textAlign: "left", padding: "8px 6px" }}>Date</th>
            <th style={{ textAlign: "left", padding: "8px 6px" }}>Hand</th>
            <th style={{ textAlign: "left", padding: "8px 6px" }}>Grip</th>
            <th style={{ textAlign: "left", padding: "8px 6px" }}>Load (lb)</th>
            <th style={{ textAlign: "left", padding: "8px 6px" }}>Duration (s)</th>
            <th style={{ textAlign: "left", padding: "8px 6px" }}>Rest (s)</th>
            <th style={{ textAlign: "left", padding: "8px 6px" }}>Notes</th>
            <th style={{ textAlign: "left", padding: "8px 6px" }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const isEd = editingId === r.id;
            return (
              <tr key={r.id} style={{ borderBottom: "1px solid #f3f3f3" }}>
                <td style={{ padding: "8px 6px" }}>
                  {isEd ? (
                    <input value={editBuf.date} onChange={(e) => setEditBuf(b => ({ ...b, date: e.target.value }))}
                           type="date" style={{ padding: 4 }} />
                  ) : r.date}
                </td>
                <td style={{ padding: "8px 6px" }}>{r.hand}</td>
                <td style={{ padding: "8px 6px" }}>
                  {isEd ? (
                    <input value={editBuf.grip || ""} onChange={(e) => setEditBuf(b => ({ ...b, grip: e.target.value }))}
                           style={{ padding: 4, width: 160 }} />
                  ) : (r.grip || "")}
                </td>
                <td style={{ padding: "8px 6px" }}>
                  {isEd ? (
                    <input value={String(editBuf.load)} onChange={(e) => setEditBuf(b => ({ ...b, load: N(e.target.value, b.load) }))}
                           inputMode="decimal" style={{ padding: 4, width: 80 }} />
                  ) : r.load}
                </td>
                <td style={{ padding: "8px 6px" }}>
                  {isEd ? (
                    <input value={String(editBuf.duration)} onChange={(e) => setEditBuf(b => ({ ...b, duration: N(e.target.value, b.duration) }))}
                           inputMode="numeric" style={{ padding: 4, width: 80 }} />
                  ) : r.duration}
                </td>
                <td style={{ padding: "8px 6px" }}>
                  {isEd ? (
                    <input value={String(r.rest ?? 0)} onChange={(e) => setEditBuf(b => ({ ...b, rest: N(e.target.value, b.rest ?? 0) }))}
                           inputMode="numeric" style={{ padding: 4, width: 80 }} />
                  ) : (r.rest ?? 0)}
                </td>
                <td style={{ padding: "8px 6px" }}>
                  {isEd ? (
                    <input value={editBuf.notes || ""} onChange={(e) => setEditBuf(b => ({ ...b, notes: e.target.value }))}
                           style={{ padding: 4, width: 240 }} />
                  ) : (r.notes || "")}
                </td>
                <td style={{ padding: "8px 6px" }}>
                  {isEd ? (
                    <>
                      <button onClick={onSaveEdit} style={{ marginRight: 6 }}>Save</button>
                      <button onClick={onCancelEdit}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => onEdit(r)} style={{ marginRight: 6 }}>Edit</button>
                      <button onClick={() => onDelete(r)} style={{ color: "#b00020" }}>Delete</button>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={8} style={{ padding: 12, color: "#666" }}>No records yet.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
