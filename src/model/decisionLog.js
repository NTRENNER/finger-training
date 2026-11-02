// Frozen record of how a session was chosen (docs/model-roadmap.md,
// "Decision log"). The plan card builds it when it applies a plan; the
// session runner adds the loads it actually started with and stamps a copy
// on every rep. Nothing rewrites it later, so an audit reads the decision
// instead of reconstructing it with newer code.
import { CURVE_MODEL_VERSION, THREE_EXP_TAUS } from './threeExp.js';
import { RECOMMENDER_VERSION } from './coaching.js';
import { PROGRESSION_VERSION } from './densityLadder.js';
import { prescription } from './prescription.js';

// v2: every domain's best alternative, and the emphasis-pilot step.
export const DECISION_LOG_VERSION = 2;

const r1 = v => Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
const r3 = v => Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;
const loads = byHand => byHand
  ? Object.fromEntries(Object.entries(byHand).filter(([, v]) => Number.isFinite(v)).map(([h, v]) => [h, r1(v)]))
  : null;

const terms = c => ({
  residual: r3(c.adaptBoost), coverage: r3(c.stalenessBoost), recency: r3(c.recency),
  cost: r3(c.costFactor), hand: r3(c.handBoost), focus: r3(c.focus),
});
const candidate = c => ({
  zone: c.zone, t_s: c.T, hand: c.hand, score: r3(c.score), coverage_status: c.staleStatus,
  local_ratio: r3(c.localRatio), confidence: r3(c.confidence), terms: terms(c),
});

// The curve each hand was prescribed from at the selected duration, with the
// bounds that changed its load.
function curveSnapshot(history, grip, T, freshMap, threeExpPriors) {
  const byHand = {};
  for (const hand of ['L', 'R']) {
    const p = T > 0 ? prescription(history, hand, grip, T, { freshMap, threeExpPriors, captureCurve: true }) : null;
    if (!p) continue;
    byHand[hand] = {
      source: p.source,
      ...(p.curveSnapshot ? { amps: p.curveSnapshot.amps.map(r3), scale: r3(p.curveSnapshot.scale),
        source_days: p.curveSnapshot.source_days } : {}),
      anchor: p.anchor ? { t_s: r1(p.anchor.T), kg: r1(p.anchor.F), date: p.anchor.date } : null,
      curve_load_kg: r1(p.value),
      bounds: { peak_capped: !!p.peakCapped, endurance_ceiled: !!p.enduranceCeiled,
        capacity_floored: !!p.capacityFloored, extrapolation_floored: !!p.extrapFloored },
    };
  }
  return { taus: [...THREE_EXP_TAUS], by_hand: byHand };
}

// The best candidate in each domain other than the pick's (candidates arrive
// best first).
function domainAlternatives(rec) {
  const seen = new Set([rec?.zone]);
  return (rec?.candidates || []).filter(c => !seen.has(c.zone) && seen.add(c.zone)).map(candidate);
}

// `rec` is always the recommender's own pick. Under the emphasis pilot the
// athlete is shown the pilot step instead; `overridden` is then relative to
// that step.
export function buildSessionDecision({
  grip, history = [], freshMap = null, threeExpPriors = null,
  rec = null, pilot = null, overridden = false, source, selected, ladder = null,
}) {
  const gripRows = history.filter(r => r?.grip === grip);
  const last = gripRows.reduce((m, r) => {
    const key = r.created_at || r.date || '';
    return key > (m?.key ?? '') ? { key, row: r } : m;
  }, null)?.row;
  const lb = ladder?.basis;
  return {
    version: DECISION_LOG_VERSION,
    versions: { curve: CURVE_MODEL_VERSION, recommender: RECOMMENDER_VERSION, progression: PROGRESSION_VERSION },
    grip,
    evidence_cutoff: last ? { date: last.date ?? null, created_at: last.created_at ?? null, grip_reps: gripRows.length } : null,
    recommended: rec ? {
      zone: rec.zone, t_s: rec.T, hand: rec.hand, peak_test: !!rec.peakTest,
      boundary_probe: !!rec.boundaryProbe, cold_start_stage: rec.coldStartStage ?? null,
      load_by_hand: loads(rec.loadByHand), score: r3(rec.score),
      coverage_status: rec.staleStatus ?? null, terms: terms(rec),
    } : null,
    alternatives: domainAlternatives(rec),
    pilot: pilot ? {
      id: pilot.pilotId, version: pilot.version, block: pilot.block, emphasis: pilot.emphasis,
      block_day: pilot.blockDay, step: pilot.step, cycle_length: pilot.cycleLength,
      zone: pilot.zone, sessions_before: pilot.sessionsBefore,
    } : null,
    selected: { ...selected, load_by_hand: loads(selected?.load_by_hand) },
    overridden: !!overridden,
    plan_source: source,
    constraints: ladder ? {
      ladder_decision: ladder.decision, ladder_reps: ladder.reps,
      overshoot_hands: lb?.overshootHands ?? [], shortfall_hands: lb?.shortfallHands ?? [],
      bounded_by_hand: lb?.boundedByHand ?? {}, incomplete: !!lb?.incomplete,
    } : {},
    curve: curveSnapshot(history, grip, selected?.t_s, freshMap, threeExpPriors),
  };
}
