// A duplicated export must not provide extra training or test observations.
// Conflicting copies of the same ID cannot be resolved without edit history.
export function prepareEvaluationRows(input) {
  const rows = [], excluded = {}, seen = new Set(), ids = new Map();
  const reject = reason => { excluded[reason] = (excluded[reason] || 0) + 1; };
  const canonical = value => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
    return value;
  };
  for (const r of input) if (r?.id) {
    const contents = JSON.stringify(canonical(r));
    if (!ids.has(r.id)) ids.set(r.id, new Set());
    ids.get(r.id).add(contents);
  }
  for (const r of input) {
    if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(r.date || '') || !Number.isFinite(Date.parse(r.date))) { reject('invalid_date'); continue; }
    if (!['L', 'R'].includes(r.hand) || !r.grip) { reject('unknown_hand_or_grip'); continue; }
    if (r.id && ids.get(r.id).size > 1) { reject('conflicting_id'); continue; }
    const key = r.id || JSON.stringify(canonical(r));
    if (seen.has(key)) { reject('duplicate'); continue; }
    seen.add(key); rows.push(r);
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || String(a.session_id).localeCompare(String(b.session_id))
    || a.hand.localeCompare(b.hand) || (a.set_num || 1) - (b.set_num || 1) || (a.rep_num || 1) - (b.rep_num || 1)
    || String(a.id).localeCompare(String(b.id)));
  return { rows, excluded };
}
