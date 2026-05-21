// ─────────────────────────────────────────────────────────────
// HISTORY VIEW
// ─────────────────────────────────────────────────────────────
// The "History" tab — three-domain (fingers / workout / climbing)
// session log with full edit capabilities for finger-training reps.
//
// Fingers domain: per-session cards with rep chips. Click ✏️ to enable
// per-rep editing — tap a chip to edit load/time/hand, + to add a rep,
// × to delete. Also supports manual session entry via "+ Session"
// (date, grip, zone, repeating rep entries with auto-alternating L/R).
// Per-session notes are persisted in the parent via onNoteChange.
//
// Workout domain: delegates to WorkoutHistoryView (strength-training log).
//
// Climbing domain: delegates to ClimbingHistoryList (date-grouped climbs).
//
// All mutations dispatch through callbacks (onUpdateRep / onAddRep /
// onDeleteRep / onDeleteSession / onUpdateSession / onDeleteActivity)
// so this view doesn't reach into the parent's state directly.

import React, { useMemo, useState } from "react";
import { C } from "../ui/theme.js";
import { Card, Btn } from "../ui/components.js";
import {
  fmt1, fmtW, fmtTime, toDisp, fromDisp, fmtClock, bwOnDate,
} from "../ui/format.js";
import { ymdLocal } from "../util.js";
import { effectiveLoad, isShortfall, prescription } from "../model/prescription.js";
import { TARGET_OPTIONS } from "../model/zones.js";
import {
  loadLS, saveLS,
  LS_BW_LOG_KEY, LS_HISTORY_DOMAIN_KEY, LS_WORKOUT_LOG_KEY,
} from "../lib/storage.js";
import { WorkoutHistoryView } from "./WorkoutHistoryView.js";
import { ClimbingHistoryList } from "./ClimbingHistoryList.js";
import { RepCurveChart } from "./cards/RepCurveChart.jsx";
import { buildRepCurveBundle } from "../model/repCurveData.js";
import { deleteBW } from "../lib/sync.js";

