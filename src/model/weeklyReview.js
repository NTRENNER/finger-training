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
import { ZONE_KEYS, ZONE_REF_T, zoneOf } from "./zones.js";
import { gradeRank, weekKey } from "../lib/climbing-grades.js";
import { effectiveLoad } from "./load.js";
import { maxTestStaleness } from "./peakForce.js";
// Behavioral notes (adherence vs own cadence, acute:chronic volume
// ramp) migrated INTO the check-in from the Session Plan card
// (2026-07-08 — coaching lives in Analysis; the plan card plans).
import { buildCoachNotes } from "./coachNotes.js";
// Exercise-level support tracking (2026-07-08, BACKLOG #6's
// observational half): workout defs give exercise→workout membership
// so piecemeal A/B/C elements get seen and credited; the prescriptive
// keystone nudge stays parked.
import { workouts as SUPPORT_WORKOUTS, exercises as SUPPORT_EXERCISES } from "./supportTraining.js";
import { migrateExerciseId } from "./exerciseIds.js";
// Busy-week workout nudge (2026-07-08, BACKLOG #6 prescriptive half,
// reshaped per Nathan: data-driven risk picks instead of a manual
// keystone list). See supportRisk.js for the detraining basis.
import { exerciseSupportRisk } from "./supportRisk.js";

// Tunables
const BASELINE_WEEKS = 4;
const STALE_DAYS = 12;          // a grip "goes quiet" past this
const SUPPORT_STALE_DAYS = 14;  // an A/B/C workout counts as skipped past this
const CURVE_TICK_PP = 3;        // curve Δ% (percentage points) this week to call a win (≥3 = earned, filters fit noise)
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

// ─────────────────────────────────────────────────────────────
// WEEKLY CHECK-IN — the full five-section coach report (July 2026)
// ─────────────────────────────────────────────────────────────
// The structured big sibling of the digest above, modeled on Nathan's
// scheduled-task coach prompt: What you did / What's moving / What's
// stuck or missing / What the engine will recommend / Heads up. Same
// philosophy — narration over EXISTING signals, and the focus section
// never argues with the recommender: focus items come from zone/grip
// staleness, the peak-test cadence, and prescription() loads, all
// engine-owned.
//
// gatherCheckInSignals() layers the extra signals over gatherSignals();
// assembleCheckIn() is pure phrasing/ranking over the combined object.

export const CHECKIN_ZONE_STALE_DAYS = 21;   // zone untouched this long → "stuck"
export const CHECKIN_OVERSHOOT = 1.4;        // actual ≥ this × target = notable overshoot
export const CHECKIN_UNDERSHOOT = 0.5;       // actual ≤ this × target = notable undershoot
export const CHECKIN_RATIO_WINDOW_D = 28;    // ratio window (and prior window for trend)

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

