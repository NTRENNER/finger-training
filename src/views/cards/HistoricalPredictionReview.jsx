import React, { useEffect, useRef, useState } from 'react';
import { Btn } from '../../ui/components.js';
import { C } from '../../ui/theme.js';

const domainNames = { power: 'Power', power_strength: 'Power / Strength', strength: 'Strength',
  strength_endurance: 'Strength / Endurance', endurance: 'Endurance', max_strength: 'Short targets' };
const pretty = n => n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;

function ReplayScores({ name, scores, unit }) {
  if (!scores) return null;
  const a = scores.currentCapacity, b = scores.candidateCapacity;
  const factor = unit === 'lbs' ? 2.2046226218 : 1;
  const fmt = n => n == null ? '—' : `${(n * factor).toFixed(1)} ${unit}`;
  return <div style={{ marginTop: 16 }}>
    <strong>{name}</strong>
    <div style={{ color: C.muted, fontSize: 13, margin: '6px 0' }}>{a.trainingDays} days · {a.observations} opening holds</div>
    <table style={{ width: '100%', textAlign: 'left', fontSize: 14 }}>
      <thead><tr><th>Error</th><th>Current</th><th>Candidate</th></tr></thead>
      <tbody>{[['Typical', 'mae'], ['Larger misses', 'rmse'], ['Bias', 'bias']].map(([label, k]) =>
        <tr key={k}><th scope="row" style={{ fontWeight: 400, padding: '5px 0' }}>{label}</th><td>{fmt(a[k])}</td><td>{fmt(b[k])}</td></tr>)}</tbody>
    </table>
  </div>;
}

export function HistoricalPredictionReview({ history, unit }) {
  const [report, setReport] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const worker = useRef(null), generation = useRef(0);
  useEffect(() => {
    generation.current++;
    worker.current?.terminate(); worker.current = null;
    setReport(null); setBusy(false); setError('');
    // Cancel the latest request, including one started after effect setup.
    // These refs are request state, not DOM nodes captured for cleanup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { generation.current++; worker.current?.terminate(); };
  }, [history]);
  const run = async () => {
    const id = ++generation.current;
    worker.current?.terminate(); setBusy(true); setError('');
    try {
      const { createHistoricalReviewWorker } = await import('../../model/historicalWorkerClient.js');
      if (id !== generation.current) return;
      const w = createHistoricalReviewWorker(); worker.current = w;
      w.onmessage = ({ data }) => {
        if (id !== generation.current) return;
        w.terminate(); worker.current = null; setBusy(false);
        if (data.error) setError(data.error); else setReport(data.report);
      };
      w.onerror = () => {
        if (id !== generation.current) return;
        w.terminate(); worker.current = null; setBusy(false); setError('The review could not finish. Please try again.');
      };
      w.postMessage(history);
    } catch (_) {
      if (id === generation.current) { setBusy(false); setError('The review could not start. Please try again.'); }
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url;
    link.download = 'historical-prediction-review.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const matched = report?.recorded.all.matched;
  return <section style={{ borderBottom: `1px solid ${C.border}`, paddingBottom: 18, marginBottom: 18 }}>
    <strong>Your earlier workouts</strong>
    <p style={{ color: C.muted, lineHeight: 1.5 }}>Your saved targets and measured holds can already tell us how the recommendations performed.
      We can also replay competing models using only workouts before each training day.</p>
    {!report && <Btn onClick={run} disabled={busy || !history.length}>{busy ? 'Reviewing history…' : 'Review earlier workouts'}</Btn>}
    {busy && <p role="status" style={{ color: C.muted }}>Running the comparison. You can keep using the app.</p>}
    {error && <p role="alert">{error}</p>}
    {report && <>
      <p>{report.replay.inventory.trainingDays} recorded training days · through {report.replay.inventory.lastDate || '—'}</p>
      <details open><summary style={{ cursor: 'pointer', fontWeight: 700 }}>Recorded targets and results</summary>
        <p>{matched.holds} opening holds on {matched.days} days were within 10% of the prescribed force.</p>
        <p style={{ color: C.muted, fontSize: 13 }}>{report.recorded.byEvidence.legacy_or_uncertain?.matched.holds || 0} of these comparisons use older records with uncertain measurement or ending details.</p>
        {matched.holds ? <>
          <p style={{ fontSize: 20, fontWeight: 700 }}>{pretty(matched.meanPercentBeyondTarget)} average time versus target</p>
          <p style={{ color: C.muted }}>Positive means you held longer. This describes target attainment, not the accuracy of a single model version.</p>
          <ul><li>{matched.below80Percent} ended below 80% of target time</li>
            <li>{matched.within20Percent} were within 20% of target time</li>
            <li>{matched.above120Percent} exceeded 120% of target time</li></ul>
        </> : <p style={{ color: C.muted }}>No comparable measured opening holds for this check yet.</p>}
        <p style={{ color: C.muted }}>Higher-force holds stay useful: {report.recorded.all.higherForceAndAtLeastTargetTime} exceeded force by more than 10% and reached the target time.
          Other different-load holds are kept separate from time-at-target comparisons.</p>
        <details><summary style={{ cursor: 'pointer' }}>By grip and planned domain</summary>
          {[...Object.entries(report.recorded.byGrip), ...Object.entries(report.recorded.byDomain)].map(([key, value]) =>
            <p key={key}><strong>{domainNames[key] || key}</strong> · {value.matched.holds} holds / {value.matched.days} days · {pretty(value.matched.meanPercentBeyondTarget)} time</p>)}
        </details>
        <p style={{ color: C.muted, fontSize: 13, lineHeight: 1.5 }}>Only first-set opening holds enter this check. Later reps, interruptions and special protocols are excluded.
          {` ${report.recorded.shortTargets.count} short-target holds are listed separately in the download.`}
          {' '}Older records may have estimated loads or uncertain endings; the download separates them from explicit measured failures.</p>
      </details>
      <details style={{ marginTop: 18 }}><summary style={{ cursor: 'pointer', fontWeight: 700 }}>Models replayed on earlier workouts</summary>
        <p style={{ color: C.muted }}>Both models use strictly earlier training days. We check the saved duration and force against each reconstructed capacity curve.
          The candidate fits opening holds only. This is a historical test, not the original forecast shown at the time.</p>
        <ReplayScores name="Capacity curves" scores={report.replay.force.capacityCurves.all.matched.candidateCapacity} unit={unit} />
        {Object.entries(report.replay.force.capacityCurves.byGrip).map(([grip, scores]) =>
          <ReplayScores key={grip} name={grip} scores={scores.matched.candidateCapacity} unit={unit} />)}
        <p style={{ color: C.muted, fontSize: 13 }}>Typical = mean absolute error; larger misses = root mean square error; bias = predicted minus actual.
          Each day has equal weight. A small overall gain can hide worse predictions for one grip.
          The download also includes bounded load recommendations, duration groups and recovery comparisons.</p>
      </details>
      <p style={{ color: C.muted, fontSize: 13 }}>History helps us choose what to test next. New saved forecasts provide a separate check on later workouts; they are not mixed into this score.</p>
      <Btn onClick={download}>Download historical review</Btn>
    </>}
  </section>;
}
