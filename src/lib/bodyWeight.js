import { today } from "../util.js";

export function validWeightDate(date, asOf = today()) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date > asOf) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

export function latestBodyWeight(log = [], asOf = today()) {
  return log.filter(e => e && Number.isFinite(e.kg) && e.kg > 0 && validWeightDate(e.date, asOf))
    .reduce((latest, entry) => !latest || entry.date > latest.date ? entry : latest, null);
}

export function bodyWeightReminderDue(latest, dismissedDate, asOf = today()) {
  if (dismissedDate === asOf) return false;
  if (!latest) return true;
  // Compare local calendar dates as UTC midnights, avoiding DST-length days.
  return (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${latest.date}T00:00:00Z`)) / 86400000 >= 7;
}