export function HistoryView({
  history,
  // Optional opts passed through to the prescription engine when we
  // reconstruct "what would the engine recommend for this protocol?"
  // for the rep-curve chart's target/used load caption. Without these,
  // prescription() falls through to its degenerate anchored-linear
  // fallback which can extrapolate wildly off short heavy reps.
  freshMap = null,
  threeExpPriors = null,
  onDownload, unit = "lbs", bodyWeight = null,
  onDeleteSession, onUpdateSession,
  onDeleteRep, onUpdateRep, onAddRep,
  notes = {}, onNoteChange,
  activities = [], onDeleteActivity = () => {}, onUpdateActivity = () => {},
  defaultWorkouts = {},
  onDeleteWorkoutSession = () => {},
  onDownloadWorkoutCSV = () => {},
  onDownloadClimbingCSV = () => {},
  gripPresets = [],
}) {
  const [domain,      setDomain]      = useState(() => loadLS(LS_HISTORY_DOMAIN_KEY) || "fingers");
  const switchDomain = (d) => { setDomain(d); saveLS(LS_HISTORY_DOMAIN_KEY, d); };
  const [grip,        setGrip]        = useState("");
  const [hand,        setHand]        = useState("");
  const [target,      setTarget]      = useState(0);
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
  const [editRepHand, setEditRepHand] = useState(null);        // "L" | "R" — null in add-mode means "auto-derive at save"
  const [editRepRest, setEditRepRest] = useState("");          // seconds of rest_s (edit or add) — empty string means "leave existing value"
  // Manual session entry
  const [addingSession,    setAddingSession]    = useState(false);
  const [newSessDate,      setNewSessDate]      = useState(() => ymdLocal());
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
    setEditRepHand(rep.hand === "L" || rep.hand === "R" ? rep.hand : null);
    setEditRepRest(rep.rest_s != null ? String(rep.rest_s) : "");
  };
  const closeRepEdit = () => { setEditingRep(null); setAddingRep(null); setEditRepHand(null); setEditRepRest(""); };

  const saveRepEdit = () => {
    if (!editingRep) return;
    const loadKg = fromDisp(parseFloat(editRepLoad), unit);
    const newTime = parseFloat(editRepTime);
    const updates = { actual_time_s: newTime };
    if (editingRep.rep.avg_force_kg > 0) updates.avg_force_kg = loadKg;
    else updates.weight_kg = loadKg;
    if (editRepHand === "L" || editRepHand === "R") updates.hand = editRepHand;
    // Re-derive failed from the new time so edits keep the flag honest.
    const tgt = editingRep.rep.target_duration;
    if (tgt > 0 && newTime > 0) updates.failed = isShortfall(newTime, tgt);
    // Rest_s edit — only write if user typed a non-empty value (so
    // the field can be left blank to leave the existing value intact).
    if (editRepRest.trim() !== "") {
      const restN = parseInt(editRepRest, 10);
      if (Number.isFinite(restN) && restN >= 0) updates.rest_s = restN;
    }
    onUpdateRep(editingRep.rep, updates);
    closeRepEdit();
  };

  const openRepAdd = (sessKey) => {
    setEditingRep(null);
    setAddingRep(sessKey);
    setEditRepLoad("");
    setEditRepTime("");
    setEditRepHand(null); // null = auto-derive from session in saveRepAdd
    setEditRepRest("");   // empty = saveRepAdd will default to 20s (matches sync.js fallback)
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
    //  - If the user explicitly picked L or R in the editor, honor it.
    //  - Otherwise single-hand session: use sess.hand
    //  - Otherwise mixed/Both session: alternate from last rep's hand (fallback L)
    let newHand;
    if (editRepHand === "L" || editRepHand === "R") {
      newHand = editRepHand;
    } else {
      newHand = sess.hand;
      if (sess.hand === "B") {
        const lastHand = existingReps.length ? existingReps[existingReps.length - 1].hand : null;
        newHand = lastHand === "L" ? "R" : "L";
      }
    }
    const newRep = {
      date:            sess.date,
      grip:            sess.grip,
      hand:            newHand,
      target_duration: sess.target_duration,
      actual_time_s:   time,
      avg_force_kg:    loadKg,
      weight_kg:       loadKg,
      peak_force_kg:   null,  // unknown for manual entries (Tindeq captures it live)
      set_num:         maxSetNum,
      rep_num:         maxRepNum + 1,
      // rest_s: prefer the user's typed value if present, otherwise
      // mirror the previous rep's rest_s, otherwise default to 20s
      // (the protocol default for all three zones).
      rest_s:          (() => {
        const typed = parseInt(editRepRest, 10);
        if (Number.isFinite(typed) && typed >= 0) return typed;
        const prev = existingReps.length ? existingReps[existingReps.length - 1].rest_s : null;
        return Number.isFinite(prev) ? prev : 20;
      })(),
      session_id:      sessionId,
      failed:          isShortfall(time, sess.target_duration),
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
        peak_force_kg:   null,  // unknown for manual entries (Tindeq captures it live)
        set_num:         1,
        rep_num:         i + 1,
        rest_s:          0,
        session_id:      sessionId,
        failed:          isShortfall(parseFloat(r.time), newSessTarget),
      };
    });
    // Pass all reps at once so addReps dedupes against the original state, not incremental updates
    onAddRep(reps);
    setAddingSession(false);
    setNewSessReps([]);
    setNewSessGrip("");
    setNewRepLoad(""); setNewRepTime("");
  };

  // Body weight log — backing state so deletions re-render. Loaded
  // once from localStorage; the Body Weight Log card mutates it via
  // setBwLog, which also writes back to LS and (for cloud-synced
  // entries) calls deleteBW to drop the row from Supabase.
  const [bwLog, setBwLog] = useState(() => loadLS(LS_BW_LOG_KEY) || []);

  // Sorted descending for display + the BW Log card. Anomaly detection
  // flags entries that differ from the rolling median by > 15%, so
  // a stale legacy entry (e.g. a 82 kg row in a 71 kg history) is
  // surfaced as red for easy cleanup.
  const bwLogSorted = useMemo(() => {
    return [...bwLog]
      .filter(e => e && e.date && Number(e.kg) > 0)
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  }, [bwLog]);
  const bwMedian = useMemo(() => {
    if (bwLogSorted.length === 0) return null;
    const sorted = bwLogSorted.map(e => Number(e.kg)).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }, [bwLogSorted]);
  const handleDeleteBW = async (date) => {
    // Native confirm — same pattern the session-delete buttons use.
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete body weight entry for ${date}?\n\nThis removes it locally and from the cloud.`)) return;
    const next = bwLog.filter(e => e.date !== date);
    setBwLog(next);
    saveLS(LS_BW_LOG_KEY, next);
    // Fire-and-forget cloud delete. If it fails, the local removal
    // still stands; next reconcile would resurrect it from cloud, so
    // log a warning so the user can retry if needed.
    deleteBW(date).then(ok => {
      if (!ok) console.warn(`BW cloud delete failed for ${date} — local removed but cloud may resurrect on next sync`);
    });
  };

  const grips = useMemo(() => [...new Set(history.map(r => r.grip).filter(Boolean))].sort(), [history]);

  const filtered = useMemo(() => history.filter(r =>
    (!grip   || r.grip === grip) &&
    (!hand   || r.hand === hand || r.hand === "B") &&  // "Both" sessions visible under any hand filter
    (!target || r.target_duration === target)
  ), [history, grip, hand, target]);

  // Group by (session_id, date) so a session_id that spans multiple dates
  // renders as separate cards per date. Backfilled sessions and Both-mode
  // runs that cross midnight can legitimately have the same session_id on
  // two different dates; under a session_id-only key the second date's
  // reps would be hidden inside the first date's card and the displayed
  // date would depend on iteration order. Keying on the pair keeps each
  // date visible and the group's displayed date honest.
  // Derive `hand` from the union of rep hands so a Both-mode session
  // with L and R reps shows "Both" (not just the first rep's hand).
  const grouped = useMemo(() => {
    const map = {};
    for (const r of filtered) {
      const key = `${r.session_id || r.date}|${r.date}`;
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
          {/* + Session is fingers-only: workouts are added from the
              Workout tab, climbs from the climbing logger on Fingers. */}
          {domain === "fingers" && <Btn small onClick={() => { setAddingSession(s => !s); setNewSessDate(ymdLocal()); setNewSessGrip(""); setNewSessTarget(TARGET_OPTIONS[0].seconds); setNewSessReps([]); setNewRepLoad(""); setNewRepTime(""); }} color={addingSession ? C.red : C.green}>＋ Session</Btn>}
          {/* CSV download is shown on every tab in the same spot, with
              the same visual treatment — picks the right exporter by
              active domain so user behavior is consistent across tabs. */}
          <Btn small onClick={() => {
            if (domain === "workout")  onDownloadWorkoutCSV(loadLS(LS_WORKOUT_LOG_KEY) || []);
            else if (domain === "climbing") onDownloadClimbingCSV();
            else onDownload();
          }} color={C.muted}>↓ CSV</Btn>
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
              {gripPresets.map(g => (
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
        {[["fingers", "🖐 Fingers"], ["workout", "🏋️ Workout"], ["climbing", "🧗 Climbing"], ["weight", "⚖️ Weight"]].map(([key, label]) => (
          <button key={key} onClick={() => switchDomain(key)} style={{
            flex: 1, padding: "8px 0", borderRadius: 20, border: "none", cursor: "pointer",
            fontWeight: 700, fontSize: 13,
            background: domain === key ? C.blue : "transparent",
            color: domain === key ? "#fff" : C.muted,
            transition: "background 0.15s",
          }}>{label}</button>
        ))}
      </div>

      {domain === "workout"  && (
        <WorkoutHistoryView
          unit={unit}
          bodyWeight={bodyWeight}
          defaultWorkouts={defaultWorkouts}
          onDeleteWorkoutSession={onDeleteWorkoutSession}
          onDownloadWorkoutCSV={onDownloadWorkoutCSV}
        />
      )}
      {domain === "climbing" && (
        <ClimbingHistoryList
          climbs={activities
            .filter(a => a.type === "climbing")
            .slice()
            .sort((a, b) => (b.date || "").localeCompare(a.date || ""))}
          onDeleteActivity={onDeleteActivity}
          onUpdateActivity={onUpdateActivity}
        />
      )}
      {domain === "weight" && (
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>Body weight log</div>
              <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
                {bwLogSorted.length} {bwLogSorted.length === 1 ? "entry" : "entries"}
                {bwMedian != null && ` · median ${fmt1(toDisp(bwMedian, unit))} ${unit}`}
              </div>
            </div>
          </div>
          {bwLogSorted.length === 0 ? (
            <div style={{ color: C.muted, fontSize: 12, padding: "16px 0", textAlign: "center" }}>
              No body weight entries yet. Log one from the Setup tab's BW prompt.
            </div>
          ) : (
            <div style={{
              display: "flex", flexDirection: "column", gap: 4,
              maxHeight: 480, overflowY: "auto",
            }}>
              {bwLogSorted.map(entry => {
                const lbs = toDisp(Number(entry.kg), unit);
                const isAnomaly = bwMedian && Math.abs(Number(entry.kg) - bwMedian) / bwMedian > 0.15;
                return (
                  <div key={entry.date} style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "8px 12px", borderRadius: 8,
                    background: isAnomaly ? "#3f1a1a" : C.bg,
                    border: `1px solid ${isAnomaly ? C.red : C.border}`,
                  }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                      <span style={{ fontSize: 13, color: C.muted, fontVariantNumeric: "tabular-nums" }}>
                        {entry.date}
                      </span>
                      <span style={{ fontSize: 15, fontWeight: 700, color: isAnomaly ? C.red : "inherit" }}>
                        {fmt1(lbs)} {unit}
                      </span>
                      {isAnomaly && (
                        <span style={{ fontSize: 10, color: C.red, fontStyle: "italic" }}>
                          off median by {Math.round(Math.abs(Number(entry.kg) - bwMedian) / bwMedian * 100)}%
                        </span>
                      )}
                    </div>
                    <button
                      onClick={() => handleDeleteBW(entry.date)}
                      title="Delete this BW entry (local + cloud)"
                      style={{
                        background: "none", border: "none",
                        color: isAnomaly ? C.red : C.muted,
                        fontSize: 15, cursor: "pointer", padding: "0 4px", lineHeight: 1,
                      }}
                    >🗑</button>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      )}
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
        const isEditing    = editKey    === sessKey;
        return (
          <Card key={i} style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
              <div>
                <b>{sess.grip}</b>
                <span style={{ marginLeft: 8, fontSize: 12, color: C.muted }}>
                  {/* Single-hand sessions show "Left" or "Right" so you
                      know what was trained. Multi-hand / Both sessions
                      drop the prefix entirely — the per-rep chips below
                      already tell the L/R story session-by-session, so
                      "L + R" up here was just noise. */}
                  {sess.hand === "L" && "Left · "}
                  {sess.hand === "R" && "Right · "}
                  {TARGET_OPTIONS.find(o => o.seconds === sess.target_duration)?.label ?? sess.target_duration + "s"}
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12, color: C.muted }}>
                  {sess.date}{sess.reps[0]?.session_started_at ? " · " + fmtClock(sess.reps[0].session_started_at) : ""}
                  {(() => { const e = bwOnDate(bwLog, sess.date); return e ? " · BW " + fmt1(toDisp(e.kg, unit)) + " " + unit : ""; })()}
                </span>
                {!isEditing && (
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
                    <button onClick={() => {
                      setEditKey(sessKey);
                      setEditHand(sess.hand);
                      setEditGrip(sess.grip);
                      setEditTarget(sess.target_duration);
                      setRepEditMode(sessKey);   // also enable per-rep editing
                      setNoteKey(null);
                      closeRepEdit();
                    }} style={{
                      background: "none", border: "none", color: C.muted,
                      fontSize: 13, cursor: "pointer", padding: "0 2px", lineHeight: 1,
                    }} title="Edit session & reps">✏️</button>
                    {/* Trash → native confirm dialog. The previous inline
                        two-step (tap trash, then tap red Delete) had both
                        buttons in roughly the same thumb zone, so a quick
                        double-tap on a phone could wipe a session before
                        you noticed. Native confirm forces a deliberate
                        OK/Cancel choice on a clearly separated dialog —
                        much harder to dismiss by accident. */}
                    <button onClick={() => {
                      const n = sess.reps?.length ?? 0;
                      const msg = `Delete this session?\n\n${n} rep${n === 1 ? "" : "s"} · ${sess.grip || ""} · ${sess.date}\n\nThis cannot be undone.`;
                      // eslint-disable-next-line no-alert
                      if (window.confirm(msg)) {
                        onDeleteSession(sessKey);
                      }
                    }} style={{
                      background: "none", border: "none", color: C.muted,
                      fontSize: 14, cursor: "pointer", padding: "0 2px", lineHeight: 1,
                    }} title="Delete session">🗑</button>
                  </>
                )}
              </div>
            </div>

            {/* Edit UI */}
            {isEditing && (
              <div style={{ marginBottom: 10, padding: 10, background: C.bg, borderRadius: 8 }}>
                {/* Row 1: hand + grip */}
                {/* "B" is INTENTIONALLY not in the picker — it's a session-
                    level derived classification (computed from the union of
                    rep hands in the grouped memo), not a valid per-rep
                    value. Tapping "Both" here used to write hand="B" to
                    every rep, which then failed the renderChip filter in
                    the Both-mode two-column layout (which only matches
                    r.hand === "L" || r.hand === "R") and made the entire
                    session disappear from view. The session-edit hand
                    picker now mass-converts every rep to L or R; the rep
                    editor handles per-rep L/R changes for mixed sessions. */}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
                  <div style={{ display: "flex", gap: 4 }}>
                    {["L","R"].map(h => (
                      <button key={h} onClick={() => setEditHand(h)} style={{
                        padding: "4px 10px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600,
                        background: editHand === h ? C.purple : C.border,
                        color: editHand === h ? "#fff" : C.muted,
                      }}>{h === "L" ? "Left" : "Right"}</button>
                    ))}
                  </div>
                  {/* Grip selector — pills matching the Hand and Zone
                      rows above/below. Built from gripPresets first
                      (Crusher / Micro / Thunder), then any historical
                      grip names not in that list so legacy / custom
                      grips remain selectable. Free-text input was
                      replaced because the canonical grip set is small
                      and tapping a pill is faster + drift-proof
                      (typos like "crusher" vs "Crusher" no longer
                      fragment the data). */}
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {[
                      ...gripPresets,
                      ...grips.filter(g => !gripPresets.includes(g)),
                    ].map(g => (
                      <button key={g} onClick={() => setEditGrip(g)} style={{
                        padding: "4px 10px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600,
                        background: editGrip === g ? C.purple : C.border,
                        color: editGrip === g ? "#fff" : C.muted,
                      }}>{g}</button>
                    ))}
                  </div>
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
                  <button onClick={() => {
                    // Defense in depth: never write hand="B" to per-rep
                    // rows. The picker no longer exposes "B", but we
                    // leave editHand fall-back-equal-to-sess.hand on
                    // open, which can be "B" for Both-mode sessions. If
                    // the user taps Done without touching the picker,
                    // skip the hand field — leave per-rep hands intact.
                    const updates = { grip: editGrip, target_duration: editTarget };
                    if (editHand === "L" || editHand === "R") updates.hand = editHand;
                    onUpdateSession(sessKey, updates);
                    setEditKey(null);
                    setRepEditMode(null);
                    closeRepEdit();
                  }} style={{
                    background: C.green, border: "none", borderRadius: 6, color: "#000",
                    fontSize: 11, fontWeight: 700, padding: "4px 10px", cursor: "pointer",
                  }}>Done</button>
                  <button onClick={() => {
                    setEditKey(null);
                    setRepEditMode(null);
                    closeRepEdit();
                  }} style={{
                    background: C.border, border: "none", borderRadius: 6, color: C.muted,
                    fontSize: 11, padding: "4px 8px", cursor: "pointer",
                  }}>Cancel</button>
                </div>
                <div style={{ marginTop: 8, fontSize: 11, color: C.muted, fontStyle: "italic" }}>
                  Tap a rep chip below to edit its load, time, or hand · use + to add a rep · × to delete.
                </div>
              </div>
            )}

            {/* Forecasted-vs-actual rep curve, rendered per-hand. Both-
                mode sessions get two stacked charts (Left + Right) so
                the actual line doesn't artifactually concatenate the
                two hands into one apparent set. Each hand's forecast is
                seeded by THAT hand's rep 1; previous-session overlay is
                also per-hand. Target / used load caption uses the
                prescription engine run on history strictly before this
                session's date — that's what the engine would have
                recommended at the time. */}
            {(() => {
              const validReps = sess.reps.filter(r => Number(r.actual_time_s) > 0);
              if (validReps.length < 2) return null;
              const hands = sess.hand === "B"
                ? ["L", "R"].filter(h => validReps.some(r => r.hand === h))
                : [sess.hand];
              if (hands.length === 0) return null;
              // History strictly before this session — what the engine
              // knew when this session was prescribed.
              const priorHistory = history.filter(r => r.date < sess.date);
              return (
                <div style={{ marginBottom: 10 }}>
                  {hands.map(handKey => {
                    const handReps = validReps
                      .filter(r => r.hand === handKey)
                      .sort((a, b) =>
                        (a.set_num ?? 1) - (b.set_num ?? 1)
                        || (a.rep_num ?? 0) - (b.rep_num ?? 0)
                      );
                    if (handReps.length === 0) return null;
                    const rep1 = handReps[0];
                    const restS = rep1.rest_s ?? 20;
                    const bundle = buildRepCurveBundle({
                      history,
                      grip: sess.grip, hand: handKey,
                      numReps: handReps.length,
                      firstRepTime: rep1.actual_time_s,
                      restSeconds: restS,
                      actualReps: handReps,
                      targetDuration: sess.target_duration,
                      beforeDate: sess.date,
                    });
                    // Pass freshMap + threeExpPriors so the engine
                    // can use its full curve-fit path rather than
                    // falling through to the anchored-linear fallback
                    // (which can over-extrapolate by 70–80% off a
                    // short heavy anchor rep). Using the current-state
                    // freshMap/priors is fine — the population priors
                    // barely move from session to session, and we
                    // want the most accurate retrospective read.
                    const target = prescription(priorHistory, handKey, sess.grip,
                      sess.target_duration, { freshMap, threeExpPriors });
                    return (
                      <div key={handKey} style={{ marginBottom: hands.length > 1 ? 12 : 0 }}>
                        {hands.length > 1 && (
                          <div style={{
                            fontSize: 10, fontWeight: 700, letterSpacing: 1,
                            color: handKey === "L" ? C.blue : C.orange,
                            marginBottom: 4,
                          }}>
                            {handKey === "L" ? "LEFT" : "RIGHT"}
                          </div>
                        )}
                        <RepCurveChart
                          forecasted={bundle.forecasted}
                          actual={bundle.actual}
                          prevSession={bundle.prevSession}
                          asymptoticHold={bundle.asymptoticHold}
                          targetS={bundle.targetS}
                          targetWeightKg={target?.value ?? null}
                          usedWeightKg={rep1.weight_kg ?? null}
                          unit={unit}
                          height={180}
                        />
                      </div>
                    );
                  })}
                </div>
              );
            })()}

            {/* Rep chips */}
            {(() => {
              const sortedReps = sess.reps.slice().sort((a, b) => a.set_num - b.set_num || a.rep_num - b.rep_num);
              const renderChip = (r, j) => {
                const isRepEditing = editingRep?.sessKey === sessKey && editingRep?.repIdx === j;
                const passed = r.actual_time_s >= sess.target_duration;
                // Per-rep hand letter — same color scheme as the F-D
                // chart's L/R dots (L=blue, R=orange). Always shown,
                // including on single-hand sessions, so the hand is
                // unambiguous from the chip alone instead of having to
                // read it off the session header.
                const handLetter = r.hand === "L" ? "L" : r.hand === "R" ? "R" : null;
                const handColor  = r.hand === "L" ? C.blue : r.hand === "R" ? C.orange : C.muted;
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
                      {handLetter && (
                        <span style={{ color: handColor, fontWeight: 700, marginRight: 6 }}>
                          {handLetter}
                        </span>
                      )}
                      <b>{fmtW(effectiveLoad(r), unit)}{unit}</b> · {fmtTime(r.actual_time_s)}
                      {/* Rest interval — small muted suffix so it's
                          visible at a glance for verifying edits and
                          spotting protocol drift, without crowding
                          the load+time pair that's the primary signal. */}
                      {r.rest_s != null && (
                        <span style={{ color: C.muted, marginLeft: 6, fontSize: 11 }}>
                          · {r.rest_s}s rest
                        </span>
                      )}
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
              };
              // Both-mode session → two-column layout (Left | Right) plus
              // a fallback row for any reps stamped hand="B" by the
              // legacy session-edit-Done bug. Without the fallback those
              // reps silently filter out of both columns and the session
              // looks empty. Use the rep editor to flip them to L/R.
              if (sess.hand === "B") {
                const orphans = sortedReps.filter(r => r.hand !== "L" && r.hand !== "R");
                return (
                  <div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      {["L", "R"].map(handKey => (
                        <div key={handKey}>
                          <div style={{
                            fontSize: 10, fontWeight: 700, letterSpacing: 1,
                            color: handKey === "L" ? C.blue : C.orange, marginBottom: 6,
                          }}>{handKey === "L" ? "LEFT" : "RIGHT"}</div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }}>
                            {sortedReps.map((r, j) => r.hand === handKey ? renderChip(r, j) : null)}
                          </div>
                        </div>
                      ))}
                    </div>
                    {orphans.length > 0 && (
                      <div style={{ marginTop: 12 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: C.muted, marginBottom: 6 }}>
                          UNASSIGNED HAND ({orphans.length}) · open the rep editor to set L or R
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                          {sortedReps.map((r, j) => r.hand !== "L" && r.hand !== "R" ? renderChip(r, j) : null)}
                        </div>
                      </div>
                    )}
                  </div>
                );
              }
              return (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {sortedReps.map((r, j) => renderChip(r, j))}
                </div>
              );
            })()}

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
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <label style={{ fontSize: 10, color: C.muted }}>Hand</label>
                    <div style={{ display: "flex", gap: 4 }}>
                      {["L", "R"].map(h => {
                        const selected = editRepHand === h;
                        return (
                          <button
                            key={h}
                            type="button"
                            onClick={() => setEditRepHand(h)}
                            style={{
                              width: 32, padding: "4px 0",
                              background: selected ? C.blue : C.border,
                              color: selected ? "#000" : C.muted,
                              border: "none", borderRadius: 6,
                              fontSize: 12, fontWeight: 700, cursor: "pointer",
                            }}
                          >{h}</button>
                        );
                      })}
                    </div>
                  </div>
                  {/* Rest interval edit. Blank = leave existing value
                      (in edit mode the box is pre-filled with the
                      current rest_s; clearing it keeps the original). */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <label style={{ fontSize: 10, color: C.muted }}>Rest (s)</label>
                    <input
                      type="number"
                      value={editRepRest}
                      onChange={e => setEditRepRest(e.target.value)}
                      placeholder="20"
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
