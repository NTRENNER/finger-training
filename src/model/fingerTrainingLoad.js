import { weekKey } from "../lib/climbing-grades.js";
import { effectiveLoad } from "./load.js";
import { isPeakMeasurement } from "./peakTest.js";

const EXCLUDED_PROTOCOLS = new Set(["peak_test", "warmup_potentiation"]);

function addDays(ymd, days) {
  const date = new Date(`${ymd}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function protocolId(rep) {
  return rep?.force_recording?.session_protocol?.id || null;
}

export function isFingerTrainingLoadRep(rep) {
  if (!rep?.date || isPeakMeasurement(rep) || EXCLUDED_PROTOCOLS.has(protocolId(rep))) return false;
  return Number(rep.actual_time_s) > 0 && effectiveLoad(rep) > 0;
}

export function buildFingerTrainingLoad(history = [], {
  grips = [],
  hand = "pooled",
  weeks = 12,
  throughDate = null,
} = {}) {
  const gripSet = new Set((grips || []).filter(Boolean));
  const eligible = (history || []).filter(rep =>
    isFingerTrainingLoadRep(rep)
    && (!gripSet.size || gripSet.has(rep.grip))
    && (hand === "pooled" || rep.hand === hand));

  if (!eligible.length) return null;

  const endDate = throughDate || eligible.reduce((latest, rep) => rep.date > latest ? rep.date : latest, "");
  const endWeek = weekKey(endDate);
  const count = Math.max(1, Math.floor(Number(weeks) || 12));
  const startWeek = addDays(endWeek, -(count - 1) * 7);
  const rows = Array.from({ length: count }, (_, index) => {
    const week = addDays(startWeek, index * 7);
    return { week, tutS: 0, volumeKgS: 0, sessions: new Set() };
  });
  const byWeek = new Map(rows.map(row => [row.week, row]));

  for (const rep of eligible) {
    const row = byWeek.get(weekKey(rep.date));
    if (!row) continue;
    const seconds = Number(rep.actual_time_s);
    row.tutS += seconds;
    row.volumeKgS += effectiveLoad(rep) * seconds;
    row.sessions.add(rep.session_id || rep.sessionId || `${rep.date}|legacy`);
  }

  const normalized = rows.map(row => ({
    week: row.week,
    tutS: row.tutS,
    volumeKgS: row.volumeKgS,
    sessions: row.sessions.size,
  }));
  const completed = normalized.slice(Math.max(0, normalized.length - 5), -1);
  const divisor = completed.length || 1;

  return {
    rows: normalized,
    currentWeek: endWeek,
    reference: {
      weeks: completed.length,
      tutS: completed.reduce((total, row) => total + row.tutS, 0) / divisor,
      volumeKgS: completed.reduce((total, row) => total + row.volumeKgS, 0) / divisor,
    },
  };
}
