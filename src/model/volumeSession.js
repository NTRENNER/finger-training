// The enrolled plan is frozen when a session starts. Its extra set is a dose
// choice, not a change to the load ladder or the definition of fresh evidence.
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(`${value}T12:00:00Z`))
  && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;

export function snapshotVolumePlan(plan, day) {
  if (plan?.id !== 'volume_beta' || plan.version !== 1 || plan.sets !== 2
    || plan.rest_s !== 300 || plan.goal_sessions_per_grip !== 18
    || typeof plan.experiment_id !== 'string' || !plan.experiment_id.trim()
    || !validDate(day) || !validDate(plan.started_on) || !validDate(plan.ends_on)
    || plan.started_on > day || plan.ends_on < day || plan.ends_on < plan.started_on) return null;
  return Object.freeze({ id: 'volume_beta', version: 1, experiment_id: plan.experiment_id,
    started_on: plan.started_on, ends_on: plan.ends_on, sets: 2, rest_s: 300,
    goal_sessions_per_grip: 18 });
}

export function isVolumeRepComplete(rep) {
  return Number.isFinite(Number(rep?.actual_time_s)) && Number(rep.actual_time_s) > 0
    && rep.failure_valid === true
    && !['equipment_interruption', 'target_not_reached', 'user_interruption', 'interrupted'].includes(rep.end_reason)
    && rep.force_recording?.signal_quality !== 'incomplete'
    && rep.force_recording?.capacity_eligible !== false;
}

export function isVolumeSetComplete(reps, config, setNum = 1) {
  const count = Number(config?.repsPerSet);
  if (!Number.isInteger(count) || count < 1) return false;
  const hands = config.hand === 'Both' ? ['L', 'R'] : [config.hand];
  return hands.every(hand => {
    const rows = reps.filter(r => Number(r.set_num) === setNum && r.hand === hand)
      .sort((a, b) => a.rep_num - b.rep_num);
    return rows.length === count && rows.every((r, i) => Number(r.rep_num) === i + 1
      && isVolumeRepComplete(r));
  });
}
