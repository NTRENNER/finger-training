// ─────────────────────────────────────────────────────────────
// SETTINGS VIEW
// ─────────────────────────────────────────────────────────────
// User preferences + auth + cloud sync controls. Cards stacked:
//
//   Units             — lbs / kg toggle
//   Body Weight       — input field, drives relative-strength display
//   Training Goal     — trip name + date; powers the WorkoutTab
//                       countdown ("days until __"). The "what are
//                       you training FOR" — an event/date.
//   Training Focus    — Balanced / Bouldering / Power-endurance /
//                       Endurance routes. Mild zone-bias weighting
//                       fed into the coaching engine. The "how
//                       should this season's mix be shaped".
//   Cloud Sync        — Supabase OTP auth + manual pull
//   Tindeq Progressor — informational text about BLE
//   Developer options — collapsible setup-SQL display
//
// Note the deliberate Goal-vs-Focus split: Goal = WHEN (target
// date), Focus = HOW (zone weighting). Both surface as "Training __"
// but they answer different questions, so don't let the labels
// drift into each other.
//
// Pure props/callbacks shape — no localStorage reads, no module-level
// state. All side effects (auth, BW change, trip change, pull) come
// in via callbacks.

import React, { useState } from "react";
import { C } from "../ui/theme.js";
import { Card, Btn, Sect } from "../ui/components.js";
import { KG_TO_LBS, fmt0, toDisp, fromDisp } from "../ui/format.js";
import { tripCountdown } from "../lib/trip.js";
import { TRAINING_FOCUS, DEFAULT_TRAINING_FOCUS } from "../model/training-focus.js";

