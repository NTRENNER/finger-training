// ─────────────────────────────────────────────────────────────
// WEEKLY REVIEW — coach-voice training digest
// ─────────────────────────────────────────────────────────────
// A short weekly note in an expert coach's voice: a headline, a win or
// two, an honest concern, a forward nudge — and it stays quiet on
// uneventful weeks rather than manufacturing praise.
//
// DESIGN: this is a NARRATION layer, not a parallel stats engine. Every
// signal is computed by the app's existing, already-tested model code;
// this file only decides which 2-4 things matter this week and phrases
// them. In particular:
//   • recovery / "down week vs overreach" → deloadStatus (real
//     cross-grip recovery signal + acute:chronic lifting spike), so a
//     light-but-recovered week reads as good rest, not as slacking.
//   • finger progress  → buildGripImprovement (curve Δ% vs baseline),
//     computeDensityLadder (earned load bumps).
//   • climbing progress → gradeRank on clean sends, per discipline.
//   • staleness        → last-trained gap per grip / support workout.
//
// "What changed THIS week" is derived by running a signal on full
// history and on history-as-of-week-start and diffing — every model fn
// here is a pure function of history, so this is free.
//
// Structure: gatherSignals() does the integration (needs real data);
// assembleReview() is pure ranking/voice over a normalized signals
// object (heavily unit-tested). buildWeeklyReview() = assemble(gather()).

import { buildThreeExpPriors } from "./threeExp.js";
import { buildGripBaselines, buildGripEstimates, buildGripImprovement } from "./baselines.js";
import { computeDensityLadder } from "./densityLadder.js";
import { deloadStatus, buildDeloadGuidance } from "./deload.js";
import { ZONE_KEYS } from "./zones.js";
import { gradeRank, weekKey } from "../lib/climbing-grades.js";

// Tunables
const BASELINE_WEEKS = 4;
const STALE_DAYS = 12;          // a grip "goes quiet" past this
const SUPPORT_STALE_DAYS = 14;  // an A/B/C workout counts as skipped past this
const CURVE_TICK_PP = 2;        // curve Δ% (percentage points) this week to call a win
const LOW_WEEK_FRAC = 0.7;      // finger days below this × baseline = a "lighter week"

// "Sent" = clean send OR a completion that took a mid-route rest — the
// same bar the app's "hardest send over time" card uses (ClimbingAnalysisView
// SENT_STYLES). Kept in sync here; excludes pure attempts/falls.
const SENT_STYLES = new Set(["onsight", "flash", "redpoint", "rest"]);
const wasSent = (a) => a && SENT_STYLES.has(a.ascent);

const round1 = (v) => Math.round(v * 10) / 10;
function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function maxDate(rows, key = "date") {
  let m = "";
  for (const r of rows || []) if (r && r[key] && r[key] > m) m = r[key];
  return m || null;
}
const distinctDates = (rows) => new Set((rows || []).map(r => r.date)).size;
const daysDiff = (from, to) =>
  Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000);

