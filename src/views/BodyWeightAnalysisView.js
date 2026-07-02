// ─────────────────────────────────────────────────────────────
// BODYWEIGHT ANALYSIS VIEW
// ─────────────────────────────────────────────────────────────
// Fourth sibling under the Analysis tab (alongside fingers / lifts /
// climbs). Reads the BW log entries from localStorage (synced by the
// reconcile path in App.js) and renders a small set of cards:
//
//   1. Headline — current BW + Δ vs 30/90 days ago + days tracked.
//   2. Bodyweight over time — line chart with raw daily entries plus
//      a 7-day rolling average overlay so the eye reads the trend
//      through the daily noise (water weight, sodium, time of day).
//
// Logging happens on the Setup tab (BwPrompt next to ClimbingLogCard).
// This view is descriptive only — no input surface.

import React, { useMemo, useState } from "react";
import {
  ResponsiveContainer, LineChart, Line,
  XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
import { C } from "../ui/theme.js";
import { Card, Sect } from "../ui/components.js";
import { fmt1, toDisp } from "../ui/format.js";
import { LS_BW_LOG_KEY } from "../lib/storage.js";
import { useLSValue } from "../hooks/useLSValue.js";
import { ymdLocal } from "../util.js";

// Time-window options for the chart. Full history is the default
// since BW data is small and the long view is the most useful for
// catching slow drift.
const WINDOWS = [
  { key: "30",  label: "30d", days: 30 },
  { key: "90",  label: "90d", days: 90 },
  { key: "365", label: "1y",  days: 365 },
  { key: "all", label: "All", days: null },
];

// 7-day rolling-average smoothing. Centered on each point with up to 3
// days of look-back and 3 days of look-ahead, blunted near the edges
// where the window can't fill. Returns the same length as `entries`.
function rollingAvg(entries, windowDays = 7) {
  if (!entries.length) return [];
  const half = Math.floor(windowDays / 2);
  const out = [];
  for (let i = 0; i < entries.length; i++) {
    const center = new Date(entries[i].date).getTime();
    const lo = center - half * 86400_000;
    const hi = center + half * 86400_000;
    let sum = 0, n = 0;
    for (const e of entries) {
      const t = new Date(e.date).getTime();
      if (t >= lo && t <= hi) { sum += e.kg; n += 1; }
    }
    out.push(n ? sum / n : entries[i].kg);
  }
  return out;
}

// Pick the entry on or before a target ISO date; null when none exists.
function entryOnOrBefore(entries, targetDate) {
  const matches = entries.filter(e => e.date <= targetDate);
  return matches.length ? matches[matches.length - 1] : null;
}

export function BodyWeightAnalysisView({ unit = "lbs" }) {
  // Live LS read — a BW entry logged elsewhere (BwPrompt, History
  // edits, a cloud pull) while this view is mounted re-renders the
  // chart; the old mount-only read went stale. Filter/sort into a
  // fresh array inside the memo — never sort the snapshot in place,
  // it's shared with every other subscriber.
  const bwRaw = useLSValue(LS_BW_LOG_KEY);
  const bwLog = useMemo(() => {
    return [...(bwRaw || [])]
      .filter(e => e?.date && e.kg > 0)
      .sort((a, b) => a.date < b.date ? -1 : 1);
  }, [bwRaw]);

  const [windowKey, setWindowKey] = useState("all");

  // Filter to the selected window so the chart has the requested span.
  // `headline` always reads the unfiltered log so 30/90-day deltas are
  // still computed even when the chart is zoomed in.
  const filtered = useMemo(() => {
    const w = WINDOWS.find(x => x.key === windowKey);
    if (!w?.days) return bwLog;
    // ymdLocal, not toISOString — BW entries are stamped with local
    // dates, so a UTC cutoff shifted the window a day early every
    // evening for users west of UTC.
    const cutoff = ymdLocal(new Date(Date.now() - w.days * 86400_000));
    return bwLog.filter(e => e.date >= cutoff);
  }, [bwLog, windowKey]);

  // Build chart data: each point gets the raw value + the rolling
  // 7-day average value, both in display units (lbs / kg).
  const chartData = useMemo(() => {
    if (filtered.length === 0) return [];
    const avgKg = rollingAvg(filtered, 7);
    return filtered.map((e, i) => ({
      date: e.date.slice(5),  // MM-DD for axis density
      raw: Math.round(toDisp(e.kg, unit) * 10) / 10,
      avg: Math.round(toDisp(avgKg[i], unit) * 10) / 10,
      isoDate: e.date,
    }));
  }, [filtered, unit]);

  const headline = useMemo(() => {
    if (bwLog.length === 0) return null;
    const latest = bwLog[bwLog.length - 1];
    const earliest = bwLog[0];
    const todayMs = Date.now();
    // ymdLocal for the same reason as the window filter above — the
    // 30/90-day reference lookups compare against local entry dates.
    const cutoff30 = ymdLocal(new Date(todayMs - 30 * 86400_000));
    const cutoff90 = ymdLocal(new Date(todayMs - 90 * 86400_000));
    const ref30 = entryOnOrBefore(bwLog, cutoff30);
    const ref90 = entryOnOrBefore(bwLog, cutoff90);
    const daysTracked = Math.floor(
      (new Date(latest.date).getTime() - new Date(earliest.date).getTime()) / 86400_000
    ) + 1;
    return {
      latestKg: latest.kg,
      latestDate: latest.date,
      delta30: ref30 && ref30.date !== latest.date ? latest.kg - ref30.kg : null,
      delta90: ref90 && ref90.date !== latest.date ? latest.kg - ref90.kg : null,
      daysTracked,
      entryCount: bwLog.length,
    };
  }, [bwLog]);

  // Empty state — no entries yet. Point the user back to Setup where
  // logging happens.
  if (!headline) {
    return (
      <div style={{ padding: "16px 20px", maxWidth: 720, margin: "0 auto" }}>
        <Sect title="Bodyweight">
          <Card>
            <div style={{ color: C.muted, fontSize: 13, lineHeight: 1.6 }}>
              No bodyweight entries yet. Log one on the Fingers tab next to the
              climb logger; it'll sync to the cloud and start charting here.
            </div>
          </Card>
        </Sect>
      </div>
    );
  }

  const fmtDelta = (kg) => {
    if (kg == null) return null;
    const disp = toDisp(kg, unit);
    const sign = disp >= 0 ? "+" : "";
    return `${sign}${fmt1(disp)} ${unit}`;
  };
  const deltaColor = (kg) => kg == null ? C.muted : kg > 0 ? C.orange : kg < 0 ? C.blue : C.muted;

  return (
    <div style={{ padding: "16px 20px", maxWidth: 720, margin: "0 auto" }}>
      <Sect title="Bodyweight">
        {/* Headline metrics. Δ vs 30/90 days are signed: + means heavier,
            − means lighter. Color is informational only (orange for
            heavier, blue for lighter), not a value judgment. */}
        <Card>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <Stat label="Current" value={`${fmt1(toDisp(headline.latestKg, unit))} ${unit}`} sub={headline.latestDate} />
            <Stat label="Days tracked" value={headline.daysTracked} sub={`${headline.entryCount} entr${headline.entryCount === 1 ? "y" : "ies"}`} />
            <Stat
              label="Δ vs 30 days ago"
              value={headline.delta30 != null ? fmtDelta(headline.delta30) : "—"}
              valueColor={deltaColor(headline.delta30)}
            />
            <Stat
              label="Δ vs 90 days ago"
              value={headline.delta90 != null ? fmtDelta(headline.delta90) : "—"}
              valueColor={deltaColor(headline.delta90)}
            />
          </div>
        </Card>

        {/* Bodyweight over time. Raw entries as faint dots, smoothed
            7-day rolling average as the bold line so the eye reads
            the trend through daily water-weight noise. */}
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, flexWrap: "wrap", gap: 8 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Weight over time</div>
            <div style={{ display: "flex", gap: 4 }}>
              {WINDOWS.map(w => (
                <button key={w.key} onClick={() => setWindowKey(w.key)} style={{
                  padding: "3px 9px", borderRadius: 12, fontSize: 11, cursor: "pointer", border: "none", fontWeight: 600,
                  background: windowKey === w.key ? C.purple : C.border,
                  color:      windowKey === w.key ? "#fff" : C.muted,
                }}>{w.label}</button>
              ))}
            </div>
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>
            Raw daily entries (faint dots) with a 7-day rolling average overlaid in purple. The smoothed line is the trend; the dots are the data.
          </div>
          {chartData.length === 0 ? (
            <div style={{ color: C.muted, fontSize: 12, padding: "12px 0" }}>
              No entries in this window. Widen the time range above.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={chartData} margin={{ top: 6, right: 14, bottom: 24, left: 0 }}>
                <CartesianGrid stroke={C.border} strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fill: C.muted, fontSize: 10 }}
                  angle={-30} textAnchor="end" interval="preserveStartEnd" />
                <YAxis tick={{ fill: C.muted, fontSize: 11 }} width={42}
                  domain={["auto", "auto"]} unit={` ${unit}`} />
                <Tooltip
                  contentStyle={{ background: C.bg, border: `1px solid ${C.border}`, fontSize: 12 }}
                  labelFormatter={(label, payload) => payload?.[0]?.payload?.isoDate || label}
                  formatter={(value, name) => [`${value} ${unit}`, name === "raw" ? "Raw" : "7-day avg"]}
                />
                <Line
                  type="monotone" dataKey="raw" name="raw"
                  stroke={C.muted} strokeWidth={1}
                  dot={{ r: 2, fill: C.muted }}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone" dataKey="avg" name="avg"
                  stroke={C.purple} strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </Card>
      </Sect>
    </div>
  );
}

function Stat({ label, value, sub, valueColor }) {
  return (
    <div style={{
      background: C.bg, borderRadius: 8, padding: "10px 14px",
      border: `1px solid ${C.border}`,
    }}>
      <div style={{ fontSize: 11, color: C.muted }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: valueColor || C.text }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
