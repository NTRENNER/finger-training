// Compare cumulative whole-curve capacity states across a fixed window.
//
// Capacity rows are expressed as percent versus a frozen baseline. Convert
// those indexes back to ratios before comparing them so +20% -> +25% is a
// 4.2% capacity gain, not a five-percentage-point gain.

const DAY_MS = 24 * 60 * 60 * 1000;

function isoDayValue(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || "");
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / DAY_MS;
}

export function buildCapacityChanges(rows, grips, days = 28, asOfDate = null) {
  if (!Array.isArray(rows) || !Array.isArray(grips) || !(days > 0)) return [];

  const requestedAsOfDay = isoDayValue(asOfDate);
  const changes = [];
  for (const grip of grips) {
    const key = `${grip}_pct`;
    const points = rows
      .map(row => ({
        date: row?.date,
        day: isoDayValue(row?.date),
        pct: row?.[key],
      }))
      .filter(point => point.day != null && Number.isFinite(point.pct))
      .sort((a, b) => a.day - b.day);

    const eligiblePoints = requestedAsOfDay == null
      ? points
      : points.filter(point => point.day <= requestedAsOfDay);
    if (eligiblePoints.length < 2) continue;
    const latest = eligiblePoints[eligiblePoints.length - 1];
    const asOfDay = requestedAsOfDay ?? latest.day;
    const cutoff = asOfDay - days;
    // Do not label an old period as "the last 28 days" when the grip
    // has no capacity observation inside the current window.
    if (latest.day <= cutoff) continue;
    let prior = null;
    for (const point of eligiblePoints) {
      if (point.day <= cutoff) prior = point;
      else break;
    }
    if (!prior) continue;

    const priorIndex = 1 + prior.pct / 100;
    const latestIndex = 1 + latest.pct / 100;
    if (!(priorIndex > 0) || !(latestIndex > 0)) continue;

    const roundedChange = Math.round((latestIndex / priorIndex - 1) * 1000) / 10;
    changes.push({
      grip,
      changePct: Object.is(roundedChange, -0) ? 0 : roundedChange,
      fromDate: prior.date,
      toDate: latest.date,
    });
  }
  return changes;
}