// ── Signal gathering (integration; validated on real data) ──────────
export function gatherSignals(history = [], activities = [], workoutSessions = [], opts = {}) {
  const fingerReps = (history || []).filter(r => r && r.date && Number(r.actual_time_s) > 0);
  const climbs = (activities || []).filter(a => a && a.date && a.type === "climbing");
  const support = (workoutSessions || []).filter(w => w && w.date && ["A", "B", "C"].includes(w.workout));

  const refDate = opts.refDate
    || [maxDate(fingerReps), maxDate(climbs), maxDate(support)].filter(Boolean).sort().pop()
    || null;
  if (!refDate) return { range: null, empty: true };

  const weekStart = weekKey(refDate);                 // Monday of refDate's week
  const baseEnd   = addDays(weekStart, -1);
  const baseStart = addDays(weekStart, -(BASELINE_WEEKS * 7));
  const inWeek = (d) => d >= weekStart && d <= refDate;
  const inBase = (d) => d >= baseStart && d <= baseEnd;

  const weekReps = fingerReps.filter(r => inWeek(r.date));
  const baseReps = fingerReps.filter(r => inBase(r.date));
  const beforeWeek = history.filter(r => r && r.date && r.date < weekStart);

  // Finger: curve improvement THIS week (now vs as-of week start), same baseline.
  const curveByGrip = {};
  try {
    const priors = buildThreeExpPriors(history);
    const baselines = buildGripBaselines(history, priors);
    const impNow  = buildGripImprovement(baselines, buildGripEstimates(history, priors));
    const impThen = buildGripImprovement(baselines, buildGripEstimates(beforeWeek, priors));
    const trainedThisWeek = new Set(weekReps.map(r => r.grip));
    for (const grip of Object.keys(impNow)) {
      if (!trainedThisWeek.has(grip)) continue;       // only credit grips touched this week
      const now = impNow[grip].total;
      const then = impThen[grip] ? impThen[grip].total : null;
      curveByGrip[grip] = { totalNow: now, weekDelta: then == null ? null : now - then };
    }
  } catch (e) { /* fit can fail on thin data — no curve signal */ }

  // Finger: density-ladder load bumps earned this week.
  const ladderBumps = [];
  const grips = [...new Set(fingerReps.map(r => r.grip).filter(Boolean))];
  for (const grip of grips) {
    for (const zoneKey of ZONE_KEYS) {
      let ld;
      try { ld = computeDensityLadder(history, grip, zoneKey); } catch (e) { ld = null; }
      if (ld && ld.decision === "step_load" && ld.basis && inWeek(ld.basis.date)) {
        ladderBumps.push({ grip, zoneKey, T: ld.T, date: ld.basis.date });
      }
    }
  }

  // Finger: staleness (per grip gone quiet).
  const lastSeen = {};
  for (const r of fingerReps) if (!lastSeen[r.grip] || r.date > lastSeen[r.grip]) lastSeen[r.grip] = r.date;
  const staleGrips = Object.entries(lastSeen)
    .map(([grip, d]) => ({ grip, days: daysDiff(d, refDate) }))
    .filter(g => g.days >= STALE_DAYS)
    .sort((a, b) => b.days - a.days);

  // Climbing: grade PR this week, per discipline (ranks aren't comparable across).
  const sent = climbs.filter(wasSent);
  const prs = [];
  for (const [label, pred] of [["boulder", c => c.discipline === "boulder"], ["rope", c => c.discipline !== "boulder"]]) {
    const wk = sent.filter(c => inWeek(c.date) && pred(c));
    const pr = sent.filter(c => c.date < weekStart && pred(c));
    if (!wk.length) continue;
    const best = wk.reduce((b, c) => (gradeRank(c.grade) > gradeRank(b.grade) ? c : b));
    const bestRank = gradeRank(best.grade);
    const priorRank = pr.reduce((m, c) => Math.max(m, gradeRank(c.grade)), -1);
    if (bestRank > 0 && bestRank > priorRank) {
      const prevGrade = pr.length ? pr.reduce((b, c) => (gradeRank(c.grade) > gradeRank(b.grade) ? c : b)).grade : null;
      prs.push({ discipline: label, grade: best.grade, prevGrade });
    }
  }

  // Support: adherence + skipped workout.
  const supportLastSeen = {};
  for (const w of support) if (!supportLastSeen[w.workout] || w.date > supportLastSeen[w.workout]) supportLastSeen[w.workout] = w.date;
  const staleWorkouts = Object.entries(supportLastSeen)
    .map(([workout, d]) => ({ workout, days: daysDiff(d, refDate) }))
    .filter(w => w.days >= SUPPORT_STALE_DAYS)
    .sort((a, b) => b.days - a.days);

  // Recovery — the marquee honesty signal.
  let recovery = { level: "green", label: null, guidanceAction: null };
  try {
    const ds = deloadStatus(history, workoutSessions, { today: refDate });
    let guidanceAction = null;
    if (ds.deload && ds.deload.deload) {
      const g = buildDeloadGuidance(ds.deload.severity, history, { today: refDate });
      guidanceAction = g ? g.action : null;
    }
    recovery = { level: ds.level, label: ds.label, guidanceAction };
  } catch (e) { /* leave green */ }

  const finger = {
    daysThisWeek: distinctDates(weekReps),
    daysPerWeekBaseline: round1(distinctDates(baseReps) / BASELINE_WEEKS),
    curveByGrip, ladderBumps, staleGrips,
  };
  const climbing = {
    daysThisWeek: distinctDates(climbs.filter(c => inWeek(c.date))),
    daysPerWeekBaseline: round1(distinctDates(climbs.filter(c => inBase(c.date))) / BASELINE_WEEKS),
    prs, countThisWeek: climbs.filter(c => inWeek(c.date)).length,
  };
  const supportSig = {
    daysThisWeek: distinctDates(support.filter(w => inWeek(w.date))),
    staleWorkouts,
  };

  return {
    range: { weekStart, weekEnd: refDate },
    finger, climbing, support: supportSig, recovery,
    totalActivity: finger.daysThisWeek + climbing.daysThisWeek + supportSig.daysThisWeek,
  };
}