export function SettingsView({
  user, loginEmail, setLoginEmail,
  onSendOtp = () => {}, onVerifyOtp = () => {}, onCancelOtp = () => {},
  otpSent = false, otpCode = "", setOtpCode = () => {},
  otpBusy = false, otpError = null,
  onSignOut,
  unit = "lbs", onUnitChange = () => {},
  bodyWeight = null, onBWChange = () => {},
  trip = { date: "", name: "" }, onTripChange = () => {},
  trainingFocus = DEFAULT_TRAINING_FOCUS, onTrainingFocusChange = () => {},
  onPullFromCloud = () => {}, pullStatus = "idle", lastPulledAt = null,
}) {
  const [showSQL, setShowSQL] = useState(false);
  const sql = `-- Run this once in your Supabase SQL editor (fresh install):
CREATE TABLE reps (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  date text, grip text, hand text,
  target_duration integer,
  weight_kg real, actual_time_s real,
  avg_force_kg real, peak_force_kg real,
  set_num integer, rep_num integer,
  rest_s integer, session_id text,
  failed boolean DEFAULT false
);
ALTER TABLE reps ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_all" ON reps
  FOR ALL USING (auth.uid() IS NOT NULL);

-- If upgrading an existing table, run this instead:
-- ALTER TABLE reps ADD COLUMN IF NOT EXISTS failed boolean DEFAULT false;`;

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
      <h2 style={{ margin: "0 0 16px", fontSize: 22 }}>Settings</h2>

      <Card>
        <Sect title="Units">
          <div style={{ display: "flex", gap: 8 }}>
            {["lbs", "kg"].map(u => (
              <button key={u} onClick={() => onUnitChange(u)} style={{
                flex: 1, padding: "10px 0", borderRadius: 8, cursor: "pointer", fontWeight: 700, fontSize: 16,
                background: unit === u ? C.blue : C.border,
                color: unit === u ? "#fff" : C.muted, border: "none",
              }}>{u}</button>
            ))}
          </div>
        </Sect>
      </Card>

      <Card>
        <Sect title="Body Weight">
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>
            Used to show <b>relative strength</b> (force ÷ bodyweight) in the Analysis tab.
            Helps compare progress through weight changes.
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <input
              type="number" inputMode="numeric" min={30} max={500} step={1}
              value={bodyWeight != null ? fmt0(toDisp(bodyWeight, unit)) : ""}
              onChange={e => {
                const v = e.target.value === "" ? null : fromDisp(Math.round(Number(e.target.value)), unit);
                onBWChange(v);
              }}
              placeholder={`Weight in ${unit}`}
              style={{
                width: 110, background: C.bg,
                border: `1px solid ${C.border}`, borderRadius: 8,
                padding: "8px 12px", color: C.text, fontSize: 15,
              }}
            />
            <span style={{ fontSize: 14, color: C.muted }}>{unit}</span>
            {bodyWeight != null && (
              <span style={{ fontSize: 12, color: C.muted, marginLeft: 4 }}>
                ({unit === "lbs" ? `${fmt0(bodyWeight)} kg` : `${fmt0(bodyWeight * KG_TO_LBS)} lbs`})
              </span>
            )}
          </div>
        </Sect>
      </Card>

      <Card>
        <Sect title="Training Goal">
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>
            Target trip or event. Drives the countdown + taper reminder on the Workout tab.
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input
              type="text"
              value={trip.name || ""}
              onChange={e => onTripChange({ name: e.target.value })}
              placeholder="Name (e.g. Tensleep)"
              style={{
                flex: "1 1 160px", minWidth: 140, background: C.bg,
                border: `1px solid ${C.border}`, borderRadius: 8,
                padding: "8px 12px", color: C.text, fontSize: 15,
              }}
            />
            <input
              type="date"
              value={trip.date || ""}
              onChange={e => onTripChange({ date: e.target.value })}
              style={{
                background: C.bg,
                border: `1px solid ${C.border}`, borderRadius: 8,
                padding: "8px 12px", color: C.text, fontSize: 15,
              }}
            />
          </div>
          {(() => {
            const cd = tripCountdown(trip.date);
            if (!cd) {
              return (
                <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>
                  Pick a date to enable the countdown.
                </div>
              );
            }
            if (cd.past) {
              return (
                <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>
                  Trip date is in the past — update it to a future date.
                </div>
              );
            }
            return (
              <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>
                {cd.weeks}wk · {cd.days}d until {trip.name || "trip"} ({cd.tripLabel}). Taper starts {cd.taperLabel}.
              </div>
            );
          })()}
        </Sect>
      </Card>

      <Card>
        <Sect title="Training Focus">
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 12, lineHeight: 1.5 }}>
            Most of the year, balance keeps every compartment humming. When
            you're prepping for a specific style — bouldering, power-endurance
            sport, or an endurance trip like the Red River Gorge — switch the
            focus to bias recommendations toward what you're working on
            without abandoning the other compartments.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {Object.entries(TRAINING_FOCUS).map(([key, focus]) => {
              const selected = trainingFocus === key;
              return (
                <label
                  key={key}
                  style={{
                    display: "flex", alignItems: "flex-start", gap: 10,
                    padding: "10px 12px", borderRadius: 8, cursor: "pointer",
                    background: selected ? C.blue + "22" : C.bg,
                    border: `1px solid ${selected ? C.blue : C.border}`,
                  }}
                >
                  <input
                    type="radio"
                    name="trainingFocus"
                    value={key}
                    checked={selected}
                    onChange={() => onTrainingFocusChange(key)}
                    style={{ marginTop: 3, accentColor: C.blue }}
                  />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: selected ? C.blue : C.text }}>
                      {focus.label}
                    </div>
                    <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
                      {focus.description}
                    </div>
                    {/* Coaching impact — only shown for the selected
                        focus (avoids cluttering all four rows with
                        weighting copy that's only actionable for the
                        active choice). The Setup tab's mini-picker
                        shows the same text in the same role. */}
                    {selected && (
                      <div style={{ fontSize: 12, color: C.muted, marginTop: 6, fontStyle: "italic", lineHeight: 1.5 }}>
                        {focus.coachingImpact}
                      </div>
                    )}
                  </div>
                </label>
              );
            })}
          </div>
        </Sect>
      </Card>

      <Card>
        <Sect title="Cloud Sync (Supabase)">
          {user ? (
            <div>
              <div style={{ fontSize: 14, marginBottom: 12 }}>
                Signed in as <b>{user.email}</b>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <Btn
                  small
                  color={pullStatus === "pulling" ? C.muted : C.blue}
                  onClick={onPullFromCloud}
                  disabled={pullStatus === "pulling"}
                >
                  {pullStatus === "pulling" ? "Pulling…" : "⟳ Pull from Cloud"}
                </Btn>
                <Btn small color={C.red} onClick={onSignOut}>Sign Out</Btn>
              </div>
              <div style={{ fontSize: 11, color: C.muted, marginTop: 8, lineHeight: 1.5 }}>
                {pullStatus === "ok" && lastPulledAt && (
                  <>Pulled at {new Date(lastPulledAt).toLocaleTimeString()} · </>
                )}
                {pullStatus === "err" && (
                  <span style={{ color: C.red }}>Pull failed — check network. </span>
                )}
                Auto-sync happens on sign-in. Use this if a workout saved on another
                device isn't showing here yet.
              </div>
            </div>
          ) : !otpSent ? (
            <div>
              <div style={{ fontSize: 13, color: C.muted, marginBottom: 10 }}>
                Sign in to sync data across devices. We'll email you a 6-digit code.
              </div>
              <form
                onSubmit={e => { e.preventDefault(); onSendOtp(); }}
                style={{ display: "flex", gap: 8 }}
              >
                <input
                  type="email" value={loginEmail}
                  onChange={e => setLoginEmail(e.target.value)}
                  placeholder="your@email.com"
                  autoComplete="email"
                  style={{ flex: 1, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px", color: C.text, fontSize: 14 }}
                />
                <Btn small type="submit" onClick={onSendOtp} disabled={otpBusy || !loginEmail}>
                  {otpBusy ? "Sending…" : "Send Code"}
                </Btn>
              </form>
              {otpError && (
                <div style={{ fontSize: 12, color: C.red, marginTop: 8 }}>{otpError}</div>
              )}
            </div>
          ) : (
            <div>
              <div style={{ fontSize: 13, color: C.muted, marginBottom: 10 }}>
                Code sent to <b style={{ color: C.text }}>{loginEmail}</b>. Enter it below.
              </div>
              <form
                onSubmit={e => { e.preventDefault(); onVerifyOtp(); }}
                style={{ display: "flex", gap: 8 }}
              >
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  autoComplete="one-time-code"
                  value={otpCode}
                  onChange={e => setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="123456"
                  autoFocus
                  maxLength={6}
                  style={{
                    flex: 1, background: C.bg, border: `1px solid ${C.border}`,
                    borderRadius: 8, padding: "8px 12px", color: C.text,
                    fontSize: 18, letterSpacing: 4, fontVariantNumeric: "tabular-nums",
                    textAlign: "center",
                  }}
                />
                <Btn small type="submit" onClick={onVerifyOtp} disabled={otpBusy || otpCode.length < 6}>
                  {otpBusy ? "Verifying…" : "Verify"}
                </Btn>
              </form>
              <div style={{ display: "flex", gap: 12, marginTop: 8, alignItems: "center" }}>
                <button
                  type="button"
                  onClick={onSendOtp}
                  disabled={otpBusy}
                  style={{ background: "none", border: "none", color: C.blue, fontSize: 12, cursor: "pointer", padding: 0 }}
                >Resend code</button>
                <button
                  type="button"
                  onClick={onCancelOtp}
                  style={{ background: "none", border: "none", color: C.muted, fontSize: 12, cursor: "pointer", padding: 0 }}
                >Use a different email</button>
              </div>
              {otpError && (
                <div style={{ fontSize: 12, color: C.red, marginTop: 8 }}>{otpError}</div>
              )}
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
        <details>
          <summary style={{ fontSize: 12, color: C.muted, cursor: "pointer", userSelect: "none" }}>
            Developer options
          </summary>
          <div style={{ marginTop: 12 }}>
            <Sect title="Supabase Setup">
              <div style={{ fontSize: 13, color: C.muted, marginBottom: 10 }}>
                If this is a fresh install, run this SQL in your Supabase project to create the <code>reps</code> table.
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
          </div>
        </details>
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
