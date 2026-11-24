// Analysis can propose questions; this boundary never changes prescriptions.
// No activation by calendar expiry: the frozen experiment requires an explicit
// decision before behavioral recommendations become an intervention.
const BEHAVIORS = new Set(['frequency', 'volume', 'spacing', 'distribution', 'grip_protocol']);
const OUTCOMES = new Set(['modeled_strength', 'modeled_endurance', 'comparable_force', 'comparable_duration']);
const CONFOUNDS = ['total_volume', 'climbing', 'grip', 'protocol', 'session_order'];

export function assessCoachingEvidence(candidate) {
  const reasons = [], e = candidate?.evidence || {};
  if (!BEHAVIORS.has(candidate?.behavior)) reasons.push('outside_behavioral_scope');
  if (typeof candidate?.action !== 'string' || !candidate.action.trim()) reasons.push('no_actionable_change');
  if (!OUTCOMES.has(e.outcome)) reasons.push('no_longitudinal_outcome');
  if (e.comparable !== true || e.independentDates !== true) reasons.push('comparisons_not_established');
  const { estimate, lower, upper, worthwhile, confidence } = e.effect || {};
  const finite = [estimate, lower, upper, worthwhile, confidence].every(Number.isFinite);
  if (!finite || worthwhile <= 0 || confidence < 0.95 || confidence >= 1
    || lower > estimate || upper < estimate || !(lower > worthwhile || upper < -worthwhile)) {
    reasons.push('effect_or_uncertainty_not_actionable');
  }
  if (CONFOUNDS.some(key => e.confounds?.[key] !== 'considered')) reasons.push('confounding_unresolved');
  if (e.replicated !== true || e.validatedOutOfSample !== true) reasons.push('not_independently_supported');
  if (e.causalClaim === true && e.design !== 'randomized') reasons.push('causal_claim_not_supported');
  return { key: candidate?.key, evidenceReady: reasons.length === 0, reasons };
}

export function observeBehavioralCoaching(notes = []) {
  const behaviorFor = { adherence: 'spacing', 'ramp-spike': 'volume', 'ramp-drop': 'volume' };
  const candidates = notes.filter(note => behaviorFor[note.key]).map(note => ({
    key: note.key, behavior: behaviorFor[note.key], observation: note.text,
    // A descriptive threshold does not supply an effect estimate, a behavioral
    // action, or a longitudinal outcome. Never manufacture those from a note.
    ...assessCoachingEvidence({ key: note.key, behavior: behaviorFor[note.key] }),
  }));
  return { mode: 'observe_only', candidates, recommendations: [] };
}
