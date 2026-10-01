import { createVolumeExperiment } from '../../model/volumeExperiment.js';
import { volumeExperimentPatch, volumeExperimentsFromSettings, restoreVolumeExperiments,
  validVolumeExperiments } from '../volumeExperimentStorage.js';

const plan = (id = 'trial') => createVolumeExperiment({ id, grips: ['Micro'], startDate: '2026-10-01',
  createdAt: '2026-10-01T08:00:00Z' });

test('new plan has one immutable key; mutable updates never resend the base', () => {
  const e = plan();
  expect(volumeExperimentPatch(e)).toEqual({ volume_beta_plan_trial: e });
  const paused = { ...e, status: 'paused', updatedAt: '2026-10-02T08:00:00Z' };
  expect(volumeExperimentPatch(paused, { statusOnly: true })).toEqual({ volume_beta_status_trial: {
    version: 1, experiment_id: 'trial', status: 'paused', updatedAt: paused.updatedAt,
  } });
  expect(volumeExperimentPatch(paused)).toEqual({});
});

test('atomic keys preserve pause and different weeks from stale devices in either write order', () => {
  const e = plan(), status = volumeExperimentPatch({ ...e, status: 'paused' }, { statusOnly: true });
  const review1 = volumeExperimentPatch({ ...e, reviews: { 1: { notes: 'First' } } }, { reviewWeek: 1 });
  const review2 = volumeExperimentPatch({ ...e, reviews: { 2: { notes: 'Second' } } }, { reviewWeek: 2 });
  for (const mutations of [[status, review1, review2], [review2, review1, status]]) {
    const settings = Object.assign({}, volumeExperimentPatch(e), ...mutations);
    expect(volumeExperimentsFromSettings(settings).trial).toMatchObject({ status: 'paused',
      reviews: { 1: { notes: 'First' }, 2: { notes: 'Second' } }, baseline: e.baseline });
  }
});

test('ended status survives a review and no review carries unrelated lifecycle fields', () => {
  const e = plan();
  const patch = volumeExperimentPatch({ ...e, status: 'active', reviews: { 1: { notes: 'Fine', status: 'active' } } }, { reviewWeek: 1 });
  expect(patch.volume_beta_review_trial_1.review).toEqual({ notes: 'Fine' });
  const result = volumeExperimentsFromSettings({ ...volumeExperimentPatch(e),
    ...volumeExperimentPatch({ ...e, status: 'ended' }, { statusOnly: true }), ...patch });
  expect(result.trial.status).toBe('ended');
});

test('cache restoration overlays pending changes, including a new plan absent from cache', () => {
  const e = plan();
  const pending = { ...volumeExperimentPatch(e),
    ...volumeExperimentPatch({ ...e, status: 'paused' }, { statusOnly: true }) };
  expect(restoreVolumeExperiments(null, pending).trial).toMatchObject({ ...e, status: 'paused' });
  const prior = { ...e, status: 'paused', reviews: { 1: { notes: 'Retained' } } };
  const next = restoreVolumeExperiments({ trial: prior },
    volumeExperimentPatch({ ...e, reviews: { 2: { notes: 'New' } } }, { reviewWeek: 2 }));
  expect(next.trial).toMatchObject({ status: 'paused', reviews: { 1: { notes: 'Retained' }, 2: { notes: 'New' } } });
});

test('malformed keys, timestamps, mismatched owners and unsafe review values are ignored', () => {
  const e = plan();
  const settings = { ...volumeExperimentPatch(e), volume_beta_plan_wrong: e,
    volume_beta_status_trial: { version: 1, experiment_id: 'other', status: 'paused', updatedAt: e.createdAt },
    volume_beta_review_trial_1: { version: 1, experiment_id: 'trial', week: 2, review: { notes: 'Wrong slot' } },
    volume_beta_review_trial_2: { version: 1, experiment_id: 'trial', week: 2, review: { climbing: {} } },
    volume_beta_plan_bad: { ...e, id: 'bad', createdAt: 123 } };
  expect(volumeExperimentsFromSettings(settings)).toEqual({ trial: e });
  expect(validVolumeExperiments({ bad: { ...e, id: 'bad', createdAt: 123 } })).toEqual({});
  expect(volumeExperimentsFromSettings(null)).toEqual({});
  expect(volumeExperimentsFromSettings([])).toEqual({});
});

test.each([{ reviewWeek: 0 }, { reviewWeek: 7 }, { statusOnly: true, reviewWeek: 1 }, { unknown: true }])(
  'invalid mutation options %j cannot write any settings key', options => {
    expect(volumeExperimentPatch({ ...plan(), reviews: { 1: { notes: 'Okay' } } }, options)).toEqual({});
  });

test('frozen plateau enrollment evidence survives sync, pause and review updates', () => {
  const entryEvidence = { version: 1, asOf: '2026-10-01', source: 'plateau_prompt', byGrip: [
    { grip: 'Micro', recommendation: 'consider_volume_beta', cells: [] } ] };
  const e = createVolumeExperiment({ id: 'trial', grips: ['Micro'], startDate: '2026-10-01', entryEvidence });
  entryEvidence.byGrip[0].recommendation = 'changed';
  expect(e.entryEvidence.byGrip[0].recommendation).toBe('consider_volume_beta');
  const settings = { ...volumeExperimentPatch(e),
    ...volumeExperimentPatch({ ...e, status: 'paused' }, { statusOnly: true }),
    ...volumeExperimentPatch({ ...e, reviews: { 1: { notes: 'Climbing feels good.' } } }, { reviewWeek: 1 }) };
  expect(volumeExperimentsFromSettings(settings).trial.entryEvidence).toEqual(e.entryEvidence);
  expect(restoreVolumeExperiments({ trial: e }).trial.entryEvidence).toEqual(e.entryEvidence);
});
