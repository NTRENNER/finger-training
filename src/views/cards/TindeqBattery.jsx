import React from "react";
import { C } from "../../ui/theme.js";
import { isPlausibleBatteryMv } from "../../lib/tindeq.js";

// Older records may hold a non-voltage reply; show those as unavailable.
const formatVoltage = mv => isPlausibleBatteryMv(mv) ? `${(mv / 1000).toFixed(2)} V` : null;

export function TindeqBattery({ battery, connected, warningOnly = false }) {
  if (!battery || (warningOnly && !battery.low_battery_warning)) return null;
  if (!connected && !battery.low_battery_warning && !battery.voltage_read_at_ms) return null;
  const voltage = formatVoltage(battery.voltage_mv);
  return <div role={battery.low_battery_warning ? "alert" : "status"}
    style={{ marginTop: 8, marginBottom: 8, fontSize: 13, lineHeight: 1.5, color: battery.low_battery_warning ? C.yellow : C.muted }}>
    {battery.low_battery_warning
      ? <b>Tindeq battery low—replace the battery.</b>
      : battery.status === "checking" ? "Checking Tindeq battery…"
      : voltage ? `${connected ? "Battery reading" : "Last battery reading"}: ${voltage} · charge level unavailable`
      : "Battery status unavailable"}
    {battery.voltage_read_at_ms && <span style={{ display: "block", fontSize: 12 }}>
      {battery.low_battery_warning && voltage ? `${voltage} · ` : ""}
      Last checked {new Date(battery.voltage_read_at_ms).toLocaleString()}
    </span>}
  </div>;
}

export function InterruptedBatteryNote({ battery }) {
  if (!battery) return null;
  const voltage = formatVoltage(battery.voltage_mv);
  return <div style={{ marginTop: 6, fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
    Last battery reading before interruption: {voltage ?? "unavailable"}.
    {voltage && battery.voltage_read_at_ms && <> Checked {new Date(battery.voltage_read_at_ms).toLocaleString()}.</>}
    {battery.low_battery_warning
      ? " The Tindeq reported a low battery. This does not confirm the cause of the interruption."
      : " No low-battery warning was recorded; this does not rule out a battery problem."}
  </div>;
}
