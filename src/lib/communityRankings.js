import { comparisonReps } from '../model/curveComparison.js';
import { COMMUNITY_METRICS, STAR_STEPS, communityComparison } from './communityProgress.js';

export const communityBaselineBand = kg => Math.floor((kg + 1e-9) / 10) * 10;
export const communityGroupKey = group => `${group.baseline_band}|${group.support_keys.join(',')}`;

// Read the frozen model's existing baselines; never re-pin them. Rankings use
// latest estimates, with a milestone confirmed on two eligible session dates.
export function communityImprovementSnapshots(history, overlays, today) {
  const snapshots = [];
  for (const [grip, overlay] of Object.entries(overlays || {})) {
    const dates = [...new Set(comparisonReps(history, grip).map(r => r.date))]
      .filter(date => date <= today && overlay.ampsByDate?.has(date)).sort();
    const [priorDate, measuredDate] = dates.slice(-2);
    if (!priorDate || !measuredDate) continue;
    const balanced = communityComparison(overlay, 'balanced', measuredDate);
    if (!balanced || !(balanced.before > 0) || !(balanced.before < 200)) continue;
    for (const { key: metric } of COMMUNITY_METRICS) {
      const current = communityComparison(overlay, metric, measuredDate);
      const prior = communityComparison(overlay, metric, priorDate);
      if (!current || !prior || current.baselineDate !== prior.baselineDate
        || priorDate <= current.baselineDate || current.support.join(',') !== prior.support.join(',')
        || !(current.now > 0 && current.now < 200) || !(current.before > 0 && current.before < 200)) continue;
      const milestone = STAR_STEPS.filter(step => Math.min(current.percent, prior.percent) + 1e-10 >= step).at(-1);
      if (!milestone || !Number.isFinite(current.percent)) continue;
      snapshots.push({ grip, metric, baseline_date: current.baselineDate, prior_date: priorDate,
        measured_date: measuredDate, baseline_force_kg: current.before, current_force_kg: current.now,
        group_force_kg: balanced.before, improvement_pct: Math.max(current.percent, milestone),
        milestone_pct: milestone, support_keys: balanced.support });
    }
  }
  return snapshots;
}
