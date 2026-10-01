import { betaEligibility, BETA_ELIGIBILITY_DESCRIPTION } from '../../model/betaEligibility.js';
import React, { useMemo, useState } from 'react';
import { Card, Btn } from '../../ui/components.js';
import { C } from '../../ui/theme.js';
import { today } from '../../util.js';
import { toDisp } from '../../ui/format.js';
import { volumeProgress, volumeComparison, isValidVolumeExperiment } from '../../model/volumeExperiment.js';

const field = { background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: 8, width: '100%', boxSizing: 'border-box' };
const signed = n => `${n >= 0 ? '+' : ''}${n.toFixed(1)}`;

function WeeklyReview({ experiment, week, onSave, ready }) {
  const saved = experiment.reviews?.[week] || {};
  const [draft, setDraft] = useState({ climbing: saved.climbing || '', fatigue: saved.fatigue || '', timeCost: saved.timeCost || '', notes: saved.notes || '' });
  const [message, setMessage] = useState('');
  const update = (name, value) => { setDraft(prev => ({ ...prev, [name]: value })); setMessage(''); };
  const save = () => {
    const review = { ...draft, notes: draft.notes.trim().slice(0, 1000), savedAt: new Date().toISOString() };
    const ok = onSave?.({ ...experiment, reviews: { ...experiment.reviews, [week]: review } }, { reviewWeek: week });
    setMessage(ok === false ? 'Could not save this review. Please try again.' : 'Weekly review saved.');
  };
  return <div style={{ display: 'grid', gap: 12 }}>
    {[
      ['climbing', 'Climbing this week', [['better', 'Better than usual'], ['same', 'About usual'], ['worse', 'Worse than usual'], ['none', 'Did not climb']]],
      ['fatigue', 'Fatigue between sessions', [['less', 'Less than usual'], ['same', 'About usual'], ['more', 'More than usual']]],
      ['timeCost', 'Time commitment', [['manageable', 'Manageable'], ['difficult', 'Difficult to fit in']]],
    ].map(([name, label, options]) => <label key={name}>{label}
      <select style={{ ...field, marginTop: 4 }} value={draft[name]} onChange={e => update(name, e.target.value)}>
        <option value="">Not recorded</option>
        {options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
      </select>
    </label>)}
    <label>Weekly notes
      <textarea style={{ ...field, marginTop: 4, minHeight: 80 }} maxLength={1000} value={draft.notes}
        placeholder="Travel, sleep, unusual climbing, or anything that affected training…" onChange={e => update('notes', e.target.value)} />
    </label>
    <div><Btn small disabled={!ready || !onSave} onClick={save}>Save weekly review</Btn></div>
    {message && <p role="status" style={{ margin: 0 }}>{message}</p>}
  </div>;
}

function ExperimentReport({ experiment, history, activities, unit, onSave, ready, date }) {
  const progress = useMemo(() => volumeProgress(experiment, history, date), [experiment, history, date]);
  const comparison = useMemo(() => volumeComparison(experiment, history, date), [experiment, history, date]);
  const [reviewWeek, setReviewWeek] = useState(Math.max(1, progress.week));
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [saveError, setSaveError] = useState('');
  const access = useMemo(() => betaEligibility(history, date), [history, date]);
  const finished = ['completed', 'ended'].includes(progress.status);
  const taggedRows = useMemo(() => history.filter(r => r.force_recording?.volume_beta?.experiment_id === experiment.id), [history, experiment.id]);
  const rests = taggedRows.filter(r => r.set_num === 2 && r.rep_num === 1)
    .map(r => r.rep_timing?.rest_before_s).filter(s => Number.isFinite(s) && s >= 0);
  const load = kg => `${toDisp(kg, unit).toFixed(1)} ${unit}`;
  const changeStatus = status => {
    if (status === 'active' && !access.eligible) return;
    const saved = onSave?.({ ...experiment, status, updatedAt: new Date().toISOString() }, { statusOnly: true });
    setSaveError(saved === false ? 'Could not save this plan change. Please try again.' : '');
    if (saved !== false) setConfirmEnd(false);
  };
  const download = () => {
    const report = { version: 1, generatedAt: new Date().toISOString(), experiment, progress, comparison,
      limitations: ['Personal before/after pilot; not a causal test of volume.', 'Frequency, climbing, travel and measurement changes can affect results.', 'Comparisons use up to three dates per period at similar measured force (within 3%) and the same measurement method.'],
      reps: taggedRows, activities: (activities || []).filter(a => a.date >= experiment.startDate && a.date <= experiment.endDate),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url;
    link.download = `volume-beta-${experiment.startDate}.json`; link.click(); URL.revokeObjectURL(url);
  };
  return <>
    <p style={{ color: C.muted }}>{experiment.startDate} through {experiment.endDate} · {finished ? 'Finished' : progress.status === 'paused' ? 'Paused' : `Week ${progress.week} of 6`}</p>
    {experiment.entryEvidence && <details>
      <summary>Why this experiment started</summary>
      <p>{experiment.entryEvidence.source === 'plateau_prompt' ? 'You opened setup from a plateau invitation.' : 'You chose the experiment yourself.'} Screening saved on {experiment.entryEvidence.asOf}.</p>
      {experiment.entryEvidence.byGrip.map(g => <p key={g.grip}>{g.grip}: {g.recommendation === 'consider_volume_beta' ? 'Possible persistent plateau; optional volume trial suggested.' : 'Plateau criteria were not met at enrollment.'}</p>)}
      <p>The original screening evidence is preserved in the downloaded review. This is a personal comparison, not proof of a volume effect.</p>
    </details>}
    <p>Two sets per hand · three sessions per week for each grip · five-minute rest target for each hand between sets.</p>
    {progress.byGrip.map(row => <div key={row.grip} style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: 14, marginBottom: 12 }}>
      <b>{row.grip}: {row.completed} of {row.goal} two-set sessions</b>
      <p style={{ color: C.muted, marginBottom: 0 }}>{row.started} training days started · {row.completedSets} complete hand sets · {(row.workSeconds / 60).toFixed(1)} minutes of recorded pulling{row.estimatedWork ? ' (some activity is estimated or incomplete)' : ''}.</p>
      <p style={{ color: C.muted, marginBottom: 0 }}>Previous six weeks: {experiment.baseline.trainingDaysByGrip?.[row.grip] ?? '—'} training days. A change in frequency can also change your results.</p>
    </div>)}
    <p style={{ color: C.muted, fontSize: 13 }}>Both hands count as one grip session. Partial sessions remain recorded but do not count as completing both sets. Each grip counts at most once per date.</p>
    <p style={{ color: C.muted, fontSize: 13 }}>{rests.length
      ? `Recorded rest before second sets: ${(rests.reduce((a, b) => a + b, 0) / rests.length).toFixed(0)} seconds on average across ${rests.length} hand transitions.`
      : 'No measured rest before second sets yet. Uncertain release times are kept separate from measured rest.'}</p>
    <h3>Opening-hold comparison</h3>
    <p style={{ color: C.muted }}>Your starting measurements are fixed from {experiment.baseline.windowStart} through {experiment.baseline.windowEnd}. Each comparison uses up to three training dates at a similar measured force (within 3%) and the same measurement method. Only eligible opening holds from the first session and first set count.</p>
    {comparison.byHand.map(row => <div key={`${row.grip}-${row.hand}`} style={{ borderTop: `1px solid ${C.border}`, padding: '14px 0' }}>
      <b>{row.grip} · {row.hand === 'L' ? 'Left' : 'Right'}</b>
      {row.status === 'baseline_missing' ? <p style={{ color: C.muted }}>No comparable historical starting measurement. This experiment cannot establish a before-and-after change for this hand; its recorded training remains available for review.</p>
        : <>
          <p>Starting hold: {row.baseline.meanTimeS.toFixed(1)}s near {load(row.baseline.loadKg)} · {row.baseline.points.length} training {row.baseline.points.length === 1 ? 'date' : 'dates'}.</p>
          {row.status === 'no_matches' ? <p style={{ color: C.muted }}>No matching opening holds from Volume Beta yet. Changes in load or measurement method can leave this comparison empty.</p>
            : <p style={{ color: C.blue, fontWeight: 700 }}>Recent holds: {row.meanTimeS.toFixed(1)}s · {signed(row.changeSeconds)}s ({signed(row.changePercent)}%) · {row.points.length} training {row.points.length === 1 ? 'date' : 'dates'}.</p>}
          {row.provisional && <p style={{ color: C.yellow, fontSize: 13 }}>Provisional: fewer than three comparable training dates in one or both periods.</p>}
          <details><summary style={{ cursor: 'pointer', color: C.muted }}>Measurements used</summary>
            {[['Starting', row.baseline.points], ['Recent', row.points]].map(([label, points]) => <div key={label}>
              <p style={{ marginBottom: 6 }}>{label}</p>
              <ul style={{ paddingLeft: 20 }}>{points.map(p => <li key={p.id || p.date}>{p.date}: {load(p.forceKg)} for {p.timeS.toFixed(1)}s</li>)}</ul>
            </div>)}
          </details>
        </>}
    </div>)}
    <p style={{ color: C.muted }}>This is a personal before-and-after pilot. Better holds alone cannot tell us whether the extra set helped: training frequency, climbing, travel and fatigue also matter. Review the added work and how you feel before deciding to keep it.</p>
    <details style={{ borderTop: `1px solid ${C.border}`, paddingTop: 14, marginBottom: 18 }}>
      <summary style={{ cursor: 'pointer', fontWeight: 700 }}>Weekly check-in</summary>
      <label style={{ display: 'block', margin: '14px 0' }}>Review week
        <select style={{ ...field, marginTop: 4 }} value={reviewWeek} onChange={e => setReviewWeek(Number(e.target.value))}>
          {Array.from({ length: Math.max(1, progress.week) }, (_, i) => <option key={i + 1} value={i + 1}>Week {i + 1}</option>)}
        </select>
      </label>
      <WeeklyReview key={`${experiment.id}-${reviewWeek}`} experiment={experiment} week={reviewWeek} onSave={onSave} ready={ready} />
    </details>
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
      <Btn small onClick={download}>Download Volume review</Btn>
      {!finished && <Btn small disabled={!ready || !onSave || (progress.status === 'paused' && !access.eligible)} color={C.border} onClick={() => changeStatus(progress.status === 'paused' ? 'active' : 'paused')}>{progress.status === 'paused' ? 'Resume plan' : 'Pause plan'}</Btn>}
      {!finished && <Btn small color={C.border} disabled={!ready || !onSave} onClick={() => setConfirmEnd(true)}>End plan</Btn>}
    </div>
    {!finished && !access.eligible && <p style={{ color: C.muted }}>{BETA_ELIGIBILITY_DESCRIPTION} Your recorded results remain available.</p>}
    {saveError && <p role="alert">{saveError}</p>}
    {!finished && <p style={{ color: C.muted, fontSize: 13 }}>Pausing keeps the original end date. You can finish a training day after one set whenever needed.</p>}
    {confirmEnd && !finished && <div role="group" aria-label="End Volume Beta" style={{ marginTop: 16 }}>
      <p>End this experiment now? Recorded workouts and reviews will remain available.</p>
      <Btn small disabled={!ready || !onSave} onClick={() => changeStatus('ended')}>End experiment</Btn>{' '}
      <Btn small color={C.border} onClick={() => setConfirmEnd(false)}>Keep plan</Btn>
    </div>}
  </>;
}

