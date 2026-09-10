// Oldest first. Stable fallbacks make cloud/input ordering irrelevant.
const text = value => String(value ?? "");
const time = r => Date.parse(r.session_started_at || r.created_at || r.date) || 0;
export function compareSessionOrder(a, b) {
  return text(a.date).localeCompare(text(b.date))
    || time(a) - time(b)
    || text(a.session_id).localeCompare(text(b.session_id))
    || text(a.id).localeCompare(text(b.id));
}
export function compareOpeningRep(a, b) {
  return (Number(a.set_num) || 1) - (Number(b.set_num) || 1)
    || (Number(a.rep_num) || 1) - (Number(b.rep_num) || 1)
    || compareSessionOrder(a, b)
    || JSON.stringify(a).localeCompare(JSON.stringify(b));
}