// ── Assembly (pure ranking + voice; unit-tested) ────────────────────
export function assembleReview(signals) {
  if (!signals || signals.empty || !signals.range) {
    return { range: null, headline: "No training logged yet — log a session to start your weekly review.", points: [] };
  }
  const { finger, climbing, support, recovery, totalActivity } = signals;
  const wins = [], concerns = [], info = [];

  // WINS — climbing PRs first (most motivating), then earned bumps, then curve.
  for (const p of climbing.prs) {
    const where = p.discipline === "boulder" ? "boulder" : "route";
    wins.push({ kind: "win", text: p.prevGrade
      ? `New ${where} grade PR — you sent ${p.grade} (past best was ${p.prevGrade}). That's a real level up.`
      : `New ${where} grade PR — you sent ${p.grade}. Bank it.` });
  }
  for (const b of finger.ladderBumps) {
    wins.push({ kind: "win", text: `You earned a load bump on ${b.grip} ${b.T}s — six clean reps, so the weight steps up (+5%). Progress by the book.` });
  }
  for (const [grip, c] of Object.entries(finger.curveByGrip)) {
    if (c.weekDelta != null && c.weekDelta >= CURVE_TICK_PP) {
      wins.push({ kind: "win", text: `Your ${grip} force curve moved up ~${c.weekDelta}% this week (now ${c.totalNow >= 0 ? "+" : ""}${c.totalNow}% over baseline).` });
    }
  }

  // CONCERNS — recovery is the marquee honest signal.
  if (recovery.level === "red") {
    concerns.push({ kind: "concern", text: recovery.guidanceAction
      ? `${recovery.label}. ${recovery.guidanceAction}`
      : `${recovery.label} — your cross-grip recovery is down. Take an easier week.` });
  } else if (recovery.level === "yellow") {
    concerns.push({ kind: "concern", text: recovery.guidanceAction
      ? `${recovery.label}. ${recovery.guidanceAction}`
      : `${recovery.label}. Nothing alarming yet — just don't add load this week.` });
  }
  for (const g of finger.staleGrips.slice(0, 2)) {
    concerns.push({ kind: "concern", text: `${g.grip} has gone quiet — ${g.days} days since you last trained it. Worth a session before the curve drifts.` });
  }
  for (const w of support.staleWorkouts.slice(0, 1)) {
    concerns.push({ kind: "concern", text: `Support workout ${w.workout} hasn't come up in ${w.days} days. If it keeps slipping you'll lose that stimulus.` });
  }

  // CONTEXT — one neutral consistency line, framed by recovery.
  const fd = finger.daysThisWeek, cd = climbing.daysThisWeek, sd = support.daysThisWeek;
  const parts = [];
  if (fd) parts.push(`${fd} finger day${fd === 1 ? "" : "s"}`);
  if (cd) parts.push(`${cd} climbing day${cd === 1 ? "" : "s"}`);
  if (sd) parts.push(`${sd} support session${sd === 1 ? "" : "s"}`);
  const activityStr = parts.length ? parts.join(", ") : "nothing logged";
  const lighter = finger.daysPerWeekBaseline >= 1 && fd < finger.daysPerWeekBaseline * LOW_WEEK_FRAC;
  if (lighter && recovery.level === "green") {
    info.push({ kind: "info", text: `A lighter week (${activityStr}) — and your recovery's green, so it reads as good rest, not lost ground.` });
  } else {
    info.push({ kind: "info", text: `This week: ${activityStr}.` });
  }

  // HEADLINE — lead with the single biggest true story.
  let headline;
  if (totalActivity < 2) {
    headline = `Quiet week — ${activityStr}. Small samples, so take this lightly.`;
  } else if (wins.length) {
    headline = wins.length === 1 ? `Strong week — you've got a win to bank.` : `Big week — ${wins.length} things went right.`;
  } else if (recovery.level === "red") {
    headline = `Time to back off — recovery says deload.`;
  } else if (recovery.level === "yellow") {
    headline = `Solid week, but keep an eye on recovery.`;
  } else if (concerns.length) {
    headline = `Decent week, with one thing to tidy up.`;
  } else {
    headline = `Steady, consistent week — nothing to flag. Keep the rhythm.`;
  }

  const points = [...wins, ...concerns.slice(0, 2), ...info.slice(0, 1)];
  return { range: signals.range, headline, points };
}

export function buildWeeklyReview(history = [], activities = [], workoutSessions = [], opts = {}) {
  return assembleReview(gatherSignals(history, activities, workoutSessions, opts));
}

export function formatWeeklyReview(review) {
  if (!review) return "";
  const lines = [review.headline];
  for (const p of review.points) {
    const mark = p.kind === "win" ? "✅" : p.kind === "concern" ? "⚠️" : "•";
    lines.push(`${mark} ${p.text}`);
  }
  return lines.join("\n");
}