export function VolumeExperimentReview({ experiments = {}, history = [], activities = [], unit = 'lbs', onSave, ready = true, date = today() }) {
  const plans = Object.values(experiments).filter(isValidVolumeExperiment)
    .sort((a, b) => b.startDate.localeCompare(a.startDate) || b.id.localeCompare(a.id));
  const [selectedId, setSelectedId] = useState(null);
  const experiment = plans.find(p => p.id === selectedId) || plans[0];
  return <Card>
    <h2 style={{ marginTop: 0 }}>Volume Beta</h2>
    {!ready ? <p role="status" style={{ color: C.muted }}>Loading your experiment plans…</p>
      : !experiment ? <p style={{ color: C.muted }}>Start an optional six-week, two-set experiment from the Fingers tab. Your progress and weekly reviews will appear here.</p>
      : <>
        {plans.length > 1 && <label>Experiment
          <select style={{ ...field, marginTop: 4 }} value={experiment.id} onChange={e => setSelectedId(e.target.value)}>
            {plans.map(plan => <option key={plan.id} value={plan.id}>{plan.startDate} · {plan.grips.join(', ')}</option>)}
          </select>
        </label>}
        <ExperimentReport key={experiment.id} experiment={experiment} history={history} activities={activities} unit={unit} onSave={onSave} ready={ready} date={date} />
      </>}
  </Card>;
}