export function gatherCheckInSignals(history = [], activities = [], workoutSessions = [], opts = {}) {
  const base = gatherSignals(history, activities, workoutSessions, opts);
  if (base.empty) return base;
  const { bwLog = [] } = opts;
  const refDate = base.range.weekEnd;
  const d7  = addDays(refDate, -6);
  const d28 = addDays(refDate, -27);
  const d56 = addDays(refDate, -55);

  const fingerReps = (history || []).filter(r => r && r.date && Number(r.actual_time_s) > 0);
  const grips = [...new Set(fingerReps.map(r => r.grip).filter(Boolean))].sort();

  // ── Volume & zone coverage, last 7 days, per grip ──
  const volume = {};
  for (const g of grips) {
    const gr7 = fingerReps.filter(r => r.grip === g && r.date >= d7 && r.date <= refDate);
    if (!gr7.length) continue;
    volume[g] = {
      sessions: distinctDates(gr7),
      tutS: Math.round(sum(gr7.map(r => Number(r.actual_time_s) || 0))),
      zones: new Set(gr7.map(r => zoneOf(r.target_duration || r.actual_time_s))).size,
    };
  }

  // ── Zone-level staleness per grip (21d+) ──
  const staleZones = [];
  for (const g of grips) {
    const lastByZone = {};
    for (const r of fingerReps) {
      if (r.grip !== g) continue;
      const z = zoneOf(r.target_duration || r.actual_time_s);
      if (!lastByZone[z] || r.date > lastByZone[z]) lastByZone[z] = r.date;
    }
    for (const [zone, last] of Object.entries(lastByZone)) {
      const days = daysDiff(last, refDate);
      if (days >= CHECKIN_ZONE_STALE_DAYS) staleZones.push({ grip: g, zone, days });
    }
  }
  staleZones.sort((a, b) => b.days - a.days);

  // ── Performance ratio (actual/target), 28d vs prior 28d ──
  const ratioReps = (from, to) => fingerReps.filter(r =>
    r.date >= from && r.date <= to && Number(r.target_duration) > 0 && effectiveLoad(r) > 0);
  const meanRatio = (rs) => rs.length
    ? sum(rs.map(r => r.actual_time_s / r.target_duration)) / rs.length : null;
  const cur = ratioReps(d28, refDate);
  const prev = ratioReps(d56, addDays(d28, -1));
  const perf = {
    ratioNow: meanRatio(cur) != null ? round1(meanRatio(cur) * 100) / 100 : null,
    ratioPrev: meanRatio(prev) != null ? round1(meanRatio(prev) * 100) / 100 : null,
    overshoots: cur.filter(r => r.actual_time_s >= r.target_duration * CHECKIN_OVERSHOOT).length,
    undershoots: cur.filter(r => r.actual_time_s <= r.target_duration * CHECKIN_UNDERSHOOT).length,
    n: cur.length,
  };

  // ── Climbing context, last 7d ──
  const climbs7 = (activities || []).filter(a =>
    a && a.type === "climbing" && a.date >= d7 && a.date <= refDate);
  const rpes = climbs7.map(a => Number(a.rpe)).filter(v => v > 0);
  const sent7 = climbs7.filter(wasSent);
  const hardest = sent7.length
    ? sent7.reduce((b, c) => (gradeRank(c.grade) > gradeRank(b.grade) ? c : b))
    : null;
  const climbCtx = {
    sessions: distinctDates(climbs7),
    count: climbs7.length,
    disciplines: [...new Set(climbs7.map(a => a.discipline).filter(Boolean))],
    hardestSend: hardest ? hardest.grade : null,
    avgRpe: rpes.length ? round1(sum(rpes) / rpes.length) : null,
  };

  // ── Body-weight trend, last 28d ──
  const bwWin = (bwLog || []).filter(b => b && b.date && b.kg > 0 && b.date >= d28 && b.date <= refDate)
    .sort((a, b) => a.date.localeCompare(b.date));
  const bw = bwWin.length >= 2
    ? { fromKg: bwWin[0].kg, toKg: bwWin[bwWin.length - 1].kg, deltaKg: round1(bwWin[bwWin.length - 1].kg - bwWin[0].kg) }
    : null;

  // ── Data quality, last 28d ──
  // Counts AND details (2026-07-08): a bare count is a nag you can't
  // act on — each flagged item carries grip + date (+ rep count) so
  // the Heads-up line points straight at the row in History.
  const reps28 = fingerReps.filter(r => r.date >= d28 && r.date <= refDate);
  const noLoadByKey = new Map();
  for (const r of reps28) {
    if (effectiveLoad(r) > 0) continue;
    const k = `${r.grip || "?"} ${r.date}`;
    noLoadByKey.set(k, (noLoadByKey.get(k) || 0) + 1);
  }
  const noLoadList = [...noLoadByKey.entries()]
    .map(([k, n]) => (n > 1 ? `${k} ×${n}` : k))
    .sort();
  const noLoad = sum([...noLoadByKey.values()]);
  const bySession = new Map();
  for (const r of reps28) {
    const sid = r.session_id || `${r.date}|nosid`;
    if (!bySession.has(sid)) bySession.set(sid, { count: 0, dates: new Set(), grip: r.grip || "?" });
    const e = bySession.get(sid);
    e.count += 1;
    e.dates.add(r.date);
  }
  const tinyList = [...bySession.values()]
    .filter(e => e.count <= 2)
    .map(e => `${e.grip} ${[...e.dates].sort()[0]} (${e.count} rep${e.count === 1 ? "" : "s"})`)
    .sort();
  const multiDateList = [...bySession.values()]
    .filter(e => e.dates.size > 1)
    .map(e => {
      const ds = [...e.dates].sort();
      return `${e.grip} ${ds[0]} → ${ds[ds.length - 1]}`;
    })
    .sort();
  const dataQuality = {
    noLoad, noLoadList,
    tinySessions: tinyList.length, tinyList,
    multiDateSessions: multiDateList.length, multiDateList,
  };

  // ── Focus candidates — GRIP-LEVEL only (2026-07-08 design call) ──
  // Once a grip is picked, the recommender's escalating staleness boost
  // already targets its stale zone — quoting a zone + load here would
  // be a second recommender, and could DISAGREE with the plan card
  // (which picks its own continuous T and applies cookedness). What
  // the engine CANNOT do is choose which grip you train: grip selection
  // is manual, so a grip's stale zones stay invisible for as long as
  // you keep picking other grips. Cross-grip allocation is therefore
  // the check-in's one legitimate prescription — name the grips that
  // most need a session, say why, and trust the engine with the rest.
  const focus = [];
  const worstZoneByGrip = new Map();
  for (const sz of staleZones) {
    if (!worstZoneByGrip.has(sz.grip)) worstZoneByGrip.set(sz.grip, sz);   // staleZones sorted worst-first
  }
  // Voice (July 2026, per Nathan): these are EXPLANATIONS of what the
  // engine will do and why — "X zone is N days stale; the engine will
  // queue it once you pick X" — not imperatives ("Give X a session").
  // The check-in narrates the recommender's reasoning; it doesn't issue
  // a parallel set of orders. The rendered section header matches
  // (WeeklyReviewCard: "What the engine will recommend — and why").
  const gripCandidates = [];
  for (const [g, sz] of worstZoneByGrip) {
    gripCandidates.push({
      grip: g, days: sz.days,
      text: `${g} — its ${sz.zone.replace(/_/g, " ")} zone (~${ZONE_REF_T[sz.zone]}s) is ${sz.days} days stale; the engine will queue it once you pick ${g} on Setup.`,
    });
  }
  for (const g of base.finger.staleGrips) {
    if (!worstZoneByGrip.has(g.grip)) {
      gripCandidates.push({
        grip: g.grip, days: g.days,
        text: `${g.grip} — no sessions in ${g.days} days; its whole curve is drifting, so any moderate session re-anchors it.`,
      });
    }
  }
  gripCandidates.sort((a, b) => b.days - a.days);
  for (const c of gripCandidates.slice(0, 3)) {
    focus.push({ key: `grip|${c.grip}`, text: c.text });
  }
  for (const g of grips) {
    let mt = null;
    try { mt = maxTestStaleness(fingerReps.filter(r => r.grip === g), refDate); } catch (e) { mt = null; }
    if (mt && mt.recommended && focus.length < 3) {
      focus.push({
        key: `peak|${g}`,
        text: mt.staleDays == null
          ? `${g} — no measured max yet; the engine's ceilings are guesses until a 3×3s peak test sets the top line.`
          : `${g} — its peak reading is ${mt.staleDays}d old; a 3×3s peak test refreshes the ceiling the engine caps loads with.`,
      });
    }
  }

  // ── Support work at the EXERCISE level, last 7d ──
  // Busy weeks produce ELEMENTS of A/B/C rather than full sessions.
  // Workout-level staleness can't see that, so: which exercises got
  // ≥1 done set this week (any session label), and — for each stale
  // workout — how many of ITS exercises were touched (partial credit).
  const touchedByEx = new Map();          // migrated exId → Set(dates)
  const supportDates7 = new Set();
  for (const w of workoutSessions || []) {
    if (!w || !w.date || w.date < d7 || w.date > refDate) continue;
    for (const [exId, ex] of Object.entries(w.exercises || {})) {
      const touched = (Array.isArray(ex?.sets) && ex.sets.some(t => t && t.done)) || ex?.done === true;
      if (!touched) continue;
      const id = migrateExerciseId(exId);
      if (!touchedByEx.has(id)) touchedByEx.set(id, new Set());
      touchedByEx.get(id).add(w.date);
      supportDates7.add(w.date);
    }
  }
  const exName = (id) => SUPPORT_EXERCISES[id]?.name || id;
  const supportDetail = {
    days: supportDates7.size,
    exercises: [...touchedByEx.keys()].sort().map(exName),
  };
  const partialCredit = {};
  for (const sw of base.support.staleWorkouts) {
    const def = SUPPORT_WORKOUTS[sw.workout];
    if (!def) continue;
    const ids = new Set((def.exercises || []).map(e => e.id));
    const touched = [...touchedByEx.keys()].filter(id => ids.has(id));
    if (touched.length) partialCredit[sw.workout] = { count: touched.length, names: touched.map(exName) };
  }

  // ── Busy-week workout nudge ──
  // Fires when the week produced NO full A/B/C session ("full" = a
  // session touching ≥60% of its workout's exercises) but DID touch
  // some pieces — Nathan's busy-week pattern. Acknowledge the effort,
  // then prescribe the exercises most at risk of going cold or
  // regressing (supportRisk.js: decay-class windows + trend).
  let anyFull7 = false;
  for (const w of workoutSessions || []) {
    if (!w || !w.date || w.date < d7 || w.date > refDate) continue;
    const def = SUPPORT_WORKOUTS[w.workout];
    if (!def || !def.exercises?.length) continue;
    let touched = 0;
    for (const [exId, ex] of Object.entries(w.exercises || {})) {
      const done = (Array.isArray(ex?.sets) && ex.sets.some(t => t && t.done)) || ex?.done === true;
      if (done && def.exercises.some(e => e.id === migrateExerciseId(exId))) touched += 1;
    }
    if (touched >= Math.ceil(def.exercises.length * 0.6)) { anyFull7 = true; break; }
  }
  let supportNudge = null;
  if (!anyFull7 && touchedByEx.size > 0) {
    let picks = [];
    try { picks = exerciseSupportRisk(workoutSessions, refDate).slice(0, 3); } catch (e) { picks = []; }
    if (picks.length) supportNudge = { picks };
  }

  // ── Behavioral notes (adherence + volume ramp), as of week end ──
  // buildCoachNotes owns the thresholds and the adherence-suppresses-
  // ramp-drop priority; no trajectory injection here — the check-in's
  // hold-ratio trend + curve-Δ wins already cover trajectory.
  let behaviorNotes = [];
  try { behaviorNotes = buildCoachNotes(history, { todayStr: refDate }); } catch (e) { behaviorNotes = []; }

  return { ...base, volume, staleZones, perf, climbCtx, bw, dataQuality, behaviorNotes, supportDetail, partialCredit, supportNudge, focusCandidates: focus.slice(0, 3) };
}

