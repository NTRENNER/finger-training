import { isValidVolumeExperiment } from '../model/volumeExperiment.js';

export const LS_VOLUME_EXPERIMENTS_KEY = 'ft_volume_experiments';
const PREFIX = 'volume_beta_plan_';
const STATUS_PREFIX = 'volume_beta_status_';
const REVIEW_PREFIX = 'volume_beta_review_';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => typeof value === 'string' && value.includes('T') && Number.isFinite(Date.parse(value));
const validWeek = week => Number.isInteger(week) && week >= 1 && week <= 6;

function basePlan(experiment) {
  const { id, version, startDate, endDate, createdAt, grips, weeks, days, weeklyGoal,
    goalSessionsPerGrip, sets, restSeconds, baseline } = experiment;
  return { id, version, startDate, endDate, createdAt, grips, weeks, days, weeklyGoal,
    goalSessionsPerGrip, sets, restSeconds, status: 'active', baseline };
}

function reviewValue(value) {
  if (!object(value)) return null;
  const allowed = {
    climbing: ['', 'better', 'same', 'worse', 'none'],
    fatigue: ['', 'less', 'same', 'more'], timeCost: ['', 'manageable', 'difficult'],
  };
  if (Object.entries(allowed).some(([key, values]) => value[key] != null && !values.includes(value[key]))
    || (value.notes != null && typeof value.notes !== 'string')
    || (value.savedAt != null && !timestamp(value.savedAt))) return null;
  return { ...Object.fromEntries(Object.keys(allowed).filter(key => value[key] != null).map(key => [key, value[key]])),
    ...(value.notes != null ? { notes: value.notes.slice(0, 1000) } : {}),
    ...(value.savedAt != null ? { savedAt: value.savedAt } : {}) };
}

// Immutable plan, lifecycle and each review have separate atomic patch keys.
// A review made from a stale device cannot resume a paused/ended experiment
// or erase a different week's review. Explicit same-field edits remain LWW.
export function volumeExperimentPatch(experiment, options = {}) {
  if (!isValidVolumeExperiment(experiment) || !object(options)) return {};
  const { statusOnly, reviewWeek } = options;
  if (statusOnly === true && reviewWeek == null) {
    return { [`${STATUS_PREFIX}${experiment.id}`]: { version: 1, experiment_id: experiment.id,
      status: experiment.status, updatedAt: timestamp(experiment.updatedAt) ? experiment.updatedAt : new Date().toISOString() } };
  }
  if (validWeek(reviewWeek) && !statusOnly) {
    const review = reviewValue(experiment.reviews?.[reviewWeek]);
    return review ? { [`${REVIEW_PREFIX}${experiment.id}_${reviewWeek}`]: {
      version: 1, experiment_id: experiment.id, week: reviewWeek, review,
    } } : {};
  }
  if (Object.keys(options).length || experiment.status !== 'active') return {};
  return { [`${PREFIX}${experiment.id}`]: basePlan(experiment) };
}

export function volumeExperimentsFromSettings(settings) {
  if (!object(settings)) return {};
  return Object.fromEntries(Object.entries(settings)
    .filter(([key, value]) => key.startsWith(PREFIX)
      && isValidVolumeExperiment(value) && value.status === 'active' && key === `${PREFIX}${value.id}`)
    .map(([, value]) => {
      let experiment = basePlan(value);
      const status = settings[`${STATUS_PREFIX}${value.id}`];
      if (status?.version === 1 && status.experiment_id === value.id
        && ['active', 'paused', 'completed', 'ended'].includes(status.status) && timestamp(status.updatedAt)) {
        experiment = { ...experiment, status: status.status, updatedAt: status.updatedAt };
      }
      const reviews = {};
      for (let week = 1; week <= 6; week++) {
        const saved = settings[`${REVIEW_PREFIX}${value.id}_${week}`];
        const review = reviewValue(saved?.review);
        if (saved?.version === 1 && saved.experiment_id === value.id && saved.week === week && review) reviews[week] = review;
      }
      if (Object.keys(reviews).length) experiment = { ...experiment, reviews };
      return [value.id, experiment];
    }));
}

export function validVolumeExperiments(raw) {
  if (!object(raw)) return {};
  return Object.fromEntries(Object.entries(raw)
    .filter(([id, value]) => isValidVolumeExperiment(value) && id === value.id));
}

// The cache contains hydrated experiments. Reconstruct their separate fields
// before overlaying pending patches, including on an offline remount after a
// failed cache write. The retry queue, not the cache, is the durable journal.
export function restoreVolumeExperiments(cache, pending = {}) {
  const settings = {};
  for (const experiment of Object.values(validVolumeExperiments(cache))) {
    Object.assign(settings, volumeExperimentPatch(basePlan(experiment)));
    if (experiment.status !== 'active' || timestamp(experiment.updatedAt)) {
      Object.assign(settings, volumeExperimentPatch({ ...experiment,
        updatedAt: timestamp(experiment.updatedAt) ? experiment.updatedAt : experiment.createdAt }, { statusOnly: true }));
    }
    for (let week = 1; week <= 6; week++) {
      if (experiment.reviews?.[week]) Object.assign(settings, volumeExperimentPatch(experiment, { reviewWeek: week }));
    }
  }
  return volumeExperimentsFromSettings({ ...settings, ...(object(pending) ? pending : {}) });
}
