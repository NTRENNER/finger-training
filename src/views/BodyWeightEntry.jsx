import React, { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { C } from "../ui/theme.js";
import { fmt1, toDisp, fromDisp } from "../ui/format.js";
import { today } from "../util.js";
import { useLSValue } from "../hooks/useLSValue.js";
import { saveLS, LS_BW_LOG_KEY, LS_BW_REMINDER_DISMISSED_KEY } from "../lib/storage.js";
import { bodyWeightReminderDue, latestBodyWeight, validWeightDate } from "../lib/bodyWeight.js";
import "./BodyWeightEntry.css";

// Shared by the weekly reminder and History → Weight. The date is fixed
// when correcting an entry; logging supports today or any previous date.
export function BodyWeightEntry({ unit = "lbs", entry = null, latest = null, reminder = false, onSave, onClose }) {
  const dialogRef = useRef(null);
  const titleId = useId();
  const [date, setDate] = useState(() => entry?.date || today());
  const initialKg = entry?.kg ?? latest?.kg;
  const [value, setValue] = useState(() => initialKg > 0 ? fmt1(toDisp(initialKg, unit)) : "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const bwLog = useLSValue(LS_BW_LOG_KEY) || [];
  const existing = bwLog.find(e => e.date === date);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  const save = async event => {
    event.preventDefault();
    const entered = Number(value);
    const kg = fromDisp(entered, unit);
    if (!Number.isFinite(kg) || kg <= 0) {
      setError("Enter a weight greater than zero.");
      return;
    }
    const entryDate = reminder ? today() : date;
    if (!validWeightDate(entryDate)) {
      setError("Choose today or a date in the past.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      // Preserve the original precision if a prefilled weight is unchanged.
      const savedKg = initialKg > 0 && entered === Number(fmt1(toDisp(initialKg, unit))) ? initialKg : kg;
      const result = await onSave(savedKg, entryDate);
      if (result === false) throw new Error("Save failed");
      onClose();
    } catch {
      setError("Weight could not be saved. Please try again.");
      setSaving(false);
    }
  };

  return createPortal(
    <dialog ref={dialogRef} className="body-weight-dialog" aria-labelledby={titleId}
      onCancel={event => { event.preventDefault(); onClose(); }}>
      <form onSubmit={save} noValidate>
        <h2 id={titleId} style={{ fontSize: 23, margin: "0 0 12px" }}>
          {reminder ? "Update your body weight" : entry ? "Edit weight" : "Log weight"}
        </h2>
        <p style={{ color: C.muted, fontSize: 15, lineHeight: 1.5, margin: "0 0 20px" }}>
          {latest ? <>Last recorded: <strong style={{ color: C.text }}>{fmt1(toDisp(latest.kg, unit))} {unit}</strong> on {latest.date}.</> : "Add your first body-weight entry."}
          {reminder && <> A weekly update keeps relative-strength tracking useful.</>}
        </p>
        {!reminder && <label className="body-weight-field">
          Date
          <input type="date" value={date} max={today()} disabled={!!entry}
            onChange={event => { setDate(event.target.value); setError(""); }} />
        </label>}
        <label className="body-weight-field">
          {reminder ? "Today's weight" : "Weight"} ({unit})
          <input type="number" inputMode="decimal" step="any" min="0" autoFocus
            value={value} onChange={event => { setValue(event.target.value); setError(""); }} />
        </label>
        {!reminder && !entry && existing && <p style={{ color: C.muted, fontSize: 13 }}>
          Saving will update the existing entry for {date}.
        </p>}
        {error && <p role="alert" style={{ color: C.red }}>{error}</p>}
        <div className="body-weight-actions">
          <button type="button" onClick={onClose} style={{ background: C.border, color: C.text }}>
            {reminder ? "Not now" : "Cancel"}
          </button>
          <button type="submit" disabled={saving} style={{ background: C.blue, color: "#fff" }}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </dialog>, document.body
  );
}

// Mounted only on idle planners. Dismissal survives navigation/reloads and
// is shared by Fingers and Workout on this device, within the user's namespace.
export function BwPrompt({ unit = "lbs", onSave }) {
  const log = useLSValue(LS_BW_LOG_KEY) || [];
  const dismissedDate = useLSValue(LS_BW_REMINDER_DISMISSED_KEY);
  const [closed, setClosed] = useState(false);
  const latest = latestBodyWeight(log);
  if (closed || !bodyWeightReminderDue(latest, dismissedDate)) return null;
  return <BodyWeightEntry key={`${latest?.date || "first"}:${latest?.kg || ""}:${unit}`}
    unit={unit} latest={latest} reminder onSave={onSave}
    onClose={() => {
      saveLS(LS_BW_REMINDER_DISMISSED_KEY, today());
      setClosed(true);
    }} />;
}
