#!/usr/bin/env node
/* eslint-disable no-console */
// awards-replay — replay a real rep history session by session and report
// how often each session award (src/model/sessionAwards.js) would have
// fired, plus the distribution behind each threshold.
//
//   node --no-warnings scripts/awards-replay.mjs
//
// Data: scripts/data/awards-reps.json (or AWARDS_DATA=/path), a JSON array
// of one athlete's rep rows in storage shape. The export is gitignored.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionAwardMetrics, sessionAwards, AWARD_THRESHOLDS, AWARD_ORDER } from "../src/model/sessionAwards.js";
import { calcLevel, getBaseline } from "../src/model/levels.js";
import { ZONE_KEYS } from "../src/model/zones.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = process.env.AWARDS_DATA || resolve(HERE, "data/awards-reps.json");
const num = v => (v == null ? null : Number(v));
const history = JSON.parse(readFileSync(DATA, "utf8")).map(r => ({ ...r,
  actual_time_s: num(r.actual_time_s), avg_force_kg: num(r.avg_force_kg), peak_force_kg: num(r.peak_force_kg),
  manual_load_kg: num(r.manual_load_kg), prescribed_load_kg: num(r.prescribed_load_kg), weight_kg: num(r.weight_kg),
  target_duration: num(r.target_duration), rest_s: num(r.rest_s), set_num: num(r.set_num), rep_num: num(r.rep_num),
})).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

const sessions = new Map();
for (const r of history) {
  if (!r.session_id || r.force_recording?.session_protocol) continue;
  if (!sessions.has(r.session_id)) sessions.set(r.session_id, []);
  sessions.get(r.session_id).push(r);
}

const quantiles = xs => {
  const s = [...xs].sort((a, b) => a - b);
  const q = p => s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2) : "—";
  return `n=${s.length} p10=${q(.1)} p25=${q(.25)} p50=${q(.5)} p75=${q(.75)} p90=${q(.9)} max=${q(.999)}`;
};
const share = (xs, test) => xs.length ? `${xs.filter(test).length}/${xs.length}` : "0/0";

const rows = [];
for (const reps of sessions.values()) {
  const first = reps[0];
  const before = history.filter(r => Date.parse(r.created_at) < Date.parse(first.created_at));
  const input = { before, reps, grip: first.grip, targetTime: first.target_duration,
    hands: [...new Set(reps.map(r => r.hand))].filter(h => h === "L" || h === "R"), restSeconds: first.rest_s ?? 20 };
  rows.push({ date: first.date, grip: first.grip, target: first.target_duration, id: first.session_id,
    metrics: sessionAwardMetrics(input), awards: sessionAwards(input) });
}

const perHand = rows.flatMap(s => s.metrics.map(m => ({ ...m, date: s.date })));
const curve = perHand.filter(m => m.curveRatio != null).map(m => m.curveRatio);
const rec = perHand.filter(m => m.recommendation).map(m => m.recommendation);
const gap = perHand.filter(m => m.recoveryGap != null).map(m => m.recoveryGap);

console.log(`Sessions: ${rows.length}   hand-sessions: ${perHand.length}   ${rows[0].date} → ${rows.at(-1).date}\n`);
console.log("Curve ratio (opening force ÷ curve force at that duration)");
console.log("  ", quantiles(curve));
for (const t of [1.03, 1.05, 1.08, 1.10, 1.15]) console.log(`   ≥${t}: ${share(curve, x => x >= t)}`);
console.log("\nRecommendation (opening hold, plan followed)");
console.log("   load ratio", quantiles(rec.map(x => x.loadRatio)));
console.log("   time ratio", quantiles(rec.map(x => x.timeRatio)));
for (const t of [1.0, 1.1, 1.15, 1.25, 1.4]) {
  console.log(`   load≥${AWARD_THRESHOLDS.recommendationLoadRatio} & time≥${t}: ${share(rec, x => x.loadRatio >= AWARD_THRESHOLDS.recommendationLoadRatio && x.timeRatio >= t)}`);
}
console.log("\nRecovery gap (rep 2 retention − expected), first hold reached target");
console.log("  ", quantiles(gap));
for (const t of [0.05, 0.10, 0.15, 0.20, 0.30]) console.log(`   ≥${t}: ${share(gap, x => x >= t)}`);

console.log("\nAwards at current thresholds", JSON.stringify(AWARD_THRESHOLDS));
for (const type of AWARD_ORDER) {
  const hit = rows.filter(s => s.awards.some(a => a.type === type));
  console.log(`   ${type.padEnd(15)} ${hit.length}/${rows.length} sessions   last 60 days: ${hit.filter(s => s.date >= "2026-09-11").length}/${rows.filter(s => s.date >= "2026-09-11").length}`);
}
const any = rows.filter(s => s.awards.length);
console.log(`   any award       ${any.length}/${rows.length} sessions   two or more kinds: ${rows.filter(s => new Set(s.awards.map(a => a.type)).size > 1).length}`);

console.log("\nLast 12 sessions");
for (const s of rows.slice(-12)) {
  console.log(`   ${s.date} ${s.grip.padEnd(8)} ${String(s.target).padStart(3)}s  ${s.awards.map(a => `${a.type}:${a.hand}`).join(" ") || "—"}`);
  for (const m of s.metrics) console.log(`        ${m.hand} level ${m.levelBefore}→${m.levelAfter} curve ${m.curveRatio?.toFixed(2) ?? "—"} rec ${m.recommendation ? `${m.recommendation.loadRatio.toFixed(2)}×load ${m.recommendation.timeRatio.toFixed(2)}×time` : "—"} gap ${m.recoveryGap?.toFixed(2) ?? "—"}`);
}

console.log("\nLevels now (baseline kg → level), per grip / zone / hand");
for (const grip of [...new Set(history.map(r => r.grip))].sort()) for (const zone of ZONE_KEYS) for (const hand of ["L", "R"]) {
  const base = getBaseline(history, hand, grip, zone);
  if (base != null) console.log(`   ${grip.padEnd(8)} ${zone.padEnd(19)} ${hand}  ${base.toFixed(1)} → level ${calcLevel(history, hand, grip, zone)}`);
}
