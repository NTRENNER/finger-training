import { isCapacityEvidenceRep } from './forceRecording.js';
import { effectiveLoad } from './load.js';
import { RECOVERY_LOAD_RATIO } from './recoveryEvidence.js';

// A frozen plan is distinct from observed capacity. In particular, restoring
// its base load never means dividing a measured force by a fatigue rating.
export function recordedSessionPrescription(rep) {
  const p = rep?.force_recording?.session_prescription;
  if (p?.version !== 1 || !Number.isInteger(p.reps_per_set) || p.reps_per_set < 1
      || !(p.target_duration_s > 0) || !(p.load_kg > 0) || p.load_kg >= 200) return null;
  return p;
}

// Progression needs the complete original sequence at comparable loads.
// Actual release-to-pull rest is used as recorded; a few seconds to react or
// acquire the target are not an adherence failure. Older untimed records can
// retain their explicitly estimated planned-rest interpretation.
export function progressionSetEvidence(reps = [], { expectedCount = null, plannedRest = 20 } = {}) {
  const sorted = [...reps].sort((a, b) => Number(a.rep_num) - Number(b.rep_num));
  const plans = sorted.map(recordedSessionPrescription).filter(Boolean);
  const planCounts = new Set(plans.map(p => p.reps_per_set));
  const count = expectedCount ?? (planCounts.size === 1 ? [...planCounts][0] : sorted.length);
  const rests = [];
  let estimatedRest = false;
  const result = reason => ({ reps: sorted, rests, count, complete: !reason, reason,
    restBasis: estimatedRest ? 'planned_rest_estimate' : 'measured_rest' });
  if (planCounts.size > 1 || (expectedCount != null && plans.some(p => p.reps_per_set !== expectedCount)))
    return result('conflicting_plan');
  // Positional numbering is only a compatibility path for entirely old,
  // untimed data. A modern recorded sequence must identify its original slots.
  const modern = sorted.some(r => r.rep_timing != null || r.force_recording != null);
  if (!(count > 0) || sorted.length !== count
      || sorted.some((r, i) => (modern && r.rep_num == null)
        || Number(r.rep_num ?? (i + 1)) !== i + 1))
    return result('missing_or_duplicate_rep');
  const opener = sorted[0];
  let minLoad = Infinity, maxLoad = 0;
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    if (!isCapacityEvidenceRep(r) || !(Number(r.actual_time_s) > 0)) return result('invalid_failure');
    if (r.grip !== opener.grip || r.hand !== opener.hand || r.session_id !== opener.session_id
        || Number(r.set_num ?? 1) !== Number(opener.set_num ?? 1)
        || (r.setup_id ?? null) !== (opener.setup_id ?? null)
        || Number(r.target_duration) !== Number(opener.target_duration)) return result('setup_changed');
    if (r.force_recording?.recovery_eligible === false
        || r.force_recording?.recording_stop_reason === 'release_not_observed') return result('unobserved_release');
    const load = effectiveLoad(r);
    if (!(load > 0)) return result('unknown_load');
    minLoad = Math.min(minLoad, load); maxLoad = Math.max(maxLoad, load);
    if (maxLoad / minLoad > RECOVERY_LOAD_RATIO + 1e-9) return result('force_changed');
    if (i) {
      const measured = r.rep_timing?.rest_before_s;
      if (Number.isFinite(measured) && measured >= 0) rests.push(measured);
      else if (r.rep_timing != null || recordedSessionPrescription(r)) return result('unmeasured_rest');
      else {
        const rest = Number(sorted[i - 1].rest_s ?? plannedRest);
        if (!Number.isFinite(rest) || rest < 0) return result('unmeasured_rest');
        estimatedRest = true; rests.push(rest);
      }
    }
  }
  return result(null);
}