export function assembleCheckIn(signals) {
  if (!signals || signals.empty || !signals.range) {
    return { range: null, headline: "No training logged yet — log a session to start your weekly check-in.", sections: null };
  }
  const digest = assembleReview(signals);
  const { volume, staleZones, perf, climbCtx, bw, dataQuality, behaviorNotes, supportDetail, partialCredit, supportNudge, focusCandidates } = signals;
  const recovery = signals.recovery || { level: "green", label: null };

  // ── Recovery × volume cross-reference (July 2026, per Nathan) ──
  // "Recovery softening — ease up" and "volume is well under your norm"
  // are the SAME story told twice: the athlete already eased up. When
  // both fire, merge them into one line that credits the lighter week
  // (busy stretch or intentional deload — either way the right
  // response) and then branches on what recovery says NOW:
  //   green  → the deload banked; frame it as a platform to advance
  //            (lands in WHAT'S MOVING, not stuck).
  //   yellow → right direction, not done — hold light until green.
  //   red    → the rest hasn't caught up — extend it.
  // With no volume drop, the recovery concern passes through verbatim.
  const rampDrop = (behaviorNotes || []).find(n => n.key === "ramp-drop");
  const dropPct = rampDrop && Number.isFinite(rampDrop.ratio)
    ? Math.round(rampDrop.ratio * 100) : null;
  const mergedRecoveryVolume = rampDrop && recovery.level !== "green" && recovery.label
    ? (recovery.level === "red"
      ? `Recovery is still down even after a light week (~${dropPct}% of your monthly norm) — the deload hasn't caught up yet. Extend the rest: easy sessions only until the trend turns.`
      : `Recovery was softening, but your volume already came down this week (~${dropPct}% of your monthly norm) — a busy stretch or an intentional deload, either way the right response. Hold it light until recovery reads green, then use the freshness as a platform to advance.`)
    : null;
  const deloadBanked = rampDrop && recovery.level === "green"
    ? `Volume ran well under your monthly norm (~${dropPct}%) and recovery reads green — that's a banked deload, not lost ground. Good week to advance: you'll meet the engine's numbers fresh.`
    : null;

  // WHAT YOU DID — volume/coverage lines.
  const did = [];
  const gripsTrained = Object.keys(volume || {});
  for (const g of gripsTrained) {
    const v = volume[g];
    const min = Math.round(v.tutS / 60 * 10) / 10;
    did.push(`${g}: ${v.sessions} session${v.sessions === 1 ? "" : "s"}, ~${min} min under tension, ${v.zones} zone${v.zones === 1 ? "" : "s"} touched.`);
  }
  if (climbCtx && climbCtx.sessions > 0) {
    did.push(`Climbing: ${climbCtx.sessions} session${climbCtx.sessions === 1 ? "" : "s"}` +
      (climbCtx.disciplines.length ? ` (${climbCtx.disciplines.join(", ")})` : "") +
      (climbCtx.hardestSend ? `, hardest send ${climbCtx.hardestSend}` : "") +
      (climbCtx.avgRpe != null ? `, avg RPE ${climbCtx.avgRpe}` : "") + ".");
  }
  if (supportDetail && supportDetail.exercises.length > 0) {
    const names = supportDetail.exercises;
    const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? `, +${names.length - 3} more` : "");
    did.push(`Support work: ${names.length} exercise${names.length === 1 ? "" : "s"} across ${supportDetail.days} day${supportDetail.days === 1 ? "" : "s"} (${shown}).`);
  }
  if (!did.length) did.push("No finger or climbing sessions logged this week.");

  // WHAT'S MOVING — digest wins + the ratio trend when it's rising.
  const moving = digest.points.filter(p => p.kind === "win").map(p => p.text);
  if (perf && perf.ratioNow != null && perf.ratioPrev != null && perf.n >= 10) {
    const dir = perf.ratioNow - perf.ratioPrev;
    if (dir >= 0.05) moving.push(`You're outlasting targets more: avg hold ratio ${perf.ratioPrev} → ${perf.ratioNow} over the last month — the curve amplitude is lifting.`);
  }
  if (perf && perf.overshoots >= 3) moving.push(`${perf.overshoots} reps beat their target by 40%+ this month — the engine will chase those with heavier prescriptions.`);
  if (deloadBanked) moving.push(deloadBanked);

  // WHAT'S STUCK OR MISSING — digest concerns + behavior (workload
  // ramp / adherence) + stale zones + falling ratio.
  // Partial credit rewrite: the digest's workout-level staleness line
  // ("Support workout B hasn't come up in 17 days...") is rephrased
  // when this week touched some of that workout's exercises inside
  // other sessions. The match keys on the digest's own copy, which is
  // owned by assembleReview in THIS file — keep the two in sync.
  const stuck = digest.points.filter(p => p.kind === "concern").map(p => p.text)
    .map(t => {
      // Recovery concern × volume drop → the merged line (see above),
      // replacing the digest's "don't add load" phrasing in place so
      // it keeps the concern's slot at the top of the section.
      if (mergedRecoveryVolume && recovery.label && t.startsWith(recovery.label)) {
        return mergedRecoveryVolume;
      }
      const m = t.match(/^Support workout (\S+) hasn't come up in (\d+) days/);
      if (m && partialCredit && partialCredit[m[1]]) {
        const pc = partialCredit[m[1]];
        const names = pc.names.slice(0, 3).join(", ") + (pc.names.length > 3 ? `, +${pc.names.length - 3} more` : "");
        return `No full Workout ${m[1]} in ${m[2]} days — but you touched ${pc.count} of its exercise${pc.count === 1 ? "" : "s"} this week (${names}), so the stimulus isn't fully cold.`;
      }
      return t;
    });
  // The raw ramp-drop note is consumed by the merge (yellow/red) or the
  // banked-deload line in WHAT'S MOVING (green) — never shown verbatim
  // alongside either.
  for (const n of behaviorNotes || []) {
    if (rampDrop && n === rampDrop && (mergedRecoveryVolume || deloadBanked)) continue;
    stuck.push(n.text);
  }
  for (const sz of (staleZones || []).slice(0, 3)) {
    stuck.push(`${sz.grip} ${sz.zone.replace(/_/g, " ")} hasn't been trained in ${sz.days} days.`);
  }
  if (perf && perf.ratioNow != null && perf.ratioPrev != null && perf.ratioNow - perf.ratioPrev <= -0.05 && perf.n >= 10) {
    stuck.push(`Hold ratio slipped ${perf.ratioPrev} → ${perf.ratioNow} vs the prior month — targets are winning more often.`);
  }
  if (bw && Math.abs(bw.deltaKg) >= 1) {
    stuck.push(`Body weight moved ${bw.deltaKg > 0 ? "+" : ""}${bw.deltaKg} kg over the month — relative strength numbers shift with it.`);
  }

  // FOCUS — at most 3 total. Grip-level finger items first (engine-
  // owned); on a busy week the workout nudge takes the last slot:
  // acknowledge the piecemeal effort (rhetorical, coach-voice), then
  // name the exercises most at risk of going cold or regressing.
  const focus = (focusCandidates || []).map(f => f.text);
  if (supportNudge && supportNudge.picks.length) {
    const pickStr = supportNudge.picks.map(pk =>
      `${pk.name} (${pk.regressing ? "trending down" : `${pk.daysSince}d idle`})`
    ).join(", ");
    const powerLed = supportNudge.picks[0] && supportNudge.picks[0].windowDays <= 10 && !supportNudge.picks[0].regressing;
    let nudgeText = `No full A/B/C workout this week, but you got pieces in — busy stretch? That's the right instinct. Next week, try to get: ${pickStr}.`;
    if (powerLed) nudgeText += " Power qualities fade fastest, which is why the explosive work leads.";
    if (focus.length >= 3) focus.length = 2;   // nudge takes the third slot
    focus.push(nudgeText);
  }

  // HEADS UP — data quality, or the all-clear. Each line names the
  // offending sessions (grip + date) so they're findable in History;
  // long lists truncate to the first three.
  const listStr = (items, cap = 3) =>
    items.slice(0, cap).join("; ") + (items.length > cap ? `; +${items.length - cap} more` : "");
  const headsUp = [];
  if (dataQuality) {
    if (dataQuality.noLoad > 0) {
      headsUp.push(`${dataQuality.noLoad} rep${dataQuality.noLoad === 1 ? "" : "s"} this month with no usable load (${listStr(dataQuality.noLoadList)}) — fits skip them; add manual loads in History if they were real.`);
    }
    if (dataQuality.tinySessions > 0) {
      headsUp.push(`${dataQuality.tinySessions} session${dataQuality.tinySessions === 1 ? "" : "s"} with ≤2 reps — accidental starts? ${listStr(dataQuality.tinyList)}. Delete in History if so.`);
    }
    if (dataQuality.multiDateSessions > 0) {
      headsUp.push(`${dataQuality.multiDateSessions} session${dataQuality.multiDateSessions === 1 ? "" : "s"} spanning multiple dates (${listStr(dataQuality.multiDateList)}) — worth a look in History.`);
    }
  }
  if (!headsUp.length) headsUp.push("Nothing odd — data looks clean.");

  return {
    range: signals.range,
    headline: digest.headline,
    points: digest.points,          // compact card keeps rendering these
    sections: { did, moving, stuck, focus, headsUp },
  };
}

export function buildCheckIn(history = [], activities = [], workoutSessions = [], opts = {}) {
  return assembleCheckIn(gatherCheckInSignals(history, activities, workoutSessions, opts));
}
