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
import { effectiveLoad, isShortfall } from "../model/prescription.js";
import { TARGET_OPTIONS } from "../model/zones.js";
import {
  loadLS, saveLS,
  LS_BW_LOG_KEY, LS_HISTORY_DOMAIN_KEY,
} from "../lib/storage.js";
import { WorkoutHistoryView } from "./WorkoutHistoryView.js";
import { ClimbingHistoryList } from "./ClimbingHistoryList.js";

export function HistoryView({
  history, onDownload, unit = "lbs", bodyWeight = null,
  onDeleteSession, onUpdateSession,
  onDeleteRep, onUpdateRep, onAddRep,
  notes = {}, onNoteChange,
  activities = [], onDeleteActivity = () => {},
  defaultWorkouts = {},
  onDeleteWorkoutSession = () => {},
  onDownloadWorkoutCSV = () => {},
  gripPresets = [],
}) {
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
          {domain === "fingers" && <Btn small onClick={() => { setAddingSession(s => !s); setNewSessDate(ymdLocal()); setNewSessGrip(""); setNewSessTarget(TARGET_OPTIONS[0].seconds); setNewSessReps([]); setNewRepLoad(""); setNewRepTime(""); }} color={addingSession ? C.red : C.green}>＋ Session</Btn>}
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
        {[["fingers", "🖐 Fingers"], ["workout", "🏋️ Workout"], ["climbing", "🧗 Climbing"]].map(([key, label]) => (
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
        />
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
        const isConfirming = confirmKey === sessKey;
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
                    <button onClick={() => {
                      setEditKey(sessKey);
                      setEditHand(sess.hand);
                      setEditGrip(sess.grip);
                      setEditTarget(sess.target_duration);
                      setRepEditMode(sessKey);   // also enable per-rep editing
                      setConfirmKey(null);
                      setNoteKey(null);
                      closeRepEdit();
                    }} style={{
                      background: "none", border: "none", color: C.muted,
                      fontSize: 13, cursor: "pointer", padding: "0 2px", lineHeight: 1,
                    }} title="Edit session & reps">✏️</button>
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
                    onUpdateSession(sessKey, { hand: editHand, grip: editGrip, target_duration: editTarget });
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

            {/* Rep chips */}
            {(() => {
              const sortedReps = sess.reps.slice().sort((a, b) => a.set_num - b.set_num || a.rep_num - b.rep_num);
              const renderChip = (r, j) => {
                const isRepEditing = editingRep?.sessKey === sessKey && editingRep?.repIdx === j;
                const passed = r.actual_time_s >= sess.target_duration;
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
              // Both-mode session → two-column layout (Left | Right).
              // Single-hand session → existing flex-wrap row.
              if (sess.hand === "B") {
                return (
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
