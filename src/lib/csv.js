// ─────────────────────────────────────────────────────────────
// CSV EXPORT HELPERS
// ─────────────────────────────────────────────────────────────
// Used by HistoryView's "download CSV" buttons and by the manual
// session summary. DOM side-effecting (Blob + anchor click) so
// these aren't pure model code, but they're trivially substitutable
// in a test environment if needed.

// Per-rep grip-training CSV — flat schema matching the Supabase
// `reps` table for round-trip import in spreadsheets.
//
// avg_force_kg is the Tindeq-measured actual force during the hang;
// the model layer prefers it over weight_kg for "effective load"
// (see effectiveLoad() in src/model/prescription.js). Reps that
// have weight_kg = 0 but a real avg_force_kg reading are still
// informative — without this column, those rows looked like blank
// zero-load rows in earlier exports.
//
// `failed` is the auto-failure flag (true if the rep timed out or
// the user marked it failed). Failure reps are what drives the
// curve fit, so leaving it out of the export made it impossible to
// reconstruct the model's view of which reps mattered.
export function toCSV(reps) {
  const cols = ["id","date","grip","hand","target_duration","weight_kg",
                "actual_time_s","avg_force_kg","peak_force_kg",
                "set_num","rep_num","rest_s","session_id","failed"];
  const esc  = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; };
  return [cols.join(","), ...reps.map(r => cols.map(c => esc(r[c])).join(","))].join("\n");
}

export function downloadCSV(reps) {
  const blob = new Blob([toCSV(reps)], { type: "text/csv" });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob), download: "finger-training-history.csv",
  });
  a.click();
}

// Per-set workout-log CSV — one row per set across all sessions.
// Sessions with bodyweight-only exercises (no sets array) get one
// row with empty set/reps/weight columns.
export function downloadWorkoutCSV(log) {
  const rows = [];
  for (const s of log) {
    // Skip rotation-pin entries — they're synced markers from
    // WorkoutTab (see ROTATION_PIN_KEY in src/lib/storage.js), not
    // real workout sessions, and have no exercises to export.
    // Hardcoded literal here to keep src/lib/csv.js dependency-free.
    if (s.workout === "__rotation_pin") continue;
    for (const [exId, exData] of Object.entries(s.exercises || {})) {
      const exName = exId.replace(/_/g, " ");
      if (exData.sets && exData.sets.length > 0) {
        exData.sets.forEach((set, i) => {
          rows.push([s.date, s.completedAt || "", s.workout || "", s.sessionNumber || "", exName, i + 1, set.reps ?? "", set.weight ?? "", set.done ? "yes" : "no"]);
        });
      } else {
        rows.push([s.date, s.completedAt || "", s.workout || "", s.sessionNumber || "", exName, "", "", "", exData.done ? "yes" : "no"]);
      }
    }
  }
  const header = ["date", "completed_at", "workout", "session_number", "exercise", "set", "reps", "weight", "done"];
  const csv = [header, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob), download: "workout-history.csv",
  });
  a.click();
}
