import { LS_HISTORY_KEY, saveLS } from './storage.js';

export const RESEARCH_CACHE_BYTES = 512 * 1024;
const researchKeys = ['prediction_check', 'mixed_load_prediction'];
const hasResearch = r => researchKeys.some(k => r.force_recording?.[k] != null);
function withoutResearch(row) {
  if (!hasResearch(row)) return row;
  const force_recording = { ...row.force_recording };
  researchKeys.forEach(k => delete force_recording[k]);
  return { ...row, force_recording };
}

// Budget entire sessions, newest first, so a retained recovery score keeps its
// opener snapshot. A cloud refresh is subjected to the same local budget.
export function boundResearchCache(history, budget = RESEARCH_CACHE_BYTES) {
  const groups = new Map();
  for (const row of history) {
    if (!hasResearch(row)) continue;
    const key = row.session_id || row.date;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const keep = new Set();
  let used = 0;
  const sessions = [...groups.entries()].sort((a, b) =>
    String(b[1][0].session_started_at || b[1][0].date).localeCompare(String(a[1][0].session_started_at || a[1][0].date))
    || String(b[0]).localeCompare(String(a[0])));
  for (const [key, rows] of sessions) {
    const cost = rows.reduce((n, r) => n + 2 * JSON.stringify(Object.fromEntries(
      researchKeys.filter(k => r.force_recording?.[k] != null).map(k => [k, r.force_recording[k]]))).length, 0);
    if (used + cost > budget) continue;
    used += cost; keep.add(key);
  }
  return history.map(row => keep.has(row.session_id || row.date) ? row : withoutResearch(row));
}

export function downloadHistoryBackup(history) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(history, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url;
  link.download = 'finger-training-backup.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function persistHistory(history) {
  const bounded = boundResearchCache(history);
  if (saveLS(LS_HISTORY_KEY, bounded) !== false) return { status: 'saved' };
  // Quota may be shared with other origin data. Retry with activity only.
  const essential = history.map(withoutResearch);
  if (history.some(hasResearch) && saveLS(LS_HISTORY_KEY, essential) !== false) {
    return { status: 'research_trimmed' };
  }
  return { status: 'failed' };
}
