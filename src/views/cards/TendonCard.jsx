// Low-intensity finger-loading card for the Fingers/Setup screen. Preset picker
// (Emil / Barr) + editable hold/rest seconds, weekly adherence + streak,
// and the guided timer launcher. A completed session logs one cloud row
// (no load). Self-contained via the shared useTendon store; separate
// from the reps model.
//
// The card owns the save lifecycle so the timer's completion screen can
// tell the truth: it awaits the cloud write, tracks saving/ok/error, and
// offers a retry (reusing the same record so a retry never duplicates).
import React, { useState } from "react";
import { C } from "../../ui/theme.js";
import { Card, Btn } from "../../ui/components.js";
import {
  TENDON_PRESETS, DEFAULT_PRESET_KEY, resolvePreset, getPreset,
  tendonAdherence, totalSets, totalWorkSeconds,
} from "../../model/tendon.js";
import { useTendon } from "../../hooks/useTendon.js";
import { TendonTimer } from "./TendonTimer.jsx";
import { today } from "../../util.js";
import { loadLS, saveLS } from "../../lib/storage.js";

const LS_KEY = "ft_tendon_cfg";

export function TendonCard() {
  const { sessions, logSession } = useTendon();
  const [active, setActive] = useState(false);
  const [showCfg, setShowCfg] = useState(false);
  const [cfg, setCfg] = useState(() => loadLS(LS_KEY) || { preset: DEFAULT_PRESET_KEY });
  // Save lifecycle for the just-finished session.
  const [saveState, setSaveState] = useState(null);   // null | "saving" | "ok" | "error"
  const [pending, setPending]     = useState(null);   // the record to (re)push

  const preset = resolvePreset(cfg.preset, cfg);
  const adh = tendonAdherence(sessions, today(), 3);

  const persist = (next) => { setCfg(next); saveLS(LS_KEY, next); };
  // Switching preset resets the times to that preset's defaults (a
  // clean baseline the user can then nudge with the inputs below).
  const pickPreset = (key) => {
    const base = getPreset(key);
    persist({ preset: key, workSec: base.workSec, restSec: base.restSec });
  };
  const setField = (field, val) => {
    const n = parseInt(val, 10);
    persist({ ...cfg, [field]: Number.isFinite(n) ? n : undefined });
  };

  // Persist the completed session, capturing the RESOLVED protocol so
  // history reflects what was actually done (not just the preset name).
  const save = async (rec) => {
    setSaveState("saving");
    const res = await logSession(rec);
    setSaveState(res.ok ? "ok" : "error");
    // Keep the record around (with its stable id) so a retry re-pushes
    // the same row instead of minting a duplicate.
    setPending(res.rec);
  };
  const handleComplete = ({ sets, totalWorkS }) => {
    save({
      preset: preset.key,
      sets, totalWorkS,
      workSec: preset.workSec, restSec: preset.restSec, effortPct: preset.effortPct,
    });
  };
  const closeTimer = () => { setActive(false); setSaveState(null); setPending(null); };

  if (active) {
    return (
      <Card style={{ marginBottom: 0, borderColor: C.blue }}>
        <TendonTimer
          preset={preset}
          saveState={saveState}
          onComplete={handleComplete}
          onRetry={() => pending && save(pending)}
          onCancel={closeTimer}
        />
      </Card>
    );
  }

  return (
    <Card style={{ marginBottom: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 800 }}>🩹 Low-intensity finger loading</div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 1 }}>Abrahangs-inspired · submaximal · no failure</div>
        </div>
        <div style={{ fontSize: 11, color: adh.onTrack ? C.green : C.muted, fontWeight: 700 }}>
          {adh.weekCount}/{adh.goalPerWeek} this wk
        </div>
      </div>

      {/* Preset pills */}
      <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
        {TENDON_PRESETS.map(p => (
          <button key={p.key} onClick={() => pickPreset(p.key)} style={{
            flex: 1, padding: "7px 0", borderRadius: 8, border: "none", cursor: "pointer",
            fontSize: 12, fontWeight: 700,
            background: cfg.preset === p.key ? C.blue : C.border,
            color: cfg.preset === p.key ? "#fff" : C.muted,
          }}>{p.name}</button>
        ))}
        <button onClick={() => setShowCfg(s => !s)} title="Adjust times" style={{
          padding: "7px 12px", borderRadius: 8, border: "none", cursor: "pointer",
          fontSize: 13, background: C.border, color: C.muted,
        }}>⚙</button>
      </div>

      {showCfg && (
        <div style={{ display: "flex", gap: 10, marginTop: 10, alignItems: "flex-end" }}>
          <label style={{ fontSize: 10, color: C.muted, flex: 1 }}>
            Hold (s)
            <input type="number" value={preset.workSec} min={10} max={30}
              onChange={e => setField("workSec", e.target.value)}
              style={{ width: "100%", marginTop: 3, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, padding: "5px 8px", color: C.text, fontSize: 14 }} />
          </label>
          <label style={{ fontSize: 10, color: C.muted, flex: 1 }}>
            Rest (s)
            <input type="number" value={preset.restSec} min={5} max={300}
              onChange={e => setField("restSec", e.target.value)}
              style={{ width: "100%", marginTop: 3, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, padding: "5px 8px", color: C.text, fontSize: 14 }} />
          </label>
        </div>
      )}

      {/* last-7-days adherence dots */}
      <div style={{ display: "flex", gap: 5, marginTop: 12 }}>
        {adh.last7.map(d => (
          <div key={d.date} title={d.date} style={{
            flex: 1, height: 8, borderRadius: 4,
            background: d.done ? C.green : C.border,
          }} />
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
        <span style={{ fontSize: 11, color: C.muted }}>
          {adh.streak > 0 ? `🔥 ${adh.streak}-day streak` : "last 7 days"}
        </span>
        <span style={{ fontSize: 11, color: C.muted }}>{adh.total} total</span>
      </div>

      <Btn onClick={() => setActive(true)} color={C.blue}
           style={{ marginTop: 12, width: "100%", padding: "12px 0", fontSize: 15, borderRadius: 12 }}>
        ▶ Start low-intensity session
      </Btn>
      <div style={{ fontSize: 11, color: C.muted, marginTop: 8, textAlign: "center", lineHeight: 1.5 }}>
        {totalSets(preset)} hangs · {preset.workSec}s on / {preset.restSec}s off · ~{totalWorkSeconds(preset)}s
        under tension · ~{preset.effortPct}% effort. Separate from your Tindeq training.
      </div>
      <div style={{ fontSize: 10, color: C.orange, marginTop: 5, textAlign: "center", lineHeight: 1.4 }}>
        Stop for sharp or increasing pain. This is not an injury-prevention or rehabilitation protocol.
      </div>
    </Card>
  );
}
