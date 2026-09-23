import { isCapacityEvidenceRep, loadProvenance } from "./forceRecording.js";
import { effectiveLoad } from "./load.js";
import { isMixedDomainRep } from './mixedDomain.js';

// Internal consistency policy. No new athlete-facing tuning controls.
export const RECOVERY_LOAD_RATIO = 1.10;
export const LEGACY_RECOVERY_WEIGHT = 0.5;
// Only pre-capture rows may substitute planned rest for actual rest.
const TIMING_CAPTURE_DATE = "2026-09-11";

// Return the complete opening prefix. Never close a missing/interrupted slot
// or treat a later fatigued effort as a fresh opener. Earlier valid comparisons
// survive an interruption later in the same set.
export function recoveryEvidence(reps) {
  const sorted = [...(reps || [])].sort((a, b) => Number(a.rep_num) - Number(b.rep_num));
  const prefix = [], rests = [];
  let estimated = false;
  let reason = null, minLoad = Infinity, maxLoad = 0;
  const opener = sorted[0];
  if (sorted.some(isMixedDomainRep)) return { reps: [], rests: [], reason: 'mixed_load_protocol',
    confidence: 'measured', weight: 0, eligible: false, status: 'descriptive_only' };
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    if (Number(r.rep_num) !== i + 1 || Number(sorted[i + 1]?.rep_num) === Number(r.rep_num)) { reason = "missing_or_duplicate_rep"; break; }
    if (!isCapacityEvidenceRep(r) || !(r.actual_time_s > 0)) { reason = "invalid_failure"; break; }
    if (r.grip !== opener.grip || r.hand !== opener.hand || r.session_id !== opener.session_id
        || (r.set_num ?? 1) !== (opener.set_num ?? 1)
        || (r.setup_id ?? null) !== (opener.setup_id ?? null)) { reason = "setup_changed"; break; }
    const source = loadProvenance(r);
    const legacy = source === "legacy_measured" && r.date && r.date < TIMING_CAPTURE_DATE
      && r.load_provenance == null && r.force_recording == null && r.rep_timing == null;
    if (!["measured_force", "known_external_load"].includes(source) && !legacy) { reason = "uncertain_load"; break; }
    if (source !== loadProvenance(opener)) { reason = "load_source_changed"; break; }
    if (source === "measured_force" && r.force_recording?.capacity_eligible !== true) { reason = "uncertain_force_stability"; break; }
    const load = effectiveLoad(r);
    if (!(load > 0)) { reason = "unknown_load"; break; }
    minLoad = Math.min(minLoad, load); maxLoad = Math.max(maxLoad, load);
    if (maxLoad / minLoad > RECOVERY_LOAD_RATIO + 1e-9) { reason = "force_changed"; break; }
    if (i) {
      const rest = legacy ? sorted[i - 1].rest_s : r.rep_timing?.rest_before_s;
      if (!Number.isFinite(rest) || rest < 0) { reason = "unmeasured_rest"; break; }
      rests.push(rest);
    }
    estimated = estimated || legacy;
    prefix.push(r);
  }
  return { reps: prefix, rests, reason, confidence: estimated ? "historical_estimate" : "measured",
    weight: estimated ? LEGACY_RECOVERY_WEIGHT : 1, eligible: prefix.length >= 2,
    status: prefix.length >= 2 ? (reason ? "partial" : "comparable") : "descriptive_only" };
}
