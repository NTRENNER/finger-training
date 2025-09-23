import React, { useEffect, useMemo, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
  AreaChart,
  Area,
} from "recharts";

// ---------- utilities ----------
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round1 = (x) => Math.round(x * 10) / 10;
const pct = (x) => `${round1(100 * x)}%`;

const loadLS = (k, fallback) => {
  try {
    const raw = localStorage.getItem(k);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};
const saveLS = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
};

// --- CSV helpers ---
function csvEscape(val = "") {
  const s = String(val ?? "");
  // escape quotes by doubling them; wrap in quotes if it has comma, quote, or newline
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function rowsToCSV(rows) {
  const headers = [
    "id","date","grip",
    "leftLoad","rightLoad","leftDur","rightDur","rest",
    "pctL","pctR","recL","recR",
    "notes"
  ];
  const lines = [headers.join(",")];
  for (const r of rows) {
    const line = [
      r.id,
      r.date,
      r.grip,
      r.leftLoad,
      r.rightLoad,
      r.leftDur,
      r.rightDur,
      r.rest,
      // write modeled percentages as 0–100 with 1 decimal
      r.pctL != null ? (100*Number(r.pctL)).toFixed(1) : "",
      r.pctR != null ? (100*Number(r.pctR)).toFixed(1) : "",
      r.recL != null ? (100*Number(r.recL)).toFixed(1) : "",
      r.recR != null ? (100*Number(r.recR)).toFixed(1) : "",
      r.notes ?? ""
    ].map(csvEscape).join(",");
    lines.push(line);
  }
  // BOM helps Excel recognize UTF-8
  return "\uFEFF" + lines.join("\n");
}
function downloadCSV(rows, filename = "finger-training-history.csv") {
  if (!rows?.length) return;
  const csv = rowsToCSV(rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------- 3-exp fatigue + recovery ----------
function fAt(t, w, tau) {
  const e = (x) => Math.exp(-t / Math.max(1e-9, x));
  return w.w1 * e(tau.tau1) + w.w2 * e(tau.tau2) + w.w3 * e(tau.tau3);
}
// Recovery fraction over rest r (how much of the missing capacity you get back)
function Rof(r, w, rec) {
  const e = (x) => Math.exp(-r / Math.max(1e-9, x));
  return 1 - (w.w1 * e(rec.r1) + w.w2 * e(rec.r2) + w.w3 * e(rec.r3));
}

// capacity simulation across a plan
function simulateCapacityPlan({
  sets,
  repsPerSet,
  T,
  restRep,
  restSet,
  w,
  tau,
  rec,
}) {
  const fT = fAt(T, w, tau);
  const repFactor = 1 - Rof(restRep, w, rec); // = sum w_i e^{-r/ρ_i}
  const setFactor = 1 - Rof(restSet, w, rec);

  let C = 1; // fresh
  const capacities = []; // C before each rep
  for (let s = 0; s < sets; s++) {
    for (let r = 0; r < repsPerSet; r++) {
      capacities.push(C);
      const Cend = C * fT;
      const isLastInSet = r === repsPerSet - 1;
      const factor = isLastInSet ? setFactor : repFactor;
      C = 1 - (1 - Cend) * factor;
    }
  }
  return { capacities, fT };
}

// recommended load so that the last rep (or last rep of first set) fails at T
function recommendLoadForPlan({
  max,
  sets,
  repsPerSet,
  T,
  restRep,
  restSet,
  w,
  tau,
  rec,
  anchor = "planEnd",
}) {
  const { capacities, fT } = simulateCapacityPlan({
    sets,
    repsPerSet,
    T,
    restRep,
    restSet,
    w,
    tau,
    rec,
  });
  let idx =
    anchor === "planEnd" ? capacities.length - 1 : Math.max(0, repsPerSet - 1);
  const Cbefore = clamp(capacities[idx], 0, 1);
  return max * Cbefore * fT;
}

// ---------- default model state ----------
const defaultState = {
  // UI
  tab: "recommend",
  // anchors / learning
  targetPower: 20,
  targetStrength: 60,
  targetEndurance: 180,
  // per-hand effective max (you can update via Learn buttons)
  maxLeft: 145,
  maxRight: 145,
  // 3-exp weights
  wLeft: { w1: 0.293, w2: 0.0, w3: 0.707 },
  wRight: { w1: 0.293, w2: 0.0, w3: 0.707 },
  // fatigue taus
  tau: { tau1: 7, tau2: 45, tau3: 180 },
  // recovery taus
  rec: { r1: 30, r2: 300, r3: 1800 },
  // history rows
  history: [],
  // planner
  plan: { sets: 3, repsPerSet: 5, T: 20, restRep: 60, restSet: 180, anchor: "planEnd" },
  // model chart range
  chartMax: 300,
};

function App() {
  const [S, setS] = useState(() => loadLS("state-v2", defaultState));
  useEffect(() => saveLS("state-v2", S), [S]);

  // convenient setters
  const setTab = (t) => setS((s) => ({ ...s, tab: t }));
  const setPlan = (p) => setS((s) => ({ ...s, plan: { ...s.plan, ...p } }));

  // ------- Recommendations: model-based loads (per hand) -------
  const f20L = useMemo(() => fAt(S.targetPower, S.wLeft, S.tau), [S]);
  const f60L = useMemo(() => fAt(S.targetStrength, S.wLeft, S.tau), [S]);
  const f180L = useMemo(() => fAt(S.targetEndurance, S.wLeft, S.tau), [S]);

  const f20R = useMemo(() => fAt(S.targetPower, S.wRight, S.tau), [S]);
  const f60R = useMemo(() => fAt(S.targetStrength, S.wRight, S.tau), [S]);
  const f180R = useMemo(() => fAt(S.targetEndurance, S.wRight, S.tau), [S]);

  const modelLoadsLeft = useMemo(
    () => ({
      power: S.maxLeft * f20L,
      strength: S.maxLeft * f60L,
      endurance: S.maxLeft * f180L,
    }),
    [S, f20L, f60L, f180L]
  );
  const modelLoadsRight = useMemo(
    () => ({
      power: S.maxRight * f20R,
      strength: S.maxRight * f60R,
      endurance: S.maxRight * f180R,
    }),
    [S, f20R, f60R, f180R]
  );

  // ------- Reps Planner (new) -------
  const recLeft = useMemo(
    () =>
      recommendLoadForPlan({
        max: S.maxLeft,
        sets: S.plan.sets,
        repsPerSet: S.plan.repsPerSet,
        T: S.plan.T,
        restRep: S.plan.restRep,
        restSet: S.plan.restSet,
        w: S.wLeft,
        tau: S.tau,
        rec: S.rec,
        anchor: S.plan.anchor,
      }),
    [S]
  );
  const recRight = useMemo(
    () =>
      recommendLoadForPlan({
        max: S.maxRight,
        sets: S.plan.sets,
        repsPerSet: S.plan.repsPerSet,
        T: S.plan.T,
        restRep: S.plan.restRep,
        restSet: S.plan.restSet,
        w: S.wRight,
        tau: S.tau,
        rec: S.rec,
        anchor: S.plan.anchor,
      }),
    [S]
  );

  // small capacity preview (left)
  const planPreviewLeft = useMemo(
    () =>
      simulateCapacityPlan({
        sets: S.plan.sets,
        repsPerSet: S.plan.repsPerSet,
        T: S.plan.T,
        restRep: S.plan.restRep,
        restSet: S.plan.restSet,
        w: S.wLeft,
        tau: S.tau,
        rec: S.rec,
      }).capacities,
    [S]
  );

  // ------- Sessions / History -------
  const [session, setSession] = useState({
    date: new Date().toISOString().slice(0, 10),
    grip: "20mm Half Crimp",
    leftLoad: "",
    rightLoad: "",
    leftDur: S.targetPower,
    rightDur: S.targetPower,
    rest: 180,
    notes: "",
  });

  const addSession = () => {
    const row = {
      id: Date.now(),
      date: session.date,
      grip: session.grip,
      leftLoad: Number(session.leftLoad) || 0,
      rightLoad: Number(session.rightLoad) || 0,
      leftDur: Number(session.leftDur) || 0,
      rightDur: Number(session.rightDur) || 0,
      rest: Number(session.rest) || 0,
      notes: session.notes || "",
      // quick model stamps for history table
      pctL: fAt(Number(session.leftDur) || 0, S.wLeft, S.tau),
      pctR: fAt(Number(session.rightDur) || 0, S.wRight, S.tau),
      recL: Rof(S.targetEndurance, S.wLeft, S.rec),
      recR: Rof(S.targetEndurance, S.wRight, S.rec),
    };
    setS((s) => ({ ...s, history: [row, ...s.history] }));
    setSession((x) => ({ ...x, leftLoad: "", rightLoad: "", notes: "" }));
  };
  const updateRow = (id, patch) =>
    setS((s) => ({
      ...s,
      history: s.history.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    }));
  const deleteRow = (id) =>
    setS((s) => ({ ...s, history: s.history.filter((r) => r.id !== id) }));

  // trends chart data
  const trends = useMemo(() => {
    if (!S.history.length) return [];
    // simple date groups
    const byDay = {};
    for (const r of S.history) {
      if (!byDay[r.date]) byDay[r.date] = [];
      byDay[r.date].push(r);
    }
    const rows = Object.keys(byDay)
      .sort()
      .map((d) => {
        const L = byDay[d];
        const avg = (arr, k) =>
          arr.length ? arr.reduce((a, x) => a + (Number(x[k]) || 0), 0) / arr.length : 0;
        const avgDur = (avg(L, "leftDur") + avg(L, "rightDur")) / 2;
        const avgLoad = (avg(L, "leftLoad") + avg(L, "rightLoad")) / 2;
        const avgPct = (avg(L, "pctL") + avg(L, "pctR")) / 2;
        return { day: d, avgDur, avgLoad, avgPct: 100 * avgPct };
      });
    return rows;
  }, [S.history]);

  // ------- Model charts -------
  const fatigueData = useMemo(() => {
    const out = [];
    for (let t = 0; t <= S.chartMax; t += 10) {
      out.push({
        t,
        fL: 100 * fAt(t, S.wLeft, S.tau),
        fR: 100 * fAt(t, S.wRight, S.tau),
        fast: 100 * (S.wLeft.w1 * Math.exp(-t / S.tau.tau1)),
        med: 100 * (S.wLeft.w2 * Math.exp(-t / S.tau.tau2)),
        slow: 100 * (S.wLeft.w3 * Math.exp(-t / S.tau.tau3)),
      });
    }
    return out;
  }, [S.wLeft, S.wRight, S.tau, S.chartMax]);

  // ---------- UI ----------
  return (
    <div style={{ fontFamily: "system-ui, -apple-system, Segoe UI, Roboto", padding: 16 }}>
      <h2 style={{ marginTop: 0 }}>
        Finger Training Dosing — Precision Mode (Per Hand)
      </h2>
      <div style={{ color: "#666", marginTop: -8, marginBottom: 12 }}>
        Aim to fail within ±2–3 s. Learn per hand, ratio-control your next load, smooth anchors
        with EMA, and see your sets on the curve.
      </div>

      {/* tabs */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        {[
          ["recommend", "Recommendations"],
          ["sessions", "Sessions"],
          ["history", "History"],
          ["model", "Model"],
        ].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid #ddd",
              background: S.tab === key ? "#111" : "#f7f7f7",
              color: S.tab === key ? "#fff" : "#111",
              cursor: "pointer",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ---------- RECOMMENDATIONS ---------- */}
      {S.tab === "recommend" && (
        <>
          {/* Precision settings + anchors */}
          <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 12 }}>
            <div className="card">
              <h3>Precision Settings</h3>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                <div>
                  <div style={{ fontSize: 12, opacity: 0.7 }}>Max Left</div>
                  <input
                    type="number"
                    value={S.maxLeft}
                    onChange={(e) =>
                      setS((s) => ({ ...s, maxLeft: Math.max(1, Number(e.target.value) || 1) }))
                    }
                  />
                </div>
                <div>
                  <div style={{ fontSize: 12, opacity: 0.7 }}>Max Right</div>
                  <input
                    type="number"
                    value={S.maxRight}
                    onChange={(e) =>
                      setS((s) => ({ ...s, maxRight: Math.max(1, Number(e.target.value) || 1) }))
                    }
                  />
                </div>
                <div>
                  <div style={{ fontSize: 12, opacity: 0.7 }}>Chart max time (s)</div>
                  <input
                    type="number"
                    value={S.chartMax}
                    onChange={(e) =>
                      setS((s) => ({ ...s, chartMax: Math.max(60, Number(e.target.value) || 300) }))
                    }
                  />
                </div>
              </div>
            </div>

            <div className="card">
              <h3>Anchor TUTs</h3>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                <label>
                  Power TUT (s)
                  <input
                    type="number"
                    value={S.targetPower}
                    onChange={(e) =>
                      setS((s) => ({ ...s, targetPower: Math.max(1, Number(e.target.value) || 1) }))
                    }
                  />
                </label>
                <label>
                  Strength TUT (s)
                  <input
                    type="number"
                    value={S.targetStrength}
                    onChange={(e) =>
                      setS((s) => ({
                        ...s,
                        targetStrength: Math.max(1, Number(e.target.value) || 1),
                      }))
                    }
                  />
                </label>
                <label>
                  Endurance TUT (s)
                  <input
                    type="number"
                    value={S.targetEndurance}
                    onChange={(e) =>
                      setS((s) => ({
                        ...s,
                        targetEndurance: Math.max(1, Number(e.target.value) || 1),
                      }))
                    }
                  />
                </label>
              </div>
              <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
                These TUTs are used for the model-based loads and curves.
              </div>
            </div>
          </div>

          {/* Model-based loads */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
            <div className="card">
              <h3>Model-Based Loads — LEFT</h3>
              <div className="grid3">
                <Pill label="Power (20s)" value={round1(modelLoadsLeft.power)} />
                <Pill label="Strength (60s)" value={round1(modelLoadsLeft.strength)} />
                <Pill label="Endurance (180s)" value={round1(modelLoadsLeft.endurance)} />
              </div>
            </div>
            <div className="card">
              <h3>Model-Based Loads — RIGHT</h3>
              <div className="grid3">
                <Pill label="Power (20s)" value={round1(modelLoadsRight.power)} />
                <Pill label="Strength (60s)" value={round1(modelLoadsRight.strength)} />
                <Pill label="Endurance (180s)" value={round1(modelLoadsRight.endurance)} />
              </div>
            </div>
          </div>

          {/* NEW: Reps Planner */}
          <div className="card" style={{ marginTop: 12 }}>
            <h3>Reps Planner (3-exp fatigue + 3-exp recovery)</h3>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(6, minmax(130px,1fr))",
                gap: 10,
              }}
            >
              <label>
                Sets
                <input
                  type="number"
                  min={1}
                  value={S.plan.sets}
                  onChange={(e) => setPlan({ sets: Math.max(1, Number(e.target.value) || 1) })}
                />
              </label>
              <label>
                Reps / Set
                <input
                  type="number"
                  min={1}
                  value={S.plan.repsPerSet}
                  onChange={(e) =>
                    setPlan({ repsPerSet: Math.max(1, Number(e.target.value) || 1) })
                  }
                />
              </label>
              <label>
                TUT (s)
                <input
                  type="number"
                  min={1}
                  value={S.plan.T}
                  onChange={(e) => setPlan({ T: Math.max(1, Number(e.target.value) || 1) })}
                />
              </label>
              <label>
                Rest between reps (s)
                <input
                  type="number"
                  min={0}
                  value={S.plan.restRep}
                  onChange={(e) => setPlan({ restRep: Math.max(0, Number(e.target.value) || 0) })}
                />
              </label>
              <label>
                Rest between sets (s)
                <input
                  type="number"
                  min={0}
                  value={S.plan.restSet}
                  onChange={(e) => setPlan({ restSet: Math.max(0, Number(e.target.value) || 0) })}
                />
              </label>
              <label>
                Anchor
                <select
                  value={S.plan.anchor}
                  onChange={(e) => setPlan({ anchor: e.target.value })}
                >
                  <option value="planEnd">Fail at end of plan</option>
                  <option value="endOfEachSet">Fail at end of each set</option>
                </select>
              </label>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(2, minmax(220px,1fr))",
                gap: 12,
                marginTop: 10,
              }}
            >
              <BigPill title="Recommended Left Load" value={round1(recLeft)} />
              <BigPill title="Recommended Right Load" value={round1(recRight)} />
            </div>

            <div style={{ fontSize: 12, opacity: 0.8, marginTop: 8 }}>
              Capacity before reps (Left):{" "}
              {planPreviewLeft.map((c, i) => (i ? ", " : "") + pct(c))}
            </div>
          </div>
        </>
      )}

      {/* ---------- SESSIONS ---------- */}
      {S.tab === "sessions" && (
        <div className="grid2">
          <div className="card">
            <h3>Log a Session</h3>
            <div className="form">
              <label>
                Date
                <input
                  type="date"
                  value={session.date}
                  onChange={(e) => setSession({ ...session, date: e.target.value })}
                />
              </label>
              <label>
                Grip / Exercise
                <input
                  value={session.grip}
                  onChange={(e) => setSession({ ...session, grip: e.target.value })}
                />
              </label>
              <div className="grid2">
                <label>
                  Left Load
                  <input
                    type="number"
                    value={session.leftLoad}
                    onChange={(e) =>
                      setSession({ ...session, leftLoad: Number(e.target.value) || 0 })
                    }
                  />
                </label>
                <label>
                  Right Load
                  <input
                    type="number"
                    value={session.rightLoad}
                    onChange={(e) =>
                      setSession({ ...session, rightLoad: Number(e.target.value) || 0 })
                    }
                  />
                </label>
              </div>
              <div className="grid2">
                <label>
                  Left Duration (s)
                  <input
                    type="number"
                    value={session.leftDur}
                    onChange={(e) =>
                      setSession({ ...session, leftDur: Number(e.target.value) || 0 })
                    }
                  />
                </label>
                <label>
                  Right Duration (s)
                  <input
                    type="number"
                    value={session.rightDur}
                    onChange={(e) =>
                      setSession({ ...session, rightDur: Number(e.target.value) || 0 })
                    }
                  />
                </label>
              </div>
              <label>
                Rest (s)
                <input
                  type="number"
                  value={session.rest}
                  onChange={(e) => setSession({ ...session, rest: Number(e.target.value) || 0 })}
                />
              </label>
              <label>
                Notes
                <textarea
                  rows={3}
                  value={session.notes}
                  onChange={(e) => setSession({ ...session, notes: e.target.value })}
                />
              </label>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={addSession}>Add Session</button>
              </div>
            </div>
          </div>

          <div className="card">
            <h3>Today’s Modeled Values</h3>
            <div className="grid3">
              <Pill label="%MVC Left @ 20s" value={pct(f20L)} />
              <Pill label="%MVC Right @ 20s" value={pct(f20R)} />
              <Pill
                label={`Recovery after ${S.targetEndurance}s`}
                value={`Left ${pct(Rof(S.targetEndurance, S.wLeft, S.rec))} · Right ${pct(
                  Rof(S.targetEndurance, S.wRight, S.rec)
                )}`}
              />
            </div>
          </div>
        </div>
      )}

      {/* ---------- HISTORY ---------- */}
      {S.tab === "history" && (
        <>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <button
              onClick={() => {
                if (window.confirm("Clear ALL history? This cannot be undone.")) {
                  setS((s) => ({ ...s, history: [] }));
                }
              }}
              style={{ background: "#fff3f3", borderColor: "#f2bcbc", color: "#b00000" }}
            >
              Clear All
            </button>
          </div>

          <div className="card">
            <h3>Session History (most recent first)</h3>
            <div className="table">
              <div className="thead">
                <div>Actions</div>
                <div>Date</div>
                <div>Grip</div>
                <div>Left Load</div>
                <div>Right Load</div>
                <div>Left Dur (s)</div>
                <div>Right Dur (s)</div>
                <div>% L</div>
                <div>% R</div>
                <div>Recov L</div>
                <div>Recov R</div>
                <div>Notes</div>
              </div>
              {S.history.map((r) => (
                <div className="trow" key={r.id}>
                  <div>
                    <button
                      onClick={() =>
                        window.confirm("Delete this row?") && deleteRow(r.id)
                      }
                      style={{ background: "#fff3f3", borderColor: "#f2bcbc", color: "#b00000" }}
                    >
                      Delete
                    </button>
                  </div>
                  <div>{r.date}</div>
                  <div>
                    <input
                      value={r.grip}
                      onChange={(e) => updateRow(r.id, { grip: e.target.value })}
                    />
                  </div>
                  <div>
                    <input
                      type="number"
                      value={r.leftLoad}
                      onChange={(e) => updateRow(r.id, { leftLoad: Number(e.target.value) || 0 })}
                    />
                  </div>
                  <div>
                    <input
                      type="number"
                      value={r.rightLoad}
                      onChange={(e) => updateRow(r.id, { rightLoad: Number(e.target.value) || 0 })}
                    />
                  </div>
                  <div>
                    <input
                      type="number"
                      value={r.leftDur}
                      onChange={(e) => updateRow(r.id, { leftDur: Number(e.target.value) || 0 })}
                    />
                  </div>
                  <div>
                    <input
                      type="number"
                      value={r.rightDur}
                      onChange={(e) => updateRow(r.id, { rightDur: Number(e.target.value) || 0 })}
                    />
                  </div>
                  <div>{pct(r.pctL)}</div>
                  <div>{pct(r.pctR)}</div>
                  <div>{pct(r.recL)}</div>
                  <div>{pct(r.recR)}</div>
                  <div>
                    <input
                      value={r.notes}
                      onChange={(e) => updateRow(r.id, { notes: e.target.value })}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Trends */}
          <div className="card" style={{ marginTop: 12 }}>
            <h3>Trends (averages)</h3>
            <div style={{ width: "100%", height: 260 }}>
              <ResponsiveContainer>
                <LineChart data={trends} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="day" />
                  <YAxis yAxisId="left" />
                  <YAxis yAxisId="right" orientation="right" domain={[0, 100]} />
                  <Tooltip />
                  <Legend />
                  <Line yAxisId="left" type="monotone" dataKey="avgLoad" name="Avg Load (L/R)" dot={false} />
                  <Line yAxisId="left" type="monotone" dataKey="avgDur" name="Avg Duration (s)" dot={false} />
                  <Line yAxisId="right" type="monotone" dataKey="avgPct" name="Modeled %MVC (avg)" dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </>
      )}
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
  <button
    onClick={() => {
      if (window.confirm("Clear ALL history? This cannot be undone.")) {
        setS((s) => ({ ...s, history: [] }));
      }
    }}
    style={{ background: "#fff3f3", borderColor: "#f2bcbc", color: "#b00000" }}
  >
    Clear All
  </button>

  <button
    onClick={() => downloadCSV(S.history)}
    disabled={!S.history.length}
    title={S.history.length ? "Download all history as CSV" : "No history yet"}
  >
    Download CSV
  </button>
</div>

      {/* ---------- MODEL ---------- */}
      {S.tab === "model" && (
        <div className="grid2">
          <div className="card">
            <h3>Parameters</h3>

            <label>
              Max Left
              <input
                type="number"
                value={S.maxLeft}
                onChange={(e) => setS((s) => ({ ...s, maxLeft: Number(e.target.value) || 0 }))}
              />
            </label>
            <label>
              Max Right
              <input
                type="number"
                value={S.maxRight}
                onChange={(e) => setS((s) => ({ ...s, maxRight: Number(e.target.value) || 0 }))}
              />
            </label>

            <h4>Left Weights</h4>
            {["w1", "w2", "w3"].map((k) => (
              <SliderRow
                key={`L-${k}`}
                label={`${k}`}
                value={S.wLeft[k]}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) =>
                  setS((s) => ({ ...s, wLeft: { ...s.wLeft, [k]: clamp(v, 0, 1) } }))
                }
              />
            ))}

            <h4>Right Weights</h4>
            {["w1", "w2", "w3"].map((k) => (
              <SliderRow
                key={`R-${k}`}
                label={`${k}`}
                value={S.wRight[k]}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) =>
                  setS((s) => ({ ...s, wRight: { ...s.wRight, [k]: clamp(v, 0, 1) } }))
                }
              />
            ))}

            <h4>Fatigue τ (s)</h4>
            {[
              ["tau1", 1, 60],
              ["tau2", 10, 600],
              ["tau3", 30, 1800],
            ].map(([k, lo, hi]) => (
              <SliderRow
                key={k}
                label={k}
                value={S.tau[k]}
                min={lo}
                max={hi}
                step={1}
                onChange={(v) => setS((s) => ({ ...s, tau: { ...s.tau, [k]: Math.max(1, v) } }))}
              />
            ))}

            <h4>Recovery τ (s)</h4>
            {[
              ["r1", 10, 300],
              ["r2", 60, 3600],
              ["r3", 300, 7200],
            ].map(([k, lo, hi]) => (
              <SliderRow
                key={k}
                label={k}
                value={S.rec[k]}
                min={lo}
                max={hi}
                step={1}
                onChange={(v) => setS((s) => ({ ...s, rec: { ...s.rec, [k]: Math.max(1, v) } }))}
              />
            ))}

            <label>
              Chart max time (s)
              <input
                type="number"
                value={S.chartMax}
                onChange={(e) =>
                  setS((s) => ({ ...s, chartMax: Math.max(60, Number(e.target.value) || 300) }))
                }
              />
            </label>
          </div>

          <div className="card">
            <h3>Fatigue Curve f(t) with Sets</h3>
            <div style={{ width: "100%", height: 320 }}>
              <ResponsiveContainer>
                <LineChart data={fatigueData} margin={{ top: 10, right: 20, left: 10, bottom: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis
                    type="number"
                    dataKey="t"
                    domain={[0, S.chartMax]}
                    label={{ value: "Time (s)", position: "insideBottomRight", offset: -5 }}
                  />
                  <YAxis domain={[0, 100]} />
                  <Tooltip />
                  <Legend />
                  <Line type="monotone" dataKey="fL" name="f_L(t)" dot={false} />
                  <Line type="monotone" dataKey="fR" name="f_R(t)" dot={false} />
                  <Line type="monotone" dataKey="fast" name="fast (τ1)" dot={false} strokeDasharray="5 5" />
                  <Line type="monotone" dataKey="med" name="med (τ2)" dot={false} strokeDasharray="5 5" />
                  <Line type="monotone" dataKey="slow" name="slow (τ3)" dot={false} strokeDasharray="5 5" />
                  <ReferenceLine x={S.targetPower} stroke="#bbb" strokeDasharray="3 3" />
                  <ReferenceLine x={S.targetStrength} stroke="#bbb" strokeDasharray="3 3" />
                  <ReferenceLine x={S.targetEndurance} stroke="#bbb" strokeDasharray="3 3" />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Recovery preview (Left) */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
              <div>
                <h4>Recovery vs Rest — LEFT</h4>
                <div style={{ width: "100%", height: 200 }}>
                  <ResponsiveContainer>
                    <AreaChart data={Array.from({ length: 19 }).map((_, i) => {
                      const rest = i * 100;
                      return { rest, rec: 100 * Rof(rest, S.wLeft, S.rec) };
                    })}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="rest" />
                      <YAxis domain={[0, 100]} />
                      <Tooltip />
                      <Area dataKey="rec" name="Recovery (%)" />
                      <ReferenceLine x={S.targetEndurance} stroke="#bbb" strokeDasharray="3 3" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
              <div>
                <h4>Recovery vs Rest — RIGHT</h4>
                <div style={{ width: "100%", height: 200 }}>
                  <ResponsiveContainer>
                    <AreaChart data={Array.from({ length: 19 }).map((_, i) => {
                      const rest = i * 100;
                      return { rest, rec: 100 * Rof(rest, S.wRight, S.rec) };
                    })}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="rest" />
                      <YAxis domain={[0, 100]} />
                      <Tooltip />
                      <Area dataKey="rec" name="Recovery (%)" />
                      <ReferenceLine x={S.targetEndurance} stroke="#bbb" strokeDasharray="3 3" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* --------- tiny styles --------- */}
      <style>{`
        .grid2 { display:grid; grid-template-columns: 1.1fr 1fr; gap:12px; }
        .grid3 { display:grid; grid-template-columns: repeat(3, minmax(120px,1fr)); gap:8px; }
        .card { border:1px solid #e6e6e6; border-radius:12px; padding:12px; background:#fff; }
        .pill { border:1px solid #ececec; border-radius:10px; padding:10px; background:#fafafa; }
        .table { display:grid; gap:6px; }
        .thead, .trow {
          display:grid; grid-template-columns: 90px 105px 160px 90px 90px 90px 90px 80px 80px 90px 90px 1fr;
          gap:6px; align-items:center;
        }
        .thead { font-weight:600; color:#333; }
        input, select, textarea, button {
          width:100%; padding:8px; border-radius:8px; border:1px solid #ddd; background:#fff;
        }
        button { cursor:pointer; }
        h3 { margin-top:0; }
        h4 { margin-bottom:6px; }
      `}</style>
    </div>
  );
}

// ---------- small UI pieces ----------
function Pill({ label, value }) {
  return (
    <div className="pill">
      <div style={{ fontSize: 12, opacity: 0.7 }}>{label}</div>
      <div style={{ fontWeight: 700 }}>{value}</div>
    </div>
  );
}
function BigPill({ title, value }) {
  return (
    <div className="pill" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <div style={{ fontSize: 12, opacity: 0.7 }}>{title}</div>
      <div style={{ fontSize: 26, fontWeight: 800 }}>{value}</div>
    </div>
  );
}
function SliderRow({ label, value, min, max, step, onChange }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, opacity: 0.8 }}>
        <span>{label}</span>
        <span>{round1(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

export default App;