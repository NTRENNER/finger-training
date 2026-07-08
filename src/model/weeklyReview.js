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
import { prescription } from "./prescription.js";
import { maxTestStaleness } from "./peakForce.js";

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
// stuck or missing / What I'd focus on / Heads up. Same philosophy —
// narration over EXISTING signals, and the focus section never argues
// with the recommender: focus items come from zone/grip staleness, the
// peak-test cadence, and prescription() loads, all engine-owned.
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
  const reps28 = fingerReps.filter(r => r.date >= d28 && r.date <= refDate);
  const noLoad = reps28.filter(r => !(effectiveLoad(r) > 0)).length;
  const bySession = new Map();
  for (const r of reps28) {
    const sid = r.session_id || `${r.date}|nosid`;
    if (!bySession.has(sid)) bySession.set(sid, { count: 0, dates: new Set() });
    const e = bySession.get(sid);
    e.count += 1;
    e.dates.add(r.date);
  }
  const tinySessions = [...bySession.values()].filter(e => e.count <= 2).length;
  const multiDateSessions = [...bySession.values()].filter(e => e.dates.size > 1).length;
  const dataQuality = { noLoad, tinySessions, multiDateSessions };

  // ── Focus candidates (recommender-owned signals + loads) ──
  // Rough load for a (grip, zone) via the SAME prescription() the plan
  // card uses — the check-in quotes the engine, never re-decides.
  let priors = null;
  try { priors = buildThreeExpPriors(history); } catch (e) { priors = null; }
  const loadFor = (grip, zone) => {
    if (!priors) return null;
    try {
      const T = ZONE_REF_T[zone];
      const vals = ["L", "R"]
        .map(h => prescription(history, h, grip, T, { threeExpPriors: priors })?.value)
        .filter(v => v != null && v > 0);
      return vals.length ? round1(sum(vals) / vals.length) : null;
    } catch (e) { return null; }
  };
  const focus = [];
  for (const sz of staleZones.slice(0, 2)) {
    focus.push({
      key: `zone|${sz.grip}|${sz.zone}`,
      text: `${sz.grip} ${sz.zone.replace(/_/g, " ")} (~${ZONE_REF_T[sz.zone]}s) — untouched ${sz.days} days` +
        (loadFor(sz.grip, sz.zone) != null ? `; the engine would start you near ${loadFor(sz.grip, sz.zone)} kg` : ""),
    });
  }
  for (const g of base.finger.staleGrips.slice(0, 1)) {
    if (!focus.some(f => f.key.includes(`|${g.grip}|`))) {
      focus.push({ key: `grip|${g.grip}`, text: `${g.grip} has gone quiet for ${g.days} days — one moderate session re-anchors its curve.` });
    }
  }
  for (const g of grips) {
    let mt = null;
    try { mt = maxTestStaleness(fingerReps.filter(r => r.grip === g), refDate); } catch (e) { mt = null; }
    if (mt && mt.recommended && focus.length < 3) {
      focus.push({
        key: `peak|${g}`,
        text: mt.staleDays == null
          ? `No measured max on ${g} yet — a 3×3s peak test sets the top line.`
          : `${g} peak reading is ${mt.staleDays}d old — a 3×3s peak test refreshes it.`,
      });
    }
  }

  return { ...base, volume, staleZones, perf, climbCtx, bw, dataQuality, focusCandidates: focus.slice(0, 3) };
}

export function assembleCheckIn(signals) {
  if (!signals || signals.empty || !signals.range) {
    return { range: null, headline: "No training logged yet — log a session to start your weekly check-in.", sections: null };
  }
  const digest = assembleReview(signals);
  const { volume, staleZones, perf, climbCtx, bw, dataQuality, focusCandidates, finger } = signals;

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
  if (!did.length) did.push("No finger or climbing sessions logged this week.");

  // WHAT'S MOVING — digest wins + the ratio trend when it's rising.
  const moving = digest.points.filter(p => p.kind === "win").map(p => p.text);
  if (perf && perf.ratioNow != null && perf.ratioPrev != null && perf.n >= 10) {
    const dir = perf.ratioNow - perf.ratioPrev;
    if (dir >= 0.05) moving.push(`You're outlasting targets more: avg hold ratio ${perf.ratioPrev} → ${perf.ratioNow} over the last month — the curve amplitude is lifting.`);
  }
  if (perf && perf.overshoots >= 3) moving.push(`${perf.overshoots} reps beat their target by 40%+ this month — the engine will chase those with heavier prescriptions.`);

  // WHAT'S STUCK OR MISSING — digest concerns + stale zones + falling ratio.
  const stuck = digest.points.filter(p => p.kind === "concern").map(p => p.text);
  for (const sz of (staleZones || []).slice(0, 3)) {
    stuck.push(`${sz.grip} ${sz.zone.replace(/_/g, " ")} hasn't been trained in ${sz.days} days.`);
  }
  if (perf && perf.ratioNow != null && perf.ratioPrev != null && perf.ratioNow - perf.ratioPrev <= -0.05 && perf.n >= 10) {
    stuck.push(`Hold ratio slipped ${perf.ratioPrev} → ${perf.ratioNow} vs the prior month — targets are winning more often.`);
  }
  if (bw && Math.abs(bw.deltaKg) >= 1) {
    stuck.push(`Body weight moved ${bw.deltaKg > 0 ? "+" : ""}${bw.deltaKg} kg over the month — relative strength numbers shift with it.`);
  }

  // FOCUS — at most 3, engine-owned.
  const focus = (focusCandidates || []).map(f => f.text);

  // HEADS UP — data quality, or the all-clear.
  const headsUp = [];
  if (dataQuality) {
    if (dataQuality.noLoad > 0) headsUp.push(`${dataQuality.noLoad} rep${dataQuality.noLoad === 1 ? "" : "s"} this month have no usable load — fits skip them; add manual loads in History if they were real.`);
    if (dataQuality.tinySessions > 0) headsUp.push(`${dataQuality.tinySessions} session${dataQuality.tinySessions === 1 ? "" : "s"} with ≤2 reps — accidental starts? Delete them if so.`);
    if (dataQuality.multiDateSessions > 0) headsUp.push(`${dataQuality.multiDateSessions} session id${dataQuality.multiDateSessions === 1 ? "" : "s"} span multiple dates — worth a look in History.`);
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
